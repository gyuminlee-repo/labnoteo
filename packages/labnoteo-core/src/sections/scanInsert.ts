/**
 * Filing scanned worksheet pages into a workflow note.
 *
 * Each scan goes in a `#### Worksheet scans` subsection at the end of the unit
 * operation it was printed from, ordered by page. Being a subsection of the
 * unit operation, it moves with the block in the outline and stays out of the
 * unit-op TOC (which reads `### [` headings only). Pages printed from the note
 * as a whole before its first unit operation go in a `## Worksheet scans`
 * section at the end of the note instead.
 *
 * Every entry starts with an HTML comment carrying its page and content hash,
 * invisible when reading, so entries can be sorted, deduplicated and removed
 * again (undo) without depending on how the image link is written.
 */
import { stepFence, type OpenFence } from './sectionEdit';
import { UNIT_OP_HEADING_PATTERN } from './workflowSectionParser';

export const WORKSHEET_SCANS_HEADING = 'Worksheet scans';

/** One `### [OPID name] alias` block of a workflow note. */
export interface UnitOpBlock {
  /** 1-based position among the note's unit operations. */
  index: number;
  opId: string;
  opName: string;
  alias: string;
  /** 0-based line of the heading. */
  headingLine: number;
  /** 0-based line where the block ends (next `#`–`###` heading or end of note), exclusive. */
  endLine: number;
  /** Like `endLine`, but before the blank and `---` lines that separate it from the next block. */
  contentEndLine: number;
}

/** A scanned page to file. */
export interface ScanEntry {
  page: number;
  pageCount: number;
  /** Short hex content hash of the stored image, used to spot the same photo twice. */
  hash: string;
  /** The embed line, e.g. `![[LN-7K3M9QX2_u3_p2_20261015.jpg]]`. */
  embed: string;
  /** One line describing where the image came from. */
  caption: string;
}

const ANY_HEADING_RE = /^(#{1,6})\s/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ENTRY_RE = /^<!-- labnoteo-scan page=(\d+)\/(\d+) sha=([0-9a-f]+) -->\s*$/;

interface Heading {
  line: number;
  level: number;
}

function scanHeadings(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const m = ANY_HEADING_RE.exec(lines[i]);
    if (m) out.push({ line: i, level: m[1].length });
  }
  return out;
}

const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

function trimTail(lines: readonly string[], from: number, end: number): number {
  let i = end;
  while (i > from + 1 && (isBlank(lines[i - 1]) || RULE_RE.test(lines[i - 1]))) i--;
  return i;
}

function blocksOf(lines: readonly string[], headings: readonly Heading[]): UnitOpBlock[] {
  const blocks: UnitOpBlock[] = [];
  for (const h of headings) {
    if (h.level !== 3) continue;
    const m = UNIT_OP_HEADING_PATTERN.exec(lines[h.line]);
    if (!m) continue;
    const endLine = headings.find(o => o.line > h.line && o.level <= 3)?.line ?? lines.length;
    blocks.push({
      index: blocks.length + 1,
      opId: m[1],
      opName: m[2].trim(),
      alias: (m[3] ?? '').trim(),
      headingLine: h.line,
      endLine,
      contentEndLine: trimTail(lines, h.line, endLine),
    });
  }
  return blocks;
}

/** The note's unit operations, in document order. */
export function listUnitOpBlocks(md: string): UnitOpBlock[] {
  const lines = md.split(/\r?\n/);
  return blocksOf(lines, scanHeadings(lines));
}

export type ScanTarget =
  | { kind: 'block'; block: UnitOpBlock; by: 'index' | 'opId' }
  | { kind: 'note' }
  | { kind: 'ambiguous'; candidates: UnitOpBlock[] }
  | { kind: 'missing' };

/**
 * Where a page printed from the `unitOpIndex`-th unit operation (`opId`)
 * belongs now that the note may have changed: the block at that position if it
 * still is that unit operation, else the note's only block of that `opId`.
 * Otherwise the page needs a person to choose.
 */
export function resolveScanTarget(
  blocks: readonly UnitOpBlock[],
  unitOpIndex: number,
  opId: string
): ScanTarget {
  if (unitOpIndex === 0) return { kind: 'note' };
  const atIndex = blocks[unitOpIndex - 1];
  if (atIndex && atIndex.opId === opId) return { kind: 'block', block: atIndex, by: 'index' };
  const same = blocks.filter(b => b.opId === opId);
  if (same.length === 1) return { kind: 'block', block: same[0], by: 'opId' };
  return same.length > 1 ? { kind: 'ambiguous', candidates: same } : { kind: 'missing' };
}

export function renderScanEntry(entry: ScanEntry): string[] {
  return [
    `<!-- labnoteo-scan page=${entry.page}/${entry.pageCount} sha=${entry.hash} -->`,
    entry.embed,
    `*${entry.caption.replace(/\*/g, '\\*')}*`,
  ];
}

interface ParsedEntry {
  page: number;
  hash: string;
  lines: string[];
}

interface Section {
  headingLine: number;
  /** Exclusive end, before trailing blank lines. */
  end: number;
  /** Lines between the heading and the first entry, without framing blanks. */
  preface: string[];
  entries: ParsedEntry[];
}

function parseSection(lines: readonly string[], headingLine: number, end: number): Section {
  const entries: ParsedEntry[] = [];
  const preface: string[] = [];
  let current: ParsedEntry | null = null;
  for (let i = headingLine + 1; i < end; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (m) {
      current = { page: Number(m[1]), hash: m[3], lines: [lines[i]] };
      entries.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    } else {
      preface.push(lines[i]);
    }
  }
  for (const e of entries) while (e.lines.length > 1 && isBlank(e.lines[e.lines.length - 1])) e.lines.pop();
  while (preface.length && isBlank(preface[0])) preface.shift();
  while (preface.length && isBlank(preface[preface.length - 1])) preface.pop();
  return { headingLine, end, preface, entries };
}

function findSection(
  lines: readonly string[],
  headings: readonly Heading[],
  level: number,
  from: number,
  to: number
): Section | undefined {
  const re = new RegExp(`^#{${level}}\\s+${WORKSHEET_SCANS_HEADING}\\s*$`);
  const h = headings.find(o => o.line > from && o.line < to && o.level === level && re.test(lines[o.line]));
  if (!h) return undefined;
  const next = headings.find(o => o.line > h.line && o.level <= level)?.line ?? lines.length;
  const end = trimTail(lines, h.line, Math.min(next, to));
  return parseSection(lines, h.line, end);
}

function renderSection(level: number, section: Pick<Section, 'preface' | 'entries'>): string[] {
  const out = [`${'#'.repeat(level)} ${WORKSHEET_SCANS_HEADING}`, ''];
  if (section.preface.length) out.push(...section.preface, '');
  section.entries.forEach((e, i) => {
    if (i > 0) out.push('');
    out.push(...e.lines);
  });
  return out;
}

/**
 * Add `entries` to the Worksheet scans section of `block` (or of the note,
 * for `null`), creating it at the end of the block when missing. Entries are
 * kept in page order; an earlier scan of the same page stays first.
 */
export function insertScanEntries(md: string, block: UnitOpBlock | null, entries: readonly ScanEntry[]): string {
  if (entries.length === 0) return md;
  const newline = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const headings = scanHeadings(lines);
  const level = block ? 4 : 2;
  const from = block ? block.headingLine : -1;
  const to = block ? block.contentEndLine : lines.length;
  const added: ParsedEntry[] = entries.map(e => ({ page: e.page, hash: e.hash, lines: renderScanEntry(e) }));

  const existing = findSection(lines, headings, level, from, to);
  if (existing) {
    const merged = [...existing.entries, ...added]
      .map((e, order) => ({ e, order }))
      .sort((a, b) => a.e.page - b.e.page || a.order - b.order)
      .map(x => x.e);
    const body = renderSection(level, { preface: existing.preface, entries: merged });
    lines.splice(existing.headingLine, existing.end - existing.headingLine, ...body);
    return lines.join(newline);
  }

  const sorted = [...added].sort((a, b) => a.page - b.page);
  const section = renderSection(level, { preface: [], entries: sorted });
  let at = block ? block.contentEndLine : lines.length;
  if (!block) while (at > 0 && isBlank(lines[at - 1])) at--;
  const before = at > 0 && !isBlank(lines[at - 1]) ? [''] : [];
  const after = at < lines.length && !isBlank(lines[at]) ? [''] : [];
  if (!block && at === lines.length) after.push('');
  lines.splice(at, 0, ...before, ...section, ...after);
  return lines.join(newline);
}

/** Content hashes of the scans already filed anywhere in the note. */
export function listScanHashes(md: string): Set<string> {
  const out = new Set<string>();
  let fence: OpenFence | null = null;
  for (const line of md.split(/\r?\n/)) {
    const next = stepFence(line, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const m = ENTRY_RE.exec(line);
    if (m) out.add(m[3]);
  }
  return out;
}

/** A scan already filed in the note. */
export interface FiledScan {
  hash: string;
  page: number;
  pageCount: number;
  /** The line after the entry's comment: the image embed. */
  embed: string;
  /** The unit operation it is filed under (1-based), or 0 for the note-level section. */
  unitOpIndex: number;
}

export function listFiledScans(md: string): FiledScan[] {
  const lines = md.split(/\r?\n/);
  const blocks = blocksOf(lines, scanHeadings(lines));
  const out: FiledScan[] = [];
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const block = blocks.find(b => b.headingLine < i && i < b.endLine);
    out.push({
      hash: m[3],
      page: Number(m[1]),
      pageCount: Number(m[2]),
      embed: (lines[i + 1] ?? '').trim(),
      unitOpIndex: block?.index ?? 0,
    });
  }
  return out;
}

/**
 * Remove the scan entry with `hash` (undo, or dropping an older scan of a
 * page), and its Worksheet scans section when nothing else is left in it.
 */
export function removeScanEntry(md: string, hash: string): { md: string; removed: boolean } {
  const newline = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const headings = scanHeadings(lines);
  const sectionRe = new RegExp(`^(#{2}|#{4})\\s+${WORKSHEET_SCANS_HEADING}\\s*$`);
  for (const h of headings) {
    if (!sectionRe.test(lines[h.line])) continue;
    const block = blocksOf(lines, headings).find(b => b.headingLine < h.line && h.line < b.endLine);
    const to = h.level === 4 && block ? block.contentEndLine : lines.length;
    const section = findSection(lines, headings, h.level, h.line - 1, to);
    if (!section) continue;
    const keep = section.entries.filter(e => e.hash !== hash);
    if (keep.length === section.entries.length) continue;
    if (keep.length === 0 && section.preface.length === 0) {
      let start = section.headingLine;
      if (start > 0 && isBlank(lines[start - 1])) start--;
      lines.splice(start, section.end - start);
    } else {
      const body = renderSection(h.level, { preface: section.preface, entries: keep });
      lines.splice(section.headingLine, section.end - section.headingLine, ...body);
    }
    return { md: lines.join(newline), removed: true };
  }
  return { md, removed: false };
}
