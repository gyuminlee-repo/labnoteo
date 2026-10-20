/**
 * Surgical, whitespace-preserving section edits.
 *
 * Like {@link appendUnitOpToWorkflowToc}, these helpers deliberately avoid a
 * full parse → re-serialize round-trip (which would normalise unrecognised
 * headings and blank lines). LLM tools and edit-adjacent commands use them to
 * touch exactly one section without disturbing the rest of the document.
 */

import { escapeRegExp } from '../lib/regexUtils';

export interface SectionEditResult {
  ok: boolean;
  md: string;
  /** What the replaced body held, when `ok`. */
  removed?: SectionBody;
}

/** The current body of one section, as {@link sectionBodyAt} reads it. */
export interface SectionBody {
  /** Body text without the blank lines framing it. */
  text: string;
  /** Non-blank lines in the body. */
  lines: number;
  /** Nested headings in the body (they are replaced along with it). */
  subheadings: number;
}

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
  if (open === null) return { char: run[0], length: run.length };

  const afterRun = line.slice(line.indexOf(run) + run.length);
  const closes = run[0] === open.char && run.length >= open.length && afterRun.trim() === '';
  return closes ? null : open;
}

/** One heading that {@link findSectionMatches} found. */
export interface SectionMatch {
  /** 0-based line index of the heading line. */
  line: number;
  /** Number of `#`s. */
  level: number;
  /** Text of the nearest enclosing heading (fewer `#`s), or '' at top level. */
  parentHeading: string;
  /** 1-based position among the matches, in document order. */
  occurrence: number;
}

const ANY_HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Heading text as {@link findSectionMatches} compares it when no heading
 * matches exactly (#145): emoji, variation selectors and square brackets
 * dropped, case and runs of spaces ignored. README headings carry emoji
 * (`## 🧪 Related Workflows`) a caller rarely types.
 */
export function normalizeHeadingText(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One heading of a note, outside code fences. */
export interface NoteHeading {
  /** 0-based line index. */
  line: number;
  level: number;
  text: string;
  /** Text of the nearest enclosing heading (fewer `#`s), or '' at top level. */
  parentHeading: string;
}

/** Every heading of `md` outside code fences, in document order. */
export function listHeadings(md: string): NoteHeading[] {
  const lines = md.split(/\r?\n/);
  const ancestors: { level: number; text: string }[] = [];
  const out: NoteHeading[] = [];
  // A fenced code block can contain lines that look like ATX headings; those
  // must NOT be treated as real headings.
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const h = lines[i].match(ANY_HEADING_RE);
    if (!h) continue;
    const level = h[1].length;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= level) ancestors.pop();
    out.push({ line: i, level, text: h[2], parentHeading: ancestors[ancestors.length - 1]?.text ?? '' });
    ancestors.push({ level, text: h[2] });
  }
  return out;
}

/**
 * Every heading whose text is `heading` (at any level), outside code fences,
 * with its enclosing heading. A workflow note repeats `#### Method` under each
 * `### [USW230 …]` unit operation, so one heading text can name many sections.
 * Only when none matches exactly are headings compared by
 * {@link normalizeHeadingText} (#145).
 */
export function findSectionMatches(md: string, heading: string): SectionMatch[] {
  const lines = md.split(/\r?\n/);
  const headingRe = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`);
  const headings = listHeadings(md);
  let found = headings.filter(h => headingRe.test(lines[h.line]));
  if (found.length === 0) {
    const wanted = normalizeHeadingText(heading);
    found = wanted ? headings.filter(h => normalizeHeadingText(h.text) === wanted) : [];
  }
  return found.map((h, i) => ({ line: h.line, level: h.level, parentHeading: h.parentHeading, occurrence: i + 1 }));
}

/**
 * `content` without a first line that repeats the target section's heading
 * (#162): models often send the heading along with the body, which then
 * appeared twice. `heading` is the target's text; the comparison is the same
 * as {@link findSectionMatches}'s fallback. Blank lines it leaves at the top go too.
 */
export function stripRepeatedHeading(content: string, heading: string): string {
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex(l => l.trim() !== '');
  if (first === -1) return content;
  const h = lines[first].trim().match(ANY_HEADING_RE);
  if (!h || normalizeHeadingText(h[2]) !== normalizeHeadingText(heading)) return content;
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  return rest.join('\n');
}

/**
 * Replace the body of the Markdown section whose heading text is `heading`
 * (matched at any level `#`..`######`) with `newBody`. When several headings
 * match, the first one wins; use {@link findSectionMatches} and
 * {@link replaceSectionBodyAt} to pick another.
 *
 * Returns `{ ok: false, md }` unchanged when the heading is not found.
 */
export function replaceSectionBody(
  md: string,
  heading: string,
  newBody: string
): SectionEditResult {
  const [first] = findSectionMatches(md, heading);
  return first ? replaceSectionBodyAt(md, first.line, newBody) : { ok: false, md };
}

/**
 * Replace the body of the section whose heading is on 0-based line `line`.
 *
 * The section body runs from just after the heading line up to — but not
 * including — the next heading of the **same or higher** level (so nested
 * sub-headings are treated as part of the body). The heading line itself is
 * preserved; the new body is framed by exactly one blank line on each side.
 *
 * Returns `{ ok: false, md }` unchanged when that line is not a heading. CRLF
 * vs LF endings are detected and preserved.
 */
export function replaceSectionBodyAt(md: string, line: number, newBody: string): SectionEditResult {
  const newline = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const headingIdx = line;
  const m = lines[headingIdx]?.match(ANY_HEADING_RE);
  if (!m) return { ok: false, md };
  const bodyEnd = sectionBodyEnd(lines, headingIdx, m[1].length);

  const bodyLines = newBody === '' ? [''] : ['', ...newBody.split('\n'), ''];
  const next: string[] = [
    ...lines.slice(0, headingIdx + 1),
    ...bodyLines,
    ...lines.slice(bodyEnd),
  ];

  return { ok: true, md: next.join(newline), removed: summarizeBody(lines.slice(headingIdx + 1, bodyEnd)) };
}

/**
 * The body of the section whose heading is on 0-based line `line` — what
 * {@link replaceSectionBodyAt} would replace — or undefined when that line is
 * not a heading.
 */
export function sectionBodyAt(md: string, line: number): SectionBody | undefined {
  const lines = md.split(/\r?\n/);
  const m = lines[line]?.match(ANY_HEADING_RE);
  if (!m) return undefined;
  return summarizeBody(lines.slice(line + 1, sectionBodyEnd(lines, line, m[1].length)));
}

/**
 * The non-blank lines only `before` has (`removed`) and only `after` has
 * (`added`), each in its own order. A line repeated in both counts as many
 * times as it occurs, so dropping one of two identical lines shows. Used to
 * show what an `update_section` call would erase: it always sends the whole
 * body, so even an appended line arrives as old body + new line (#187).
 */
export function diffBodyLines(before: string, after: string): { removed: string[]; added: string[] } {
  const lines = (s: string): string[] =>
    s
      .split(/\r?\n/)
      .map(l => l.trimEnd())
      .filter(l => l.trim() !== '');
  const left = lines(before);
  const right = lines(after);
  const remaining = new Map<string, number>();
  for (const l of right) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of left) {
    const n = remaining.get(l) ?? 0;
    if (n > 0) remaining.set(l, n - 1);
    else removed.push(l);
  }
  const kept = new Map<string, number>();
  for (const l of left) kept.set(l, (kept.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of right) {
    const n = kept.get(l) ?? 0;
    if (n > 0) kept.set(l, n - 1);
    else added.push(l);
  }
  return { removed, added };
}

function summarizeBody(body: readonly string[]): SectionBody {
  let subheadings = 0;
  let fence: OpenFence | null = null;
  for (const l of body) {
    const next = stepFence(l, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (!fence && ANY_HEADING_RE.test(l)) subheadings++;
  }
  return {
    text: body.join('\n').replace(/^\s*\n/, '').trimEnd(),
    lines: body.filter(l => l.trim() !== '').length,
    subheadings,
  };
}

/**
 * Index of the line that ends the body of the level-`level` section whose
 * heading is on `headingIdx`: the next heading of the same or higher level
 * (#count <= level), or `lines.length`.
 */
export function sectionBodyEnd(lines: readonly string[], headingIdx: number, level: number): number {
  // The heading was matched outside any fence, so restart fence tracking here;
  // a `#` line inside a code block after the heading is not a real boundary.
  const boundaryRe = new RegExp(`^#{1,${level}}\\s`);
  let bodyFence: OpenFence | null = null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const next = stepFence(lines[i], bodyFence);
    if (next !== bodyFence) {
      bodyFence = next;
      continue;
    }
    if (bodyFence) continue;
    if (boundaryRe.test(lines[i])) return i;
  }
  return lines.length;
}
