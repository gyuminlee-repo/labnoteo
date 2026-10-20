/** "Import scanned pages": drop photos, scanner PDFs or zips, or pick them from disk. */
import { App, Modal, Setting } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import type { ScanInput } from './scanPipeline';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.bmp,.pdf,.zip,.heic,.heif,.tif,.tiff,image/*,application/pdf,application/zip';

export class ImportScansModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly t: Translator,
    private readonly onFiles: (inputs: ScanInput[]) => Promise<void>,
    private readonly onProcessFolder?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, t } = this;
    this.setTitle(t('Import scanned pages'));
    contentEl.createEl('p', {
      text: t('Drop photos or scans of printed worksheets here: JPEG, PNG, PDF (several pages are fine) or a zip of them. Each page is filed in its note by its QR code.'),
    });
    const zone = contentEl.createDiv({ text: t('Drop files here, or click to choose') });
    Object.assign(zone.style, {
      border: '2px dashed var(--background-modifier-border)',
      borderRadius: '8px',
      padding: '40px 16px',
      textAlign: 'center',
      cursor: 'pointer',
      color: 'var(--text-muted)',
    });
    const input = contentEl.createEl('input', { attr: { type: 'file', multiple: 'true', accept: ACCEPT } });
    input.style.display = 'none';
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => void this.take(Array.from(input.files ?? [])));
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.style.borderColor = 'var(--interactive-accent)';
    });
    zone.addEventListener('dragleave', () => (zone.style.borderColor = 'var(--background-modifier-border)'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor = 'var(--background-modifier-border)';
      void this.take(Array.from(e.dataTransfer?.files ?? []));
    });
    if (this.onProcessFolder) {
      const run = this.onProcessFolder;
      new Setting(contentEl)
        .setDesc(t('Files put in the scan folder are picked up on their own every 30 seconds.'))
        .addButton(b =>
          b.setButtonText(t('Process scan folder now')).onClick(() => {
            this.close();
            run();
          })
        );
    }
  }

  private async take(files: File[]): Promise<void> {
    if (this.busy || files.length === 0) return;
    this.busy = true;
    const inputs = await Promise.all(files.map(async f => ({ name: f.name, bytes: await f.arrayBuffer() })));
    this.close();
    await this.onFiles(inputs);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
