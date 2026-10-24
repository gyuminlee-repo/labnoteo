/**
 * Printed experiment worksheets: one or more pages per unit operation, each
 * carrying a QR code that names the note, the unit operation and the page.
 *
 * This module only decides *what* goes on which page; the host renders the
 * pages (HTML for printing) and draws the QR codes. Text already written in
 * the note is printed without its blank lines, Method steps get a checkbox,
 * and sections still holding the template placeholder print their heading only.
 */
import { listUnitOpBlocks, WORKSHEET_SCANS_HEADING } from '../sections/scanInsert';
import { stepFence, type OpenFence } from '../sections/sectionEdit';
import { fitRow, SEPARATOR_ROW_RE, splitTableRow } from './exportTablesCsv';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from './unitOpTemplate';
import { stripAiCallouts } from './noteResults';

export type UnitOpKind = 'hw' | 'sw';

/** A piece of a section's body, as the printed sheet lays it out. */
export type WorksheetBlock =
  /** A list item; `level` is how deeply it is nested (0 = outermost). */
  | { kind: 'item'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'table'; rows: string[][] };

/** One Method step: its own line, the lines nested under it, and a table written below it. */
export interface WorksheetStep {
  text: string;
  sub: string[];
  table?: string[][];
}

export type WorksheetSection =
  | { type: 'meta'; title: string; fields: { label: string; value: string }[] }
  | { type: 'steps'; title: string; steps: WorksheetStep[] }
  | { type: 'text'; title: string; blocks: WorksheetBlock[] }
  /** Nothing written yet: printed as the heading alone. */
  | { type: 'blank'; title: string };

export interface WorksheetUnitOp {
  /** 1-based position among the note's unit operations. */
  index: number;
  opId: string;
  opName: string;
  alias: string;
  kind: UnitOpKind;
  description: string;
  sections: WorksheetSection[];
}

export interface WorksheetPage {
  unitOp: WorksheetUnitOp;
  page: number;
  pageCount: number;
  sections: WorksheetSection[];
}

const PLACEHOLDERS = new Set<string>([...Object.values(HW_PLACEHOLDERS), ...Object.values(SW_PLACEHOLDERS)]);

/** Meta fields printed as a blank to fill in when the note has no value yet. */
const META_FILL_IN = ['Start_date', 'End_date'];

/**
 * HW for lab steps, SW for software ones: catalog IDs say so by prefix; a
 * custom ID counts as software when its Meta has a `- Software:` line.
 */
export function classifyUnitOp(opId: string, metaLines: readonly string[]): UnitOpKind {
  if (/^UHW/.test(opId)) return 'hw';
  if (/^USW/.test(opId)) return 'sw';
  return metaLines.some(l => /^\s*-\s*Software\s*:/.test(l)) ? 'sw' : 'hw';
}

interface RawSection {
  title: string;
  lines: string[];
}

function splitSections(lines: readonly string[]): { description: string; sections: RawSection[] } {
  const sections: RawSection[] = [];
  const intro: string[] = [];
  let current: RawSection | null = null;
  let fence: OpenFence | null = null;
  for (const line of lines) {
    const next = stepFence(line, fence);
    const inCode = fence !== null || next !== fence;
    fence = next;
    const m = !inCode && /^####\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { title: m[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  const description = intro
    .filter(l => /^\s*>/.test(l))
    .map(l => l.replace(/^\s*>\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  return { description, sections };
}

const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const PIPE_ROW_RE = /^\s*\|/;

/** Width of a line's indent in columns, a tab counting as four. */
function indentWidth(line: string): number {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? '';
  return [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
}

/**
 * How deeply an item at `indent` is nested, tracked the way a Markdown reader
 * does it: a wider indent than the item above opens a level, a narrower one
 * closes back to the level that matches.
 */
function levelOf(indent: number, open: number[]): number {
  while (open.length > 0 && indent < open[open.length - 1]) open.pop();
  if (open.length === 0 || indent > open[open.length - 1]) open.push(indent);
  return open.length - 1;
}

/**
 * A section's lines as blocks to print. List items keep their nesting, pipe
 * tables stay tables instead of printing their `|` marks (#253, #254), and a
 * line that is neither continues the item or paragraph above it.
 */
export function parseWorksheetBlocks(lines: readonly string[]): WorksheetBlock[] {
  const blocks: WorksheetBlock[] = [];
  const open: number[] = [];
  let afterBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }
    if (PIPE_ROW_RE.test(line) && lines[i + 1] !== undefined && SEPARATOR_ROW_RE.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows = [header];
      for (i += 2; i < lines.length && PIPE_ROW_RE.test(lines[i]); i++) {
        rows.push(fitRow(splitTableRow(lines[i]), header.length));
      }
      i--;
      blocks.push({ kind: 'table', rows });
      open.length = 0;
      afterBlank = false;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      blocks.push({ kind: 'item', level: levelOf(indentWidth(line), open), text: item[1].trim() });
      afterBlank = false;
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (!afterBlank && last && last.kind !== 'table') {
      last.text += ` ${line.trim()}`;
      continue;
    }
    blocks.push({ kind: 'para', text: line.trim() });
    open.length = 0;
    afterBlank = false;
  }
  return blocks;
}

/**
 * Method blocks as numbered steps. Only outermost items are steps, so the
 * numbers match the note: what is nested under a step prints below it, and a
 * table written after a step prints with it (#254).
 */
function toSteps(blocks: readonly WorksheetBlock[]): WorksheetStep[] {
  const steps: WorksheetStep[] = [];
  for (const block of blocks) {
    const last = steps[steps.length - 1];
    if (block.kind === 'table') {
      if (last) last.table = block.rows;
      else steps.push({ text: '', sub: [], table: block.rows });
      continue;
    }
    if (last && block.kind === 'item' && block.level > 0) {
      last.sub.push(block.text);
      continue;
    }
    steps.push({ text: block.text, sub: [] });
  }
  return steps;
}

const trimBlankEdges = (lines: string[]): string[] => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
};

function toSection(raw: RawSection): WorksheetSection {
  // The `> [!note] AI draft` line over a drafted Method would print as step 1 (#280).
  const lines = raw.title === 'Method' ? stripAiCallouts(raw.lines.join('\n')).split('\n') : raw.lines;
  const body = trimBlankEdges(lines.map(l => l.trimEnd()));
  const text = body.join('\n').trim();
  if (raw.title === 'Meta') {
    const fields = body
      .map(l => /^\s*-\s*([^:]+?)\s*:\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ label: m[1], value: m[2].replace(/^(['"])(.*)\1$/, '$2').trim() }));
    for (const label of META_FILL_IN) {
      if (!fields.some(f => f.label === label)) fields.push({ label, value: '' });
    }
    return { type: 'meta', title: raw.title, fields };
  }
  if (text === '' || PLACEHOLDERS.has(text)) {
    return { type: 'blank', title: raw.title };
  }
  if (raw.title === 'Method') {
    return { type: 'steps', title: raw.title, steps: toSteps(parseWorksheetBlocks(body)) };
  }
  return { type: 'text', title: raw.title, blocks: parseWorksheetBlocks(body) };
}

/** Every unit operation of the note, as worksheet content. */
export function listWorksheetUnitOps(md: string): WorksheetUnitOp[] {
  const lines = md.split(/\r?\n/);
  return listUnitOpBlocks(md).map(block => {
    const { description, sections } = splitSections(lines.slice(block.headingLine + 1, block.contentEndLine));
    const meta = sections.find(s => s.title === 'Meta')?.lines ?? [];
    return {
      index: block.index,
      opId: block.opId,
      opName: block.opName,
      alias: block.alias,
      kind: classifyUnitOp(block.opId, meta),
      description,
      sections: sections.filter(s => s.title !== WORKSHEET_SCANS_HEADING).map(toSection),
    };
  });
}

/**
 * Roughly how many text lines fit on one A4 page between the QR bands (10pt
 * type, 1.5 line height). The printed page shrinks its type when the estimate
 * falls short, so this only has to be close.
 */
export const PAGE_LINE_BUDGET = 42;
const CHARS_PER_LINE = 80;

/**
 * Writing space kept for a section with nothing in it, so a full page cannot
 * squeeze it to its heading (#245). The printed sheet hands out whatever is
 * left over on top of this.
 */
const BLANK_WRITING_LINES = 3;

const wrapped = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_LINE));

/** A table prints one line per row plus the rule under its header. */
const tableLines = (rows: readonly string[][]): number => rows.length + 1;

const stepWeight = (step: WorksheetStep): number =>
  wrapped(step.text) +
  step.sub.reduce((n, line) => n + wrapped(line), 0) +
  (step.table ? tableLines(step.table) : 0);

/** Estimated printed height of a section, in text lines (heading included). */
export function sectionWeight(section: WorksheetSection): number {
  const heading = 2;
  switch (section.type) {
    case 'meta':
      return heading + section.fields.length;
    case 'steps':
      return heading + section.steps.reduce((n, s) => n + stepWeight(s), 0);
    case 'text':
      return heading + section.blocks.reduce((n, b) => n + (b.kind === 'table' ? tableLines(b.rows) : wrapped(b.text)), 0);
    case 'blank':
      return heading + BLANK_WRITING_LINES;
  }
}

/**
 * Lay the unit operations out on pages: each starts on a new page, and one
 * that does not fit continues on the next page at a `####` section boundary.
 * A single section taller than a page gets a page of its own.
 */
export function paginateWorksheet(
  unitOps: readonly WorksheetUnitOp[],
  budget: number = PAGE_LINE_BUDGET
): WorksheetPage[] {
  const pages: WorksheetPage[] = [];
  for (const unitOp of unitOps) {
    const groups: WorksheetSection[][] = [[]];
    // The title and description are printed in the header band, not the body.
    let used = 0;
    for (const section of unitOp.sections) {
      const weight = sectionWeight(section);
      const current = groups[groups.length - 1];
      if (current.length > 0 && used + weight > budget) {
        groups.push([section]);
        used = weight;
      } else {
        current.push(section);
        used += weight;
      }
    }
    groups.forEach((sections, i) =>
      pages.push({ unitOp, page: i + 1, pageCount: groups.length, sections })
    );
  }
  return pages;
}
