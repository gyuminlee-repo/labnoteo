/**
 * Pages of a scanned PDF (a multifunction printer's usual output) as images,
 * rendered with the pdf.js that ships inside Obsidian — no extra library.
 */
import { loadPdfJs } from 'obsidian';

/** Rendering resolution: enough for the QR and for reading handwriting back. */
const PDF_DPI = 200;
/** A scan job longer than this is more likely a mistake than a stack of worksheets. */
export const MAX_PDF_PAGES = 50;

interface PdfJs {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

export interface PdfPageImage {
  /** 1-based. */
  page: number;
  pageCount: number;
  bitmap: ImageBitmap;
}

/**
 * Render each page in turn, handing it to `onPage` before rendering the next,
 * so a long scan never holds every page in memory. Pages past
 * {@link MAX_PDF_PAGES} are left out; the return value is the page count.
 */
export async function forEachPdfPage(
  bytes: ArrayBuffer,
  onPage: (page: PdfPageImage) => Promise<void>
): Promise<{ pageCount: number; skipped: number }> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  try {
    const pageCount = doc.numPages;
    const last = Math.min(pageCount, MAX_PDF_PAGES);
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: PDF_DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const bitmap = await createImageBitmap(canvas);
      canvas.width = canvas.height = 0;
      await onPage({ page: n, pageCount, bitmap });
    }
    return { pageCount, skipped: pageCount - last };
  } finally {
    await doc.destroy();
  }
}
