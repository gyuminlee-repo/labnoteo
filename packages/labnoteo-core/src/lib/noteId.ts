/**
 * Note IDs — the `labnote_id` front-matter field that ties a printed worksheet
 * (and the photos taken of it) back to its note.
 *
 * Separate from the optional README `id` (e.g. `EXP-001`): automation uses that
 * one as the experiment's issue identity, so it must not change meaning.
 */
import { serializeFrontMatterEntry } from '../sections/frontMatter';

export const NOTE_ID_KEY = 'labnote_id';

/** Crockford base32: no I, L, O or U, so a handwritten or misread ID stays unambiguous. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NOTE_ID_RE = /^LN-[0-9A-HJKMNP-TV-Z]{8}$/;

/** `LN-` + 8 Crockford base32 characters (40 random bits). */
export function generateNoteId(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return `LN-${out}`;
}

function defaultRandomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function isValidNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID_RE.test(value);
}

/** Line range of the front-matter block: `[1, close)` are its entry lines, or `null` without one. */
function frontMatterLines(lines: string[]): { close: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return close === -1 ? null : { close };
}

const KEY_LINE_RE = new RegExp(`^${NOTE_ID_KEY}\\s*:(.*)$`);

/** The note's `labnote_id` when it is a valid ID; any other value counts as none. */
export function readNoteId(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const fm = frontMatterLines(lines);
  if (!fm) return undefined;
  for (let i = 1; i < fm.close; i++) {
    const m = KEY_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    return isValidNoteId(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Set the note's `labnote_id` to `id`, touching only that line: an existing
 * entry is rewritten in place, otherwise it goes right after `title:` (or
 * first). A note without front matter gets a block holding just the ID.
 * Line endings are preserved; unchanged content is returned as is.
 */
export function setNoteId(content: string, id: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const entry = serializeFrontMatterEntry(NOTE_ID_KEY, id);
  const fm = frontMatterLines(lines);
  if (!fm) return ['---', entry, '---', '', content].join(newline);
  for (let i = 1; i < fm.close; i++) {
    if (!KEY_LINE_RE.test(lines[i])) continue;
    if (lines[i] === entry) return content;
    lines[i] = entry;
    return lines.join(newline);
  }
  const title = lines.findIndex((l, i) => i > 0 && i < fm.close && /^title\s*:/.test(l));
  // A title continued on indented lines (block scalar, folded string) keeps them.
  const afterTitle = title !== -1 && !/^[ \t]/.test(lines[title + 1] ?? '') ? title + 1 : 1;
  lines.splice(afterTitle, 0, entry);
  return lines.join(newline);
}

/** IDs carried by more than one note, with the notes' paths in input order. */
export function findDuplicateNoteIds(notes: readonly { path: string; id: string }[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const { path, id } of notes) {
    const list = byId.get(id);
    if (list) list.push(path);
    else byId.set(id, [path]);
  }
  for (const [id, paths] of byId) if (paths.length < 2) byId.delete(id);
  return byId;
}
