/**
 * `@issue` markers — "open a GitHub Issue about THIS spot in the note".
 *
 * Discussion comes up anywhere in a note, but Markdown has no thread to hold a
 * question, so the marker promotes one line to an Issue. The grammar extends
 * the sample-reference convention researchers already use
 * (`@type;ID;content`), so there is nothing new to learn:
 *
 *   3차 시도에서만 수율 40%. @issue;ISS-mkd8x3k;시드 배양 시간 차이 때문인지 논의 필요
 *
 * A marker runs from `@issue` to END OF LINE, so there is at most one per line.
 * Being an explicit token it carries no false-positive risk, which is why the
 * automation may act on it deterministically while free-text scanning stays
 * banned.
 *
 * The ID is what makes the Issue stable: the topic sentence can be reworded
 * without orphaning the discussion it opened.
 *
 * Domain-only (no Obsidian/Node APIs) because three callers must agree on the
 * grammar — the plugin command that writes markers, `issue-sync` that promotes
 * them, and `validate` that reports broken ones.
 */
import { isInFrontMatter } from '../sections/documentHead';

/** Marker keyword, without the delimiter. */
export const ISSUE_MARKER_KEYWORD = '@issue';

/** Prefix of every generated marker ID. */
export const ISSUE_MARKER_ID_PREFIX = 'ISS';

/** A well-formed marker found in a note. */
export interface IssueMarker {
  /** Stable ID, e.g. `ISS-mkd8x3k`. */
  id: string;
  /** Topic sentence; becomes the Issue title. */
  title: string;
  /** 1-based line within the scanned text. */
  line: number;
}

/** A marker that was recognised but cannot be promoted. */
export interface MalformedIssueMarker {
  /** 1-based line within the scanned text. */
  line: number;
  /** The offending text, from `@issue` to end of line. */
  text: string;
  reason: 'missing-id' | 'missing-title';
}

/** Result of scanning a note for markers. */
export interface IssueMarkerScan {
  markers: IssueMarker[];
  malformed: MalformedIssueMarker[];
}

/**
 * `@issue` followed by a delimiter, an ID, and optionally a delimiter plus the
 * topic sentence. `;` is canonical; `:` is accepted for the same reason sample
 * references accept it. The ID charset excludes the delimiters so a topic
 * sentence written without an ID fails to match and is reported instead of
 * being silently mistaken for one.
 */
const MARKER_RE = /^@issue[;:]([A-Za-z0-9-]+)(?:[;:](.*))?$/i;

/**
 * Start of a marker CANDIDATE: the keyword immediately followed by a delimiter.
 *
 * The delimiter is what separates a marker from prose. Matching the bare
 * keyword meant an ordinary sentence — "자세한 건 @issue 마커 문법을 참고하세요"
 * — was read as a marker with a missing ID, and `validate` treats malformed
 * markers as a hard error, so merely mentioning the feature in a note turned
 * the push red. `AGENTS.md` documents the syntax, which makes that a likely
 * thing for a researcher to write.
 *
 * Requiring the delimiter costs nothing real: every marker the insert command
 * writes has one (see {@link renderIssueMarker}), and a genuine typo like
 * `@issue;주제만 쓴 경우` still has one and is still reported. The lookahead
 * also subsumes the old `\b`, since `@issues` is not followed by a delimiter.
 */
const MARKER_START_RE = /@issue(?=[;:])/i;

/** Opening/closing fence of a code block (up to 3 leading spaces, per CommonMark). */
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;

/**
 * Which of `lines` are code: fenced blocks (fence lines included; a fence
 * left open runs to the end) and indented code blocks — four spaces or a tab
 * after a blank line, outside a list, as the CSV export reads them (#209).
 * Blank lines between indented code lines are not flagged; they hold nothing.
 * Every reader of markers goes through this, so what the editor styles is
 * what `issue-sync` and `validate` read (#120, #224).
 */
function codeLines(lines: readonly string[]): boolean[] {
  const code: boolean[] = [];
  let inFence = false;
  let inIndented = false;
  let inList = false;
  let prevBlank = true;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      code.push(true);
      prevBlank = false;
      continue;
    }
    if (inFence) {
      code.push(true);
      continue;
    }
    if (line.trim() === '') {
      code.push(false);
      prevBlank = true;
      continue;
    }
    if (INDENTED_CODE_RE.test(line)) {
      // Indented text under a list item continues the item.
      if (inIndented || (prevBlank && !inList)) inIndented = true;
    } else {
      inIndented = false;
      inList = LIST_ITEM_RE.test(line) || (inList && !prevBlank && /^\s/.test(line));
    }
    code.push(inIndented);
    prevBlank = false;
  }
  return code;
}

const HTML_COMMENT_OPEN = '<!--';
const HTML_COMMENT_CLOSE = '-->';
const OBSIDIAN_COMMENT = '%%';

/** Start of the run of exactly `n` backticks closing a code span, or -1. */
function closingBackticks(line: string, from: number, n: number): number {
  for (let j = from; j < line.length; ) {
    if (line[j] !== '`') {
      j++;
      continue;
    }
    let k = j;
    while (k < line.length && line[k] === '`') k++;
    if (k - j === n) return j;
    j = k;
  }
  return -1;
}

/**
 * Character ranges of the comments in `md` — HTML `<!-- … -->` and Obsidian
 * `%% … %%`, either of which may run over several lines; one left open runs to
 * the end of the text. The reading view hides them, so a marker in one is
 * switched off: it is neither read nor styled (#266). Comment marks in code
 * are text — in code blocks, fenced or indented as {@link codeBlockRanges}
 * reads them, and in an inline code span.
 */
export function commentRanges(md: string): IssueMarkerRange[] {
  return scanCommentsAndSpans(md).comments;
}

/**
 * Character ranges of the inline code spans in `md` outside code blocks and
 * comments, backticks included. The reading view shows them as code, so a
 * marker starting in one is an example, not a marker (#378).
 */
export function codeSpanRanges(md: string): IssueMarkerRange[] {
  return scanCommentsAndSpans(md).spans;
}

/** What switches a marker off: a comment or an inline code span. */
export function markerHiddenRanges(md: string): IssueMarkerRange[] {
  const { comments, spans } = scanCommentsAndSpans(md);
  return [...comments, ...spans];
}

function scanCommentsAndSpans(md: string): { comments: IssueMarkerRange[]; spans: IssueMarkerRange[] } {
  const ranges: IssueMarkerRange[] = [];
  const spans: IssueMarkerRange[] = [];
  const raws = md.split('\n');
  const code = codeLines(raws.map(raw => raw.replace(/\r$/, '')));
  let open: { close: string; start: number } | undefined;
  let offset = 0;
  for (let li = 0; li < raws.length; li++) {
    const line = raws[li];
    let i = 0;
    while (!code[li] && i < line.length) {
      if (open) {
        const close = line.indexOf(open.close, i);
        if (close < 0) break;
        i = close + open.close.length;
        ranges.push({ start: open.start, end: offset + i });
        open = undefined;
      } else if (line[i] === '`') {
        let n = 1;
        while (line[i + n] === '`') n++;
        const close = closingBackticks(line, i + n, n);
        if (close >= 0) spans.push({ start: offset + i, end: offset + close + n });
        i = close < 0 ? i + n : close + n;
      } else if (line.startsWith(HTML_COMMENT_OPEN, i)) {
        open = { close: HTML_COMMENT_CLOSE, start: offset + i };
        i += HTML_COMMENT_OPEN.length;
      } else if (line.startsWith(OBSIDIAN_COMMENT, i)) {
        open = { close: OBSIDIAN_COMMENT, start: offset + i };
        i += OBSIDIAN_COMMENT.length;
      } else {
        i++;
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push({ start: open.start, end: md.length });
  return { comments: ranges, spans };
}

const inRanges = (ranges: readonly IssueMarkerRange[], at: number): boolean =>
  ranges.some(r => at >= r.start && at < r.end);

/**
 * Where the marker of `line` starts: its first candidate that `hidden` does
 * not switch off, or -1. The marker owns the rest of the line, so a candidate
 * after the first live one is part of its topic.
 */
function markerStart(line: string, hidden?: (at: number) => boolean): number {
  const re = new RegExp(MARKER_START_RE.source, 'gi');
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (!hidden?.(m.index)) return m.index;
  }
  return -1;
}

/**
 * Find every `@issue` marker in `md`.
 *
 * Code blocks, fenced or indented, are skipped: a note that documents the
 * marker syntax by example must not open issues for its own examples (#224).
 * So are markers in a comment (see {@link commentRanges}), which the reading
 * view hides (#266), and markers starting in an inline code span, which it
 * shows as code (#378).
 *
 * Expects LF-normalised text, like the other parsers here.
 */
export function parseIssueMarkers(md: string): IssueMarkerScan {
  const markers: IssueMarker[] = [];
  const malformed: MalformedIssueMarker[] = [];

  const lines = md.split('\n');
  const code = codeLines(lines);
  const comments = markerHiddenRanges(md);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    if (code[i]) continue;

    // Only the FIRST candidate matters: the marker owns the rest of the line.
    const at = markerStart(line, a => inRanges(comments, lineStart + a));
    if (at === -1) continue;

    const text = line.slice(at);
    const lineNo = i + 1;
    const m = text.match(MARKER_RE);
    if (!m) {
      malformed.push({ line: lineNo, text, reason: 'missing-id' });
      continue;
    }
    const title = (m[2] ?? '').trim();
    if (!title) {
      malformed.push({ line: lineNo, text, reason: 'missing-title' });
      continue;
    }
    markers.push({ id: m[1], title, line: lineNo });
  }

  return { markers, malformed };
}

/** Character span of a marker within the scanned text. */
export interface IssueMarkerRange {
  start: number;
  end: number;
}

/**
 * Character ranges of the WELL-FORMED markers in `text`, for editor
 * highlighting.
 *
 * Only valid markers are returned, which makes the highlight itself the
 * feedback: a marker that stays unstyled is one that will not open an issue.
 *
 * Unlike {@link parseIssueMarkers} this does not track code blocks — the editor
 * hands over arbitrary slices of the document, where a block may have opened
 * outside the slice. The editor drops the markers inside
 * {@link codeBlockRanges} of the whole document instead (#120, #224), and
 * reading mode filters code by DOM. Comments are the same, except that a
 * commented candidate can leave a live one later on its line, so the editor
 * passes `hidden` (offsets within `text`) for the {@link commentRanges} of the
 * whole document (#266).
 */
export function findIssueMarkerRanges(text: string, hidden?: (at: number) => boolean): IssueMarkerRange[] {
  const ranges: IssueMarkerRange[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    const at = markerStart(line, hidden && (a => hidden(lineStart + a)));
    if (at !== -1) {
      const m = line.slice(at).match(MARKER_RE);
      if (m && (m[2] ?? '').trim()) {
        ranges.push({ start: offset + at, end: offset + line.length });
      }
    }
    offset += line.length + 1; // + the newline consumed by split
  }
  return ranges;
}

/** A piece of a rendered line: a text node, or an inline element such as a link or bold. */
export interface InlineRun {
  text: string;
  /** A text node, which a line break inside may end the line in. */
  isText: boolean;
}

/**
 * The reading view splits a marker whose topic has a link, code, bold or
 * italics into a text node and the elements after it (#292). Given a text
 * node and the inline siblings after it up to the next line break or block,
 * where a marker starting in that text node ends: the runs after the first
 * it takes whole, the last of them only up to `endInLast`. Undefined when no
 * marker starting there runs on past the text node, which the text node
 * alone then shows. A topic made only of formatting (`@issue;ID;` then bold)
 * counts, since the line is read whole.
 */
export function markerSpanAcrossRuns(
  runs: readonly InlineRun[]
): { start: number; lastRun: number; endInLast: number } | undefined {
  if (runs.length < 2 || !runs[0].isText) return undefined;
  const first = runs[0].text;
  const lineStart = first.lastIndexOf('\n') + 1;
  let line = first.slice(lineStart);
  let lastRun = 0;
  let endInLast = first.length;
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    const nl = run.isText ? run.text.indexOf('\n') : -1;
    line += nl === -1 ? run.text : run.text.slice(0, nl);
    lastRun = i;
    endInLast = nl === -1 ? run.text.length : nl;
    if (nl !== -1) break;
  }
  const marker = findIssueMarkerRanges(line)[0];
  if (!marker || lineStart + marker.start >= first.length) return undefined;
  return { start: lineStart + marker.start, lastRun, endInLast };
}

/**
 * Character ranges of the fenced code blocks in `md`, fence lines included,
 * fenced exactly as {@link parseIssueMarkers} fences them: a marker the editor
 * styles must be one `issue-sync` and `validate` read (#120). A fence left
 * open runs to the end of the text.
 */
export function fencedCodeRanges(md: string): IssueMarkerRange[] {
  const ranges: IssueMarkerRange[] = [];
  let offset = 0;
  let start = -1;
  for (const line of md.split('\n')) {
    const end = offset + line.length;
    if (FENCE_RE.test(line)) {
      if (start === -1) {
        start = offset;
      } else {
        ranges.push({ start, end });
        start = -1;
      }
    }
    offset = end + 1;
  }
  if (start !== -1) ranges.push({ start, end: md.length });
  return ranges;
}

/**
 * Character ranges of the code blocks in `md` — fenced (fence lines included)
 * and indented — coded exactly as {@link parseIssueMarkers} skips them (#224),
 * so a marker the editor styles is one `issue-sync` and `validate` read.
 */
export function codeBlockRanges(md: string): IssueMarkerRange[] {
  const ranges: IssueMarkerRange[] = [];
  const lines = md.split('\n');
  const code = codeLines(lines);
  let offset = 0;
  let open: IssueMarkerRange | undefined;
  for (let i = 0; i < lines.length; i++) {
    const end = offset + lines[i].length;
    if (code[i]) {
      if (open) open.end = end;
      else open = { start: offset, end };
    } else if (open) {
      ranges.push(open);
      open = undefined;
    }
    offset = end + 1;
  }
  if (open) ranges.push(open);
  return ranges;
}

// Same-millisecond guard, mirroring `generateSampleId`: two markers inserted in
// one burst must not collide.
let idCounter = 0;
let lastTimestamp = 0;

/**
 * Generate a marker ID: `ISS-` plus the current timestamp in base36, with a
 * `-N` suffix when called twice within one millisecond.
 *
 * Base36 rather than the sample IDs' decimal milliseconds because this string
 * shows up in the note body AND in the Issue title, where length is felt.
 */
export function generateIssueMarkerId(): string {
  const timestamp = Date.now();
  if (timestamp === lastTimestamp) {
    idCounter++;
  } else {
    idCounter = 0;
    lastTimestamp = timestamp;
  }
  const suffix = idCounter > 0 ? `-${idCounter}` : '';
  return `${ISSUE_MARKER_ID_PREFIX}-${timestamp.toString(36)}${suffix}`;
}

/**
 * Give every marker in `md` a new ID from `newId`, keeping its delimiters,
 * topic and line endings; returns the text and how many IDs changed. For a
 * copied note (#89): its markers would otherwise share their IDs with the
 * original's, merging both discussions into one issue. Markers are found as
 * {@link parseIssueMarkers} finds them (code and comments skipped), so what
 * `issue-sync` and `validate` read is what gets a new ID.
 */
export function reassignIssueMarkerIds(
  md: string,
  newId: () => string = generateIssueMarkerId
): { content: string; count: number } {
  let count = 0;
  const raws = md.split('\n');
  const code = codeLines(raws.map(raw => raw.replace(/\r$/, '')));
  const comments = markerHiddenRanges(md);
  let offset = 0;
  const lines = raws.map((raw, i) => {
    const lineStart = offset;
    offset += raw.length + 1;
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (code[i]) return raw;
    const at = markerStart(line, a => inRanges(comments, lineStart + a));
    if (at === -1) return raw;
    const m = line.slice(at).match(MARKER_RE);
    if (!m) return raw;
    const idStart = at + ISSUE_MARKER_KEYWORD.length + 1;
    count++;
    return line.slice(0, idStart) + newId() + line.slice(idStart + m[1].length) + cr;
  });
  return { content: lines.join('\n'), count };
}

/**
 * `md` with every marker {@link parseIssueMarkers} would read replaced by its
 * topic sentence (#354), for text sent to a model: a marker copied into the
 * reply would open a second issue, or fail `validate` once reworded. A
 * marker without a topic is dropped. Code and comments are left as they are.
 */
export function stripIssueMarkers(md: string): string {
  const raws = md.split('\n');
  const code = codeLines(raws.map(raw => raw.replace(/\r$/, '')));
  const comments = markerHiddenRanges(md);
  let offset = 0;
  return raws
    .map((raw, i) => {
      const lineStart = offset;
      offset += raw.length + 1;
      if (code[i]) return raw;
      const cr = raw.endsWith('\r') ? '\r' : '';
      const line = cr ? raw.slice(0, -1) : raw;
      const at = markerStart(line, a => inRanges(comments, lineStart + a));
      if (at === -1) return raw;
      const topic = (line.slice(at).match(MARKER_RE)?.[2] ?? '').trim();
      const before = line.slice(0, at).trimEnd();
      return (topic ? (before ? `${before} ${topic}` : topic) : before) + cr;
    })
    .join('\n');
}

/**
 * `text` with the `@` taken off every `@issue;`/`@issue:` in it (#354), for a
 * model's reply going into a note: whatever the model wrote, nothing in it
 * opens an issue or reads as a broken marker.
 */
export function neutralizeIssueMarkers(text: string): string {
  return text.replace(new RegExp(`@(issue)(?=[;:])`, 'gi'), '$1');
}

/** Reset the ID counter (tests only). */
export function resetIssueMarkerIdCounter(): void {
  idCounter = 0;
  lastTimestamp = 0;
}

/** The canonical text of a marker, as the insert command writes it. */
export function renderIssueMarker(marker: { id: string; title: string }): string {
  return `${ISSUE_MARKER_KEYWORD};${marker.id};${marker.title}`;
}

/**
 * Where the insert command puts a marker: one edit plus the caret offset, or
 * the reason it refuses.
 */
export type IssueMarkerInsertion =
  | { edit: { from: number; to: number; insert: string }; cursor: number }
  | { reason: 'conflict' | 'table' | 'frontMatter' | 'codeBlock' | 'comment' };

const isHeadingLine = (line: string): boolean => /^ {0,3}#{1,6}(?:\s|$)/.test(line);
const isTableRow = (line: string): boolean => /^\s*\|/.test(line);

/**
 * Whether `line` holds a sample reference the marker would damage (#373): an
 * `ID;alias` (or `ID|alias`) anywhere, whose alias runs to the next `;` and
 * so would take in a marker appended to the line, or a sentence that is an
 * ID alone, which the prefilled topic would replace. Any type's IDs count,
 * since the types in use are not known here.
 */
export function lineHasSampleReference(line: string): boolean {
  const sentence = issueSentenceRange(line, 0)?.text ?? '';
  return (
    /(?:^|[^\w-])[A-Za-z][A-Za-z0-9_]*-\d+(?:-\d+)*[;|]/.test(line) ||
    /^(?:@[A-Za-z][\w-]*[;:])?[A-Za-z][A-Za-z0-9_]*-\d+(?:-\d+)*$/.test(sentence)
  );
}

/**
 * Plan inserting a marker for the selection `[from, to)` of `doc` (`from ===
 * to` for a bare caret). The selected text becomes the topic.
 *
 * A marker owns everything up to the end of its line, so replacing a selection
 * in place is only safe when nothing but whitespace follows it. Otherwise the
 * rest of the sentence would leak into the Issue title, so the line is left
 * intact and the marker goes at its end. A selection that starts after the
 * line's text begins (see {@link issueSentenceRange}) is not replaced either:
 * that would delete the end of a sentence (#135). The note is somebody's
 * record; the command must not reword it.
 *
 * - Heading line: the marker goes on a new line below. Text appended to
 *   `### [UHW..]` would change the unit op's alias, and with it the TOC entry
 *   and the section name the Issue reports.
 * - Table row: refused (`table`). Appended text is an excess cell GitHub hides,
 *   and a line below would cut the table in two.
 * - A line that would end up with two markers is refused (`conflict`): only
 *   the first is read, so the second would merge into its title.
 * - A selection starting in the front matter, its `---` lines included, is
 *   refused (`frontMatter`): a marker there is broken YAML, not an issue (#87).
 * - A line in a code block, fenced (fences included, #120) or indented (#224),
 *   is refused (`codeBlock`): the automation skips code, so the marker would
 *   open no issue.
 * - A marker that would land in a comment is refused (`comment`) for the same
 *   reason (#266).
 *
 * `topic`, when given, is the topic instead of the selected text (#100: typed
 * for a bare caret). Where the marker goes is decided the same way.
 */
export function planIssueMarkerInsertion(
  doc: string,
  from: number,
  to: number,
  id: string,
  topic?: string
): IssueMarkerInsertion {
  if (from > to) [from, to] = [to, from];
  if (isInFrontMatter(doc, from)) return { reason: 'frontMatter' };
  // A selection that swallowed its line break (triple-click) ends on that line.
  while (to > from && doc[to - 1] === '\n') to--;

  const selected = doc.slice(from, to);
  // A multi-line selection is never replaced: that would fold a list or a
  // paragraph into the marker line (#200). Its lines, without their list and
  // quote marks, make the topic.
  const multiLine = topic === undefined && selected.includes('\n');
  const title = multiLine
    ? selected
        .split('\n')
        .map(l => l.replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/, '').trim())
        .filter(Boolean)
        .join(' ')
    : (topic ?? selected).trim().replace(/\s*\n\s*/g, ' ');
  const marker = renderIssueMarker({ id, title });
  const lineStartOf = (i: number): number => (i === 0 ? 0 : doc.lastIndexOf('\n', i - 1) + 1);
  const lineEndOf = (i: number): number => {
    const nl = doc.indexOf('\n', i);
    return nl === -1 ? doc.length : nl;
  };
  const pad = (i: number, lineStart: number): string =>
    i > lineStart && !/\s/.test(doc[i - 1]) ? ' ' : '';

  const toLineEnd = lineEndOf(to);
  const sentence = issueSentenceRange(doc, from);
  const appendAtEnd =
    multiLine || doc.slice(to, toLineEnd).trim() !== '' || (sentence !== undefined && from > sentence.from);
  const anchor = appendAtEnd ? to : from;
  const lineStart = lineStartOf(anchor);
  const lineEnd = lineEndOf(anchor);
  const line = doc.slice(lineStart, lineEnd);

  if (codeBlockRanges(doc).some(r => lineStart >= r.start && lineStart <= r.end)) {
    return { reason: 'codeBlock' };
  }

  let edit: { from: number; to: number; insert: string };
  if (isHeadingLine(line)) {
    edit = { from: lineEnd, to: lineEnd, insert: '\n' + marker };
  } else if (lineHasSampleReference(line)) {
    // Under the line, indented to continue its list item rather than start
    // a new one, which the section's sample list would read.
    const prefix = line.slice(0, (issueSentenceRange(line, 0)?.from ?? 0));
    const indent = prefix.replace(/[-*+]|\d+[.)]|\[[^\]\n]\]/g, m => ' '.repeat(m.length));
    edit = { from: lineEnd, to: lineEnd, insert: '\n' + indent + marker };
  } else if (appendAtEnd) {
    edit = { from: lineEnd, to: lineEnd, insert: pad(lineEnd, lineStart) + marker };
  } else {
    const lead = /^[ \t]*/.exec(doc.slice(from, to))![0];
    edit = { from, to, insert: (lead || pad(from, lineStart)) + marker };
  }

  // Judged on the note as it would read, since the marker may open or close
  // a comment's line.
  const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
  const comments = commentRanges(after);
  const markerAt = edit.from + edit.insert.length - marker.length;
  if (inRanges(comments, markerAt)) return { reason: 'comment' };
  // After the comment check, so a commented-out table line gets the comment
  // reason (#282); before the conflict one, so a table row holding a marker
  // is still refused as a table.
  if (isTableRow(line)) return { reason: 'table' };
  const resultStart = after.lastIndexOf('\n', markerAt - 1) + 1;
  const resultEnd = after.indexOf('\n', markerAt);
  const resultLine = after.slice(resultStart, resultEnd === -1 ? after.length : resultEnd);
  const hidden = markerHiddenRanges(after);
  let live = 0;
  for (const m of resultLine.matchAll(new RegExp(MARKER_START_RE.source, 'gi'))) {
    if (!inRanges(hidden, resultStart + m.index!)) live++;
  }
  if (live > 1) return { reason: 'conflict' };
  return { edit, cursor: edit.from + edit.insert.length };
}

/**
 * The sentence on the line holding `offset`, to prefill the topic when nothing
 * is selected (#100). Leading Markdown syntax is left out: quote marks (`> `),
 * a list marker (`- `, `1. `) with its task box (`[ ] `), or heading hashes.
 * Selecting `[from, to)` and planning the marker gives what selecting that
 * sentence by hand would. Undefined for a line with no text.
 */
export function issueSentenceRange(
  doc: string,
  offset: number
): { from: number; to: number; text: string } | undefined {
  const lineStart = offset <= 0 ? 0 : doc.lastIndexOf('\n', offset - 1) + 1;
  const nl = doc.indexOf('\n', offset);
  const line = doc.slice(lineStart, nl === -1 ? doc.length : nl).replace(/\r$/, '');
  const prefix = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}(?=[ \t]|$)|(?:[-*+]|\d+[.)])[ \t]+(?:\[[^\]\n]\](?=[ \t]|$))?)?/.exec(
    line
  )![0];
  const body = line.slice(prefix.length);
  const text = body.trim();
  if (!text) return undefined;
  const from = lineStart + prefix.length + (body.length - body.trimStart().length);
  return { from, to: from + text.length, text };
}

/**
 * Text of the nearest Markdown heading at or above `line` (1-based), or
 * undefined when the marker sits before any heading. Gives the Issue the
 * section it came from (`Results` vs `Methods`) without copying the note.
 *
 * Headings inside code blocks are ignored, for the same reason markers are.
 */
export function findEnclosingHeading(md: string, line: number): string | undefined {
  const lines = md.split('\n');
  const code = codeLines(lines);

  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    if (code[i]) continue;
    const m = lines[i].match(/^#{1,6}\s+(.*?)\s*$/);
    if (m && m[1]) return m[1];
  }
  return undefined;
}
