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
 *  3. Cursor on a sample definition line (`@type;ID;alias;desc`) -> the line
 *     AFTER it. The definition's alias/description run to the next `;:|` or the
 *     line end, so anything appended to that line is read back into them and
 *     overwrites the registered sample.
 *     Cursor on an existing sample reference — its id or the `;alias;desc`
 *     after it, up to whitespace — -> the end of that line (splitting a
 *     reference corrupts it and can register a mangled fragment as a sample).
 *  4. Otherwise -> at the cursor, padding with a space only when the adjacent
 *     character would fuse with the id (letters/digits in any script, `_;-`).
 */
import { findSampleIdRanges } from './sampleSuggest';
import { escapeRegExp } from '../lib/regexUtils';
import { scanDocumentHead, isBeforeBody } from '../sections/documentHead';

export interface ReferenceInsert {
  /** Absolute offset in the text where `text` is inserted. */
  offset: number;
  /** The exact string to insert at `offset` (may include leading/trailing newlines or spaces). */
  text: string;
}

/** A character that would fuse with a sample id if placed right against it. */
const ADJACENT = /[\p{L}\p{N}_;-]/u;

/** The `;alias;desc` tail a reference may carry, stopping at whitespace. */
const REFERENCE_TAIL = /^(?:[;|][^\s;:|]*){0,2}/;

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
  types: readonly string[]
): ReferenceInsert {
  const pos = Math.max(0, Math.min(cursor, text.length));
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

  // Rule 3: on a definition line -> the next line; on a reference -> line end.
  const line = lines[cursorLine];
  const lineEnd = lineStart[cursorLine] + line.length;
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

  // Rule 4: at the cursor, padded only when it would fuse with a neighbour.
  const before = pos > 0 ? text[pos - 1] : '';
  const after = pos < text.length ? text[pos] : '';
  const lead = before && ADJACENT.test(before) ? ' ' : '';
  const trail = after && ADJACENT.test(after) ? ' ' : '';
  return { offset: pos, text: `${lead}${ref}${trail}` };
}
