/**
 * Closed code fences of a README, for the two workflow paths that must not
 * touch a fenced example: deletion skips the lines inside one, and adding
 * moves an entry that would land inside one to just after it. Finding the
 * section, reading entries and reordering them do not look at fences, as in
 * v0.130.0, so a fence can only make these paths do less, never hide a line
 * they used to see.
 *
 * A line is inside when either reading puts it there: fences indented up to
 * three spaces ({@link closedFenceSpans} as is), or fences at any indent (the line
 * with its indent dropped, as under a list entry). An opener that is never
 * closed is not a fence. Each reading is one linear pass.
 */
import { classifyLines, closedFenceSpans, htmlBlockMarks, isFenced } from '../sections/codeFences';

/**
 * Which lines are in an HTML block (CommonMark, read line by line, in block quotes and list
 * items too): from a line starting one, outside a fence, to the line ending it. A backtick run
 * there is HTML, no fence, so it pairs with no fence below.
 */
// front matter: its callers pass the README's lines from past the front matter (removeWorkflowFromReadme, insertWorkflowChecklistEntries, dropBlankLeftByEntries).
export function htmlBlockLines(lines: readonly string[]): boolean[] {
  return htmlBlockMarks(lines);
}

/** Each line as a fence reading takes it: one `inHtml` marks (in an HTML block) is no fence line. */
function fenceReading(lines: readonly string[], indentAny: boolean, inHtml?: readonly boolean[], lazyHtml = false): [number, number][] {
  const read = indentAny ? (line: string) => line.trimStart() : (line: string) => line;
  // Without `inHtml` the HTML blocks are not read, and a backtick run in one may be a fence.
  return closedFenceSpans(lines, (line, i) => (inHtml?.[i] ? '' : read(line)), { html: inHtml !== undefined, lazyHtml });
}

/**
 * Line by line (CommonMark: a fence left open runs to the end), outside HTML blocks: `code[i]`
 * whether line `i` is in a fence or is one, `openBefore[p]` whether a line put before line `p`
 * would be in one. The closed readings take an opener never closed for text; this one does not.
 */
function lineByLineFences(lines: readonly string[], from = 0): { code: boolean[]; openBefore: boolean[] } {
  // Lines as the one block reading has them (classifyLines).
  const kinds = classifyLines(lines, from);
  const open = (i: number): boolean => i >= from && isFenced(kinds[i]) && !kinds[i].ends;
  const code = kinds.map(isFenced);
  const openBefore = Array.from({ length: lines.length + 1 }, (_x, i) => open(i - 1));
  return { code, openBefore };
}

/** The HTML blocks of `lines` as `[first, last]` line pairs. */
function htmlBlockSpans(lines: readonly string[], html: readonly boolean[] = htmlBlockLines(lines)): [number, number][] {
  const spans: [number, number][] = [];
  html.forEach((on, i) => {
    if (!on) return;
    if (spans.length && spans[spans.length - 1][1] === i - 1) spans[spans.length - 1][1] = i;
    else spans.push([i, i]);
  });
  return spans;
}

/**
 * Closed fences of `lines` as `[opener, closer]` pairs, in either reading (they may overlap),
 * and the HTML blocks: an entry goes into neither.
 */
export function readmeFenceSpans(lines: readonly string[]): [number, number][] {
  const html = htmlBlockLines(lines);
  return [...fenceReading(lines, false, html), ...fenceReading(lines, true, html), ...htmlBlockSpans(lines, html)];
}

/**
 * {@link readmeFencedLines} (`inCode`, either reading) and the lines in a closed fence
 * indented up to three spaces alone (`plain`, the CommonMark reading), from the same two
 * readings: a heading in a `plain` fence is no heading, while the any-indent reading only
 * keeps lines from being touched and never hides a heading. `inCode` also takes the fences
 * read with an HTML block's backtick lines as fences, as before: deletion keeps from a line
 * either way puts in code (it can only do less), while `plain` reads the HTML block as HTML,
 * so a backtick line there hides no heading below.
 */
export function readmeFencedReadings(lines: readonly string[]): { inCode: boolean[]; plain: boolean[] } {
  const fill = (spans: readonly [number, number][]): boolean[] => {
    const out = new Array<boolean>(lines.length).fill(false);
    for (const [open, close] of spans) out.fill(true, open, close + 1);
    return out;
  };
  // An HTML block is no Markdown either: no line in it is an entry, nor a heading. For deletion
  // only, an HTML start at column 0 right after a list item's paragraph line is that paragraph
  // going on, as Obsidian 1.15.0 reads it (reading view and metadataCache), not an HTML block.
  const html = htmlBlockMarks(lines, 0, { lazyHtml: true });
  const plainSpans = [...fenceReading(lines, false, html, true), ...htmlBlockSpans(lines, html)];
  // Without an HTML block the readings that take its lines as fences are these same ones.
  const asFences = html.some(Boolean) ? [...fenceReading(lines, false), ...fenceReading(lines, true)] : [];
  // The HTML blocks CommonMark reads there keep their lines from the section's own deletion too
  // (it can only do less): a fence the lazy reading opens may never close, and so hide nothing.
  const either = [...plainSpans, ...fenceReading(lines, true, html, true), ...asFences, ...htmlBlockSpans(lines)];
  return { inCode: fill(either), plain: fill(plainSpans) };
}

/** Whether each line lies in a closed fence of {@link readmeFenceSpans}, its fence lines included. */
export function readmeFencedLines(lines: readonly string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  for (const [open, close] of readmeFenceSpans(lines)) inCode.fill(true, open, close + 1);
  return inCode;
}

/**
 * `at` (a position before line `at`) in the section headed on line `header`,
 * moved out of every closed fence it falls inside: past the fence's closing
 * line, or, when that would pass `limit` (the end of the section, which a
 * fence may hide a heading in), before the fence's opening line instead. The
 * line then stays in the section, where reading finds it. A section whose
 * heading is itself in a fence is left as v0.130.0 reads it: `at` stays.
 */
export function positionOutsideFences(
  lines: readonly string[],
  at: number,
  header: number,
  limit = lines.length,
  spans: readonly [number, number][] = readmeFenceSpans(lines),
  from = 0
): number {
  if (spans.some(([open, close]) => open < header && header <= close)) return at;
  const inside = (pos: number): [number, number][] => spans.filter(([open, close]) => open < pos && pos <= close);
  let after = at;
  for (let around = inside(after); around.length > 0; around = inside(after)) after = Math.max(...around.map(([, close]) => close + 1));
  let before = at;
  for (let around = inside(before); around.length > 0; around = inside(before)) before = Math.min(...around.map(([open]) => open));
  // Not into a fence the line-by-line reading has open there (one left open, say), when `at` is
  // in none by that reading: a closed reading's fence may be no fence at all. A place passes when
  // it is in no span (fence or HTML block) and in no such fence: past the spans, before them, or
  // the section's end; `at` only when none passes.
  const { openBefore } = lineByLineFences(lines, from);
  const passes = (pos: number): boolean => inside(pos).length === 0 && (!openBefore[pos] || openBefore[at]);
  const moved = after <= limit ? after : before;
  for (const pos of [moved, moved === after ? before : after, limit]) if (pos <= limit && passes(pos)) return pos;
  return at;
}
