/**
 * "Go to definition" popup for a sample reference in the editor.
 *
 * Registry-first: a sample's definition (alias/description) lives in JSON, not
 * in the document. This modal shows the resolved record (local/global registry
 * or the read-only catalog) and offers edit/delete/open-file actions.
 */
import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from './main';
import { isSameSampleFolder, noteLocalSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import {
  editSampleInteractive,
  deleteSampleInteractive,
  changeSampleTypeInteractive,
  moveSampleInteractive,
  resolveSampleDefinition,
  type ResolvedSampleDefinition,
} from './sampleActions';

/**
 * Resolve `(type, id)` then show the definition popup (or a Notice if absent).
 * `resolved` skips the lookup when the caller already knows the record.
 */
export async function openSampleDefinition(
  app: App,
  plugin: LabnotePlugin,
  opts: { type: string; id: string; docPath: string; resolved?: ResolvedSampleDefinition }
): Promise<void> {
  const resolved = opts.resolved ?? (await resolveSampleDefinition(plugin, opts));
  if (!resolved) {
    new Notice(plugin.t('No definition found for {0}', opts.id));
    return;
  }
  new SampleDefinitionModal(app, plugin, opts.type, opts.id, opts.docPath, resolved).open();
}

class SampleDefinitionModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: LabnotePlugin,
    private readonly type: string,
    private readonly id: string,
    private readonly docPath: string,
    private readonly resolved: ResolvedSampleDefinition
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
    const local = this.docPath ? noteLocalSampleFolder(this.docPath, globalFolder) : undefined;
    if (!local || isSameSampleFolder(local, folder)) return undefined;
    return { toFolder: local, label: this.plugin.t('Move to Local') };
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.plugin.t;
    const { scope, folder, record } = this.resolved;
    const jsonPath = posix.join(folder, `${this.type}.json`);

    this.setTitle(t('Sample definition'));

    const rows: Array<[string, string]> = [
      [t('Type'), this.type],
      [t('ID'), this.id],
      [t('Alias'), record.alias ?? '-'],
      [t('Description'), record.descriptions?.[0] ?? '-'],
      [t('Location'), record.location ?? '-'],
      ...(record.discarded ? [[t('Discarded'), record.discarded] as [string, string]] : []),
      [t('Scope'), scope],
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

    const isEditable = scope !== 'catalog';
    const canOpenFile = isEditable && Platform.isDesktopApp;

    const buttons = new Setting(contentEl);
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
    this.contentEl.empty();
  }
}
