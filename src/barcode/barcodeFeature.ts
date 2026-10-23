/**
 * Note barcodes, printed worksheets and scan filing, wired into the plugin:
 * commands, the QR icon in a lab note's header, the scan folder, the unmatched
 * queue, and taking a note's scans along when it moves to another experiment.
 */
import { MarkdownView, Notice, Platform, TFile, TFolder, type App } from 'obsidian';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from '../main';
import { NoteIdService } from './noteIdService';
import { BarcodeModal } from './barcodeModal';
import { noteTitleOf, printWorksheetCommand, type WorksheetDeps } from '../print/worksheetPrint';
import { printFullNoteCommand } from '../print/fullNotePrint';
import { createPcStore, type PcStore } from '../scan/pcStore';
import { ScanPipeline, type ScanInput, type ScanResult } from '../scan/scanPipeline';
import { createPageDecoder } from '../scan/pageDecoder';
import { ScanFolderWatcher, POLL_MS } from '../scan/scanFolderWatcher';
import { ImportScansModal } from '../scan/importModal';
import { ScanResultModal, summarizeResults } from '../scan/resultModal';
import { UnmatchedModal, listUnmatched } from '../scan/unmatchedModal';
import { isScanOfNote, SCANS_SUBFOLDER } from '../scan/imageStore';
import { SlackInbox } from '../scan/slack';

/** Notes that get a barcode: lab notes (`*.labnote.md`). */
export const isBarcodeNote = (path: string): boolean => path.toLowerCase().endsWith('.labnote.md');

/**
 * Which of a note's scans (by name in the old experiment's scans folder) move
 * along to the new one, and which stay because the name is taken there.
 */
export function planScanMoves(
  names: readonly string[],
  noteId: string,
  takenInTarget: ReadonlySet<string>
): { move: string[]; keep: string[] } {
  const own = names.filter(n => isScanOfNote(n, noteId));
  return { move: own.filter(n => !takenInTarget.has(n)), keep: own.filter(n => takenInTarget.has(n)) };
}

export class BarcodeFeature {
  readonly noteIds: NoteIdService;
  readonly pipeline: ScanPipeline;
  readonly store: PcStore;
  readonly watcher?: ScanFolderWatcher;
  readonly slack: SlackInbox;
  private readonly headerActions = new Map<MarkdownView, HTMLElement>();
  private busy = false;

  constructor(
    private readonly plugin: LabnotePlugin,
    private readonly paletteName: (key: string) => string
  ) {
    const { app, host } = plugin;
    this.noteIds = new NoteIdService(app, host);
    this.store = createPcStore(app);
    this.pipeline = new ScanPipeline({
      app,
      host,
      t: plugin.t,
      noteIds: this.noteIds,
      decoder: createPageDecoder(() => ({
        maxEdge: plugin.settings.scanMaxImageEdge,
        quality: plugin.settings.scanJpegQuality,
      })),
      embedWidth: () => plugin.settings.scanEmbedWidth,
      markUserEdit: path => plugin.markUserEdit(path),
    });
    if (Platform.isDesktopApp) {
      const req = (window as unknown as { require: NodeRequire }).require;
      this.watcher = new ScanFolderWatcher(
        {
          store: this.store,
          t: plugin.t,
          run: (inputs, opts) => this.runWithProgress(inputs, opts.skipNoQr ?? false, false),
          report: (results, manual) => this.report(results, manual),
          notify: message => new Notice(message),
        },
        { fs: req('fs'), path: req('path') }
      );
    }
    this.slack = new SlackInbox({
      store: this.store,
      t: plugin.t,
      run: inputs => this.runWithProgress(inputs, false, false),
      summarize: results => summarizeResults(plugin.t, results),
      notify: message => new Notice(message),
      report: results => this.report(results, false),
    });
  }

  private get app(): App {
    return this.plugin.app;
  }
  private get host(): LabnoteHost {
    return this.plugin.host;
  }
  private get t(): Translator {
    return this.plugin.t;
  }

  register(): void {
    const { plugin } = this;
    plugin.addCommand({
      id: 'show-note-barcode',
      name: this.paletteName('Show note barcode'),
      checkCallback: checking => this.withActiveNote(checking, file => this.showBarcode(file)),
    });
    plugin.addCommand({
      id: 'assign-note-id',
      name: this.paletteName('Assign note ID'),
      checkCallback: checking => this.withActiveNote(checking, file => this.assignId(file)),
    });
    plugin.addCommand({
      id: 'print-experiment-worksheet',
      name: this.paletteName('Print experiment worksheet'),
      checkCallback: checking =>
        this.withActiveNote(checking, file => printWorksheetCommand(this.worksheetDeps(), file), isValidWorkflowPath),
    });
    plugin.addCommand({
      id: 'print-whole-note',
      name: this.paletteName('Print whole note with barcodes'),
      checkCallback: checking => this.withActiveNote(checking, file => printFullNoteCommand(this.worksheetDeps(), file)),
    });
    plugin.addCommand({
      id: 'import-scanned-pages',
      name: this.paletteName('Import scanned pages'),
      callback: () => this.openImport(),
    });
    plugin.addCommand({
      id: 'process-scan-folder',
      name: this.paletteName('Process scan folder now'),
      checkCallback: checking => {
        if (!this.watcher) return false;
        if (!checking) this.processFolderNow();
        return true;
      },
    });
    plugin.addCommand({
      id: 'assign-unmatched-scans',
      name: this.paletteName('Assign unmatched scans'),
      callback: () => this.openUnmatched(),
    });
    plugin.addRibbonIcon('scan-line', this.t('Import scanned pages'), () => this.openImport());

    plugin.registerEvent(this.app.workspace.on('layout-change', () => this.refreshHeaderActions()));
    plugin.registerEvent(this.app.workspace.on('file-open', () => this.refreshHeaderActions()));
    plugin.register(() => this.removeHeaderActions());

    this.app.workspace.onLayoutReady(() => {
      this.refreshHeaderActions();
      this.watcher?.start();
      this.slack.start();
      // Once the metadata cache has every note, look for IDs copied along with a note.
      const check = () => this.run(() => this.noteIds.offerDuplicateFixes());
      if ((this.app.metadataCache as unknown as { resolved?: boolean }).resolved) check();
      else {
        const ref = this.app.metadataCache.on('resolved', () => {
          this.app.metadataCache.offref(ref);
          check();
        });
        plugin.registerEvent(ref);
      }
    });
    plugin.registerEvent(
      this.app.metadataCache.on('changed', file => {
        if (!isBarcodeNote(file.path) || !this.noteIds.idOf(file)) return;
        // A copied experiment renews its notes' IDs itself; asking as well gave the copy two (#265).
        if (this.plugin.isRenewingCopiedNoteId(file.path)) return;
        if (this.noteIds.filesWithId(this.noteIds.idOf(file)!).length > 1) {
          this.run(() => this.noteIds.offerDuplicateFixes());
        }
      })
    );
    if (this.watcher) {
      const watcher = this.watcher;
      plugin.registerInterval(window.setInterval(() => void watcher.tick(), POLL_MS));
      plugin.register(() => watcher.stop());
    }
    plugin.registerInterval(window.setInterval(() => void this.slack.poll(), this.slack.pollMs));
    plugin.register(() => this.slack.stop());
  }

  private run(fn: () => Promise<unknown>): void {
    fn().catch(err => {
      console.error('[labnoteo] barcode/scan action failed:', err);
      this.host.notify('error', this.t('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    });
  }

  private withActiveNote(
    checking: boolean,
    action: (file: TFile) => Promise<void>,
    accepts: (path: string) => boolean = isBarcodeNote
  ): boolean {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !accepts(file.path)) return false;
    if (!checking) this.run(() => action(file));
    return true;
  }

  worksheetDeps(): WorksheetDeps {
    return {
      app: this.app,
      host: this.host,
      t: this.t,
      paper: () => this.plugin.settings.worksheetPaperSize,
      setPaper: async paper => {
        this.plugin.settings.worksheetPaperSize = paper;
        await this.plugin.saveSettings();
      },
      ensureNoteId: file => this.noteIds.ensureId(file),
    };
  }

  async showBarcode(file: TFile): Promise<void> {
    const id = await this.noteIds.ensureId(file);
    if (!id) return;
    const onPrint = isValidWorkflowPath(file.path)
      ? () => this.run(() => printWorksheetCommand(this.worksheetDeps(), file))
      : undefined;
    new BarcodeModal(this.app, this.t, { title: noteTitleOf(this.app, file), id }, onPrint).open();
  }

  private async assignId(file: TFile): Promise<void> {
    const current = readNoteId(await this.app.vault.read(file));
    if (current) {
      const others = this.noteIds.filesWithId(current).filter(f => f.path !== file.path);
      if (others.length === 0) {
        this.host.notify('info', this.t('This note already has the note ID {0}.', current));
        return;
      }
      const ok = await this.host.confirm(
        this.t('{0} also has the note ID {1}. Give this note a new ID?', others.map(f => f.path).join(', '), current),
        { confirmLabel: this.t('Give a new ID') }
      );
      if (!ok) return;
    }
    const id = await this.noteIds.ensureId(file, { reassign: !!current });
    if (id) this.host.notify('info', this.t('{0} now has the note ID {1}.', file.basename, id));
  }

  /** Copies made in Obsidian get their own ID right away, like their issue markers. */
  async reassignCopiedId(file: TFile): Promise<void> {
    if (!readNoteId(await this.app.vault.read(file))) return;
    const id = await this.noteIds.ensureId(file, { reassign: true });
    if (id) this.host.notify('info', this.t('Gave the copy {0} its own note ID {1}.', file.basename, id));
  }

  // --- scans -------------------------------------------------------------

  openImport(): void {
    new ImportScansModal(
      this.app,
      this.t,
      async inputs => {
        const results = await this.runWithProgress(inputs, false, true);
        this.report(results, true);
      },
      this.watcher ? () => this.processFolderNow() : undefined
    ).open();
  }

  processFolderNow(includeExisting = false): void {
    this.run(async () => {
      await this.watcher?.tick({ manual: true, includeExisting });
    });
  }

  openUnmatched(): void {
    new UnmatchedModal(this.app, this.host, this.t, this.pipeline, this.noteIds).open();
  }

  private async runWithProgress(inputs: ScanInput[], skipNoQr: boolean, manual: boolean): Promise<ScanResult[]> {
    while (this.busy) await new Promise(r => window.setTimeout(r, 500));
    this.busy = true;
    const notice = manual || !skipNoQr ? new Notice(this.t('Processing scans…'), 0) : undefined;
    try {
      return await this.pipeline.run(inputs, {
        skipNoQr,
        onProgress: (done, label) => notice?.setMessage(this.t('Processing scans… {0} page(s) done ({1})', String(done), label)),
      });
    } finally {
      notice?.hide();
      this.busy = false;
    }
  }

  private report(results: ScanResult[], manual: boolean): void {
    const shown = results.filter(r => r.status !== 'skipped');
    if (shown.length === 0) {
      if (manual && results.length > 0) new Notice(this.t('No worksheet pages were found.'));
      return;
    }
    const open = () =>
      new ScanResultModal(this.app, this.t, this.pipeline, results, {
        openNote: path => void this.host.openFile(path),
        openUnmatched: () => this.openUnmatched(),
      }).open();
    if (manual) {
      open();
      return;
    }
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: `${this.t('Scans')}: ${summarizeResults(this.t, results)} ` });
    const link = frag.createEl('a', { text: this.t('Details'), href: '#' });
    const notice = new Notice(frag, 15000);
    link.addEventListener('click', e => {
      e.preventDefault();
      notice.hide();
      open();
    });
  }

  unmatchedCount(): number {
    return listUnmatched(this.app).length;
  }

  /**
   * A workflow note moved to another experiment: move its scans
   * (`images/scans/<labnote_id>_*`) along, like its table CSVs.
   */
  async moveScansWithNote(newPath: string, fromDir: string, toDir: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(newPath);
    if (!(file instanceof TFile)) return;
    const noteId = readNoteId(await this.app.vault.read(file));
    if (!noteId) return;
    const fromExp = getExperimentDir(posix.join(fromDir, 'x.md')) ?? fromDir;
    const toExp = getExperimentDir(newPath) ?? toDir;
    if (fromExp === toExp) return;
    const source = this.app.vault.getAbstractFileByPath(posix.join(fromExp, SCANS_SUBFOLDER));
    if (!(source instanceof TFolder)) return;
    const targetDir = posix.join(toExp, SCANS_SUBFOLDER);
    const target = this.app.vault.getAbstractFileByPath(targetDir);
    const taken = new Set(target instanceof TFolder ? target.children.map(c => c.name) : []);
    const { move, keep } = planScanMoves(
      source.children.filter(c => c instanceof TFile).map(c => c.name),
      noteId,
      taken
    );
    if (move.length === 0 && keep.length === 0) return;
    if (move.length > 0 && !target) await this.app.vault.createFolder(targetDir).catch(() => undefined);
    let moved = 0;
    for (const name of move) {
      const img = this.app.vault.getAbstractFileByPath(posix.join(fromExp, SCANS_SUBFOLDER, name));
      if (!(img instanceof TFile)) continue;
      try {
        await this.app.fileManager.renameFile(img, posix.join(targetDir, name));
        moved++;
      } catch (err) {
        console.warn('[labnoteo] could not move scan', name, err);
      }
    }
    if (moved > 0) this.host.notify('info', this.t('Moved {0} scan image(s) to {1} with the note.', String(moved), targetDir));
    const left = keep.length + (move.length - moved);
    if (left > 0) {
      this.host.notify(
        'warn',
        this.t('{0} scan image(s) stayed in {1}: a file with the same name is already in {2}, or the move failed.', String(left), posix.join(fromExp, SCANS_SUBFOLDER), targetDir)
      );
    }
  }

  // --- header action -------------------------------------------------------

  private refreshHeaderActions(): void {
    const live = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      live.add(view);
      const wanted = !!view.file && isBarcodeNote(view.file.path);
      const el = this.headerActions.get(view);
      if (wanted && !el) {
        const action = view.addAction('qr-code', this.t('Show note barcode'), () => {
          if (view.file) this.run(() => this.showBarcode(view.file!));
        });
        this.headerActions.set(view, action);
      } else if (!wanted && el) {
        el.remove();
        this.headerActions.delete(view);
      }
    }
    for (const [view, el] of this.headerActions) {
      if (live.has(view)) continue;
      el.remove();
      this.headerActions.delete(view);
    }
  }

  private removeHeaderActions(): void {
    for (const el of this.headerActions.values()) el.remove();
    this.headerActions.clear();
  }
}
