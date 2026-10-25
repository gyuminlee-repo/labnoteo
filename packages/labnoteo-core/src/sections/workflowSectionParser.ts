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

export const UNIT_OP_HEADING_PATTERN = /^###\s+\[([A-Z]+\d+)\s+(.+?)\]\s*(.*)/;

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
  const newline = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);

  const headingIdx = lines.findIndex(l => l.trim() === '## Related Unit Operations');
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

  let lastEntry = -1;
  for (let j = headingIdx + 1; j < endIdx; j++) {
    if (/^\s*- \[/.test(lines[j])) lastEntry = j;
  }

  if (lastEntry !== -1) {
    lines.splice(lastEntry + 1, 0, entryLine);
  } else {
    let insertAt = headingIdx + 1;
    // Skip the single blank line that follows the heading.
    if (lines[insertAt] !== undefined && lines[insertAt].trim() === '') insertAt++;
    const toInsert = [entryLine];
    // Keep a blank separator before following non-blank prose.
    if (lines[insertAt] !== undefined && lines[insertAt].trim() !== '') toInsert.push('');
    lines.splice(insertAt, 0, ...toInsert);
  }

  return lines.join(newline);
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

  let headingIdx = -1;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineAt(i).trim() === '## Related Unit Operations') {
      headingIdx = i;
      break;
    }
  }
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
 * section has no block yet (or is missing).
 */
export interface UnitOpInsertPoint {
  offset: number;
  place: 'after' | 'first' | 'end' | 'empty';
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

  const headingIdx = lineStarts.findIndex((_, i) => lineAt(i).trim() === '## Related Unit Operations');
  if (headingIdx === -1) return { offset: md.length, place: 'empty' };
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
  let fence: { ch: string; len: number } | null = null;
  let start = 0;
  for (;;) {
    const nl = md.indexOf('\n', start);
    const end = nl === -1 ? md.length : nl > start && md[nl - 1] === '\r' ? nl - 1 : nl;
    const text = md.slice(start, end);
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    let fenced = fence !== null;
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && text.trim() === m[1]) fence = null;
    } else if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      fenced = true;
    }
    lines.push({ start, end, text, fenced });
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

const isTocEntry = (line: MdLine): boolean => !line.fenced && /^\s*- \[/.test(line.text);

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
 * The rebuilt entries, each with the tail of the current entry for the same
 * unit operation (the nth entry of an opId goes with its nth heading).
 */
function entriesWithTails(scan: UnitOpTocScan): string[] {
  const tails = new Map<string, string[]>();
  for (const idx of scan.entryIdxs) {
    const opId = tocEntryOpId(scan.lines[idx].text);
    if (!opId) continue;
    const list = tails.get(opId) ?? [];
    list.push(splitTocEntry(scan.lines[idx].text).tail);
    tails.set(opId, list);
  }
  const used = new Map<string, number>();
  return scan.entries.map((line, k) => {
    const opId = scan.entryOpIds[k];
    const nth = used.get(opId) ?? 0;
    used.set(opId, nth + 1);
    return line + (tails.get(opId)?.[nth] ?? '');
  });
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
  const headingIdx = lines.findIndex(l => !l.fenced && l.text.trim() === '## Related Unit Operations');
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
  const entries = entriesWithTails(scan);

  if (entryIdxs.length > 0) {
    const first = entryIdxs[0];
    const last = entryIdxs[entryIdxs.length - 1];
    const kept: string[] = [];
    for (let j = first; j <= last; j++) {
      if (!isTocEntry(lines[j])) kept.push(lines[j].text);
    }
    const from = lines[first].start;
    const to = lines[last].end;
    const d = minimalReplacement(md.slice(from, to), [...entries, ...kept].join(newline));
    return d && { from: from + d.start, to: from + d.end, insert: d.text };
  }

  if (entries.length === 0) return null;
  let insertAt = headingIdx + 1;
  if (lines[insertAt] !== undefined && lines[insertAt].text.trim() === '') insertAt++;
  const target = lines[insertAt];
  if (!target) return { from: md.length, to: md.length, insert: newline + entries.join(newline) };
  // Keep a blank separator before following non-blank prose.
  const gap = target.text.trim() !== '' ? newline : '';
  return { from: target.start, to: target.start, insert: entries.join(newline) + newline + gap };
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
 * The TOC entries rewritten from the headings they point at, in the order the
 * note already has them (#258). Each entry is paired with the nth `### [..]`
 * heading of the same opId, so a renamed unit operation gets its new name and
 * anchor; an entry nothing matches is left alone. This is what runs when
 * "{@link rebuildUnitOpToc}"'s sorting is turned off: names and links stay
 * right without the order being touched.
 */
export function refreshUnitOpTocEntries(md: string): string {
  const scan = scanUnitOpToc(md);
  if (!scan) return md;
  const { lines, entryIdxs, entries, entryOpIds } = scan;
  const fresh = new Map<string, string[]>();
  entries.forEach((line, k) => {
    const list = fresh.get(entryOpIds[k]) ?? [];
    list.push(line);
    fresh.set(entryOpIds[k], list);
  });
  const used = new Map<string, number>();
  const edits: TextEdit[] = [];
  for (const idx of entryIdxs) {
    const opId = tocEntryOpId(lines[idx].text);
    if (!opId) continue;
    const nth = used.get(opId) ?? 0;
    used.set(opId, nth + 1);
    const entry = fresh.get(opId)?.[nth];
    if (entry === undefined) continue;
    const line = entry + splitTocEntry(lines[idx].text).tail;
    if (line === lines[idx].text) continue;
    edits.push({ from: lines[idx].start, to: lines[idx].end, insert: line });
  }
  return applyTextEdits(md, edits);
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
