/**
 * Where scanned pages are stored in the vault: next to the experiment's other
 * images under `images/scans/`, named after the note ID so moving a note can
 * take its scans along, and the unmatched queue at the vault root.
 */
import { TFile, normalizePath, type App } from 'obsidian';
import * as posix from '@labnoteo/core/posix';

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

/** Unmatched page file name, keeping the note ID when one was read: `20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg`. */
export function unmatchedFileName(stamp: string, sourceName: string, noteId: string | undefined, page?: number): string {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#^[\]]/g, '_').slice(0, 60);
  const pagePart = page !== undefined ? `_p${page}` : '';
  return `${stamp}_${noteId ?? 'unknown'}_${stem}${pagePart}.jpg`;
}

/** The note ID recorded in an unmatched page's file name, if any. */
export function noteIdFromUnmatchedName(name: string): string | undefined {
  return /^\d{8}-\d{6}_(LN-[0-9A-HJKMNP-TV-Z]{8})_/.exec(name)?.[1];
}

export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
