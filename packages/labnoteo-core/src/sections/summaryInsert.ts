/**
 * Where the AI result summaries go (#279, #306): at the end of a named
 * section (`Conclusions and Discussion` of a workflow note, `Summary and
 * Discussion` of a README), replacing the summary an earlier run put there.
 */
import { findSectionMatches, sectionBodyEnd } from './sectionEdit';

/** The first section named `heading` (compared as {@link findSectionMatches} does): its heading line and body end. */
function locate(md: string, heading: string): { lines: string[]; line: number; end: number } | undefined {
  const match = findSectionMatches(md, heading)[0];
  if (!match) return undefined;
  const lines = md.split('\n');
  return { lines, line: match.line, end: sectionBodyEnd(lines, match.line, match.level) };
}

/** Character offset of the start of 0-based line `line`. */
function lineOffset(lines: readonly string[], line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) at += lines[i].length + 1;
  return at;
}

/** The text under the section named `heading`, trimmed; undefined without one. */
export function sectionText(md: string, heading: string): string | undefined {
  const found = locate(md, heading);
  return found ? found.lines.slice(found.line + 1, found.end).join('\n').trim() : undefined;
}

/**
 * Where to put `block` so it ends the section named `heading`: after its last
 * written line, a blank line apart from it. Undefined without such a section.
 */
export function planSectionAppend(md: string, heading: string, block: string): { offset: number; text: string } | undefined {
  const found = locate(md, heading);
  if (!found) return undefined;
  const { lines, line } = found;
  let last = found.end - 1;
  while (last > line && lines[last].trim() === '') last--;
  const offset = lineOffset(lines, last) + lines[last].length;
  const atEnd = offset >= md.length;
  return { offset, text: `\n\n${block}${atEnd ? '\n' : ''}` };
}

/**
 * The `> [!note] …` callout in the section named `heading` whose title starts
 * with one of `titles` — the summary an earlier run wrote — as the character
 * range from its first line to the end of its last.
 */
export function findAiCalloutInSection(
  md: string,
  heading: string,
  titles: readonly string[]
): { start: number; end: number } | undefined {
  const found = locate(md, heading);
  if (!found) return undefined;
  const { lines } = found;
  for (let i = found.line + 1; i < found.end; i++) {
    const m = /^>\s*\[!note\]\s*(.*)$/i.exec(lines[i]);
    if (!m || !titles.some(t => t && m[1].startsWith(t))) continue;
    let last = i;
    while (last + 1 < found.end && lines[last + 1].trimStart().startsWith('>')) last++;
    const start = lineOffset(lines, i);
    return { start, end: lineOffset(lines, last) + lines[last].length };
  }
  return undefined;
}
