/**
 * Where an AI-written block goes in a note (#48).
 *
 * Inserting a model reply at the raw cursor split the line under it
 * (`헴## [USW100 …]`) and left the unit operation's Method placeholder in place.
 * These pure helpers decide instead: inside a unit operation the draft replaces
 * that unit operation's `#### Method` body; anywhere else it goes in as its own
 * block after the cursor's line. The Obsidian side only applies the result.
 */
import { findSectionMatches, sectionBodyEnd, stepFence, type OpenFence } from './sectionEdit';
import { UNIT_OP_HEADING_PATTERN } from './workflowSectionParser';
import { scanDocumentHead, isBeforeBody } from './documentHead';
import { SW_PLACEHOLDERS, HW_PLACEHOLDERS } from '../lib/unitOpTemplate';

/** The `#### Method` subsection of one unit operation. */
export interface UnitOpMethodLocation {
  /** The unit operation's heading line (`### [USW100 …] alias`). */
  unitOpHeading: string;
  /** 0-based position among the note's unit-operation headings. */
  unitOpIndex: number;
  /** 0-based line range of the unit operation: heading line to next `#`–`###` heading (exclusive). */
  unitOpStartLine: number;
  unitOpEndLine: number;
  /** 0-based line of the `#### Method` heading. */
  methodLine: number;
  /** True when the Method body is empty or still the template placeholder. */
  isPlaceholder: boolean;
}

const ANY_HEADING_RE = /^(#{1,6})\s/;

interface HeadingLine {
  line: number;
  level: number;
}

/** Every ATX heading outside code fences, in document order. */
function scanHeadings(lines: readonly string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const m = ANY_HEADING_RE.exec(lines[i]);
    if (m) headings.push({ line: i, level: m[1].length });
  }
  return headings;
}

const isUnitOpHeading = (lines: readonly string[], h: HeadingLine): boolean =>
  h.level === 3 && UNIT_OP_HEADING_PATTERN.test(lines[h.line]);

const METHOD_PLACEHOLDERS: readonly string[] = [SW_PLACEHOLDERS.Method, HW_PLACEHOLDERS.Method];

/** The Method subsection inside the unit operation whose heading is `unitOp`. */
function methodInUnitOp(
  md: string,
  lines: readonly string[],
  headings: readonly HeadingLine[],
  unitOp: HeadingLine,
  unitOpIndex: number
): UnitOpMethodLocation | null {
  const end = headings.find(h => h.line > unitOp.line && h.level <= 3)?.line ?? lines.length;
  const method = findSectionMatches(md, 'Method').find(
    m => m.level === 4 && m.line > unitOp.line && m.line < end
  );
  if (!method) return null;
  const body = lines
    .slice(method.line + 1, sectionBodyEnd(lines, method.line, 4))
    .join('\n')
    .trim();
  return {
    unitOpHeading: lines[unitOp.line],
    unitOpIndex,
    unitOpStartLine: unitOp.line,
    unitOpEndLine: end,
    methodLine: method.line,
    isPlaceholder: body === '' || METHOD_PLACEHOLDERS.includes(body),
  };
}

/**
 * The Method subsection of the unit operation the cursor is in, or null.
 *
 * The cursor is inside a unit operation only when the nearest `#`–`###` heading
 * at or above its line IS a unit-operation heading: a researcher's own
 * `## 결과` between them puts the cursor outside. Null too when that unit
 * operation has no `#### Method`.
 */
export function findUnitOpMethodAt(md: string, cursor: number): UnitOpMethodLocation | null {
  const lines = md.split(/\r?\n/);
  const cursorLine = md.slice(0, Math.max(0, Math.min(cursor, md.length))).split('\n').length - 1;
  const headings = scanHeadings(lines);
  let enclosing: HeadingLine | undefined;
  for (const h of headings) {
    if (h.line > cursorLine) break;
    if (h.level <= 3) enclosing = h;
  }
  if (!enclosing || !isUnitOpHeading(lines, enclosing)) return null;
  const unitOps = headings.filter(h => isUnitOpHeading(lines, h));
  return methodInUnitOp(md, lines, headings, enclosing, unitOps.indexOf(enclosing));
}

/**
 * Find the same Method subsection again after the note may have changed (the
 * model takes a while to answer): the `unitOpIndex`-th unit operation, provided
 * its heading line is still `unitOpHeading`. Null when it moved or is gone.
 */
export function findUnitOpMethodByIndex(
  md: string,
  unitOpIndex: number,
  unitOpHeading: string
): UnitOpMethodLocation | null {
  const lines = md.split(/\r?\n/);
  const headings = scanHeadings(lines);
  const unitOp = headings.filter(h => isUnitOpHeading(lines, h))[unitOpIndex];
  if (!unitOp || lines[unitOp.line] !== unitOpHeading) return null;
  return methodInUnitOp(md, lines, headings, unitOp, unitOpIndex);
}

/**
 * Reduce a model reply to a Method body. Models asked for "the body only" still
 * echo `#### Method`, or rewrite the whole unit operation (#48): take the
 * Method section's body when there is one, then drop any remaining `#`–`####`
 * heading line, which would otherwise end the Method section early. `#####`
 * and deeper stay — they nest inside Method.
 */
export function extractMethodBody(output: string): string {
  let text = output.trim();
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(text);
  if (fenced) text = fenced[2];

  let lines = text.split(/\r?\n/);
  const [method] = findSectionMatches(text, 'Method');
  if (method) {
    lines = lines.slice(method.line + 1, sectionBodyEnd(lines, method.line, method.level));
  }

  const kept: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of lines) {
    const next = stepFence(line, fence);
    const inCode = fence !== null || next !== fence;
    fence = next;
    if (!inCode && /^#{1,4}\s/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** Where {@link planBlockInsert} puts a block: insert `text` at `offset`. */
export interface BlockInsert {
  offset: number;
  text: string;
}

/**
 * Insert `block` as its own paragraph-separated block without splitting the
 * cursor's line: after that line when it has text, in place of the line's
 * start when it is blank. A blank line separates the block from non-blank
 * neighbours.
 *
 * A cursor in the front matter or at/above the first heading (e.g. a note just
 * opened, cursor at the top) appends the block at the end of the document
 * instead, the same rule sample references follow (#63): text above the title
 * belongs to no section, and inside the front matter it breaks the YAML.
 */
export function planBlockInsert(text: string, cursor: number, block: string): BlockInsert {
  const body = block.replace(/^\s*\n/, '').trimEnd();
  const lines = text.split('\n');
  const pos = Math.max(0, Math.min(cursor, text.length));
  const lineIdx = text.slice(0, pos).split('\n').length - 1;

  const lineStarts: number[] = [];
  let acc = 0;
  for (const ln of lines) {
    lineStarts.push(acc);
    acc += ln.length + 1;
  }
  if (isBeforeBody(scanDocumentHead(lines), lineStarts, lineIdx, pos)) {
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { offset: text.length, text: `${sep}${body}\n` };
  }

  const lineStart = lineStarts[lineIdx];
  const lineEnd = lineStart + lines[lineIdx].length;

  const isLast = lineIdx === lines.length - 1;
  const nextHasText = !isLast && lines[lineIdx + 1].trim() !== '';
  // End the block with a line break when text follows directly, or at EOF.
  const tail = isLast || nextHasText ? '\n' : '';

  if (lines[lineIdx].trim() === '') {
    const prevHasText = lineIdx > 0 && lines[lineIdx - 1].trim() !== '';
    return { offset: lineStart, text: `${prevHasText ? '\n' : ''}${body}${tail}` };
  }
  return { offset: lineEnd, text: `\n\n${body}${tail}` };
}
