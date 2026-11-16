/**
 * The lines the README workflow delete of #442 (labnoteo main at 12fde98)
 * removes, kept as it was, fence and heading rules included, so the current
 * delete can take the union with it and never remove less than main did.
 * Every line it removes is one v0.130.0 removed too (a checklist line for the
 * file), so the union stays within v0.130.0. Do not "fix" this module: its
 * job is to stay what main shipped.
 */
import { isWorkflowChecklistEntryLine } from './workflowStructure';
import { escapeRegExp } from './regexUtils';
import { normalizeHeadingText } from '../sections/sectionEdit';

interface OpenFence {
  char: string;
  length: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ANY_HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const WORKFLOW_SECTION_NAMES = ['related workflows', '관련 워크플로'];

/** `stepFence` as main had it: any backtick run opens a fence, info string or not. */
// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
function stepFence(line: string, open: OpenFence | null): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) return open;
  const run = match[1];
  if (open === null) return { char: run[0], length: run.length };
  const afterRun = line.slice(line.indexOf(run) + run.length);
  const closes = run[0] === open.char && run.length >= open.length && afterRun.trim() === '';
  return closes ? null : open;
}

// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
function listHeadings(md: string): { line: number; level: number; text: string }[] {
  const lines = md.split(/\r?\n/);
  const out: { line: number; level: number; text: string }[] = [];
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence) continue;
    const h = lines[i].match(ANY_HEADING_RE);
    if (h) out.push({ line: i, level: h[1].length, text: h[2] });
  }
  return out;
}

// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
function findSectionMatches(md: string, heading: string): { line: number; level: number }[] {
  const lines = md.split(/\r?\n/);
  const headingRe = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`);
  const headings = listHeadings(md);
  let found = headings.filter(h => headingRe.test(lines[h.line]));
  if (found.length === 0) {
    const wanted = normalizeHeadingText(heading);
    found = wanted ? headings.filter(h => normalizeHeadingText(h.text) === wanted) : [];
  }
  return found;
}

// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
function sectionBodyEnd(lines: readonly string[], headingIdx: number, level: number): number {
  const boundaryRe = new RegExp(`^#{1,${level}}\\s`);
  let bodyFence: OpenFence | null = null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const next = stepFence(lines[i], bodyFence);
    if (next !== bodyFence) {
      bodyFence = next;
      continue;
    }
    if (bodyFence) continue;
    if (!boundaryRe.test(lines[i])) continue;
    let j = i - 1;
    while (j > headingIdx && lines[j].trim() === '') j--;
    if (j > headingIdx && THEMATIC_BREAK_RE.test(lines[j]) && (j - 1 === headingIdx || lines[j - 1].trim() === '')) return j;
    return i;
  }
  return lines.length;
}

// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
function workflowChecklistSectionRange(readmeContent: string): { header: number; end: number } | undefined {
  const lines = readmeContent.split(/\r?\n/);
  const isH2 = (line: string): boolean => /^##\s/.test(line.trim());
  const endOf = (header: number): number => {
    for (let i = header + 1; i < lines.length; i++) if (isH2(lines[i])) return i;
    return lines.length;
  };
  const named = lines.findIndex(line => {
    if (!isH2(line)) return false;
    const text = normalizeHeadingText(line.trim().replace(/^##\s+/, ''));
    return WORKFLOW_SECTION_NAMES.some(name => text.includes(name));
  });
  if (named !== -1) return { header: named, end: endOf(named) };
  for (let i = 0; i < lines.length; i++) {
    if (!isH2(lines[i])) continue;
    const end = endOf(i);
    if (lines.slice(i + 1, end).some(isWorkflowChecklistEntryLine)) return { header: i, end };
    i = end - 1;
  }
  return undefined;
}

/**
 * Indices of `lines` (`readmeContent` split after each `\n`) that main's delete
 * removes for the checklist lines `isEntryFor` recognises.
 */
// front matter: main (#442) as it was, kept to compare with. It reads the front matter as Markdown; removeWorkflowFromReadme drops each returned line inside it.
export function v442DeletedLines(
  readmeContent: string,
  lines: readonly string[],
  isEntryFor: (line: string) => boolean
): Set<number> {
  const inCode: boolean[] = [];
  let fence: OpenFence | null = null;
  for (const line of lines) {
    const next = stepFence(line, fence);
    inCode.push(fence !== null || next !== null);
    fence = next;
  }
  const ranges = findSectionMatches(readmeContent, 'Related Workflows').map(section => ({
    start: section.line + 1,
    end: sectionBodyEnd(lines, section.line, section.level),
  }));
  const workflow = workflowChecklistSectionRange(readmeContent);
  if (workflow) {
    ranges.push({ start: workflow.header + 1, end: Math.min(workflow.end, sectionBodyEnd(lines, workflow.header, 2)) });
  }
  const drop = new Set<number>();
  for (const { start, end } of ranges) {
    for (let i = start; i < Math.min(end, lines.length); i++) {
      if (!inCode[i] && isEntryFor(lines[i])) drop.add(i);
    }
  }
  return drop;
}
