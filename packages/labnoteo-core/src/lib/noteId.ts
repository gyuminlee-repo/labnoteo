/**
 * Note IDs — the `labnote_id` front-matter field that ties a printed worksheet
 * (and the photos taken of it) back to its note.
 *
 * Separate from the optional README `id` (e.g. `EXP-001`): automation uses that
 * one as the experiment's issue identity, so it must not change meaning.
 */
import { serializeFrontMatterEntry } from '../sections/frontMatter';
import { joinLineBuffer, spliceLineBuffer, splitLineBuffer } from '../util/lineEnds';

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

/**
 * The lines of `content` up to its front matter's closing `---` (all of it without one),
 * read one by one so a long body is not split: what {@link frontMatterLines} needs.
 */
function frontMatterHead(content: string): string[] {
  const lines: string[] = [];
  for (let at = 0; at <= content.length; ) {
    const nl = content.indexOf('\n', at);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(at, end > at && content[end - 1] === '\r' && nl !== -1 ? end - 1 : end);
    lines.push(line);
    if (lines.length === 1 ? line.trim() !== '---' : line.trim() === '---') break;
    if (nl === -1) break;
    at = nl + 1;
  }
  return lines;
}

const KEY_LINE_RE = new RegExp(`^${NOTE_ID_KEY}\\s*:(.*)$`);

/**
 * The note's `labnote_id` when it is a valid ID on its key line; any other value counts
 * as none. A value {@link setNoteId} leaves as it is ({@link noteIdUnwritable}: continued
 * on the next lines after an empty first line, a block scalar or an open quote) is no ID
 * either, so a note never has an ID it cannot be given. A plain value with lines below it
 * is read and written on its key line, as B7 did.
 */
export function readNoteId(content: string): string | undefined {
  if (noteIdUnwritable(content)) return undefined;
  const value = readRawNoteId(content);
  return isValidNoteId(value) ? value : undefined;
}

/**
 * The note's `labnote_id` value as written, valid or not (#478), unquoted and
 * trimmed; undefined without the line or with an empty value.
 */
export function readRawNoteId(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const fm = frontMatterLines(lines);
  if (!fm) return undefined;
  for (let i = 1; i < fm.close; i++) {
    const m = KEY_LINE_RE.exec(lines[i]);
    if (!m) continue;
    // The value on the key line, as B7 read it: a plain value with lines continuing
    // it is read, and written ({@link setNoteId}), on that line alone. A value that
    // cannot be written there ({@link noteIdUnwritable}) is no ID (readNoteId).
    const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * Whether the note has a `labnote_id` line whose value {@link setNoteId} leaves as it is
 * (continued on the lines below it after an empty first line, a block scalar indicator or
 * an open quote; a plain value on the key line is written there): the ID can be
 * neither read nor written there, which is not the same as having none.
 */
export function noteIdUnwritable(content: string): boolean {
  const lines = frontMatterHead(content);
  const fm = frontMatterLines(lines);
  if (!fm) return false;
  for (let i = 1; i < fm.close; i++) if (KEY_LINE_RE.test(lines[i])) return !oneLineScalarAt(lines, i, fm.close);
  return false;
}

/**
 * Whether `line` continues the value of the `labnote_id:` key above it, whose
 * own line holds `keyValue`: indented by ASCII spaces or tabs and not a
 * comment, or a `- ` item at column 0 when `keyValue` is empty (a comment
 * aside), as a block sequence is. Under a key with a value such an item is a
 * YAML error, not more of the value, and the value reads as before. A line
 * indented by another space (NBSP, U+3000), or a `-` followed by one, is a
 * key of its own.
 */
const continuesValue = (line: string, keyValue: string): boolean =>
  /^[ \t]+[^\s#]/.test(line) || (/^(?:[ \t]+#.*)?[ \t]*$/.test(keyValue) && /^-([ \t]|$)/.test(line));

/**
 * Whether the `labnote_id:` line `i` can be rewritten alone: it holds a plain value
 * ({@link plainKeyValue}), or nothing continues it on the next line
 * ({@link continuesValue}). A block scalar indicator
 * (`|`, `>`) or a quote left open with no line continuing it is that line alone
 * too, and is rewritten as before (B7): one line replaced keeps the YAML valid.
 */
function oneLineScalarAt(lines: readonly string[], i: number, close: number): boolean {
  const next = i + 1 < close ? lines[i + 1] : '';
  const keyValue = KEY_LINE_RE.exec(lines[i])?.[1] ?? '';
  return plainKeyValue(keyValue) || !continuesValue(next, keyValue);
}

/**
 * Whether the `labnote_id:` line holds a plain value of its own (not empty or a comment,
 * no block scalar indicator `|` `>`, no quote left open). Lines continuing it are left as
 * they are when that line is rewritten, as B7 rewrote it: YAML read the value with them
 * before and reads it with them after (`LN-X more`, then `LN-NEW more`), so nothing the
 * write does breaks more than it was.
 */
function plainKeyValue(keyValue: string): boolean {
  // A tag (`!!str`) or anchor (`&a`) ahead of the value is not the value.
  const value = keyValue.replace(/(^|[ \t])#.*$/, '').trim().replace(/^(?:[!&]\S*[ \t]+)+/, '');
  if (value === '' || /^[!&|>]/.test(value)) return false;
  const quote = /^['"]/.exec(value)?.[0];
  return quote === undefined || (value.length > 1 && value.endsWith(quote));
}

/**
 * Set the note's `labnote_id` to `id`, touching only that line: an existing
 * entry is rewritten in place, otherwise it goes right after `title:` (or
 * first). A note without front matter gets a block holding just the ID.
 * Line endings are preserved; unchanged content is returned as is.
 */
export function setNoteId(content: string, id: string): string {
  // Every other line keeps its own line break, even in mixed endings.
  const buf = splitLineBuffer(content);
  const { lines, newline } = buf;
  const entry = serializeFrontMatterEntry(NOTE_ID_KEY, id);
  const fm = frontMatterLines(lines);
  if (!fm) return ['---', entry, '---', '', content].join(newline);
  for (let i = 1; i < fm.close; i++) {
    if (!KEY_LINE_RE.test(lines[i])) continue;
    // Only a value on this one line is rewritten, a block scalar indicator or an
    // open quote with nothing continuing it included; a value continued on the
    // lines below stays as written: the caller reads the ID back.
    if (!oneLineScalarAt(lines, i, fm.close)) return content;
    if (lines[i] === entry) return content;
    spliceLineBuffer(buf, i, 1, [entry]);
    return joinLineBuffer(buf);
  }
  const title = lines.findIndex((l, i) => i > 0 && i < fm.close && /^title\s*:/.test(l));
  // A title continued on indented lines (block scalar, folded string) keeps them.
  const afterTitle = title !== -1 && !/^[ \t]/.test(lines[title + 1] ?? '') ? title + 1 : 1;
  spliceLineBuffer(buf, afterTitle, 0, [entry]);
  return joinLineBuffer(buf);
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
