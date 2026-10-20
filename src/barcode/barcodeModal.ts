/** "Show note barcode": the note's QR code and ID, large enough to scan from the screen. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import { encodeNotePayload } from '@labnoteo/core/lib/scanPayload';
import { qrSvg } from './qr';

export class BarcodeModal extends Modal {
  constructor(
    app: App,
    private readonly t: Translator,
    private readonly note: { title: string; id: string },
    private readonly onPrint?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, t, note } = this;
    this.setTitle(t('Note barcode'));
    contentEl.createEl('p', { text: note.title });
    const box = contentEl.createDiv({ cls: 'labnoteo-barcode' });
    const svg = new DOMParser().parseFromString(qrSvg(encodeNotePayload(note.id), note.id), 'image/svg+xml');
    box.appendChild(svg.documentElement);
    Object.assign(box.style, { width: '240px', maxWidth: '100%', margin: '0 auto' });
    const label = contentEl.createEl('p', { text: note.id });
    Object.assign(label.style, { textAlign: 'center', fontFamily: 'var(--font-monospace)', fontSize: '1.2em' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('Printed worksheets carry this ID with the unit operation and page, so photos of them find their way back to this note.'),
    });
    const buttons = new Setting(contentEl).addButton(b =>
      b.setButtonText(t('Copy ID')).onClick(async () => {
        await navigator.clipboard.writeText(note.id);
        new Notice(t('Copied {0}.', note.id));
      })
    );
    if (this.onPrint) {
      const print = this.onPrint;
      buttons.addButton(b =>
        b
          .setButtonText(t('Print experiment worksheet'))
          .setCta()
          .onClick(() => {
            this.close();
            print();
          })
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
