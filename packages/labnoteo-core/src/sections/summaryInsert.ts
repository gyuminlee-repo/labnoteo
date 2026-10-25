/**
 * Where the AI result summaries go (#279, #306): at the end of a named
 * section (`Conclusions and Discussion` of a workflow note, `Summary and
 * Discussion` of a README), replacing the summary an earlier run put there.
 */
import { findSectionMatches, listHeadings, sectionBodyEnd, stepFence, type OpenFence } from './sectionEdit';

/** Where {@link locateSummary} found the summary's section. */
export type SummaryPlace =
  /** The section named as asked. */
  | { kind: 'named'; heading: string }
  /** No such section, but an earlier summary sits under this heading ('' above the first heading). */
  | { kind: 'callout'; heading: string }
  /** Neither: the summary goes at the end of the note. */
  | { kind: 'end' };

interface Located {
  lines: string[];
  /** Heading line, or -1 for the text above the first heading. */
  line: number;
  end: number;
  place: SummaryPlace;
}

/** Whether `line` opens a `> [!note]` callout whose title starts with one of `titles`. */
function isSummaryCallout(line: string, titles: readonly string[]): boolean {
  const m = /^>\s*\[!note\]\s*(.*)$/i.exec(line);
  return Boolean(m) && titles.some(t => t && m![1].startsWith(t));
}

/**
 * The section of `md` a summary goes in (#319): the first section named
 * `heading` (compared as {@link findSectionMatches} does); failing that, the
 * section holding the last earlier summary (a `> [!note]` callout titled with
 * one of `titles`, outside code blocks), since the researcher may have
 * renamed the heading; else none.
 */
function locate(md: string, heading: string, titles: readonly string[] = []): Located | undefined {
  const lines = md.split('\n');
  const match = findSectionMatches(md, heading)[0];
  if (match) {
    const text = lines[match.line].replace(/^#{1,6}\s+/, '').trim();
    return { lines, line: match.line, end: sectionBodyEnd(lines, match.line, match.level), place: { kind: 'named', heading: text } };
  }
  if (titles.length === 0) return undefined;
  let callout = -1;
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (!fence && isSummaryCallout(lines[i], titles)) callout = i;
  }
  if (callout === -1) return undefined;
  const above = listHeadings(md).filter(h => h.line < callout).pop();
  if (!above) return { lines, line: -1, end: sectionBodyEnd(lines, -1, 6), place: { kind: 'callout', heading: '' } };
  return { lines, line: above.line, end: sectionBodyEnd(lines, above.line, above.level), place: { kind: 'callout', heading: above.text } };
}

/** Where a summary for the section `heading` goes; see {@link locate}. */
export function locateSummary(md: string, heading: string, titles: readonly string[]): SummaryPlace {
  return locate(md, heading, titles)?.place ?? { kind: 'end' };
}

/** Character offset of the start of 0-based line `line`. */
function lineOffset(lines: readonly string[], line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) at += lines[i].length + 1;
  return at;
}

/** The text under the section named `heading` (or where {@link locate} falls back to with `titles`), trimmed; undefined without one. */
export function sectionText(md: string, heading: string, titles: readonly string[] = []): string | undefined {
  const found = locate(md, heading, titles);
  return found ? found.lines.slice(found.line + 1, found.end).join('\n').trim() : undefined;
}

/**
 * Where to put `block` so it ends the section named `heading` (or where
 * {@link locate} falls back to with `titles`): after its last written line, a
 * blank line apart from it. Undefined without such a section.
 */
export function planSectionAppend(
  md: string,
  heading: string,
  block: string,
  titles: readonly string[] = []
): { offset: number; text: string } | undefined {
  const found = locate(md, heading, titles);
  if (!found) return undefined;
  const { lines, line } = found;
  let last = found.end - 1;
  while (last > line && lines[last].trim() === '') last--;
  if (last < 0) return { offset: 0, text: `${block}\n\n` };
  const offset = lineOffset(lines, last) + lines[last].length;
  const atEnd = offset >= md.length;
  return { offset, text: `\n\n${block}${atEnd ? '\n' : ''}` };
}

/**
 * The `> [!note] …` callout in the section named `heading` (or where
 * {@link locate} falls back to) whose title starts with one of `titles` — the
 * summary an earlier run wrote — as the character range from its first line
 * to the end of its last.
 */
export function findAiCalloutInSection(
  md: string,
  heading: string,
  titles: readonly string[]
): { start: number; end: number } | undefined {
  const found = locate(md, heading, titles);
  if (!found) return undefined;
  const { lines } = found;
  for (let i = found.line + 1; i < found.end; i++) {
    if (!isSummaryCallout(lines[i], titles)) continue;
    let last = i;
    while (last + 1 < found.end && lines[last + 1].trimStart().startsWith('>')) last++;
    const start = lineOffset(lines, i);
    return { start, end: lineOffset(lines, last) + lines[last].length };
  }
  return undefined;
}
