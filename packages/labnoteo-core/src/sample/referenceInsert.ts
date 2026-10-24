/**
 * Decide WHERE in a note a sample reference (`id;alias` / bare `id`) should be
 * inserted, given the cursor offset. Pure and platform-neutral so the rule set
 * is unit-tested; the Obsidian side ({@link insertSampleReference}) only applies
 * the returned edit and reveals it.
 *
 * The rules, in order (see #50, #55):
 *  1. Cursor inside the front matter, or at/above the start of the first
 *     heading line -> append at the end of the document (a floating reference
 *     above the title belongs to no section). Without any heading, this applies
 *     only inside the front matter.
 *  2. Cursor on a heading line -> the line AFTER the heading (inserting at the
 *     line start would push the `##` and break the heading).
 *  T. Cursor on a table row (#72) -> stay inside the cells: right BEFORE the
 *     reference or definition under the cursor, else at the cursor (moved
 *     inside the outer pipes). The next line would split the table, and the
 *     line end would add a cell the header does not render.
 *  3. Cursor on a sample definition line (`@type;ID;alias;desc`) -> the line
 *     AFTER it. The definition's alias/description run to the next `;:|` or the
 *     line end, so anything appended to that line is read back into them and
 *     overwrites the registered sample.
 *     Cursor on an existing sample reference — its id or the `;alias;desc`
 *     after it, up to whitespace — -> the end of that line (splitting a
 *     reference corrupts it and can register a mangled fragment as a sample).
 *  S. A selection within one body line (#302) -> replaced by the reference,
 *     unless the line is a definition or the selection overlaps a reference or
 *     crosses a table cell's `|`; those fall back to the rules for its start.
 *  4. Otherwise -> at the cursor, padding with a space when the adjacent
 *     character would fuse with the id (letters/digits in any script, `_;-`),
 *     or, for a reference with an alias, before any non-blank character: the
 *     alias runs up to whitespace and would swallow it (`pET-28a(+)(samples`).
 */
import { findSampleIdRanges } from './sampleSuggest';
import { escapeRegExp } from '../lib/regexUtils';
import { scanDocumentHead, isBeforeBody } from '../sections/documentHead';

export interface ReferenceInsert {
  /** Absolute offset in the text where `text` is inserted. */
  offset: number;
  /** The exact string to insert at `offset` (may include leading/trailing newlines or spaces). */
  text: string;
  /** End of the selected text `text` replaces, from `offset`; absent for a plain insert. */
  end?: number;
}

/** A character that would fuse with a sample id if placed right against it. */
const ADJACENT = /[\p{L}\p{N}_;-]/u;

/** The `;alias;desc` tail a reference may carry, stopping at whitespace; `\|` belongs to it. */
const REFERENCE_TAIL = /^(?:[;|](?:\\\||[^\s;:|])*){0,2}/;

const TABLE_ROW = /^\s*\|/;

/** Index of the first unescaped `|` at or after `from`, or -1. */
function nextCellPipe(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '|') return i;
  }
  return -1;
}

/** Index of the last unescaped `|` on `line`, or -1. */
function lastCellPipe(line: string): number {
  let last = -1;
  for (let i = nextCellPipe(line, 0); i !== -1; i = nextCellPipe(line, i + 1)) last = i;
  return last;
}

/**
 * Start of the sample token under column `ch` in a table row, or -1. A
 * definition starts at its `@type;` and its alias/description run to the end
 * of the cell; a reference ends at whitespace like {@link isOnReference}.
 */
function tokenStartInCell(line: string, ch: number, types: readonly string[]): number {
  for (const range of findSampleIdRanges(line, types)) {
    const def = new RegExp(`@${escapeRegExp(range.type)}[;:]$`, 'i').exec(line.slice(0, range.start));
    if (def) {
      const cellEnd = nextCellPipe(line, range.end);
      if (ch >= def.index && ch <= (cellEnd === -1 ? line.length : cellEnd)) return def.index;
      continue;
    }
    const tail = REFERENCE_TAIL.exec(line.slice(range.end))?.[0] ?? '';
    if (ch >= range.start && ch <= range.end + tail.length) return range.start;
  }
  return -1;
}

/** Where a reference goes on a table row, as a column of `line`. */
function tableInsertColumn(line: string, ch: number, types: readonly string[]): number {
  const token = tokenStartInCell(line, ch, types);
  if (token !== -1) return token;
  const first = nextCellPipe(line, 0);
  if (ch <= first) return first + 1;
  const last = lastCellPipe(line);
  if (last > first && ch > last && !line.slice(last + 1).trim()) return last;
  return ch;
}

/**
 * True when `line` holds a `@type;ID…` sample definition of one of `types`,
 * anywhere on it: sync registers a definition after other text too
 * (`오늘 쓴 것: @reagent;…`), so it needs the same protection (#55).
 */
function isDefinitionLine(line: string, types: readonly string[]): boolean {
  return types.some(type => {
    const t = escapeRegExp(type);
    return new RegExp(`@${t}[;:]${t}-\\d+(?:-\\d+)*\\b`, 'i').test(line);
  });
}

/**
 * Whether `ref` needs a space before the character `after`: a bare id only
 * before one it would fuse with, a reference with an alias before any
 * non-blank one, since the alias runs up to whitespace.
 */
function keepsApart(ref: string, after: string): boolean {
  return /[;|]/.test(ref) ? !/\s/.test(after) : ADJACENT.test(after);
}

/** True when columns `[from, to)` touch a reference's id or its `;alias;desc` tail. */
function overlapsReference(line: string, from: number, to: number, types: readonly string[]): boolean {
  return findSampleIdRanges(line, types).some(range => {
    const tail = REFERENCE_TAIL.exec(line.slice(range.end))?.[0] ?? '';
    return from <= range.end + tail.length && to >= range.start;
  });
}

/** True when column `ch` sits on a reference's id or its `;alias;desc` tail. */
function isOnReference(line: string, ch: number, types: readonly string[]): boolean {
  return findSampleIdRanges(line, types).some(range => {
    const tail = REFERENCE_TAIL.exec(line.slice(range.end))?.[0] ?? '';
    return ch >= range.start && ch <= range.end + tail.length;
  });
}

export function planReferenceInsert(
  text: string,
  cursor: number,
  ref: string,
  types: readonly string[],
  selectionEnd?: number
): ReferenceInsert {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const selEnd = selectionEnd === undefined ? pos : Math.max(pos, Math.min(selectionEnd, text.length));
  const lines = text.split('\n');

  // Offset at which each line begins (line i spans [start, start+len], with the
  // newline, if any, at start+len).
  const lineStart: number[] = [];
  let acc = 0;
  for (const ln of lines) {
    lineStart.push(acc);
    acc += ln.length + 1;
  }

  let cursorLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (pos <= lineStart[i] + lines[i].length) {
      cursorLine = i;
      break;
    }
  }
  const cursorCol = pos - lineStart[cursorLine];

  const head = scanDocumentHead(lines);
  const { headingLines } = head;

  // Rule 1: append at end of document.
  if (isBeforeBody(head, lineStart, cursorLine, pos)) {
    const prefix = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return { offset: text.length, text: `${prefix}${ref}\n` };
  }

  // Rule 2: cursor on a heading line -> the line after it.
  if (headingLines.has(cursorLine)) {
    const headEnd = lineStart[cursorLine] + lines[cursorLine].length;
    if (headEnd < text.length && text[headEnd] === '\n') {
      return { offset: headEnd + 1, text: `${ref}\n` };
    }
    return { offset: headEnd, text: `\n${ref}\n` };
  }

  const line = lines[cursorLine];
  const lineEnd = lineStart[cursorLine] + line.length;

  // A selection on one line, away from definitions and references: replace it.
  if (selEnd > pos && selEnd <= lineEnd && !isDefinitionLine(line, types)) {
    const from = cursorCol;
    const to = selEnd - lineStart[cursorLine];
    const crossesCell = TABLE_ROW.test(line) && nextCellPipe(line, from) !== -1 && nextCellPipe(line, from) < to;
    if (!crossesCell && !overlapsReference(line, from, to, types)) {
      const before = pos > 0 ? text[pos - 1] : '';
      const after = selEnd < text.length ? text[selEnd] : '';
      const lead = before && ADJACENT.test(before) ? ' ' : '';
      const trail = after && keepsApart(ref, after) ? ' ' : '';
      return { offset: pos, end: selEnd, text: `${lead}${ref}${trail}` };
    }
  }

  // Table row: inside the cells, padded with a space against any neighbour.
  if (TABLE_ROW.test(line)) {
    const col = tableInsertColumn(line, cursorCol, types);
    const lead = col > 0 && !/\s/.test(line[col - 1]) ? ' ' : '';
    const trail = col < line.length && !/\s/.test(line[col]) ? ' ' : '';
    return { offset: lineStart[cursorLine] + col, text: `${lead}${ref}${trail}` };
  }

  // Rule 3: on a definition line -> the next line; on a reference -> line end.
  if (isDefinitionLine(line, types)) {
    if (lineEnd < text.length && text[lineEnd] === '\n') {
      return { offset: lineEnd + 1, text: `${ref}\n` };
    }
    return { offset: lineEnd, text: `\n${ref}` };
  }
  if (isOnReference(line, cursorCol, types)) {
    const prefix = /\s$/.test(line) ? '' : ' ';
    return { offset: lineEnd, text: `${prefix}${ref}` };
  }

  // Rule 4: at the cursor, kept apart from a fusing neighbour before and any text after.
  const before = pos > 0 ? text[pos - 1] : '';
  const after = pos < text.length ? text[pos] : '';
  const lead = before && ADJACENT.test(before) ? ' ' : '';
  const trail = after && keepsApart(ref, after) ? ' ' : '';
  return { offset: pos, text: `${lead}${ref}${trail}` };
}
