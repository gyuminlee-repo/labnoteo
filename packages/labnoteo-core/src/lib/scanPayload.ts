/**
 * What the QR code on a printed page says: which note and which unit operation
 * the page belongs to, so a photo of it can be filed without any record of the
 * print job. The text stays short (a version-4 QR at level Q) to remain
 * readable from a phone photo at 2.5 cm.
 *
 *   LN1:LN-7K3M9QX2                         the note (screen QR, label)
 *   LN1:LN-7K3M9QX2:3:UHW010:2/3:261015:K7QD  3rd unit op (UHW010), page 2 of 3, printed 2026-10-15,
 *                                             block fingerprint K7QD
 *   LN1:LN-7K3M9QX2:0:-:1/5:261015          a full-note page before the first unit op
 *
 * Pages printed before 0.123.0 carry no fingerprint and still decode.
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
  /**
   * {@link unitOpFingerprint} of the unit operation's name and alias when
   * printed, telling apart blocks of the same ID (#304). Absent on pages
   * before the first unit operation and on older printouts.
   */
  fingerprint?: string;
}

export type ScanPayload = NotePayload | PagePayload;

const PREFIX = 'LN1';
const PAGE_RE =
  /^LN1:(LN-[0-9A-HJKMNP-TV-Z]{8})(?::(\d{1,3}):([A-Z]+\d+|-):(\d{1,3})\/(\d{1,3}):(\d{2})(\d{2})(\d{2})(?::([0-9A-HJKMNP-TV-Z]{4}))?)?$/;

/** Crockford base32, as in note IDs. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Four base32 characters standing for a unit operation's name and alias
 * (`Liquid Handling` + `2차 정제`), ignoring case, spacing, Markdown
 * escapes and emphasis marks (a rendered heading has none). Two blocks of one ID with different aliases get different ones,
 * barring a 1-in-a-million clash, so a scan finds its block after blocks
 * were added, removed or reordered (#304).
 */
export function unitOpFingerprint(opName: string, alias: string): string {
  const text = `${opName} ${alias}`.normalize('NFC').replace(/\\(.)/g, '$1').replace(/[*`~=]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  // FNV-1a over the UTF-16 code units.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 4; i++) out += BASE32[(hash >>> (i * 5)) & 31];
  return out;
}

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
  const fingerprint = p.unitOpIndex > 0 && p.fingerprint ? `:${p.fingerprint}` : '';
  return `${PREFIX}:${p.noteId}:${p.unitOpIndex}:${opId}:${p.page}/${p.pageCount}:${date}${fingerprint}`;
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
    ...(m[9] && unitOpIndex > 0 ? { fingerprint: m[9] } : {}),
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
