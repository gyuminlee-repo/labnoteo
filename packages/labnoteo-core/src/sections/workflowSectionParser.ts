/**
 * Surgical, whitespace-preserving edits to a workflow's `## Related Unit
 * Operations` table of contents.
 *
 * The lossy full-document parser/serializer (`parseWorkflowMd` /
 * `serializeWorkflowMd`) was removed — it normalised unrecognised headings and
 * whitespace, which corrupted user edits. The Obsidian port instead inserts
 * unit-op blocks at the cursor and keeps the TOC in sync with these targeted
 * helpers.
 */
import { normalizeHeadingText, stepFence, type OpenFence } from './sectionEdit';
import { joinLineBuffer, spliceLineBuffer, splitLineBuffer } from '../util/lineEnds';
import { frontMatterLineCount } from './frontMatter';

export const UNIT_OP_HEADING_PATTERN = /^###\s+\[([A-Z]+\d+)\s+(.+?)\]\s*(.*)/;

const UNIT_OP_SECTION_NAMES = ['related unit operations', '관련 유닛 오퍼레이션'];

/** Whether a `##` title names the unit-operation section, emoji, case and translation aside (#402). */
export function isUnitOpSectionTitle(title: string): boolean {
  const text = normalizeHeadingText(title);
  return UNIT_OP_SECTION_NAMES.some(name => text.includes(name));
}

/** Whether `text` is a unit-operation TOC entry, `- [UHW010 Mixing](#…)`; a `- [ ] task` is not. */
export function isUnitOpTocEntryLine(text: string): boolean {
  return /^\s*- \[[A-Z]+\d+\s(?:\\.|[^\\])*?\]\(#[^)\s]*\)/.test(text);
}

/**
 * The workflow's title, `## [WD070 Name]`. The same shape as `lib/workflowStructure`'s,
 * kept here so `sections` does not import `lib`.
 */
const WORKFLOW_TITLE_RE = /^##\s+\[[A-Z]{2}\d{3}\s+[^\]]+\]/;

/** The heading {@link ensureUnitOpSection} writes. */
const UNIT_OP_SECTION_HEADING = '## Related Unit Operations';

/**
 * Line index of the unit-operation section's `##` heading, or -1 (#402). The
 * heading is matched loosely, as the README's Related Workflows is: any `##`
 * naming it in English or Korean. Failing that, the first `##` section holding
 * a `### [ID …]` block or a TOC entry is taken, since a heading renamed to
 * anything else still has its unit operations under it — but not the
 * workflow's title: with the heading deleted its blocks fall under the title,
 * and the TOC would go between the title and its description (#564). Fenced
 * lines are skipped.
 */
export function findUnitOpSection(lines: readonly { text: string; fenced: boolean }[]): number {
  const isH2 = (j: number): boolean => !lines[j].fenced && /^##\s/.test(lines[j].text);
  const named = lines.findIndex((_, j) => isH2(j) && isUnitOpSectionTitle(lines[j].text.replace(/^##\s+/, '')));
  if (named !== -1) return named;
  for (let j = 0; j < lines.length; j++) {
    if (!isH2(j)) continue;
    const title = WORKFLOW_TITLE_RE.test(lines[j].text);
    let k = j + 1;
    for (; k < lines.length && !isH2(k); k++) {
      const { text, fenced } = lines[k];
      if (!title && !fenced && (UNIT_OP_HEADING_PATTERN.test(text) || isUnitOpTocEntryLine(text))) return j;
    }
    j = k - 1;
  }
  return -1;
}

/**
 * The edit that puts `## Related Unit Operations` back when a note has unit
 * operations but no section for them (#564), or null when none is needed.
 * The heading goes before the first TOC entry left without it, else after the
 * workflow title's description quote (where the template has it), else before
 * the first unit-operation block. A note without unit operations is left
 * alone unless the first one would land under the workflow title.
 */
export function missingUnitOpSectionEdit(md: string): { offset: number; text: string } | null {
  const lines = scanLines(md);
  if (findUnitOpSection(lines) !== -1) return null;
  const firstBlock = lines.findIndex(l => !l.fenced && UNIT_OP_HEADING_PATTERN.test(l.text));
  const firstEntry = lines.findIndex(l => !l.fenced && isUnitOpTocEntryLine(l.text));
  const title = lines.findIndex(l => !l.fenced && WORKFLOW_TITLE_RE.test(l.text));
  if (firstBlock === -1 && firstEntry === -1) {
    if (title === -1) return null;
    // The first block goes before the conclusions, into the section above them:
    // one the researcher renamed takes it, as it did before (#455).
    const conclusions = findConclusionsIdx(lines);
    for (let j = (conclusions === -1 ? lines.length : conclusions) - 1; j > title; j--) {
      if (!lines[j].fenced && /^##\s/.test(lines[j].text)) return null;
    }
  }
  const nl = md.includes('\r\n') ? '\r\n' : '\n';
  if (firstEntry !== -1 && (firstBlock === -1 || firstEntry < firstBlock)) {
    return { offset: lines[firstEntry].start, text: `${UNIT_OP_SECTION_HEADING}${nl}${nl}` };
  }
  if (title !== -1 && (firstBlock === -1 || title < firstBlock)) {
    const stop = firstBlock === -1 ? lines.length : firstBlock;
    let last = title;
    let j = title + 1;
    while (j < stop && lines[j].text.trim() === '') j++;
    while (j < stop && /^\s*>/.test(lines[j].text)) last = j++;
    return { offset: lines[last].end, text: `${nl}${nl}${UNIT_OP_SECTION_HEADING}` };
  }
  if (firstBlock === -1) return null;
  let start = firstBlock;
  let j = firstBlock - 1;
  while (j >= 0 && lines[j].text.trim() === '') j--;
  if (j >= 0 && lines[j].text.trim() === '---') start = j;
  return { offset: lines[start].start, text: `${UNIT_OP_SECTION_HEADING}${nl}${nl}` };
}

/** `md` with {@link missingUnitOpSectionEdit} applied. */
export function ensureUnitOpSection(md: string): string {
  const edit = missingUnitOpSectionEdit(md);
  return edit ? md.slice(0, edit.offset) + edit.text + md.slice(edit.offset) : md;
}

/** {@link findUnitOpSection} on a whole note: the 0-based line of its unit-operation `##` heading, or -1. */
export function unitOpSectionLine(md: string): number {
  return findUnitOpSection(scanLines(md));
}

/** Line index of the note's conclusions `##` heading (`## Conclusions and Discussion`), or -1. */
function findConclusionsIdx(lines: readonly { text: string; fenced: boolean }[]): number {
  return lines.findIndex(l => {
    if (l.fenced || !/^##\s/.test(l.text)) return false;
    const text = normalizeHeadingText(l.text.replace(/^##\s+/, ''));
    return text.includes('conclusion') || text.includes('결론');
  });
}

/**
 * The anchor GitHub gives a heading with this text, before de-duplication:
 * ASCII letters lowercased, everything but letters/marks/numbers/`_`/`-`/space
 * dropped, then each space turned into `-` (runs are not collapsed). Non-ASCII
 * letters keep their case and Korean text is kept.
 *
 * The TOC links target GitHub's rendering of the note; Obsidian resolves `#`
 * links by heading text instead, so it navigates via its Outline view.
 */
export function githubHeadingAnchor(text: string): string {
  return text
    .trim()
    .replace(/[A-Z]/g, c => c.toLowerCase())
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Build a single Related-Unit-Operations TOC line for a unit op.
 *
 * `anchor` defaults to the heading's base {@link githubHeadingAnchor}; pass the
 * de-duplicated one (`-1`, `-2`, ...) when the note is known, as
 * {@link rebuildUnitOpToc} does.
 */
export function buildUnitOpTocLine(
  opId: string,
  opName: string,
  alias?: string,
  anchor?: string
): string {
  // Escaped like a checklist label, or a lone bracket breaks the link (#367).
  const label = `${opId} ${opName}${alias ? ' | ' + alias : ''}`.replace(/[\\[\]]/g, '\\$&');
  const headingText = `[${opId} ${opName}]${alias ? ' ' + alias : ''}`;
  return `- [${label}](#${anchor ?? githubHeadingAnchor(headingText)})`;
}

/**
 * Append one unit-op entry to the `## Related Unit Operations` TOC **without
 * re-serializing the whole document**.
 *
 * The Obsidian port inserts unit-op blocks at the cursor rather than round-
 * tripping through a full-document serializer (which would normalise
 * unrecognised headings/whitespace — the very lossiness that motivated dropping
 * the Section Editor). This helper performs a surgical, whitespace-preserving
 * edit:
 *
 * - Appends after the last existing `- [...]` entry in the section, if any.
 * - Otherwise inserts right after the heading's blank line, keeping a blank
 *   separator before any following prose (e.g. the template hint blockquotes).
 * - Returns the input unchanged when the section is absent.
 *
 * CRLF vs LF line endings are detected and preserved.
 */
export function appendUnitOpToWorkflowToc(
  md: string,
  opId: string,
  opName: string,
  alias?: string
): string {
  // Every other line keeps its own line break, even in mixed endings.
  const buf = splitLineBuffer(md);
  const { lines } = buf;

  const headingIdx = findUnitOpSection(scanLines(md));
  if (headingIdx === -1) return md;

  // Section spans until the next `## ` heading or a thematic break `---`.
  let endIdx = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j]) || lines[j].trim() === '---') {
      endIdx = j;
      break;
    }
  }

  const entryLine = buildUnitOpTocLine(opId, opName, alias);

  const isEntry = (j: number): boolean => /^\s*- \[/.test(lines[j]);
  let lastEntry = -1;
  for (let j = headingIdx + 1; j < endIdx; j++) {
    if (isEntry(j)) lastEntry = j;
  }

  // A last `- [` line in a code example (fences read line by line): the entry
  // goes after the last one before it out of every fence, or nowhere when none
  // is. Only a fence opened unindented in the section and closed there counts, and
  // only when no fence line before it was indented: an indented one may belong
  // to a list item and end with it (CommonMark), which this reading does not see.
  // Nor after a line that may start an HTML block (`<` at up to three spaces): a
  // fence in an HTML block is no code there. Nor when a fence closes on a line with
  // anything but spaces and tabs after its run (an NBSP, say): this reading takes
  // that for a closer, CommonMark does not. Nor when a line holds a lone CR: CommonMark
  // ends a line there, this reading (split on LF) does not.
  if (lastEntry !== -1) {
    const opener: number[] = [];
    const closed = new Set<number>();
    let fence: OpenFence | null = null;
    let at = -1;
    let indented = false;
    let oddClose = false;
    // No fence in the front matter, as scanLines reads it.
    const frontMatter = frontMatterLineCount(md);
    for (let j = 0; j < endIdx; j++) {
      const next: OpenFence | null = j < frontMatter ? fence : stepFence(lines[j], fence);
      if (next !== fence && j < lastEntry && /^\s/.test(lines[j])) indented = true;
      if (fence === null && next !== null) at = j;
      opener.push(fence !== null || next !== null ? at : -1);
      if (fence !== null && next === null) {
        closed.add(at);
        if (!/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(lines[j])) oddClose = true;
      }
      fence = next;
    }
    const html = lines.slice(0, lastEntry).some(l => /^ {0,3}</.test(l));
    const loneCr = lines.slice(0, endIdx).some(l => l.includes('\r'));
    const inCode = (j: number): boolean =>
      !indented && !html && !oddClose && !loneCr && opener[j] > headingIdx && closed.has(opener[j]) && /^[`~]/.test(lines[opener[j]]);
    if (inCode(lastEntry)) {
      let alt = -1;
      for (let j = lastEntry - 1; j > headingIdx && alt === -1; j--) if (isEntry(j) && opener[j] === -1) alt = j;
      if (alt === -1) return md;
      lastEntry = alt;
    }
  }

  if (lastEntry !== -1) {
    spliceLineBuffer(buf, lastEntry + 1, 0, [entryLine]);
  } else {
    let insertAt = headingIdx + 1;
    // Skip the single blank line that follows the heading.
    if (lines[insertAt] !== undefined && lines[insertAt].trim() === '') insertAt++;
    const toInsert = [entryLine];
    // Keep a blank separator before following non-blank prose.
    if (lines[insertAt] !== undefined && lines[insertAt].trim() !== '') toInsert.push('');
    spliceLineBuffer(buf, insertAt, 0, toInsert);
  }

  return joinLineBuffer(buf);
}

/**
 * Character offset at which a new unit-op block belongs: the end of the
 * `## Related Unit Operations` section, i.e. immediately before the `## `
 * heading that follows it (`## Conclusions and Discussion` in the template).
 *
 * Unlike the TOC helpers above, the scan deliberately does NOT stop at a `---`
 * line. Every unit-op block starts with one, so the first `---` marks where the
 * *entry list* ends and the blocks begin — stopping there would put each new
 * block above the existing ones instead of after them.
 *
 * Offsets are computed against the input string and no text is rewritten, so
 * the caller can splice the block in with a single surgical range edit that
 * leaves the rest of the document (and its line endings) untouched. Returns
 * `md.length` — append at the end of the document — when the section or its
 * closing heading is missing, which also covers a not-yet-templated note.
 */
export function findUnitOpInsertOffset(md: string): number {
  const lineStarts = [0];
  for (let i = 0; i < md.length; i++) {
    if (md[i] === '\n') lineStarts.push(i + 1);
  }
  const lineAt = (i: number): string => {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : md.length;
    return md.slice(lineStarts[i], end).replace(/\r?\n$/, '');
  };

  const headingIdx = findUnitOpSection(scanLines(md));
  if (headingIdx === -1) return md.length;

  for (let i = headingIdx + 1; i < lineStarts.length; i++) {
    if (/^##\s/.test(lineAt(i))) return lineStarts[i];
  }
  return md.length;
}

/**
 * Where {@link findUnitOpInsertPointAt} puts a new unit-op block. `place` says
 * how it relates to the blocks already there: after the block headed `after`,
 * before the first block, after the last one (`end`), or `empty` when the
 * section has no block yet. `noSection` means no unit-operation section was
 * found (#402): the block goes before the conclusions heading
 * (`beforeConclusions`), or at the end of the note when that is missing too.
 */
export interface UnitOpInsertPoint {
  offset: number;
  place: 'after' | 'first' | 'end' | 'empty' | 'noSection';
  beforeConclusions?: boolean;
  /** Heading text of the block the new one follows, e.g. `[UHW010 Spin]`. */
  after?: string;
}

/**
 * Insertion point for a new unit-op block that follows the cursor (#103).
 *
 * Inside a block, the new one goes right after that block — before the next
 * block's `---` separator, or at the end of the section for the last block.
 * Between the TOC and the first block it goes before the first block. Anywhere
 * else (front matter, above the section, below it) it goes after the last
 * block, as {@link findUnitOpInsertOffset} does.
 */
export function findUnitOpInsertPointAt(md: string, cursor: number): UnitOpInsertPoint {
  const lineStarts = [0];
  for (let i = 0; i < md.length; i++) {
    if (md[i] === '\n') lineStarts.push(i + 1);
  }
  const lineAt = (i: number): string => {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : md.length;
    return md.slice(lineStarts[i], end).replace(/\r?\n$/, '');
  };

  const scanned = scanLines(md);
  const headingIdx = findUnitOpSection(scanned);
  if (headingIdx === -1) {
    const conclusions = findConclusionsIdx(scanned);
    return conclusions === -1
      ? { offset: md.length, place: 'noSection' }
      : { offset: scanned[conclusions].start, place: 'noSection', beforeConclusions: true };
  }
  let endIdx = lineStarts.length;
  for (let i = headingIdx + 1; i < lineStarts.length; i++) {
    if (/^##\s/.test(lineAt(i))) {
      endIdx = i;
      break;
    }
  }
  const sectionEnd = endIdx < lineStarts.length ? lineStarts[endIdx] : md.length;

  const blocks: { start: number; heading: string }[] = [];
  for (let i = headingIdx + 1; i < endIdx; i++) {
    const line = lineAt(i);
    if (!/^###\s+\[/.test(line)) continue;
    // A block begins at its `---` separator when it has one.
    let start = i;
    let j = i - 1;
    while (j > headingIdx && lineAt(j).trim() === '') j--;
    if (j > headingIdx && lineAt(j).trim() === '---') start = j;
    blocks.push({ start, heading: line.replace(/^###\s+/, '').trim() });
  }
  if (blocks.length === 0) return { offset: sectionEnd, place: 'empty' };

  const last = blocks[blocks.length - 1];
  const atEnd: UnitOpInsertPoint = { offset: sectionEnd, place: 'end', after: last.heading };
  let cursorLine = 0;
  while (cursorLine + 1 < lineStarts.length && lineStarts[cursorLine + 1] <= cursor) cursorLine++;
  if (cursorLine <= headingIdx || cursorLine >= endIdx) return atEnd;
  if (cursorLine < blocks[0].start) return { offset: lineStarts[blocks[0].start], place: 'first' };

  let k = 0;
  while (k + 1 < blocks.length && blocks[k + 1].start <= cursorLine) k++;
  if (k === blocks.length - 1) return atEnd;
  return { offset: lineStarts[blocks[k + 1].start], place: 'after', after: blocks[k].heading };
}

/**
 * One replacement in a markdown string: `[from, to)` becomes `insert`.
 *
 * Offsets refer to the string the edits were computed from. A list returned by
 * {@link computeUnitOpSyncEdits} is sorted by `from` and never overlaps, so it
 * can be handed to CodeMirror as one change set or applied with
 * {@link applyTextEdits}.
 */
export type TextEdit = { from: number; to: number; insert: string };

/** A source line: `[start, end)` excludes the line break; `fenced` = inside/on a code fence. */
interface MdLine {
  start: number;
  end: number;
  text: string;
  fenced: boolean;
}

/** Split into lines with offsets, marking ``` / ~~~ fenced code (fence lines included). */
function scanLines(md: string): MdLine[] {
  const lines: MdLine[] = [];
  // Fences read as stepFence reads them, so a backtick run with a backtick in its info is text;
  // none in the front matter, which Obsidian reads as properties.
  const frontMatter = frontMatterLineCount(md);
  let fence: OpenFence | null = null;
  let start = 0;
  for (;;) {
    const nl = md.indexOf('\n', start);
    const end = nl === -1 ? md.length : nl > start && md[nl - 1] === '\r' ? nl - 1 : nl;
    const text = md.slice(start, end);
    const next: OpenFence | null = lines.length < frontMatter ? fence : stepFence(text, fence);
    const fenced = fence !== null || next !== null;
    fence = next;
    lines.push({ start, end, text, fenced });
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

/** A `- [OPID ...` line; a hand-written `- [link](..)` among them is the user's (#520). */
const isTocEntry = (line: MdLine): boolean => !line.fenced && tocEntryOpId(line.text) !== undefined;

/**
 * GitHub's anchor for every ATX heading line, keyed by line index. GitHub
 * numbers a repeated base anchor `-1`, `-2`, ... across ALL headings of the
 * document (`#### Meta` included), so the count must start at the top, not at
 * the TOC. Front matter and fenced code hold no headings.
 */
function headingAnchors(lines: MdLine[]): Map<number, string> {
  let start = 0;
  if (lines[0]?.text.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.text.trim() === '---');
    if (close !== -1) start = close + 1;
  }
  const anchors = new Map<number, string>();
  const seen = new Map<string, number>();
  for (let j = start; j < lines.length; j++) {
    if (lines[j].fenced) continue;
    const m = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/.exec(lines[j].text);
    if (!m) continue;
    const base = githubHeadingAnchor((m[1] ?? '').replace(/(?:^|[ \t]+)#+$/, ''));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.set(j, n > 0 ? `${base}-${n}` : base);
  }
  return anchors;
}

/**
 * The line index of the heading `#anchor` reaches on GitHub, or undefined.
 * Obsidian resolves `#` links by heading text, so the TOC's GitHub anchors
 * lead nowhere in it without this (#505).
 */
export function resolveGithubAnchor(md: string, anchor: string): number | undefined {
  let target = anchor.replace(/^#/, '');
  try {
    target = decodeURIComponent(target);
  } catch {
    // A stray `%` is part of the anchor as written.
  }
  for (const [line, a] of headingAnchors(scanLines(md))) if (a === target) return line;
  return undefined;
}

/**
 * A TOC line split after its `[label](#anchor)` link: `tail` is what the user
 * wrote after it, such as an `@issue` marker or a memo, which a rebuild keeps
 * (#372).
 */
function splitTocEntry(text: string): { link: string; tail: string } {
  const m = /^\s*- \[(?:\\.|[^\\])*?\]\(#[^)\s]*\)/.exec(text);
  return m ? { link: m[0], tail: text.slice(m[0].length) } : { link: text, tail: '' };
}

/** A TOC line without its `(#anchor)`, so a stale anchor doesn't hide a reorder. */
const tocLabel = (line: string): string =>
  splitTocEntry(line)
    .link.trim()
    .replace(/\]\(#[^)]*\)$/, ']');

/**
 * Which current TOC line stands for each heading (keyed by its index in
 * `scan.entries`): an entry with the heading's label goes with it, and the
 * rest of an opId's entries pair with its remaining headings in order. Deleting
 * the first of two blocks with the same opId thus leaves the second block its
 * own entry and `@issue` tail (#406).
 */
function pairTocEntries(scan: UnitOpTocScan): Map<number, number> {
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  const take = (k: number, match: (idx: number) => boolean): void => {
    if (pairs.has(k)) return;
    const idx = scan.entryIdxs.find(j => !taken.has(j) && match(j));
    if (idx === undefined) return;
    pairs.set(k, idx);
    taken.add(idx);
  };
  scan.entries.forEach((line, k) => take(k, j => tocLabel(scan.lines[j].text) === tocLabel(line)));
  scan.entries.forEach((_, k) => take(k, j => tocEntryOpId(scan.lines[j].text) === scan.entryOpIds[k]));
  return pairs;
}

/**
 * The rebuilt entries, each with the tail of the current entry paired with it, and those
 * pairs ({@link pairTocEntries}), worked out once for the caller.
 */
function entriesWithTails(scan: UnitOpTocScan): { entries: string[]; pairs: Map<number, number> } {
  const pairs = pairTocEntries(scan);
  const entries = scan.entries.map((line, k) => {
    const idx = pairs.get(k);
    return line + (idx === undefined ? '' : splitTocEntry(scan.lines[idx].text).tail);
  });
  return { entries, pairs };
}

/**
 * Edits that drop the TOC entries no `### [..]` heading is left for, without
 * touching the order or the other lines (#406): what deleting a block does
 * when TOC sorting is off. Entries pair with headings as in
 * {@link pairTocEntries}; a dropped entry's tail goes with it.
 */
export function pruneUnitOpTocEntries(md: string): TextEdit[] {
  const scan = scanUnitOpToc(md);
  if (!scan) return [];
  const paired = new Set(pairTocEntries(scan).values());
  const edits: TextEdit[] = [];
  for (const idx of scan.entryIdxs) {
    if (paired.has(idx) || !tocEntryOpId(scan.lines[idx].text)) continue;
    const line = scan.lines[idx];
    const next = scan.lines[idx + 1];
    const prev = scan.lines[idx - 1];
    edits.push(next ? { from: line.start, to: next.start, insert: '' } : { from: prev ? prev.end : line.start, to: line.end, insert: '' });
  }
  return edits;
}

/** Everything the TOC and separator edits need, from one pass over the document. */
interface UnitOpTocScan {
  lines: MdLine[];
  newline: string;
  headingIdx: number;
  /** `- [..]` line indices inside the entry region. */
  entryIdxs: number[];
  /** TOC lines rebuilt from the `### [..]` headings, in document order. */
  entries: string[];
  /** The opId of each line in {@link entries}, same order. */
  entryOpIds: string[];
}

function scanUnitOpToc(md: string): UnitOpTocScan | null {
  const lines = scanLines(md);
  const headingIdx = findUnitOpSection(lines);
  if (headingIdx === -1) return null;

  // The entry region ends at the first `---` break or at ANY heading, so the
  // list stays bounded (and block bodies with `- [ ]` / `- [link](..)` lines stay
  // out of it) even when the first block has lost its leading `---`.
  let tocEndIdx = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.fenced && (/^#{1,6}\s/.test(l.text) || l.text.trim() === '---')) {
      tocEndIdx = j;
      break;
    }
  }

  // Collect unit-op headings across the body, in document order. TOC lines start
  // with `- [`, so they never match the `### [` heading pattern.
  const anchors = headingAnchors(lines);
  const entries: string[] = [];
  const entryOpIds: string[] = [];
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (lines[j].fenced) continue;
    const m = lines[j].text.match(UNIT_OP_HEADING_PATTERN);
    if (!m) continue;
    entries.push(buildUnitOpTocLine(m[1], m[2].trim(), m[3]?.trim() || undefined, anchors.get(j)));
    entryOpIds.push(m[1]);
  }

  const entryIdxs: number[] = [];
  for (let j = headingIdx + 1; j < tocEndIdx; j++) {
    if (isTocEntry(lines[j])) entryIdxs.push(j);
  }

  return { lines, newline: md.includes('\r\n') ? '\r\n' : '\n', headingIdx, entryIdxs, entries, entryOpIds };
}

/**
 * The single edit that reorders the TOC entry lines, or `null` when they already
 * match. We must NOT rewrite interleaved non-entry lines (comments, blockquotes,
 * stray blanks) away: the ordered entries go where the first one began and the
 * interleaved lines follow them, untouched.
 */
function tocEdit(md: string, scan: UnitOpTocScan): TextEdit | null {
  const { lines, newline, headingIdx, entryIdxs } = scan;
  const { entries, pairs } = entriesWithTails(scan);
  // The line break after line `j` as written (mixed endings stay), or for the
  // last line the one before it; new lines take the break of the line above.
  const breakAfter = (j: number): string =>
    j + 1 < lines.length ? md.slice(lines[j].end, lines[j + 1].start) : j > 0 ? md.slice(lines[j - 1].end, lines[j].start) : newline;

  if (entryIdxs.length > 0) {
    const first = entryIdxs[0];
    const last = entryIdxs[entryIdxs.length - 1];
    // The break a line ended with, '' for the last line of the note.
    const own = (j: number): string => (j + 1 < lines.length ? md.slice(lines[j].end, lines[j + 1].start) : '');
    // The ordered entries, then the interleaved lines. An entry rebuilt from
    // an existing one, and every interleaved line, keeps that line's break; a
    // new entry takes the break of the line above it.
    const out: { text: string; end: string }[] = [];
    let above = breakAfter(first - 1);
    const push = (text: string, end: string): void => {
      out.push({ text, end: end || above });
      above = end || above;
    };
    entries.forEach((text, k) => {
      const idx = pairs.get(k);
      push(text, idx === undefined ? '' : own(idx));
    });
    for (let j = first; j <= last; j++) if (!isTocEntry(lines[j])) push(lines[j].text, own(j));
    // The range runs to the next line, so the line now last carries its own break too.
    // With no line left, the break the last entry ended on stays, so the text
    // above does not run into what follows (a `---` would make it a heading).
    const toEnd = out.length === 0 || last + 1 >= lines.length;
    const text = out.map((l, k) => l.text + (toEnd && k === out.length - 1 ? '' : l.end)).join('');
    const from = lines[first].start;
    const to = toEnd ? lines[last].end : lines[last + 1].start;
    const d = minimalReplacement(md.slice(from, to), text);
    return d && { from: from + d.start, to: from + d.end, insert: d.text };
  }

  if (entries.length === 0) return null;
  let insertAt = headingIdx + 1;
  if (lines[insertAt] !== undefined && lines[insertAt].text.trim() === '') insertAt++;
  const target = lines[insertAt];
  const above = breakAfter(insertAt - 1);
  if (!target) return { from: md.length, to: md.length, insert: above + entries.join(above) };
  // Keep a blank separator before following non-blank prose.
  const gap = target.text.trim() !== '' ? above : '';
  return { from: target.start, to: target.start, insert: entries.join(above) + above + gap };
}

/**
 * True when the TOC holds exactly the headings' entries (as a multiset, so a
 * unit op used twice still counts) but in a different order — the signature of
 * a moved block. Added, removed or renamed headings are not a reorder.
 *
 * Entries are compared by label: a note written before the anchors were
 * de-duplicated still reads as a reorder, while an anchor-only change is left
 * to the regular TOC sync.
 */
function isReorder(scan: UnitOpTocScan): boolean {
  const current = scan.entryIdxs.map(j => tocLabel(scan.lines[j].text));
  const entries = scan.entries.map(tocLabel);
  if (current.length !== entries.length) return false;
  if (current.every((c, i) => c === entries[i])) return false;
  const a = [...current].sort();
  const b = [...entries].sort();
  return a.every((c, i) => c === b[i]);
}

/**
 * Restore the template's separator shape inside `## Related Unit Operations`
 * after a block move: one `---` before every `### [..]` block and none dangling
 * at the section end.
 *
 * An Outline drag moves a heading up to the next same-level heading, so each
 * block carries the NEXT block's leading `---` at its tail. Only notes that
 * already use separators (some `---` directly precedes a `### [`) are touched;
 * a `---` followed by other content is the user's and is kept (runs of
 * back-to-back breaks are merged into one).
 */
function separatorEdits(md: string, scan: UnitOpTocScan): TextEdit[] {
  const { lines, newline, headingIdx } = scan;

  let sectionEnd = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (!lines[j].fenced && /^#{1,2}\s/.test(lines[j].text)) {
      sectionEnd = j;
      break;
    }
  }

  // A `---` right under paragraph text is a setext underline, not a break.
  const isBreak = (j: number): boolean => {
    if (lines[j].fenced || lines[j].text.trim() !== '---') return false;
    const prev = lines[j - 1].text.trim();
    return prev === '' || prev === '---' || /^#{1,6}\s/.test(lines[j - 1].text);
  };

  const items: { idx: number; kind: 'break' | 'unitOp' | 'other' }[] = [];
  for (let j = headingIdx + 1; j < sectionEnd; j++) {
    if (!lines[j].fenced && lines[j].text.trim() === '') continue;
    const kind = isBreak(j)
      ? 'break'
      : !lines[j].fenced && UNIT_OP_HEADING_PATTERN.test(lines[j].text)
        ? 'unitOp'
        : 'other';
    items.push({ idx: j, kind });
  }

  const usesSeparators = items.some((it, k) => it.kind === 'break' && items[k + 1]?.kind === 'unitOp');
  if (!usesSeparators) return [];

  const edits: TextEdit[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.kind === 'unitOp') {
      if (items[k - 1]?.kind === 'break') continue;
      const line = lines[it.idx];
      // A blank line first, or the `---` would turn the text above into a heading.
      const lead = lines[it.idx - 1].text.trim() === '' ? '' : newline;
      edits.push({ from: line.start, to: line.start, insert: lead + '---' + newline + newline });
    } else if (it.kind === 'break') {
      let last = k;
      while (items[last + 1]?.kind === 'break') last++;
      if (last + 1 >= items.length) {
        // Dangling at the section end: drop the break(s) and the blanks after.
        const to = sectionEnd < lines.length ? lines[sectionEnd].start : md.length;
        edits.push({ from: lines[it.idx].start, to, insert: '' });
      } else if (last > k) {
        edits.push({ from: lines[it.idx].end, to: lines[items[last].idx].end, insert: '' });
      }
      k = last;
    }
  }
  return edits;
}

/**
 * Edits that bring a workflow note's `## Related Unit Operations` section in
 * line with its `### [opId opName]` blocks, as a sorted, non-overlapping list of
 * small {@link TextEdit}s against `md`:
 *
 * - **TOC:** only the changed span of the entry lines (same result as
 *   {@link rebuildUnitOpToc}, which is built on this).
 * - **Separators:** only when the blocks were reordered (see
 *   {@link separatorEdits}); additions, removals and renames never touch them.
 *
 * With `onlyOnReorder`, returns `[]` unless the change is a reorder — the live
 * editor filter uses this and leaves other TOC updates to the debounced sync.
 * Code fences are ignored; CRLF is preserved in inserted text. Returns `[]`
 * when the section is absent.
 */
export function computeUnitOpSyncEdits(
  md: string,
  opts: { onlyOnReorder?: boolean } = {}
): TextEdit[] {
  const scan = scanUnitOpToc(md);
  if (!scan) return [];
  const reordered = isReorder(scan);
  if (opts.onlyOnReorder && !reordered) return [];

  const edits: TextEdit[] = [];
  const toc = tocEdit(md, scan);
  if (toc) edits.push(toc);
  if (reordered) edits.push(...separatorEdits(md, scan));
  return edits;
}

/** Apply non-overlapping edits (offsets against `md`) and return the result. */
export function applyTextEdits(md: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  let out = md;
  for (let k = sorted.length - 1; k >= 0; k--) {
    const e = sorted[k];
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * Regenerate the entire `## Related Unit Operations` TOC so its entries match
 * the **document order** of the `### [opId opName]` unit-op headings.
 *
 * Unlike {@link appendUnitOpToWorkflowToc} (which always appends), this scans
 * the body for the actual headings and rewrites the entry list in that order.
 * This keeps the TOC correct even when a unit op is inserted at an arbitrary
 * cursor position, and self-heals any previously mis-ordered list.
 *
 * The edit is confined to the entry lines inside the section (heading → first
 * heading or `---`); surrounding blanks and the template hint blockquotes are
 * preserved, and headings inside code fences are ignored. Returns the input
 * unchanged when the section is absent. CRLF vs LF line endings are preserved.
 */
export function rebuildUnitOpToc(md: string): string {
  const scan = scanUnitOpToc(md);
  const edit = scan && tocEdit(md, scan);
  return edit ? applyTextEdits(md, [edit]) : md;
}

/** The opId a TOC entry line points at: `- [UHW010 Mixing | 완충액](#…)` → `UHW010`. */
const tocEntryOpId = (text: string): string | undefined => /^\s*- \[([A-Z]+\d+)\s/.exec(text)?.[1];

/**
 * The TOC with an entry for the `### [..]` heading at `headingOffset` added,
 * leaving the order of the other entries as it is — for an insert with
 * sorting turned off (#457). Among blocks of the same opId the entry takes its
 * place in note order, since {@link refreshUnitOpTocEntries} pairs those
 * entries with their headings by position; otherwise it goes right after the
 * entry of the block before it in the note, else right before the next
 * block's, else after the last entry. Unchanged when the section or the
 * heading is not found.
 */
export function addUnitOpTocEntry(md: string, headingOffset: number): string {
  const scan = scanUnitOpToc(md);
  if (!scan) return md;
  const { lines, newline, headingIdx, entryIdxs, entries, entryOpIds } = scan;
  const headings: number[] = [];
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (!lines[j].fenced && UNIT_OP_HEADING_PATTERN.test(lines[j].text)) headings.push(j);
  }
  const k = headings.findIndex(j => lines[j].start <= headingOffset && headingOffset <= lines[j].end);
  if (k === -1) return md;
  // The TOC line of heading `h`: the nth entry of its opId, n counted without the new heading.
  const entryOf = (h: number): number | undefined => {
    const opId = entryOpIds[h];
    const nth = entryOpIds.slice(0, h).filter((o, i) => i !== k && o === opId).length;
    return entryIdxs.filter(j => tocEntryOpId(lines[j].text) === opId)[nth];
  };
  const line = entries[k];
  const after = (idx: number): string => applyTextEdits(md, [{ from: lines[idx].end, to: lines[idx].end, insert: newline + line }]);
  const before = (idx: number): string => applyTextEdits(md, [{ from: lines[idx].start, to: lines[idx].start, insert: line + newline }]);
  const opId = entryOpIds[k];
  const sameBefore = entryOpIds.slice(0, k).lastIndexOf(opId);
  const sameAfter = entryOpIds.indexOf(opId, k + 1);
  const sameBeforeEntry = sameBefore !== -1 ? entryOf(sameBefore) : undefined;
  if (sameBeforeEntry !== undefined) return after(sameBeforeEntry);
  const sameAfterEntry = sameAfter !== -1 ? entryOf(sameAfter) : undefined;
  if (sameAfterEntry !== undefined) return before(sameAfterEntry);
  const prev = k > 0 ? entryOf(k - 1) : undefined;
  if (prev !== undefined) return after(prev);
  const next = k + 1 < entries.length ? entryOf(k + 1) : undefined;
  if (next !== undefined) return before(next);
  if (entryIdxs.length > 0) {
    const last = lines[entryIdxs[entryIdxs.length - 1]];
    return applyTextEdits(md, [{ from: last.end, to: last.end, insert: newline + line }]);
  }
  const edit = tocEdit(md, { ...scan, entries: [line], entryOpIds: [entryOpIds[k]] });
  return edit ? applyTextEdits(md, [edit]) : md;
}

/**
 * The TOC entries rewritten from the headings they point at, in the order the
 * note already has them (#258). Entries pair with headings as in
 * {@link pairTocEntries}: one with the heading's label first, so two blocks of
 * one opId the user put in another order keep it (#502), then the nth of the
 * same opId, so a renamed unit operation gets its new name and anchor; an
 * entry nothing matches is left alone. This is what runs when
 * "{@link rebuildUnitOpToc}"'s sorting is turned off: names and links stay
 * right without the order being touched.
 */
export function refreshUnitOpTocEntries(md: string): string {
  const scan = scanUnitOpToc(md);
  if (!scan) return md;
  const { lines, entries } = scan;
  const edits: TextEdit[] = [];
  for (const [k, idx] of pairTocEntries(scan)) {
    const line = entries[k] + splitTocEntry(lines[idx].text).tail;
    if (line === lines[idx].text) continue;
    edits.push({ from: lines[idx].start, to: lines[idx].end, insert: line });
  }
  edits.sort((a, b) => a.from - b.from);
  return applyTextEdits(md, edits);
}

/**
 * The table of contents once a unit operation block was inserted at
 * `insertOffset`, shared by the insert command and the AI tool (#491): rebuilt
 * in note order, or with `sortToc` off (#457) the new entry added where it
 * belongs and the others left in their order. Rebuilt as well when the new
 * heading cannot be found.
 */
export function syncUnitOpTocAfterInsert(md: string, insertOffset: number, sortToc: boolean): string {
  const heading = insertOffset >= 0 ? md.indexOf('### [', insertOffset) : -1;
  return sortToc || heading === -1 ? rebuildUnitOpToc(md) : refreshUnitOpTocEntries(addUnitOpTocEntry(md, heading));
}

/**
 * Smallest single-range edit that turns `before` into `after`, by stripping the
 * shared prefix and suffix. Returns the character range in `before` to replace
 * plus the replacement text, or `null` when the strings are identical.
 *
 * Used to apply a `rebuildUnitOpToc` result to a live editor without rewriting
 * the whole document: editing only the changed span keeps the caret anchored to
 * the surrounding text (a full-document replace would reset it).
 */
export function minimalReplacement(
  before: string,
  after: string
): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let s = 0;
  while (s < max && before[s] === after[s]) s++;
  let e = 0;
  while (e < max - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
  return { start: s, end: before.length - e, text: after.slice(s, after.length - e) };
}

/**
 * Whether the TOC sync should wait because the caret is in (or at either end
 * of) the span `edit` replaces (#562): replacing it would leave the caret in
 * the next entry, as after Enter at the end of one. The next edit of the note
 * runs the sync again.
 */
export function shouldDeferTocSync(caret: number, edit: { start: number; end: number }): boolean {
  return caret >= edit.start && caret <= edit.end;
}

/**
 * Given the post-insert markdown, the pre-insert cursor offset, and the
 * TOC-rebuilt markdown, return the character offset of the just-inserted
 * `### [..]` unit-op heading within the rebuilt text (or -1 if none).
 *
 * The inserted block sits at `cursorBefore`, so the first `### [` at/after that
 * offset is ours. Since {@link rebuildUnitOpToc} only rewrites `- [..]` lines
 * (never `### [..]`), the heading keeps its ordinal index among all headings;
 * we map by that index into the rebuilt text.
 */
export function locateInsertedUnitOpHeading(
  mdAfterInsert: string,
  cursorBefore: number,
  rebuiltMd: string
): number {
  const HEAD = '### [';
  const headingInMd = mdAfterInsert.indexOf(HEAD, Math.max(0, cursorBefore));
  if (headingInMd === -1) return -1;

  // Ordinal (0-based) index of our heading among all headings in mdAfterInsert.
  let idx = 0;
  for (
    let p = mdAfterInsert.indexOf(HEAD);
    p !== -1 && p < headingInMd;
    p = mdAfterInsert.indexOf(HEAD, p + 1)
  ) {
    idx++;
  }

  // Find the idx-th heading in the rebuilt text.
  let p = rebuiltMd.indexOf(HEAD);
  for (let c = 0; c < idx && p !== -1; c++) p = rebuiltMd.indexOf(HEAD, p + 1);
  return p;
}
