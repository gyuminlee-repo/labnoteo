/**
 * Code fences as every writer that deletes or replaces note text reads them:
 * only a fence that is closed is code. An opener that is never closed is a
 * line of text, so it cannot hide the headings below it and make a section
 * run to the end of the note (and a replacement delete what follows).
 */
import { frontMatterLineCountOf } from './frontMatter';

/** An open code fence: which character opened it, and how long the run was. */
export interface OpenFence {
  char: string;
  length: number;
}

/** A fence line: up to 3 leading spaces, then a run of 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Advance code-fence state across one line.
 *
 * Per CommonMark a fence is closed only by a run of the SAME character that is
 * at least as long as the opener, and a closing fence carries no info string.
 * Tracking that matters: a plain boolean toggle read the ``` inside a `~~~`
 * block as a close, then read the real `~~~` as an open — and from there every
 * heading in the rest of the document looked like it was inside code, so the
 * section body ran to EOF and replacing it deleted every following section.
 * Showing fenced Markdown inside a fenced example is a normal thing to write in
 * a protocol note.
 */
export function stepFence(line: string, open: OpenFence | null): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) return open;

  const run = match[1];
  const afterRun = line.slice(line.indexOf(run) + run.length);
  // CommonMark: a backtick fence's info string has no backtick (```` ```a``` ```` is inline code).
  if (open === null) return run[0] === '`' && afterRun.includes('`') ? null : { char: run[0], length: run.length };

  // Only spaces and tabs may follow a closing run (CommonMark): an NBSP or another Unicode space
  // after it makes the line no closer.
  const closes = run[0] === open.char && run.length >= open.length && /^[ \t]*$/.test(afterRun.replace(/\r?\n$|\r$/, ''));
  return closes ? null : open;
}

/** A container a line may sit in: a block quote, or a list item whose content starts `indent` columns in. */
type Container = { quote: true } | { quote: false; indent: number };

const QUOTE_MARK = /^ {0,3}> ?/;
const LIST_MARK = /^( {0,3})([-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** CommonMark HTML block type 6: these tag names start a block ended by a blank line. */
export const BLOCK_TAGS =
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

/** `text` with the tabs among its leading spaces, `>` and list markers set to spaces (tab stops of 4). */
function expandLeadingTabs(text: string): string {
  const end = /^[ \t>\-*+.)0-9]*/.exec(text)![0].length;
  if (!text.slice(0, end).includes('\t')) return text;
  let out = '';
  for (const c of text.slice(0, end)) out += c === '\t' ? ' '.repeat(4 - (out.length % 4)) : c;
  return out + text.slice(end);
}

/** How {@link readBlocks} reads: `html: false` reads no HTML block, so a backtick run in one may be a fence. */
export interface BlockReading {
  html?: boolean;
}

/**
 * Each line of `lines` (from line `from` on) as {@link stepFence} should read it, so that a fence
 * in a block quote or a list item opens and closes as CommonMark has it: the quote markers and the
 * item's indent are taken off (`- ```md` reads as ```` ```md ````, its closer `  ```` as ```` ``` ````),
 * and where the quote or item ends with its fence still open (a line without the `>`, or indented
 * less than the item's content) the line before reads as that fence's closer, or the opener, when
 * nothing came between, as text. A line in an HTML block reads as an empty line: a backtick run
 * there is HTML, no fence. A line in no container reads as it is. Not read: a list item's second
 * blank line.
 */
export function fenceView(lines: readonly string[], from = 0, reading: BlockReading = {}): string[] {
  const { at } = readBlocks(lines, from, reading);
  return lines.map((_line, i) => at(i));
}

/**
 * {@link fenceView} read lazily: line `i` as it reads, reading the lines up to the one after it
 * (whose container may end a fence) and no further, for a reader that stops at a heading.
 */
export function fenceReader(lines: readonly string[], from = 0): (i: number) => string {
  return readBlocks(lines, from).at;
}

/** Which lines of `lines` (from line `from` on) are in an HTML block, as {@link fenceView} reads them. */
export function htmlBlockMarks(lines: readonly string[], from = 0): boolean[] {
  const { at, html } = readBlocks(lines, from);
  return lines.map((_line, i) => (at(i), html(i)));
}

/**
 * One pass over the block structure the fence readers need: containers (block quotes and list
 * items), fences and HTML blocks, line by line as CommonMark reads them.
 */
// front matter: read from `from`, which its callers set past the front matter (or pass a section's or a body's lines).
function readBlocks(lines: readonly string[], from: number, { html: readHtml = true }: BlockReading = {}): { at: (i: number) => string; html: (i: number) => boolean } {
  const view: string[] = [];
  const marks: boolean[] = [];
  let stack: Container[] = [];
  let fence: OpenFence | null = null;
  // The containers the open fence sits in, and its opening line.
  let fenceDepth = 0;
  let fenceLine = -1;
  // The open HTML block: its end mark (types 1 to 5) or null (6 and 7, ended by a blank line),
  // and the containers it sits in.
  let html: { end: RegExp | null; depth: number } | null = null;
  // The line before was paragraph text, which a lazy line continues and some list items cannot interrupt.
  let para = false;
  let i = from;
  const step = (): void => {
    view[i] = lines[i];
    let rest = lines[i].replace(/\r?\n$|\r$/, '');
    let matched = 0;
    for (const c of stack) {
      const text = expandLeadingTabs(rest);
      if (c.quote) {
        const q = QUOTE_MARK.exec(text);
        if (!q) break;
        rest = text.slice(q[0].length);
      } else if (text.trim() === '') {
        rest = '';
      } else if (/^ */.exec(text)![0].length >= c.indent) {
        rest = text.slice(c.indent);
      } else break;
      matched++;
    }
    if (fence && matched < fenceDepth) {
      // The fence's container ended with it: the line before closes it.
      if (i - 1 > fenceLine) view[i - 1] = fence.char.repeat(fence.length);
      else view[fenceLine] = '';
      fence = null;
    }
    // An HTML block ends with its container.
    if (html && matched < html.depth) html = null;
    if (fence) {
      fence = stepFence(rest, fence);
      view[i] = rest;
      return;
    }
    if (html) {
      marks[i] = true;
      view[i] = '';
      para = false;
      // The blank line ending a block is marked too: a line put right before it would join the block.
      if (html.end === null ? rest.trim() === '' : html.end.test(rest)) html = null;
      return;
    }
    if (matched < stack.length) {
      // A lazy line: paragraph text going on in the containers it does not mark.
      const text = expandLeadingTabs(rest);
      const item = LIST_MARK.exec(text);
      const starts =
        text.trim() === '' ||
        QUOTE_MARK.test(text) ||
        // A list item interrupts a paragraph when it is not empty, and an ordered one starts at 1.
        (item !== null && text.slice(item[0].length).trim() !== '' && (item[3] === undefined || item[3] === '1')) ||
        THEMATIC_BREAK.test(text) ||
        ATX_HEADING.test(text) ||
        HTML_STARTS.some(k => k.paragraph && k.start.test(text)) ||
        stepFence(text, null) !== null;
      if (para && !starts) {
        if (stack.length > 0) view[i] = rest;
        return;
      }
      stack = stack.slice(0, matched);
    }
    const contained = stack.length > 0;
    // New containers this line opens.
    for (;;) {
      const text = expandLeadingTabs(rest);
      const q = QUOTE_MARK.exec(text);
      if (q) {
        stack.push({ quote: true });
        rest = text.slice(q[0].length);
        para = false;
        continue;
      }
      const m = THEMATIC_BREAK.test(text) ? null : LIST_MARK.exec(text);
      if (!m) break;
      const after = text.slice(m[0].length);
      const spaces = /^ */.exec(after)![0].length;
      const empty = after.trim() === '';
      if (para && (empty || (m[3] !== undefined && m[3] !== '1'))) break;
      const indent = m[0].length + (empty || spaces >= 5 ? 1 : spaces);
      stack.push({ quote: false, indent });
      rest = text.slice(Math.min(indent, text.length));
      para = false;
    }
    if (contained || stack.length > 0) view[i] = rest;
    fence = stepFence(rest, null);
    if (fence) {
      fenceDepth = stack.length;
      fenceLine = i;
      para = false;
      return;
    }
    const kind = readHtml ? HTML_STARTS.find(k => k.start.test(rest) && (k.paragraph || !para)) : undefined;
    if (kind) {
      marks[i] = true;
      view[i] = '';
      para = false;
      if (kind.end === null || !kind.end.test(rest.slice(rest.indexOf('<') + 1))) html = { end: kind.end, depth: stack.length };
      return;
    }
    const text = expandLeadingTabs(rest);
    if (text.trim() === '' || ATX_HEADING.test(text) || THEMATIC_BREAK.test(text) || (para && /^ {0,3}=+[ \t]*$/.test(text))) para = false;
    else if (!para && /^ {4}/.test(text)) para = false;
    else para = true;
  };
  const read = (k: number): void => {
    while (i < lines.length && i <= k + 1) {
      step();
      i++;
    }
  };
  return {
    at: k => {
      if (k < from) return lines[k];
      read(k);
      return view[k] ?? lines[k];
    },
    html: k => {
      if (k < from) return false;
      read(k);
      return marks[k] === true;
    },
  };
}

/** {@link fenceView} of `lines` from line `from`, or `lines` itself when no line could open a fence. */
export function fenceLines(lines: readonly string[], from = 0): readonly string[] {
  return mayHaveFences(lines) ? fenceView(lines, from) : lines;
}

/**
 * `[opener, closer]` line pairs of the closed fences of `lines`, each line
 * read through `read` first, in one linear pass. An opener that is never
 * closed is not a fence, and the lines after it are read as before.
 */
export function closedFenceSpans(
  lines: readonly string[],
  read: (line: string, index: number) => string = line => line,
  reading: BlockReading = {}
): [number, number][] {
  const n = lines.length;
  // Each line as its block quote, list item or HTML block has it ({@link fenceView}), then through `read`.
  const view = mayHaveFences(lines) ? fenceView(lines, 0, reading) : lines;
  const openers: (OpenFence | null)[] = view.map((line, i) => stepFence(read(line, i), null));
  // below[char]: the closing lines below that no nearer one is as long as, farthest first, so
  // their run lengths fall: an opener's closer is the last one at least as long as it is.
  const below = new Map<string, { line: number; length: number }[]>();
  const closeAfter = new Array<number>(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const open = openers[i];
    const list = open ? below.get(open.char) : undefined;
    if (open && list) {
      let lo = 0, hi = list.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].length >= open.length) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at !== -1) closeAfter[i] = list[at].line;
    }
    // A bare run (nothing after it) closes any open fence of its character no longer than itself.
    if (open && stepFence(read(view[i], i), open) === null) {
      const runs = list ?? [];
      while (runs.length > 0 && runs[runs.length - 1].length <= open.length) runs.pop();
      runs.push({ line: i, length: open.length });
      below.set(open.char, runs);
    }
  }
  const spans: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (openers[i] && closeAfter[i] !== -1) {
      spans.push([i, closeAfter[i]]);
      i = closeAfter[i] + 1;
    } else i++;
  }
  return spans;
}

/** Whether each line of `lines` lies in a closed fence ({@link closedFenceSpans}), its fence lines included. */
export function closedFencedLines(lines: readonly string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  for (const [open, close] of closedFenceSpans(lines)) inCode.fill(true, open, close + 1);
  return inCode;
}

/**
 * Whether any line could open a fence at all (a run of three backticks or tildes anywhere in
 * it): without one, every fence reading here reads no code, so a caller may skip them.
 */
export function mayHaveFences(lines: readonly string[]): boolean {
  return lines.some(line => line.includes('```') || line.includes('~~~'));
}

/**
 * Code lines as a reader closer to CommonMark has them, for writers that only
 * want to keep code out of an edit: the front matter is no Markdown; a fence
 * runs to its closer, the end of its block quote or list item ({@link fenceView}),
 * or the end of the note. Not read: indented code.
 */
export function markdownCodeLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  // From past the front matter as Obsidian finds it (lines split on \r?\n).
  const start = frontMatterLineCountOf(lines);
  // A fence in a list item or block quote as CommonMark reads it ({@link fenceView}).
  const view = fenceView(lines, start);
  let open: OpenFence | null = null;
  for (let i = start; i < lines.length; i++) {
    const next = stepFence(view[i], open);
    if (open || next) out[i] = true;
    open = next;
  }
  return out;
}
