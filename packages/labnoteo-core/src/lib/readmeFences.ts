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
import { closedFenceSpans, fenceView, mayHaveFences, stepFence, type OpenFence } from '../sections/codeFences';

/** CommonMark HTML block type 6: these tag names start a block ended by a blank line. */
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const ATTRIBUTE = `\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^"'=<>\`\\s]+|'[^']*'|"[^"]*"))?`;
/**
 * The seven CommonMark HTML block starts (up to three spaces in), each with the line that ends
 * it: types 1 to 5 end on the line holding their end mark (the start line too), 6 and 7 before a
 * blank line. Type 7 is a whole open or closing tag alone on its line, and cannot interrupt a
 * paragraph. An autolink (`<https://…>`, `<a@b.c>`) or `a < b` starts none.
 */
const HTML_STARTS: { start: RegExp; end: RegExp | null; paragraph: boolean }[] = [
  { start: /^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, end: /<\/(?:script|pre|style|textarea)>/i, paragraph: true },
  { start: /^ {0,3}<!--/, end: /-->/, paragraph: true },
  { start: /^ {0,3}<\?/, end: /\?>/, paragraph: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, paragraph: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, paragraph: true },
  { start: new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:\\s|/?>|$)`, 'i'), end: null, paragraph: true },
  {
    start: new RegExp(`^ {0,3}(?:<(?!(?:script|pre|style|textarea)\\b)[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>)\\s*$`, 'i'),
    end: null,
    paragraph: false,
  },
];

/**
 * Which lines are in an HTML block (CommonMark, read line by line): from a line starting one,
 * outside a fence, to the line ending it ({@link HTML_STARTS}). A backtick run there is HTML,
 * no fence, so it pairs with no fence below.
 */
// front matter: its callers pass the README's lines from past the front matter (removeWorkflowFromReadme, insertWorkflowChecklistEntries, dropBlankLeftByEntries).
export function htmlBlockLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let fence: OpenFence | null = null;
  // The open block's end mark (types 1 to 5), or null for one ended by a blank line (6 and 7).
  let open: { end: RegExp | null } | null = null;
  // The line before was paragraph text, which a type 7 start does not interrupt.
  let paragraph = false;
  // Fences in a block quote or list item as CommonMark reads them.
  const view = mayHaveFences(lines) ? fenceView(lines) : lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$|\r$/, '');
    const blank = line.trim() === '';
    if (open) {
      // The blank line ending a block is marked too: a line put right before it would join the
      // block, so an entry is moved past it.
      if (open.end === null && blank) {
        out[i] = true;
        open = null;
        paragraph = false;
        continue;
      }
      out[i] = true;
      if (open.end && open.end.test(line)) open = null;
      paragraph = false;
      continue;
    }
    const next = stepFence(view[i].replace(/\r?\n$|\r$/, ''), fence);
    if (next !== fence || fence) {
      fence = next;
      paragraph = false;
      continue;
    }
    const kind = HTML_STARTS.find(k => k.start.test(line) && (k.paragraph || !paragraph));
    if (kind) {
      out[i] = true;
      const rest = line.slice(line.indexOf('<') + 1);
      if (kind.end === null || !kind.end.test(rest)) open = { end: kind.end };
      paragraph = false;
      continue;
    }
    // An indented line not continuing a paragraph is indented code, no paragraph.
    if (!paragraph && /^(?: {4}|\t)/.test(line)) continue;
    paragraph = !blank && !/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_][ \t]*){3,}$|=+\s*$)/.test(line);
  }
  return out;
}

/** Each line as a fence reading takes it: one `inHtml` marks (in an HTML block) is no fence line. */
function fenceReading(lines: readonly string[], indentAny: boolean, inHtml: readonly boolean[] = []): [number, number][] {
  const read = indentAny ? (line: string) => line.trimStart() : (line: string) => line;
  return closedFenceSpans(lines, (line, i) => (inHtml[i] ? '' : read(line)));
}

/**
 * Line by line (CommonMark: a fence left open runs to the end), outside HTML blocks: `code[i]`
 * whether line `i` is in a fence or is one, `openBefore[p]` whether a line put before line `p`
 * would be in one. The closed readings take an opener never closed for text; this one does not.
 */
function lineByLineFences(lines: readonly string[], from = 0): { code: boolean[]; openBefore: boolean[] } {
  const html = htmlBlockLines(lines.slice(from));
  const code = new Array<boolean>(lines.length).fill(false);
  const openBefore = new Array<boolean>(lines.length + 1).fill(false);
  let fence: OpenFence | null = null;
  const view = fenceView(lines, from);
  for (let i = from; i < lines.length; i++) {
    openBefore[i] = fence !== null;
    if (html[i - from]) continue;
    const next = stepFence(view[i].replace(/\r?\n$|\r$/, ''), fence);
    code[i] = fence !== null || next !== null;
    fence = next;
  }
  openBefore[lines.length] = fence !== null;
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
  // An HTML block is no Markdown either: no line in it is an entry, nor a heading.
  const html = htmlBlockLines(lines);
  const plainSpans = [...fenceReading(lines, false, html), ...htmlBlockSpans(lines, html)];
  // Without an HTML block the readings that take its lines as fences are these same ones.
  const asFences = html.some(Boolean) ? [...fenceReading(lines, false), ...fenceReading(lines, true)] : [];
  const either = [...plainSpans, ...fenceReading(lines, true, html), ...asFences];
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
  const moved = after <= limit ? after : before;
  // Not into a fence the line-by-line reading has open there (one left open, say), when `at` is
  // in none by that reading: a closed reading's fence may be no fence at all.
  const { openBefore } = lineByLineFences(lines, from);
  return openBefore[moved] && !openBefore[at] ? at : moved;
}
