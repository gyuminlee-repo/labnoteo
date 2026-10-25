/**
 * Where scanned pages are stored in the vault: next to the experiment's other
 * images under `images/scans/`, named after the note ID so moving a note can
 * take its scans along, and the unmatched queue at the vault root.
 */
import { TFile, normalizePath, type App } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import type { PagePayload } from '@labnoteo/core/lib/scanPayload';

export const SCANS_SUBFOLDER = 'images/scans';
/** Pages no note could be found for. Outside `labnote/` and git-ignored. */
export const UNMATCHED_FOLDER = '_labnote-scans/unmatched';
/** Short content hash written beside each filed scan. */
export const HASH_LENGTH = 12;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const shortHash = (hex: string): string => hex.slice(0, HASH_LENGTH);

/** `LN-7K3M9QX2_u3_p2_20261015.jpg` (unit op 0: pages before the first unit op). */
export function scanFileName(noteId: string, unitOpIndex: number, page: number, date: string): string {
  return `${noteId}_u${unitOpIndex}_p${page}_${date.replace(/-/g, '')}.jpg`;
}

/**
 * The note ID in a filed scan's embed line (`![[LN-7K3M9QX2_u3_p2_20261015.jpg|200]]`,
 * with or without a folder, or as a Markdown link), by the naming above.
 */
export function noteIdFromFiledScanEmbed(embed: string): string | undefined {
  return /(?:^|[/[(])(LN-[0-9A-HJKMNP-TV-Z]{8})_u\d+_p\d+_\d{8}(?:_\d+)?\.(?:jpe?g|png)/i.exec(embed)?.[1];
}

/** Whether `name` is a scan of note `noteId`, by the naming above. */
export function isScanOfNote(name: string, noteId: string): boolean {
  return name.startsWith(`${noteId}_u`) && /\.(jpe?g|png)$/i.test(name);
}

/** `name`, or `name_2`, `name_3`… before the extension, whichever is free in `taken`. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(folder)) return;
  let path = '';
  for (const part of folder.split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(path)) {
      try {
        await app.vault.createFolder(path);
      } catch {
        // Created meanwhile (another scan of the same batch).
      }
    }
  }
}

/** Write `bytes` as `folder/name` (renamed when taken) and return the file. */
export async function saveBinary(app: App, folder: string, name: string, bytes: ArrayBuffer): Promise<TFile> {
  const dir = normalizePath(folder);
  await ensureFolder(app, dir);
  const finalName = freeName(name, candidate => app.vault.getAbstractFileByPath(posix.join(dir, candidate)) !== null);
  return app.vault.createBinary(posix.join(dir, finalName), bytes);
}

/** Why a page went to the unmatched queue; kept in its file name (#349). */
const UNMATCHED_REASONS = ['no-qr', 'note-not-found', 'duplicate-id', 'note-only', 'no-unit-op', 'ambiguous', 'renamed'];

/** What the QR code of a queued page said, and why it was not filed (#349). */
export interface UnmatchedInfo {
  noteId?: string;
  /** The unit operation and page the QR code named, without the note ID. */
  page?: Omit<PagePayload, 'noteId'>;
  reason?: string;
}

/**
 * Unmatched page file name, keeping the note ID when one was read:
 * `20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg`. With `info`, the rest of
 * the QR code and the reason go after the note ID, so the assignment can
 * offer them (#349): `…_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_1234.jpg`.
 */
export function unmatchedFileName(
  stamp: string,
  sourceName: string,
  noteId: string | undefined,
  page?: number,
  info: { payload?: PagePayload; reason?: string } = {}
): string {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#^[\]]/g, '_').slice(0, 60);
  const pagePart = page !== undefined ? `_p${page}` : '';
  const p = info.payload;
  const date = p && /^\d{4}-\d{2}-\d{2}$/.test(p.printedOn) ? p.printedOn.slice(2).replace(/-/g, '') : '';
  const qr = p && date ? `_q${p.unitOpIndex}-${p.opId || '-'}-${p.page}o${p.pageCount}-${date}${p.fingerprint ? `-${p.fingerprint}` : ''}` : '';
  const reason = info.reason && UNMATCHED_REASONS.includes(info.reason) ? `_${info.reason}` : '';
  return `${stamp}_${noteId ?? 'unknown'}${qr}${reason}_${stem}${pagePart}.jpg`;
}

const UNMATCHED_NAME_RE = new RegExp(
  '^\\d{8}-\\d{6}_(LN-[0-9A-HJKMNP-TV-Z]{8}|unknown)' +
    '(?:_q(\\d{1,3})-([A-Z]+\\d+|-)-(\\d{1,3})o(\\d{1,3})-(\\d{2})(\\d{2})(\\d{2})(?:-([0-9A-HJKMNP-TV-Z]{4}))?)?' +
    `(?:_(${UNMATCHED_REASONS.join('|')}))?_`
);

/** What {@link unmatchedFileName} kept in `name`; older names give the note ID only. */
export function unmatchedInfoFromName(name: string): UnmatchedInfo {
  const m = UNMATCHED_NAME_RE.exec(name);
  if (!m) return {};
  const info: UnmatchedInfo = {};
  if (m[1] !== 'unknown') info.noteId = m[1];
  if (m[2] !== undefined) {
    info.page = {
      unitOpIndex: Number(m[2]),
      opId: m[3] === '-' ? '' : m[3],
      page: Number(m[4]),
      pageCount: Number(m[5]),
      printedOn: `20${m[6]}-${m[7]}-${m[8]}`,
      ...(m[9] ? { fingerprint: m[9] } : {}),
    };
  }
  if (m[10]) info.reason = m[10];
  return info;
}

/** The note ID recorded in an unmatched page's file name, if any. */
export function noteIdFromUnmatchedName(name: string): string | undefined {
  return unmatchedInfoFromName(name).noteId;
}

export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
