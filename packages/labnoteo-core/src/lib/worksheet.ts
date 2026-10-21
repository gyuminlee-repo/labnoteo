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
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from './unitOpTemplate';

export type UnitOpKind = 'hw' | 'sw';

export type WorksheetSection =
  | { type: 'meta'; title: string; fields: { label: string; value: string }[] }
  | { type: 'steps'; title: string; steps: string[] }
  | { type: 'text'; title: string; lines: string[] }
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

const trimBlankEdges = (lines: string[]): string[] => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
};

function toSection(raw: RawSection): WorksheetSection {
  const body = trimBlankEdges(raw.lines.map(l => l.trimEnd()));
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
    const steps: string[] = [];
    for (const line of body) {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
      if (item) steps.push(item[1]);
      else if (line.trim() && steps.length) steps[steps.length - 1] += ` ${line.trim()}`;
      else if (line.trim()) steps.push(line.trim());
    }
    return { type: 'steps', title: raw.title, steps };
  }
  return { type: 'text', title: raw.title, lines: body.filter(l => l.trim() !== '') };
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

const wrapped = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_LINE));

/** Estimated printed height of a section, in text lines (heading included). */
export function sectionWeight(section: WorksheetSection): number {
  const heading = 2;
  switch (section.type) {
    case 'meta':
      return heading + section.fields.length;
    case 'steps':
      return heading + section.steps.reduce((n, s) => n + wrapped(s), 0);
    case 'text':
      return heading + section.lines.reduce((n, l) => n + wrapped(l), 0);
    case 'blank':
      return heading;
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
