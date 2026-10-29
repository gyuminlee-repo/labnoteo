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
