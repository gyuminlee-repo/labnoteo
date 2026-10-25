/**
 * "Assign unmatched scans": pages no note was found for, shown as thumbnails
 * to file by hand (note → unit operation → page) or delete.
 */
import { App, Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import type { LabnoteHost, PickItem, Translator } from '@labnoteo/core';
import { listUnitOpBlocks } from '@labnoteo/core';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { NoteIdService } from '../barcode/noteIdService';
import { unmatchedInfoFromName, UNMATCHED_FOLDER } from './imageStore';
import type { ScanPipeline } from './scanPipeline';
import { describeResult, unmatchedReasonText } from './resultModal';

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

export function listUnmatched(app: App): TFile[] {
  const folder = app.vault.getAbstractFileByPath(UNMATCHED_FOLDER);
  if (!(folder instanceof TFolder)) return [];
  return folder.children
    .filter((f): f is TFile => f instanceof TFile && IMAGE_RE.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "2/3" → page 2 of 3; "2" → page 2 of 2. */
export function parsePageInput(value: string): { page: number; pageCount: number } | undefined {
  const m = /^\s*(\d{1,3})\s*(?:\/\s*(\d{1,3}))?\s*$/.exec(value);
  if (!m) return undefined;
  const page = Number(m[1]);
  const pageCount = m[2] ? Number(m[2]) : page;
  return page >= 1 && pageCount >= page ? { page, pageCount } : undefined;
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isDateInput(value: string): boolean {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export class UnmatchedModal extends Modal {
  constructor(
    app: App,
    private readonly host: LabnoteHost,
    private readonly t: Translator,
    private readonly pipeline: ScanPipeline,
    private readonly noteIds: NoteIdService
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl, t } = this;
    contentEl.empty();
    this.setTitle(t('Assign unmatched scans'));
    const files = listUnmatched(this.app);
    if (files.length === 0) {
      contentEl.createEl('p', { text: t('No unmatched scans.') });
      return;
    }
    contentEl.createEl('p', {
      text: t('These pages could not be filed on their own. Choose the note and unit operation for each, or delete it.'),
    });
    for (const file of files) {
      const row = new Setting(contentEl).setName(file.name);
      const info = unmatchedInfoFromName(file.name);
      if (info.reason) row.descEl.createDiv({ text: unmatchedReasonText(t, info.reason, info.noteId) });
      const img = row.descEl.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: file.name } });
      Object.assign(img.style, { display: 'block', maxWidth: '220px', maxHeight: '220px', marginTop: '4px', cursor: 'zoom-in' });
      img.addEventListener('click', () => window.open(this.app.vault.getResourcePath(file)));
      row
        .addButton(b => b.setButtonText(t('Assign')).setCta().onClick(() => void this.assign(file)))
        .addButton(b =>
          b
            .setButtonText(t('Delete'))
            .setWarning()
            .onClick(async () => {
              await this.app.fileManager.trashFile(file);
              this.render();
            })
        );
    }
  }

  private async assign(file: TFile): Promise<void> {
    const { t, host } = this;
    const info = unmatchedInfoFromName(file.name);
    const hintedFile = info.noteId ? this.noteIds.filesWithId(info.noteId)[0] : undefined;
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter(f => isValidWorkflowPath(f.path))
      .sort((a, b) => (a === hintedFile ? -1 : b === hintedFile ? 1 : a.path.localeCompare(b.path)));
    const note = await host.pick(
      notes.map(f => ({
        label: f.basename.replace(/\.labnote$/, ''),
        description: f === hintedFile ? t('from the QR code') : undefined,
        detail: f.parent?.path,
        value: f,
      })),
      { title: t('Assign to which note?'), placeholder: t('Search workflow notes') }
    );
    if (!note) return;
    const blocks = listUnitOpBlocks(await this.app.vault.read(note));
    const items: PickItem<number>[] = [
      ...blocks.map(b => ({ label: `${b.index}. [${b.opId} ${b.opName}]${b.alias ? ` ${b.alias}` : ''}`, value: b.index })),
      { label: t('The whole note (no unit operation)'), value: 0 },
    ];
    // What the QR code said only holds for the note it named (#349).
    const qr = note === hintedFile ? info.page : undefined;
    const title = t('Assign to which unit operation?');
    let pickTitle = title;
    if (qr && qr.unitOpIndex > 0) {
      // Offered first only while that position still holds the same ID: a
      // block deleted since puts the next one there (#304).
      const at = items.findIndex(i => i.value === qr.unitOpIndex);
      if (at >= 0 && blocks[at]?.opId === qr.opId) {
        const [same] = items.splice(at, 1);
        items.unshift({ ...same, description: t('QR code: unit operation {0}', String(qr.unitOpIndex)) });
      } else {
        pickTitle = `${title} ${t('The QR code says unit operation {0} ({1}).', String(qr.unitOpIndex), qr.opId)}`;
      }
    }
    const unitOp = await host.pick(items, { title: pickTitle });
    if (unitOp === undefined) return;
    const pageText = await host.prompt({
      title: t('Page'),
      prompt: t('Page number on the printout, e.g. 2/3'),
      value: qr ? `${qr.page}/${qr.pageCount}` : '1/1',
      validate: v => (parsePageInput(v) ? null : t('Enter a page like 2/3.')),
    });
    const page = pageText ? parsePageInput(pageText) : undefined;
    if (!page) return;
    const printedText = await host.prompt({
      title: t('Print date'),
      prompt: t('When was this page printed (YYYY-MM-DD)? Leave it empty if you do not know or it was never printed.'),
      value: qr?.printedOn ?? '',
      placeholder: 'YYYY-MM-DD',
      validate: v => (v.trim() === '' || isDateInput(v) ? null : t('Enter a date like 2026-10-15, or leave it empty.')),
    });
    if (printedText === undefined) return;
    const printedOn = printedText.trim() || undefined;
    const result = await this.pipeline.fileManually(file, note, unitOp, page, printedOn);
    new Notice(describeResult(t, result));
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
