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

/**
 * Find every `@issue` marker in `md`.
 *
 * Fenced code blocks are skipped: a note that documents the marker syntax by
 * example must not open issues for its own examples.
 *
 * Expects LF-normalised text, like the other parsers here.
 */
export function parseIssueMarkers(md: string): IssueMarkerScan {
  const markers: IssueMarker[] = [];
  const malformed: MalformedIssueMarker[] = [];
  let inFence = false;

  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Only the FIRST candidate matters: the marker owns the rest of the line.
    const at = line.search(MARKER_START_RE);
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
 * Unlike {@link parseIssueMarkers} this does not track code fences — the editor
 * hands over arbitrary slices of the document, where a fence may have opened
 * outside the slice. The editor drops the markers inside
 * {@link fencedCodeRanges} of the whole document instead (#120), and reading
 * mode filters code by DOM.
 */
export function findIssueMarkerRanges(text: string): IssueMarkerRange[] {
  const ranges: IssueMarkerRange[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const at = line.search(MARKER_START_RE);
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
 * {@link parseIssueMarkers} finds them (fenced code skipped), so what
 * `issue-sync` and `validate` read is what gets a new ID.
 */
export function reassignIssueMarkerIds(
  md: string,
  newId: () => string = generateIssueMarkerId
): { content: string; count: number } {
  let count = 0;
  let inFence = false;
  const lines = md.split('\n').map(raw => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return raw;
    }
    if (inFence) return raw;
    const at = line.search(MARKER_START_RE);
    if (at === -1) return raw;
    const m = line.slice(at).match(MARKER_RE);
    if (!m) return raw;
    const idStart = at + ISSUE_MARKER_KEYWORD.length + 1;
    count++;
    return line.slice(0, idStart) + newId() + line.slice(idStart + m[1].length) + cr;
  });
  return { content: lines.join('\n'), count };
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
  | { reason: 'conflict' | 'table' | 'frontMatter' | 'codeBlock' };

const isHeadingLine = (line: string): boolean => /^ {0,3}#{1,6}(?:\s|$)/.test(line);
const isTableRow = (line: string): boolean => /^\s*\|/.test(line);

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
 * - A line in a fenced code block, fences included, is refused (`codeBlock`):
 *   the automation skips code, so the marker would open no issue (#120).
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

  const title = (topic ?? doc.slice(from, to)).trim().replace(/\s*\n\s*/g, ' ');
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
  const appendAtEnd = doc.slice(to, toLineEnd).trim() !== '' || (sentence !== undefined && from > sentence.from);
  const anchor = appendAtEnd ? to : from;
  const lineStart = lineStartOf(anchor);
  const lineEnd = lineEndOf(anchor);
  const line = doc.slice(lineStart, lineEnd);

  if (fencedCodeRanges(doc).some(r => lineStart >= r.start && lineStart <= r.end)) {
    return { reason: 'codeBlock' };
  }
  if (isTableRow(line)) return { reason: 'table' };

  let edit: { from: number; to: number; insert: string };
  let resultLine: string;
  if (isHeadingLine(line)) {
    edit = { from: lineEnd, to: lineEnd, insert: '\n' + marker };
    resultLine = marker;
  } else if (appendAtEnd) {
    const insert = pad(lineEnd, lineStart) + marker;
    edit = { from: lineEnd, to: lineEnd, insert };
    resultLine = line + insert;
  } else {
    const lead = /^[ \t]*/.exec(doc.slice(from, to))![0];
    const insert = (lead || pad(from, lineStart)) + marker;
    edit = { from, to, insert };
    resultLine = doc.slice(lineStart, from) + insert + doc.slice(to, toLineEnd);
  }

  const candidates = resultLine.match(new RegExp(MARKER_START_RE.source, 'gi')) ?? [];
  if (candidates.length > 1) return { reason: 'conflict' };
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
 * Headings inside fenced code are ignored, for the same reason markers are.
 */
export function findEnclosingHeading(md: string, line: number): string | undefined {
  const lines = md.split('\n');
  const fenced = new Set<number>();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      fenced.add(i);
      continue;
    }
    if (inFence) fenced.add(i);
  }

  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    if (fenced.has(i)) continue;
    const m = lines[i].match(/^#{1,6}\s+(.*?)\s*$/);
    if (m && m[1]) return m[1];
  }
  return undefined;
}
