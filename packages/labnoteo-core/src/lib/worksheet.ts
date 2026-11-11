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
import { classifyLines, isFenced, isPlain } from '../sections/codeFences';
import { fitRow, isTableHeaderLine, isTableRowLine, splitTableCells } from './exportTablesCsv';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from './unitOpTemplate';
import { stripAiCallouts } from './aiCallout';
import { findSampleReferenceSpans, type SampleLocationLookup } from './sampleStorage';
import { escapeMarkdownInline } from './sampleUtils';

export type UnitOpKind = 'hw' | 'sw';

/** A piece of a section's body, as the printed sheet lays it out. */
export type WorksheetBlock =
  /** A list item; `level` is how deeply it is nested (0 = outermost), `checked` for a ticked `[x]`. */
  | { kind: 'item'; level: number; text: string; checked?: true }
  /** A paragraph; `footnote` for a footnote definition (`[^1]: …`). */
  | { kind: 'para'; text: string; footnote?: true }
  | { kind: 'table'; rows: string[][] }
  /** A fenced code block's lines, without the fences (#418). */
  | { kind: 'code'; lines: string[] }
  | WorksheetQuote;

/**
 * A block quote's lines without their `>` (#558). A callout (`> [!warning] Title`)
 * has its type, lowercased, and its title; its first line is not among `lines`.
 */
export interface WorksheetQuote {
  kind: 'quote';
  callout?: string;
  title?: string;
  lines: string[];
}

/**
 * One Method step: its own line, the lines nested under it, and a table and
 * code blocks written below it. `done` for a ticked step (#436); `preface`
 * for a table or code block above the first step, printed without a box or
 * number so the steps keep the note's numbers.
 */
export interface WorksheetStep {
  text: string;
  sub: string[];
  table?: string[][];
  code?: string[][];
  /** Quotes and callouts written below it, printed under it without a number (#558). */
  quotes?: WorksheetQuote[];
  done?: true;
  preface?: true;
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
  return metaLines.some(l => /^[ \t]*-\s*Software\s*:/.test(l)) ? 'sw' : 'hw';
}

interface RawSection {
  title: string;
  lines: string[];
}

// front matter: reads one unit operation block's lines, below the front matter.
function splitSections(lines: readonly string[]): { description: string; sections: RawSection[] } {
  const sections: RawSection[] = [];
  const intro: string[] = [];
  let current: RawSection | null = null;
  const kinds = classifyLines(lines);
  for (const [i, line] of lines.entries()) {
    const m = isPlain(kinds[i]) && /^####[ \t]+(.+?)[ \t]*$/.exec(line);
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
    .filter(l => /^[ \t]*>/.test(l))
    .map(l => l.replace(/^[ \t]*>\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  // What the user wrote between the title and the first `####`, such as a
  // caution for whoever runs the step, prints first without a heading (#383).
  const written = intro.filter(l => !/^[ \t]*>/.test(l) && !/^\s*-{3,}\s*$/.test(l));
  if (written.some(l => l.trim() !== '')) sections.unshift({ title: '', lines: written });
  return { description, sections };
}

const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const FOOTNOTE_DEF_RE = /^[ \t]*\[\^[^\]\s]+\]:/;
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/;
const CALLOUT_RE = /^\[!([^\]\s]+)\][+-]?\s*(.*)$/;

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
 * tables stay tables instead of printing their `|` marks (#253, #254), a
 * fenced code block keeps its lines as written (#418), and a line that is
 * none of these continues the item or paragraph above it. A footnote
 * definition starts a paragraph of its own. A run of `>` lines, indented or
 * not, is a quote or callout (#558); a plain line right after one continues
 * it, as Markdown reads it, while a list item, table, fence or blank line ends it.
 */
export function parseWorksheetBlocks(lines: readonly string[]): WorksheetBlock[] {
  const blocks: WorksheetBlock[] = [];
  const open: number[] = [];
  let afterBlank = false;
  let code: string[] = [];
  // Each line as the one block reading has it (classifyLines): a fence ended by the end of its list
  // item or block quote keeps its last line as code.
  const kinds = classifyLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kind = kinds[i].kind;
    if (isFenced(kinds[i])) {
      if (kind === 'opener') {
        code = [];
        blocks.push({ kind: 'code', lines: code });
      } else if (kind === 'code') {
        code.push(line);
      }
      open.length = 0;
      afterBlank = false;
      continue;
    }
    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }
    const quoted = QUOTE_RE.exec(line);
    if (quoted) {
      const text = quoted[1].trim();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'quote' && !afterBlank) {
        if (text) last.lines.push(text);
      } else {
        const callout = CALLOUT_RE.exec(text);
        blocks.push(
          callout
            ? { kind: 'quote', callout: callout[1].toLowerCase(), ...(callout[2] ? { title: callout[2] } : {}), lines: [] }
            : { kind: 'quote', lines: text ? [text] : [] }
        );
        open.length = 0;
      }
      afterBlank = false;
      continue;
    }
    if (isTableHeaderLine(lines, i)) {
      const header = splitTableCells(line);
      const rows = [header];
      for (i += 2; i < lines.length && isTableRowLine(lines[i], kinds[i]); i++) {
        rows.push(fitRow(splitTableCells(lines[i]), header.length));
      }
      i--;
      blocks.push({ kind: 'table', rows });
      open.length = 0;
      afterBlank = false;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      blocks.push({
        kind: 'item',
        level: levelOf(indentWidth(line), open),
        text: item[2].trim(),
        ...(item[1] !== undefined && item[1] !== ' ' && { checked: true as const }),
      });
      afterBlank = false;
      continue;
    }
    const footnote = FOOTNOTE_DEF_RE.test(line);
    const last = blocks[blocks.length - 1];
    if (!afterBlank && !footnote && last?.kind === 'quote') {
      if (last.lines.length > 0) last.lines[last.lines.length - 1] += ` ${line.trim()}`;
      else last.lines.push(line.trim());
      continue;
    }
    if (!afterBlank && !footnote && last && (last.kind === 'item' || last.kind === 'para')) {
      last.text += ` ${line.trim()}`;
      continue;
    }
    blocks.push({ kind: 'para', text: line.trim(), ...(footnote && { footnote: true as const }) });
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
  const above = (): WorksheetStep => {
    if (steps.length === 0) steps.push({ text: '', sub: [], preface: true });
    return steps[steps.length - 1];
  };
  for (const block of blocks) {
    // A code block or footnote belongs to the step above, as a table does, so
    // no step number is spent on it (#418).
    if (block.kind === 'table') {
      above().table = block.rows;
      continue;
    }
    if (block.kind === 'code') {
      (above().code ??= []).push(block.lines);
      continue;
    }
    // A callout after a blank line no longer takes a step number (#558).
    if (block.kind === 'quote') {
      (above().quotes ??= []).push(block);
      continue;
    }
    if (block.kind === 'para' && block.footnote) {
      above().sub.push(block.text);
      continue;
    }
    const last = steps[steps.length - 1];
    if (last && block.kind === 'item' && block.level > 0) {
      last.sub.push(block.text);
      continue;
    }
    steps.push({ text: block.text, sub: [], ...(block.kind === 'item' && block.checked && { done: true as const }) });
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

/**
 * `lines` with each template hint line outside code blocks made blank (#400):
 * one kept above what was written would print as text or as step 1. A blank
 * line, not none, so the paragraphs around it stay apart.
 */
function blankPlaceholders(lines: readonly string[]): string[] {
  const kinds = classifyLines(lines);
  return lines.map((line, i) => {
    return !isFenced(kinds[i]) && PLACEHOLDERS.has(line.trim()) ? '' : line;
  });
}

function toSection(raw: RawSection): WorksheetSection {
  // The `> [!note] AI draft` line over a drafted Method would print as step 1 (#280).
  const source = raw.title === 'Method' ? stripAiCallouts(raw.lines.join('\n')).split('\n') : raw.lines;
  const lines = raw.title === 'Meta' ? source : blankPlaceholders(source);
  const body = trimBlankEdges(lines.map(l => l.trimEnd()));
  const text = body.join('\n').trim();
  if (raw.title === 'Meta') {
    const fields = body
      .map(l => /^[ \t]*-\s*([^:]+?)\s*:\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ label: m[1], value: m[2].replace(/^(['"])(.*)\1$/, '$2').trim() }));
    for (const label of META_FILL_IN) {
      if (!fields.some(f => f.label === label)) fields.push({ label, value: '' });
    }
    return { type: 'meta', title: raw.title, fields };
  }
  if (text === '') {
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
 * `text` with the storage location of the samples it references added at the
 * end (#496): ` — -80 / Box 1 / A3` for one sample, ` — DNA-1: …; DNA-2: …`
 * for several. The reference itself is left as written: a plain reference's
 * alias runs to the end of the line, so nothing could be put after it inside.
 */
function withSampleLocations(text: string, types: readonly string[], lookup: SampleLocationLookup): string {
  const spans = findSampleReferenceSpans(text, types);
  const seen = new Set<string>();
  const found: { id: string; location: string }[] = [];
  for (const span of spans) {
    const key = `${span.type}\u0000${span.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = lookup(span.type, span.id);
    if (location) found.push({ id: span.id, location: escapeMarkdownInline(location) });
  }
  if (found.length === 0) return text;
  if (seen.size === 1) return `${text} — ${found[0].location}`;
  return `${text} — ${found.map(f => `${escapeMarkdownInline(f.id)}: ${f.location}`).join('; ')}`;
}

/**
 * The unit operations with each sample reference's storage location added to
 * the line it is on (#496), so the sheet says where to fetch the tube. Meta
 * values, Method steps and the lines under them, list items, paragraphs and
 * table cells are annotated; code blocks, the title, alias and description
 * are not, so the QR code's fingerprint is the same. Discarded and unknown
 * samples, and ones without a location, add nothing.
 */
export function annotateWorksheetSamples(
  unitOps: readonly WorksheetUnitOp[],
  types: readonly string[],
  lookup: SampleLocationLookup
): WorksheetUnitOp[] {
  const line = (text: string): string => withSampleLocations(text, types, lookup);
  const rows = (table: string[][]): string[][] => table.map(row => row.map(line));
  const quote = (q: WorksheetQuote): WorksheetQuote => ({ ...q, lines: q.lines.map(line) });
  const section = (s: WorksheetSection): WorksheetSection => {
    switch (s.type) {
      case 'meta':
        return { ...s, fields: s.fields.map(f => ({ ...f, value: line(f.value) })) };
      case 'steps':
        return {
          ...s,
          steps: s.steps.map(step => ({
            ...step,
            text: line(step.text),
            sub: step.sub.map(line),
            ...(step.table ? { table: rows(step.table) } : {}),
            ...(step.quotes ? { quotes: step.quotes.map(quote) } : {}),
          })),
        };
      case 'text':
        return {
          ...s,
          blocks: s.blocks.map(b =>
            b.kind === 'table'
              ? { ...b, rows: rows(b.rows) }
              : b.kind === 'code'
                ? b
                : b.kind === 'quote'
                  ? quote(b)
                  : { ...b, text: line(b.text) }
          ),
        };
      case 'blank':
        return s;
    }
  };
  return unitOps.map(op => ({ ...op, sections: op.sections.map(section) }));
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

/** A code block prints each line, a long one wrapping. */
const codeLines = (lines: readonly string[]): number => lines.reduce((n, line) => n + wrapped(line), 0);

/** A quote prints each line, a callout its title line too, with room for the box around it. */
const quoteLines = (quote: WorksheetQuote): number =>
  (quote.callout ? 1 : 0) + quote.lines.reduce((n, line) => n + wrapped(line), 0) + 1;

const stepWeight = (step: WorksheetStep): number =>
  (step.preface && !step.text ? 0 : wrapped(step.text)) +
  step.sub.reduce((n, line) => n + wrapped(line), 0) +
  (step.table ? tableLines(step.table) : 0) +
  (step.code ?? []).reduce((n, lines) => n + codeLines(lines), 0) +
  (step.quotes ?? []).reduce((n, quote) => n + quoteLines(quote), 0);

const blockWeight = (block: WorksheetBlock): number => {
  switch (block.kind) {
    case 'table':
      return tableLines(block.rows);
    case 'code':
      return codeLines(block.lines);
    case 'quote':
      return quoteLines(block);
    default:
      return wrapped(block.text);
  }
};

/** Estimated printed height of a section, in text lines (heading included). */
export function sectionWeight(section: WorksheetSection): number {
  const heading = section.title ? 2 : 0;
  switch (section.type) {
    case 'meta':
      return heading + section.fields.length;
    case 'steps':
      return heading + section.steps.reduce((n, s) => n + stepWeight(s), 0);
    case 'text':
      return heading + section.blocks.reduce((n, b) => n + blockWeight(b), 0);
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
