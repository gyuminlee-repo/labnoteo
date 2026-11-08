/**
 * Line endings for the README checklist writers, which split a README on `\n`
 * and keep each line's `\r` on the line while they move, drop or add lines.
 */

/**
 * `text` split on `\n` for a writer that keeps each line's `\r` on the line and
 * moves, drops or adds whole lines. Without a final newline, the last line
 * gets the `\r` of the CRLF break before it, so a line moved off
 * the end or a line left last carries the right ending;
 * {@link joinSplitKeepingCr} takes that `\r` off the new last line again.
 */
export function splitKeepingCr(text: string): string[] {
  const lines = text.split('\n');
  if (addsLastCr(text)) lines[lines.length - 1] += '\r';
  return lines;
}

/**
 * Whether {@link splitKeepingCr} gives the last line of `text` a `\r`: it has
 * no final newline and the line break before it is CRLF. A lone CR ending
 * `text` is the last line's text; the added CR follows it.
 */
export function addsLastCr(text: string): boolean {
  const lastBreak = text.lastIndexOf('\n');
  return lastBreak > 0 && lastBreak < text.length - 1 && text[lastBreak - 1] === '\r';
}

/**
 * `lines` from {@link splitKeepingCr} of `text` joined again, still without a
 * final newline when `text` had none, so the line now last ends in no `\r`
 * of a line break: the one the split added, or that of a CRLF line moved or
 * added to the end. A `\r` that ended `text` as text stays while its line is
 * still last.
 */
export function joinSplitKeepingCr(text: string, lines: readonly string[]): string {
  const joined = lines.join('\n');
  if (text.endsWith('\n') || lines.length === 0) return joined;
  if (addsLastCr(text)) return joined.replace(/\r$/, '');
  const textLast = text.slice(text.lastIndexOf('\n') + 1);
  return lines[lines.length - 1] === textLast ? joined : joined.replace(/\r$/, '');
}

/**
 * A text's lines (without their line breaks) and the line break each one
 * ended with, for a writer that edits some lines and must leave every other
 * line's break as it was, even in a README or note with mixed endings.
 * `ends[i]` is `\n` or `\r\n`, and `''` for the last line only. A lone CR
 * ending the text is the last line's text.
 */
export interface LineBuffer {
  lines: string[];
  ends: string[];
  /** The break new lines get when none comes before them: CRLF when the text has any. */
  newline: string;
}

/** `text` as a {@link LineBuffer}: its lines are those of `text.split(/\r?\n/)`. */
export function splitLineBuffer(text: string): LineBuffer {
  const pieces = text.split('\n');
  const lines: string[] = [];
  const ends: string[] = [];
  pieces.forEach((piece, i) => {
    const last = i === pieces.length - 1;
    const cr = !last && piece.endsWith('\r');
    lines.push(cr ? piece.slice(0, -1) : piece);
    ends.push(last ? '' : cr ? '\r\n' : '\n');
  });
  return { lines, ends, newline: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** A line of the buffer as it was before an edit, to carry into the edit with its own break. */
export interface LineRef {
  line: number;
}

/**
 * Like `buf.lines.splice(start, deleteCount, ...items)`, moving the breaks
 * along: removed lines take theirs with them, an item that is a
 * {@link LineRef} brings that line with its own break, and each new line (a
 * string) gets the break of the line before it (or {@link LineBuffer.newline}
 * at the top). The last line keeps ending in none, so a line added after it
 * gives it one. Leading and trailing items equal to the lines they replace
 * are not replaced.
 */
export function spliceLineBuffer(
  buf: LineBuffer,
  start: number,
  deleteCount: number,
  items: readonly (string | LineRef)[] = []
): void {
  const same = (item: string | LineRef, at: number): boolean =>
    typeof item === 'string' ? buf.lines[at] === item : item.line === at;
  let head = 0;
  while (head < deleteCount && head < items.length && same(items[head], start + head)) head++;
  let tail = 0;
  while (tail < deleteCount - head && tail < items.length - head && same(items[items.length - 1 - tail], start + deleteCount - 1 - tail)) tail++;
  spliceRaw(buf, start + head, deleteCount - head - tail, items.slice(head, items.length - tail));
}

/**
 * `arr.splice(start, deleteCount, ...items)` in place without spreading
 * `items` into an argument list, which overflows the stack for a long one.
 */
function replaceRange<T>(arr: T[], start: number, deleteCount: number, items: readonly T[]): void {
  const tail = arr.slice(start + deleteCount);
  arr.length = start;
  for (const item of items) arr.push(item);
  for (const item of tail) arr.push(item);
}

/**
 * The break `end` for `line`. A line ending in `\r` (the lone CR that ended the text) takes
 * the text's own break for LF, as B6 wrote it: CRLF in a text with any, so that CR stays the
 * line's and is not read with the LF as one CRLF.
 */
function breakAfter(buf: LineBuffer, line: string, end: string): string {
  return end === '\n' && line.endsWith('\r') ? buf.newline : end;
}

function spliceRaw(buf: LineBuffer, start: number, deleteCount: number, items: readonly (string | LineRef)[]): void {
  const n = buf.lines.length;
  const toEnd = start + deleteCount >= n;
  let end = start > 0 ? buf.ends[start - 1] : buf.newline;
  if (end === '') end = start >= 2 ? buf.ends[start - 2] : buf.newline;
  const lines: string[] = [];
  const ends: string[] = [];
  let above = end;
  for (const item of items) {
    // A carried line keeps its break; one that ended the text takes the break above it.
    const own = typeof item === 'string' ? '' : buf.ends[item.line];
    const line = typeof item === 'string' ? item : buf.lines[item.line];
    lines.push(line);
    ends.push(breakAfter(buf, line, own || above));
    above = own || above;
  }
  replaceRange(buf.lines, start, deleteCount, lines);
  replaceRange(buf.ends, start, deleteCount, ends);
  if (start > 0 && buf.ends[start - 1] === '' && start < buf.lines.length) buf.ends[start - 1] = breakAfter(buf, buf.lines[start - 1], end);
  if (toEnd && buf.lines.length > 0) buf.ends[buf.lines.length - 1] = '';
}

/** The text of `buf`: each line followed by its own break. */
/**
 * {@link spliceLineBuffer} for several edits at once that do not overlap, as if each were
 * applied from the last up, in one pass over the buffer (many sections removed from a long
 * note cost the note's length, not its length per section).
 */
export function spliceLineBufferMany(
  buf: LineBuffer,
  edits: readonly { start: number; count: number; body?: readonly (string | LineRef)[] }[]
): void {
  const sorted = [...edits].sort((x, y) => x.start - y.start);
  const n = buf.lines.length;
  const lines: string[] = [];
  const ends: string[] = [];
  let at = 0;
  let lastToEnd = false;
  for (const { start, count, body = [] } of sorted) {
    const same = (item: string | LineRef, k: number): boolean =>
      typeof item === 'string' ? buf.lines[k] === item : item.line === k;
    let head = 0;
    while (head < count && head < body.length && same(body[head], start + head)) head++;
    let tail = 0;
    while (tail < count - head && tail < body.length - head && same(body[body.length - 1 - tail], start + count - 1 - tail)) tail++;
    const s = start + head, del = count - head - tail, items = body.slice(head, body.length - tail);
    for (; at < s; at++) { lines.push(buf.lines[at]); ends.push(buf.ends[at]); }
    // As spliceRaw: the break above the edit, carried lines keeping their own.
    let end = s > 0 ? buf.ends[s - 1] : buf.newline;
    if (end === '') end = s >= 2 ? buf.ends[s - 2] : buf.newline;
    if (s > 0 && lines.length > 0 && ends[ends.length - 1] === '' && (items.length > 0 || s + del < n)) ends[ends.length - 1] = breakAfter(buf, lines[lines.length - 1], end);
    let above = end;
    for (const item of items) {
      const own = typeof item === 'string' ? '' : buf.ends[item.line];
      const line = typeof item === 'string' ? item : buf.lines[item.line];
      lines.push(line);
      ends.push(breakAfter(buf, line, own || above));
      above = own || above;
    }
    at = s + del;
    lastToEnd = s + del >= n;
  }
  for (; at < n; at++) { lines.push(buf.lines[at]); ends.push(buf.ends[at]); }
  if (lastToEnd && lines.length > 0) ends[lines.length - 1] = '';
  buf.lines.length = 0;
  buf.ends.length = 0;
  for (let i = 0; i < lines.length; i++) { buf.lines.push(lines[i]); buf.ends.push(ends[i]); }
}

export function joinLineBuffer(buf: LineBuffer): string {
  let out = '';
  for (let i = 0; i < buf.lines.length; i++) out += buf.lines[i] + buf.ends[i];
  return out;
}
