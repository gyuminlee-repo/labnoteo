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
 *  3. Cursor on an existing sample reference -> the end of that line (splitting a
 *     reference corrupts it and can register a mangled fragment as a sample).
 *  4. Otherwise -> at the cursor, padding with a space only when the adjacent
 *     character would fuse with the id (`[\w;-]`).
 */
import { findSampleReferenceAt } from './sampleSuggest';

export interface ReferenceInsert {
  /** Absolute offset in the text where `text` is inserted. */
  offset: number;
  /** The exact string to insert at `offset` (may include leading/trailing newlines or spaces). */
  text: string;
}

/** A character that would fuse with a sample id if placed right against it. */
const ADJACENT = /[\w;-]/;

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

  // Front matter: first line `---`, closed by the next `---`. `fmEndLine` is the
  // closing fence's line index, or -1 when there is no (closed) front matter.
  let fmEndLine = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEndLine = i;
        break;
      }
    }
  }

  // First heading + the set of heading lines, ignoring `#` lines inside fenced
  // code blocks and inside the front matter (YAML comments look like headings).
  const headingLines = new Set<number>();
  let firstHeadingLine = -1;
  {
    let inFence = false;
    let fenceChar = '';
    for (let i = 0; i < lines.length; i++) {
      if (fmEndLine !== -1 && i <= fmEndLine) continue;
      const trimmed = lines[i].trimStart();
      const fence = /^(```+|~~~+)/.exec(trimmed);
      if (fence) {
        const ch = fence[1][0];
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
        } else if (ch === fenceChar) {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;
      if (/^#{1,6}\s/.test(trimmed)) {
        headingLines.add(i);
        if (firstHeadingLine === -1) firstHeadingLine = i;
      }
    }
  }

  const inFrontMatter = fmEndLine !== -1 && cursorLine <= fmEndLine;
  const atOrAboveFirstHeading =
    firstHeadingLine !== -1 && pos <= lineStart[firstHeadingLine];

  // Rule 1: append at end of document.
  if (inFrontMatter || atOrAboveFirstHeading) {
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

  // Rule 3: cursor on an existing reference -> end of that line.
  const onReference = findSampleReferenceAt(lines[cursorLine], cursorCol, types);
  if (onReference) {
    const line = lines[cursorLine];
    const lineEnd = lineStart[cursorLine] + line.length;
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
