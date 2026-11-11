/** "Show note barcode": the note's QR code and ID, large enough to scan from the screen. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import { encodeNotePayload } from '@labnoteo/core/lib/scanPayload';
import { qrSvg } from './qr';
import { sayFailure } from '../unawaited';

/** What the window can print: a workflow note's worksheet, and any note in full. */
export interface BarcodePrintActions {
  worksheet?: () => void;
  wholeNote: () => void;
}

export class BarcodeModal extends Modal {
  constructor(
    app: App,
    private readonly t: Translator,
    private readonly note: { title: string; id: string },
    private readonly print: BarcodePrintActions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, t, note, print } = this;
    this.setTitle(t('Note barcode'));
    contentEl.createEl('p', { text: note.title });
    const box = contentEl.createDiv({ cls: 'labnoteo-barcode' });
    const svg = new DOMParser().parseFromString(qrSvg(encodeNotePayload(note.id), note.id), 'image/svg+xml');
    box.appendChild(svg.documentElement);
    Object.assign(box.style, { width: '240px', maxWidth: '100%', margin: '0 auto' });
    const label = contentEl.createEl('p', { text: note.id });
    Object.assign(label.style, { textAlign: 'center', fontFamily: 'var(--font-monospace)', fontSize: '1.2em' });
    // Only a workflow note has worksheets; any other note is printed whole (#465).
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: print.worksheet
        ? t('Printed worksheets carry this ID with the unit operation and page, so photos of them find their way back to this note.')
        : t(
            'Pages printed with "{0}" carry this ID and their page number, so photos of them find their way back to this note.',
            t('Print whole note with barcodes')
          ),
    });
    const buttons = new Setting(contentEl).addButton(b =>
      b.setButtonText(t('Copy ID')).onClick(() => sayFailure(async () => {
        await navigator.clipboard.writeText(note.id);
        new Notice(t('Copied {0}.', note.id));
      }))
    );
    const action = (label: string, run: () => void, cta: boolean): void => {
      buttons.addButton(b => {
        b.setButtonText(label).onClick(() => {
          this.close();
          run();
        });
        if (cta) b.setCta();
      });
    };
    action(t('Print whole note with barcodes'), print.wholeNote, !print.worksheet);
    if (print.worksheet) action(t('Print experiment worksheet'), print.worksheet, true);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
