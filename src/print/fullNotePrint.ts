/**
 * "Print whole note with barcodes": the note rendered as Obsidian renders it,
 * cut into pages between top-level blocks, each page carrying a QR code for
 * the unit operation it starts in (or the note, before the first one).
 *
 * Page breaks are measured off screen at the printed width, so a block never
 * splits across pages unless it is taller than a page by itself (a long table
 * or code block), in which case it is clipped at the page bottom.
 */
import { Component, MarkdownRenderer, TFile } from 'obsidian';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { encodePagePayload, payloadLabel, type PagePayload } from '@labnoteo/core/lib/scanPayload';
import { bodyBox, buildPrintHtml, escapeHtml, openHtmlInBrowser, printHtml, type PrintPage } from './printPages';
import { noteTitleOf, type WorksheetDeps } from './worksheetPrint';

export interface MeasuredBlock {
  top: number;
  bottom: number;
  /** Set when the block is a unit-operation heading. */
  opId?: string;
}

export interface NotePageSlice {
  /** Index range into the blocks, `[from, to)`. */
  from: number;
  to: number;
  /** Unit operation the page starts in: 1-based index and ID, or 0 and ''. */
  unitOpIndex: number;
  opId: string;
}

/**
 * Cut measured blocks into pages of `pageHeight`: a page ends before the
 * block that would overflow it; a unit-operation heading never ends a page.
 */
export function sliceIntoPages(blocks: readonly MeasuredBlock[], pageHeight: number): NotePageSlice[] {
  // The unit operation each block belongs to.
  const opAt: { unitOpIndex: number; opId: string }[] = [];
  let unitOpIndex = 0;
  let opId = '';
  for (const b of blocks) {
    if (b.opId) {
      unitOpIndex++;
      opId = b.opId;
    }
    opAt.push({ unitOpIndex, opId });
  }
  const pages: NotePageSlice[] = [];
  let from = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i === from || blocks[i].bottom - blocks[from].top <= pageHeight) continue;
    // Keep a unit operation's heading with what follows it.
    const cut = i - 1 > from && blocks[i - 1].opId ? i - 1 : i;
    pages.push({ from, to: cut, ...opAt[from] });
    from = cut;
  }
  if (blocks.length > from) pages.push({ from, to: blocks.length, ...opAt[from] });
  return pages;
}

const UNIT_OP_TITLE_RE = /^\s*\[([A-Z]+\d+)\s+[^\]]+\]/;

const stripFrontMatter = (md: string): string => md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');

export async function printFullNoteCommand(deps: WorksheetDeps, file: TFile): Promise<void> {
  const { app, host, t } = deps;
  const noteId = await deps.ensureNoteId(file);
  if (!noteId) return;
  const paper = deps.paper();
  const box = bodyBox(paper);
  const measure = document.body.createDiv({ cls: 'markdown-rendered labnoteo-print-measure' });
  Object.assign(measure.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${box.width}mm`,
    fontSize: '10pt',
    lineHeight: '1.5',
    visibility: 'hidden',
  });
  const component = new Component();
  component.load();
  try {
    await MarkdownRenderer.render(app, stripFrontMatter(await app.vault.read(file)), measure, file.path, component);
    await new Promise(r => window.setTimeout(r, 300));
    const pxPerMm = measure.getBoundingClientRect().width / box.width;
    const children = Array.from(measure.children) as HTMLElement[];
    const blocks: MeasuredBlock[] = children.map(el => {
      const heading = el.matches('h3') ? el : el.querySelector(':scope > h3');
      const opId = heading ? UNIT_OP_TITLE_RE.exec(heading.textContent ?? '')?.[1] : undefined;
      return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, opId };
    });
    const slices = sliceIntoPages(blocks, box.height * pxPerMm);
    if (slices.length === 0) {
      host.notify('info', t('This note is empty.'));
      return;
    }
    const printedOn = getSeoulDateString();
    const title = noteTitleOf(app, file);
    const pages: PrintPage[] = slices.map((s, i) => {
      const payload: PagePayload = {
        noteId,
        unitOpIndex: s.unitOpIndex,
        opId: s.opId,
        page: i + 1,
        pageCount: slices.length,
        printedOn,
      };
      return {
        payload: encodePagePayload(payload),
        label: payloadLabel(payload),
        header:
          `<div class="muted">${escapeHtml(noteId)}</div><div class="title">${escapeHtml(title)}</div>` +
          `<div class="muted">${escapeHtml(t('Page {0} of {1} · printed {2}', String(i + 1), String(slices.length), printedOn))}</div>`,
        body: `<div class="note-body">${children.slice(s.from, s.to).map(el => el.outerHTML).join('')}</div>`,
        footer: escapeHtml(t('Write on this sheet, then photograph or scan it with a QR code visible and put the file in the scan folder.')),
      };
    });
    const html = buildPrintHtml(title, paper, pages);
    try {
      await printHtml(html);
    } catch (err) {
      console.warn('[labnoteo] printing from Obsidian failed, opening in the browser:', err);
      await openHtmlInBrowser(html, `${noteId}_note.html`);
      host.notify('info', t('Printing from Obsidian did not work, so the worksheet opened in your browser. Print it from there.'));
    }
  } finally {
    component.unload();
    measure.remove();
  }
}
