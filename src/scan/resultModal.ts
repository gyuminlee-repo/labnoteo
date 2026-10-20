/** What a batch of scans came to, with undo per filed page. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import { isPagePayload, payloadLabel } from '@labnoteo/core/lib/scanPayload';
import type { ScanPipeline, ScanResult } from './scanPipeline';

/** "12 page(s): 10 filed, 1 unmatched, 1 blank". */
export function summarizeResults(t: Translator, results: readonly ScanResult[]): string {
  const counted = results.filter(r => r.status !== 'skipped');
  const count = (status: ScanResult['status']) => counted.filter(r => r.status === status).length;
  const parts: string[] = [];
  const add = (n: number, key: string) => n > 0 && parts.push(t(key, String(n)));
  add(count('filed'), '{0} filed');
  add(count('duplicate'), '{0} already filed');
  add(count('unmatched'), '{0} unmatched');
  add(count('blank'), '{0} blank');
  add(count('unsupported'), '{0} unsupported');
  add(count('error'), '{0} failed');
  return t('{0} page(s): {1}', String(counted.length), parts.join(', ') || t('nothing to do'));
}

export function describeResult(t: Translator, r: ScanResult): string {
  switch (r.status) {
    case 'filed':
      return t('Filed in {0}', r.notePath ?? '');
    case 'duplicate':
      return t('Already in {0}; skipped', r.notePath ?? '');
    case 'blank':
      return t('Blank page; skipped');
    case 'skipped':
      return t('No worksheet QR code; left alone');
    case 'error':
      return t('Failed: {0}', r.message ?? '');
    case 'unsupported':
      switch (r.reason) {
        case 'heic':
          return t('HEIC photo, which Obsidian cannot open. On iPhone set Settings → Camera → Formats → Most Compatible, or share the photo as JPEG.');
        case 'tiff':
          return t('TIFF scan, which Obsidian cannot open. Set the scanner to save PDF or JPEG.');
        case 'zip-limit':
          return t('Zip too large: only the first files were read (at most 200 files, 500 MB).');
        case 'pdf-limit':
          return t('PDF too long: only the first 50 pages were read.');
        default:
          return t('Not an image, PDF or zip file.');
      }
    case 'unmatched': {
      const why: Record<string, string> = {
        'no-qr': t('No worksheet QR code was found.'),
        'note-not-found': t('No note has the ID {0}.', r.payload?.noteId ?? ''),
        'duplicate-id': t('Several notes share the ID {0}.', r.payload?.noteId ?? ''),
        'note-only': t('The QR code names the note but no unit operation.'),
        'no-unit-op': t('The unit operation it was printed from is no longer in the note.'),
        ambiguous: t('The note has several unit operations it could belong to.'),
      };
      return `${why[r.reason ?? 'no-qr'] ?? ''} ${t('Assign it with "{0}".', t('Assign unmatched scans'))}`;
    }
  }
}

export class ScanResultModal extends Modal {
  constructor(
    app: App,
    private readonly t: Translator,
    private readonly pipeline: ScanPipeline,
    private readonly results: ScanResult[],
    private readonly actions: { openNote(path: string): void; openUnmatched(): void }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, t } = this;
    this.setTitle(t('Scan results'));
    contentEl.createEl('p', { text: summarizeResults(t, this.results) });
    for (const r of this.results.filter(x => x.status !== 'skipped')) {
      const name = r.sourcePage ? `${r.source} (p.${r.sourcePage})` : r.source;
      const label = r.payload ? ` — ${payloadLabel(r.payload)}` : '';
      const row = new Setting(contentEl).setName(name + label).setDesc(describeResult(t, r));
      if (r.notePath && (r.status === 'filed' || r.status === 'duplicate')) {
        const path = r.notePath;
        row.addButton(b => b.setButtonText(t('Open note')).onClick(() => this.actions.openNote(path)));
      }
      if (r.status === 'filed' && r.previous?.length && r.payload && isPagePayload(r.payload)) {
        row.addButton(b =>
          b
            .setButtonText(t('Delete earlier scan'))
            .setTooltip(t('This page was filed before; remove the earlier scan and its image.'))
            .onClick(async () => {
              const n = await this.pipeline.removePrevious(r);
              new Notice(t('Removed {0} earlier scan(s).', String(n)));
              b.setDisabled(true);
            })
        );
      }
      if (r.status === 'filed') {
        row.addButton(b =>
          b
            .setButtonText(t('Undo'))
            .setWarning()
            .onClick(async () => {
              const ok = await this.pipeline.undo(r);
              r.status = 'skipped';
              new Notice(ok ? t('Removed the scan from {0}.', r.notePath ?? '') : t('The scan was no longer in the note.'));
              row.setDesc(t('Undone'));
              row.controlEl.empty();
            })
        );
      }
    }
    if (this.results.some(r => r.status === 'unmatched')) {
      new Setting(contentEl).addButton(b =>
        b
          .setButtonText(t('Assign unmatched scans'))
          .setCta()
          .onClick(() => {
            this.close();
            this.actions.openUnmatched();
          })
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
