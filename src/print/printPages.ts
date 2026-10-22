/**
 * Printable pages with a QR code in two corners (top right, bottom left), so
 * a photo still shows one when a hand or a fold covers the other.
 *
 * Markdown has no pages, and Obsidian's PDF export has no headers or footers,
 * so the pages are laid out here as fixed-size boxes and printed from a
 * hidden iframe — or, when printing from Obsidian does not work, opened in the
 * system browser. Every piece of note text must go through {@link escapeHtml}.
 */
import { Platform } from 'obsidian';
import type { WorksheetPaperSize } from '../settings';
import { qrSvg } from '../barcode/qr';

export interface PrintPage {
  /** QR text (see `scanPayload`). */
  payload: string;
  /** The line under each QR for people. */
  label: string;
  /** Header HTML (already escaped). */
  header: string;
  /** Body HTML (already escaped). */
  body: string;
  /** Footer HTML (already escaped). */
  footer: string;
}

export const PAPER_MM: Record<WorksheetPaperSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
};

/** Distance of the QR codes from the paper edge: clear of what printers cannot reach. */
const QR_INSET_MM = 10;
/** Printed QR size; 2.5 cm or more stays readable in a phone photo of the whole page. */
const QR_SIZE_MM = 26;
/** Smallest type the body shrinks to when it does not fit the page. */
const MIN_SCALE = 0.7;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** The body area of a page, in mm: what the full-note layout measures against. */
export function bodyBox(paper: WorksheetPaperSize): { width: number; height: number; top: number; left: number } {
  const { width, height } = PAPER_MM[paper];
  const top = QR_INSET_MM + QR_SIZE_MM + 8;
  const bottom = QR_INSET_MM + QR_SIZE_MM + 6;
  const side = 14;
  return { width: width - side * 2, height: height - top - bottom, top, left: side };
}

export function pageCss(paper: WorksheetPaperSize): string {
  const { width, height } = PAPER_MM[paper];
  const box = bodyBox(paper);
  return `
@page { size: ${width}mm ${height}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: ${width}mm; height: ${height}mm; overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
@media screen { body { background: #888; } .page { margin: 8mm auto; background: #fff; box-shadow: 0 1mm 4mm rgba(0,0,0,.4); } }
.qr { position: absolute; width: ${QR_SIZE_MM}mm; text-align: center; font: 6.5pt/1.2 ui-monospace, Consolas, monospace; }
.qr svg { display: block; width: ${QR_SIZE_MM}mm; height: ${QR_SIZE_MM}mm; }
.qr.tr { top: ${QR_INSET_MM}mm; right: ${QR_INSET_MM}mm; }
.qr.bl { bottom: ${QR_INSET_MM}mm; left: ${QR_INSET_MM}mm; }
.qr .label { margin-top: 0.8mm; }
.head { position: absolute; top: ${QR_INSET_MM + 2}mm; left: ${box.left}mm; right: ${QR_INSET_MM + QR_SIZE_MM + 6}mm; font-size: 9pt; line-height: 1.35; }
.head .title { font-size: 13pt; font-weight: 700; margin: 1mm 0; }
.head .muted, .foot { color: #444; }
.body { position: absolute; top: ${box.top}mm; left: ${box.left}mm; width: ${box.width}mm; height: ${box.height}mm; overflow: hidden; font-size: 10pt; line-height: 1.5; }
.foot { position: absolute; bottom: ${QR_INSET_MM + 1}mm; left: ${QR_INSET_MM + QR_SIZE_MM + 6}mm; right: ${box.left}mm; font-size: 8pt; line-height: 1.35; }
.sec { margin: 0 0 2.5mm; break-inside: avoid; }
.sec h3 { font-size: 10.5pt; margin: 0 0 1mm; padding-bottom: 0.5mm; border-bottom: 0.3mm solid #000; }
.meta { border-collapse: collapse; width: 100%; }
.meta td { padding: 0.6mm 1mm; vertical-align: bottom; }
.meta td.k { width: 30mm; color: #333; white-space: nowrap; }
.meta td.v { border-bottom: 0.2mm solid #999; }
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { display: flex; gap: 2mm; margin: 0.8mm 0; }
.steps .box { flex: none; width: 3.6mm; height: 3.6mm; margin-top: 0.9mm; border: 0.3mm solid #000; }
.steps .n { flex: none; min-width: 5mm; }
.steps .s { flex: 1 1 auto; min-width: 0; }
.steps .sub { margin: 0.4mm 0 0; padding-left: 5mm; }
.steps .sub li { display: list-item; margin: 0.2mm 0; }
.bul { margin: 0; padding-left: 4mm; }
.bul li { margin: 0.2mm 0; }
.bul li.d1 { margin-left: 4mm; }
.bul li.d2 { margin-left: 8mm; }
.bul li.d3 { margin-left: 12mm; }
.sec .grid { border-collapse: collapse; margin: 0.8mm 0; }
.sec .grid th, .sec .grid td { border: 0.2mm solid #999; padding: 0.4mm 1.4mm; text-align: left; }
.text p { margin: 0; white-space: pre-wrap; }
.note-body img { max-width: 100%; }
.note-body table { border-collapse: collapse; }
.note-body th, .note-body td { border: 0.2mm solid #999; padding: 0.5mm 1.5mm; }
.note-body pre { white-space: pre-wrap; font-size: 8.5pt; }
`;
}

/** Shrink each page body's type until it fits, down to {@link MIN_SCALE}. */
function fitScript(): string {
  return `(${fitBodies.toString()})(document, ${MIN_SCALE});`;
}

export function fitBodies(doc: Document, minScale: number): void {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.body'))) {
    let scale = 1;
    while (el.scrollHeight > el.clientHeight + 1 && scale > minScale) {
      scale = Math.round((scale - 0.05) * 100) / 100;
      el.style.fontSize = `${10 * scale}pt`;
    }
  }
}

export function buildPrintHtml(title: string, paper: WorksheetPaperSize, pages: readonly PrintPage[]): string {
  const pageHtml = pages
    .map(p => {
      const qr = qrSvg(p.payload, p.label);
      const label = `<div class="label">${escapeHtml(p.label)}</div>`;
      return (
        '<section class="page">' +
        `<div class="qr tr">${qr}${label}</div>` +
        `<header class="head">${p.header}</header>` +
        `<main class="body">${p.body}</main>` +
        `<footer class="foot">${p.footer}</footer>` +
        `<div class="qr bl">${qr}${label}</div>` +
        '</section>'
      );
    })
    .join('\n');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title><style>${pageCss(paper)}</style></head>` +
    `<body>${pageHtml}<script>${fitScript()}</script></body></html>`
  );
}

/**
 * Print `html` from a hidden iframe. Resolves once the print dialog closed
 * (or could not open); the iframe is removed afterwards.
 */
export async function printHtml(html: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error('print frame failed to load'));
      iframe.srcdoc = html;
    });
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) throw new Error('print frame has no document');
    await doc.fonts?.ready;
    await waitForImages(doc);
    fitBodies(doc, MIN_SCALE);
    win.focus();
    win.print();
  } finally {
    // print() returns once the dialog closed; keep the frame a moment for spoolers that read it late.
    window.setTimeout(() => iframe.remove(), 2000);
  }
}

async function waitForImages(doc: Document): Promise<void> {
  await Promise.all(
    Array.from(doc.images)
      .filter(img => !img.complete)
      .map(
        img =>
          new Promise<void>(resolve => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
            window.setTimeout(resolve, 5000);
          })
      )
  );
}

/**
 * Write `html` to the system temp folder and open it in the default browser,
 * which prints reliably. Desktop only.
 */
export async function openHtmlInBrowser(html: string, fileName: string): Promise<string> {
  if (!Platform.isDesktopApp) throw new Error('Opening in a browser is only available on desktop.');
  const req = (window as unknown as { require: NodeRequire }).require;
  const fs = req('fs') as typeof import('fs');
  const os = req('os') as typeof import('os');
  const path = req('path') as typeof import('path');
  const file = path.join(os.tmpdir(), fileName.replace(/[\\/:*?"<>|]/g, '_'));
  await fs.promises.writeFile(file, html, 'utf8');
  const electron = req('electron') as { shell?: { openPath(p: string): Promise<string> } };
  const error = electron.shell ? await electron.shell.openPath(file) : 'no shell';
  if (error) window.open(`file://${file.replace(/\\/g, '/')}`);
  return file;
}
