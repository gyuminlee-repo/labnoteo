/** What a batch of scans came to, with undo per filed page. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import { isPagePayload, payloadLabel } from '@labnoteo/core/lib/scanPayload';
import type { ScanPipeline, ScanResult } from './scanPipeline';
import { guardScanAction } from './actionGuard';

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
    case 'filed': {
      const where = r.block ? `${r.notePath ?? ''} › ${r.block}` : (r.notePath ?? '');
      const placed = r.replacedMissing
        ? `${t('Filed in {0}', where)} ${t('The note already had this scan, but its image was deleted, so it was filed again in its place.')}`
        : t('Filed in {0}', where);
      const filed = r.uncertain
        ? `${placed} ${t('{0} may or may not have the change: it was being saved when another change reached it. Check the note before trying again.', r.notePath ?? '')}`
        : placed;
      if (r.legacy) {
        return `${filed} ${t('This printout is from before 0.123.0 and does not say which block it is, so check that it went to the right one.')}`;
      }
      if (r.matchedBy && r.matchedBy !== 'index') {
        return `${filed} ${t('The block is no longer where it was printed from, so check that the scan went to the right one.')}`;
      }
      return filed;
    }
    case 'duplicate':
      return t('Already in {0}; skipped', r.notePath ?? '');
    case 'blank':
      return t('Blank page; skipped');
    case 'skipped':
      if (r.reason === 'cancelled') return t('Cancelled; the scan is still waiting to be assigned.');
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
    case 'unmatched':
      return `${unmatchedReasonText(t, r.reason ?? 'no-qr', r.payload?.noteId)} ${t('Assign it with "{0}".', t('Assign unmatched scans'))}`;
  }
}

/** Why a page was not filed, for the result and the assignment window (#342). */
export function unmatchedReasonText(t: Translator, reason: string, noteId = ''): string {
  const why: Record<string, string> = {
    'no-qr': t('No worksheet QR code was found.'),
    'note-not-found': t('No note has the ID {0}.', noteId),
    'duplicate-id': t('Several notes share the ID {0}.', noteId),
    'note-only': t('The QR code names the note but no unit operation.'),
    'no-unit-op': t('The unit operation it was printed from is no longer in the note.'),
    ambiguous: t('The note has several unit operations it could belong to.'),
    // A fingerprint no block has: deleted and renamed look the same.
    renamed: t(
      'The unit operation it was printed from was deleted, or its title or alias changed since, so it is unclear which block it belongs to.'
    ),
  };
  return why[reason] ?? '';
}

/**
 * What a click on a result's undo or "delete earlier scan" says, and whether it is done (its
 * button goes): a note not written, or that may not have been, keeps the button to try again.
 */
export async function undoScanResult(
  t: Translator,
  pipeline: Pick<ScanPipeline, 'undo' | 'removePrevious'>,
  r: ScanResult,
  earlier: boolean,
  shown?: readonly string[]
): Promise<{ message: string; done: boolean }> {
  const out = earlier ? await pipeline.removePrevious(r, shown) : await pipeline.undo(r);
  const path = r.notePath ?? '';
  if (out === 'uncertain') {
    return { done: false, message: t('{0} may or may not have the change: it was being saved when another change reached it. Check the note before trying again.', path) };
  }
  if (out === 'notWritten') {
    return { done: false, message: t('{0} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.', path) };
  }
  if (typeof out === 'object') {
    // What was done, both counts: the entries out of the note and the images moved to the trash.
    return {
      done: true,
      message:
        out.removed === out.trashed
          ? t('Removed {0} earlier scan(s).', String(out.removed))
          : t('Removed {0} earlier scan(s) from the note and moved {1} image(s) to the trash.', String(out.removed), String(out.trashed)),
    };
  }
  return { done: true, message: out ? t('Removed the scan from {0}.', path) : t('The scan was no longer in the note.') };
}

/**
 * The question before "Delete earlier scan" (#576): the images that go to the trash, by name,
 * and apart from them the ones that stay because the note still links them elsewhere, or
 * because the note could not be read (`unreadable`) and so none can be known to be unlinked.
 */
export function earlierScanQuestion(
  t: Translator,
  plan: { trash: readonly { name: string }[]; kept: readonly { name: string }[]; unreadable?: boolean }
): string {
  const names = (files: readonly { name: string }[]): string => files.map(f => `- ${f.name}`).join('\n');
  const kept = String(plan.kept.length);
  return [
    t('Delete the earlier scan of this page? Its entry leaves the note.'),
    plan.unreadable
      ? t('The note could not be read, so no image goes to the trash.')
      : plan.trash.length > 0
        ? `${t('These images go to the trash:')}\n${names(plan.trash)}`
        : t('No image goes to the trash.'),
    ...(plan.kept.length > 0
      ? [
          `${plan.unreadable
            ? t('{0} image(s) stay, as the note could not be read:', kept)
            : t('{0} image(s) stay, as the note still links them elsewhere:', kept)}\n${names(plan.kept)}`,
        ]
      : []),
  ].join('\n\n');
}

/**
 * "Delete earlier scan": asks with {@link earlierScanQuestion} as the note is now, then removes
 * as {@link undoScanResult} says; undefined when the answer was no and nothing was done.
 */
export async function deleteEarlierScan(
  t: Translator,
  pipeline: Pick<ScanPipeline, 'previousImagesPlan' | 'removePrevious' | 'undo'>,
  r: ScanResult,
  confirmDelete: (message: string) => Promise<boolean>
): Promise<{ message: string; done: boolean } | undefined> {
  const plan = await pipeline.previousImagesPlan(r);
  if (!(await confirmDelete(earlierScanQuestion(t, plan)))) return undefined;
  // Only the images the question named as going to the trash may go (#576).
  return undoScanResult(t, pipeline, r, true, plan.trash.map(image => image.path));
}

export class ScanResultModal extends Modal {
  constructor(
    app: App,
    private readonly t: Translator,
    private readonly pipeline: ScanPipeline,
    private readonly results: ScanResult[],
    private readonly actions: {
      openNote(path: string, hash?: string): void;
      openUnmatched(): void;
      /** Ask before something is trashed; true to go ahead. */
      confirmDelete(message: string): Promise<boolean>;
    }
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
        row.addButton(b =>
          b.setButtonText(t('Open note')).onClick(() => {
            this.close();
            this.actions.openNote(path, r.hash);
          })
        );
      }
      if (r.status === 'filed' && r.previous?.length && r.payload && isPagePayload(r.payload)) {
        row.addButton(b =>
          b
            .setButtonText(t('Delete earlier scan'))
            .setTooltip(t('This page was filed before; remove the earlier scan and its image.'))
            .onClick(() =>
              void guardScanAction(t, async () => {
                const out = await deleteEarlierScan(t, this.pipeline, r, message => this.actions.confirmDelete(message));
                if (!out) return;
                const { message, done } = out;
                new Notice(message);
                // Done: nothing earlier is left to delete, so the button goes.
                if (done) b.buttonEl.remove();
              })
            )
        );
      }
      if (r.status === 'filed') {
        row.addButton(b =>
          b
            .setButtonText(t('Undo'))
            .setWarning()
            .onClick(() =>
              void guardScanAction(t, async () => {
                const { message, done } = await undoScanResult(t, this.pipeline, r, false);
                new Notice(message);
                if (!done) return;
                r.status = 'skipped';
                row.setDesc(t('Undone'));
                row.controlEl.empty();
              })
            )
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
