/**
 * What the QR code on a printed page says: which note and which unit operation
 * the page belongs to, so a photo of it can be filed without any record of the
 * print job. The text stays short (a version-4 QR at level Q) to remain
 * readable from a phone photo at 2.5 cm.
 *
 *   LN1:LN-7K3M9QX2                         the note (screen QR, label)
 *   LN1:LN-7K3M9QX2:3:UHW010:2/3:261015     3rd unit op (UHW010), page 2 of 3, printed 2026-10-15
 *   LN1:LN-7K3M9QX2:0:-:1/5:261015          a full-note page before the first unit op
 */
import { isValidNoteId } from './noteId';

export interface NotePayload {
  noteId: string;
}

export interface PagePayload extends NotePayload {
  /** 1-based position among the note's unit operations when printed; 0 for none. */
  unitOpIndex: number;
  /** The unit operation's ID (`UHW010`), or '' with `unitOpIndex` 0. */
  opId: string;
  page: number;
  pageCount: number;
  /** `YYYY-MM-DD`. */
  printedOn: string;
}

export type ScanPayload = NotePayload | PagePayload;

const PREFIX = 'LN1';
const PAGE_RE =
  /^LN1:(LN-[0-9A-HJKMNP-TV-Z]{8})(?::(\d{1,3}):([A-Z]+\d+|-):(\d{1,3})\/(\d{1,3}):(\d{2})(\d{2})(\d{2}))?$/;

export function isPagePayload(p: ScanPayload): p is PagePayload {
  return typeof (p as PagePayload).page === 'number';
}

export function encodeNotePayload(noteId: string): string {
  return `${PREFIX}:${noteId}`;
}

export function encodePagePayload(p: PagePayload): string {
  const [y, m, d] = p.printedOn.split('-');
  const date = `${y.slice(2)}${m}${d}`;
  const opId = p.unitOpIndex > 0 && p.opId ? p.opId : '-';
  return `${PREFIX}:${p.noteId}:${p.unitOpIndex}:${opId}:${p.page}/${p.pageCount}:${date}`;
}

/** The payload in a decoded QR text, or undefined when it is not one of ours. */
export function decodeScanPayload(text: string): ScanPayload | undefined {
  const m = PAGE_RE.exec(text.trim());
  if (!m || !isValidNoteId(m[1])) return undefined;
  if (m[2] === undefined) return { noteId: m[1] };
  const unitOpIndex = Number(m[2]);
  const page = Number(m[4]);
  const pageCount = Number(m[5]);
  if (page < 1 || pageCount < page) return undefined;
  if ((unitOpIndex === 0) !== (m[3] === '-')) return undefined;
  return {
    noteId: m[1],
    unitOpIndex,
    opId: m[3] === '-' ? '' : m[3],
    page,
    pageCount,
    printedOn: `20${m[6]}-${m[7]}-${m[8]}`,
  };
}

/** The line printed under each QR so a person can read it too. */
export function payloadLabel(p: ScanPayload): string {
  if (!isPagePayload(p)) return p.noteId;
  const parts = [p.noteId];
  if (p.opId) parts.push(p.opId);
  parts.push(`${p.page}/${p.pageCount}`);
  return parts.join(' · ');
}
