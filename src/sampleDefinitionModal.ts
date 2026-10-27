/**
 * "Go to definition" popup for a sample reference in the editor.
 *
 * Registry-first: a sample's definition (alias/description) lives in JSON, not
 * in the document. This modal shows the resolved record (local/global registry
 * or the read-only catalog) and offers edit/delete/open-file actions.
 */
import { App, Modal, Notice, Platform, Setting, TFile } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from './main';
import { isSameSampleFolder, noteLocalSampleFolder, type SampleUsageSpot } from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import {
  editSampleInteractive,
  deleteSampleInteractive,
  changeSampleTypeInteractive,
  moveSampleInteractive,
  resolveSampleDefinition,
  sampleUsageSpots,
  usageSpotLabel,
  type ResolvedSampleDefinition,
} from './sampleActions';
import { openInPartbank } from './partbank/partbankActions';
import { refreshOneLocation } from './partbank/partbankLocation';

/** Experiment groups shown open in the usage list; the rest start folded. */
const OPEN_USAGE_GROUPS = 5;

/**
 * Resolve `(type, id)` then show the definition popup (or a Notice if absent).
 * `resolved` skips the lookup when the caller already knows the record.
 * `localFolder` stands in for `docPath` when there is no note to derive the
 * Local folder from, as when the Samples sidebar opens the window.
 */
export async function openSampleDefinition(
  app: App,
  plugin: LabnotePlugin,
  opts: {
    type: string;
    id: string;
    docPath: string;
    resolved?: ResolvedSampleDefinition;
    localFolder?: string;
  }
): Promise<void> {
  const resolved = opts.resolved ?? (await resolveSampleDefinition(plugin, opts));
  if (!resolved) {
    new Notice(
      plugin.t(
        'No definition found for {0}. It is not in the sample registry: it may have been deleted or moved to another experiment, or the Global sample folder setting changed.',
        opts.id
      )
    );
    return;
  }
  new SampleDefinitionModal(app, plugin, opts.type, opts.id, opts.docPath, resolved, opts.localFolder).open();
}

/**
 * The note a stored basename (`sources`, `descriptionSources`) stands for:
 * the one in the sample's own experiment, else the only one in the vault.
 * Undefined when the name is ambiguous or gone.
 */
function noteForBasename(app: App, basename: string, folder: string): TFile | undefined {
  const matches = app.vault.getMarkdownFiles().filter(f => f.name === basename);
  const expDir = getExperimentDir(folder);
  if (expDir) {
    const inside = matches.filter(f => f.path.startsWith(`${expDir}/`));
    if (inside.length === 1) return inside[0];
  }
  return matches.length === 1 ? matches[0] : undefined;
}

class SampleDefinitionModal extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly plugin: LabnotePlugin,
    private readonly type: string,
    private readonly id: string,
    private readonly docPath: string,
    private readonly resolved: ResolvedSampleDefinition,
    private readonly localFolder?: string
  ) {
    super(app);
  }

  /** The other scope's folder, or undefined when the note has no Local one. */
  private moveTarget(): { toFolder: string; label: string } | undefined {
    const { scope, folder } = this.resolved;
    const globalFolder = this.plugin.settings.globalSampleFolder;
    if (scope === 'local') {
      if (!globalFolder || isSameSampleFolder(folder, globalFolder)) return undefined;
      return { toFolder: globalFolder, label: this.plugin.t('Move to Global') };
    }
    const local = this.docPath ? noteLocalSampleFolder(this.docPath, globalFolder) : this.localFolder || undefined;
    if (!local || isSameSampleFolder(local, folder)) return undefined;
    return { toFolder: local, label: this.plugin.t('Move to Local') };
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.plugin.t;
    const { scope, folder, record } = this.resolved;
    const jsonPath = this.resolved.file ?? posix.join(folder, `${this.type}.json`);
    const scopeLabel =
      scope === 'local' ? t('Local') : scope === 'global' ? t('Global') : t('Product catalog (read-only)');

    this.setTitle(t('Sample definition'));

    const source = record.source;
    const rows: Array<[string, string]> = [
      [t('Type'), this.type],
      [t('ID'), this.id],
      [t('Alias'), record.alias ?? '-'],
      [t('Location'), record.location ?? '-'],
      // The partbank id is the one key that makes the link usable by hand.
      ...(source
        ? [
            [
              t('partbank'),
              [
                source.kid ?? source.id,
                t(source.type),
                source.connection === 'desktop' ? t('partbank desktop app') : t('partbank server'),
                source.origin,
              ].join(' · '),
            ] as [string, string],
          ]
        : []),
      ...(record.discarded ? [[t('Discarded'), record.discarded] as [string, string]] : []),
      [t('Scope'), scopeLabel],
      [t('File'), jsonPath],
    ];
    for (const [name, value] of rows) {
      // `labnote-sample-def-row` widens the value column; the labels are short
      // but the values (the JSON path above all) are not. Scoped to these rows
      // so the button row below keeps Obsidian's default right alignment.
      new Setting(contentEl)
        .setClass('labnote-sample-def-row')
        .setName(name)
        .addText(text => {
          text.setValue(value).setDisabled(true);
        });
    }
    this.renderDescriptions(contentEl, folder);
    this.renderDefinedIn(contentEl, folder);
    const usagesEl = contentEl.createDiv({ cls: 'labnote-sample-def-section' });
    usagesEl.createEl('h4', { text: t('Usages') });
    void this.renderUsages(usagesEl.createDiv({ cls: 'labnote-sample-def-usages' }), folder);

    const isEditable = scope !== 'catalog';
    const canOpenFile = isEditable && Platform.isDesktopApp;
    if (!isEditable) {
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: t(
          'Samples in a product catalog file ({Type}_name.json) are read-only here. To change one, edit that file, or rename it back to {0} if it was the sample registry.',
          `${this.type}.json`
        ),
      });
    }

    // Up to eight buttons ran off the side of the window in one row (#283).
    const buttons = new Setting(contentEl).setClass('labnote-sample-def-buttons');
    if (isEditable) {
      buttons.addButton(btn =>
        btn
          .setButtonText(t('Edit sample'))
          .setCta()
          .onClick(async () => {
            const ok = await editSampleInteractive(this.app, this.plugin, {
              folder,
              type: this.type,
              id: this.id,
              record,
            });
            if (ok) this.close();
          })
      );
      buttons.addButton(btn =>
        btn.setButtonText(t('Delete sample')).setWarning().onClick(async () => {
          const ok = await deleteSampleInteractive(this.app, this.plugin, {
            folder,
            type: this.type,
            id: this.id,
          });
          if (ok) this.close();
        })
      );
      // #121: reachable from the keyboard through "Open sample definition",
      // unlike the Samples sidebar's context menu.
      const move = this.moveTarget();
      if (move) {
        buttons.addButton(btn =>
          btn.setButtonText(move.label).onClick(async () => {
            const ok = await moveSampleInteractive(this.app, this.plugin, {
              fromScope: scope === 'local' ? 'local' : 'global',
              fromFolder: folder,
              toFolder: move.toFolder,
              type: this.type,
              id: this.id,
            });
            if (ok) this.close();
          })
        );
      }
      if (record.source) {
        const source = record.source;
        buttons.addButton(btn =>
          btn.setButtonText(t('Refresh storage location from partbank')).onClick(async () => {
            const stored = await refreshOneLocation(this.plugin, {
              type: this.type,
              id: this.id,
              folder,
              record,
            });
            if (stored) this.close();
          })
        );
        buttons.addButton(btn =>
          btn
            .setButtonText(t('Open in partbank'))
            .onClick(() => void openInPartbank(this.plugin, source))
        );
      }
      buttons.addButton(btn =>
        btn.setButtonText(t('Change type')).onClick(async () => {
          const ok = await changeSampleTypeInteractive(this.app, this.plugin, {
            folder,
            type: this.type,
            id: this.id,
          });
          if (ok) this.close();
        })
      );
    }
    if (canOpenFile) {
      buttons.addButton(btn =>
        btn.setButtonText(t('Open JSON file')).onClick(() => {
          void (
            this.app as unknown as { openWithDefaultApp(p: string): Promise<void> }
          )
            .openWithDefaultApp(jsonPath)
            .catch(() => new Notice(this.plugin.t('Could not open {0}', jsonPath)));
        })
      );
    }
    buttons.addButton(btn => btn.setButtonText(t('Close')).onClick(() => this.close()));
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  /** A link to a note that closes this window and opens it, at `at` when given. */
  private noteLink(parent: HTMLElement, file: TFile, text: string, at?: { line: number; ch?: number }): void {
    const link = parent.createEl('a', { text, href: '#', cls: 'labnote-sample-def-link' });
    link.addEventListener('click', evt => {
      evt.preventDefault();
      this.close();
      void this.plugin.host.openFile(file.path, at);
    });
  }

  /** A stored note basename as a link when it names one note, else as text. */
  private basenameLink(parent: HTMLElement, basename: string, folder: string): void {
    const file = noteForBasename(this.app, basename, folder);
    if (file) this.noteLink(parent, file, file.basename);
    else parent.createSpan({ text: basename });
  }

  /**
   * Every description, each with the notes whose `@type;` definition put it
   * in (#172). A partbank description runs to 1000 characters (#300), so each
   * gets a textarea sized to it.
   */
  private renderDescriptions(contentEl: HTMLElement, folder: string): void {
    const t = this.plugin.t;
    const descriptions = this.resolved.record.descriptions ?? [];
    const bySource = this.resolved.record.descriptionSources ?? {};
    if (descriptions.length === 0) {
      new Setting(contentEl)
        .setClass('labnote-sample-def-row')
        .setName(t('Description'))
        .addText(text => {
          text.setValue('-').setDisabled(true);
        });
      return;
    }
    descriptions.forEach((value, i) => {
      const row = new Setting(contentEl)
        .setClass('labnote-sample-def-row')
        .setName(descriptions.length > 1 ? t('Description {0}', String(i + 1)) : t('Description'))
        .addTextArea(area => {
          area.setValue(value).setDisabled(true);
          area.inputEl.rows = Math.min(8, Math.max(1, Math.ceil(value.length / 60)));
        });
      const notes = Object.keys(bySource).filter(note => bySource[note] === value);
      if (notes.length === 0) return;
      const desc = row.descEl.createSpan({ text: `${t('From')} ` });
      notes.forEach((note, j) => {
        if (j > 0) desc.appendText(', ');
        this.basenameLink(desc, note, folder);
      });
    });
  }

  /** The notes the registry records as defining the sample (`sources`). */
  private renderDefinedIn(contentEl: HTMLElement, folder: string): void {
    const sources = this.resolved.record.sources ?? [];
    if (sources.length === 0) return;
    const row = new Setting(contentEl).setClass('labnote-sample-def-row').setName(this.plugin.t('Defined in'));
    const list = row.controlEl.createDiv({ cls: 'labnote-sample-def-notes' });
    sources.forEach((note, i) => {
      if (i > 0) list.appendText(', ');
      this.basenameLink(list, note, folder);
    });
  }

  /**
   * The lines that use the sample, grouped by experiment folder (#130, #291).
   * Loaded after the window opens: it reads every note in the sample's scope.
   */
  private async renderUsages(el: HTMLElement, folder: string): Promise<void> {
    const t = this.plugin.t;
    el.setText(t('Loading…'));
    let spots: SampleUsageSpot[];
    try {
      spots = await sampleUsageSpots(this.app, this.plugin, folder, this.type, this.id);
    } catch (err) {
      console.warn('[labnoteo] sample usages failed:', err);
      if (!this.closed) el.setText(t('Could not list the usages.'));
      return;
    }
    if (this.closed) return;
    el.empty();
    if (spots.length === 0) {
      el.setText(t('{0} is not used in any note.', this.id));
      return;
    }
    const groups = new Map<string, SampleUsageSpot[]>();
    for (const spot of spots) {
      const key = getExperimentDir(spot.path) ?? '';
      groups.set(key, [...(groups.get(key) ?? []), spot]);
    }
    // Experiments in folder order, notes outside any experiment last.
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    keys.forEach((key, i) => {
      const list = groups.get(key)!;
      const details = el.createEl('details', { cls: 'labnote-sample-def-usage-group' });
      if (i < OPEN_USAGE_GROUPS) details.open = true;
      const notes = new Set(list.map(s => s.path)).size;
      details.createEl('summary', {
        text: `${key ? posix.basename(key) : t('Outside experiments')} (${t('{0} note(s)', String(notes))})`,
      });
      const ul = details.createEl('ul');
      for (const spot of list) {
        const file = this.app.vault.getAbstractFileByPath(spot.path);
        const li = ul.createEl('li');
        const name = file instanceof TFile ? file.basename : posix.basename(spot.path);
        const text = `${name} · ${usageSpotLabel(t, spot)}`;
        if (file instanceof TFile) this.noteLink(li, file, text, { line: spot.line, ch: spot.ch });
        else li.setText(text);
      }
    });
  }
}
