/**
 * Pure helper for the "Delete Workflow" command (issue #38 follow-up).
 *
 * Removes a single workflow entry from the README "Related Workflows" checklist
 * while preserving section order, the instruction blockquote, and every other
 * section. The filesystem side (moving the file to trash, sample cleanup) is
 * handled by the command; this module stays pure and unit-testable.
 */
import { frontMatterLineCount } from '../sections/frontMatter';
import {
  decodeChecklistLink,
  dropBlankLeftByEntries,
  isWorkflowSectionHeading,
  workflowChecklistEntryLink,
  workflowChecklistSectionRange,
} from './workflowStructure';
import { readmeFencedReadings } from './readmeFences';
import { v442DeletedLines } from './workflowDeleteV442';
import { normalizeHeadingText, sectionBodyEnd } from '../sections/sectionEdit';

export interface RemoveWorkflowFromReadmeResult {
  changed: boolean;
  content: string;
}

/**
 * Whether `line` is a "Related Workflows" checklist item linking to `fileName`.
 *
 * Matches both the legacy marker-less `[ ] [title](link)` form and the
 * standard task-list `- [ ] [title](link)` form, comparing the link's base
 * name to `fileName`. The link pattern is intentionally permissive
 * (`[^)]+`) so non-ASCII file names — which the strict checklist parser rejects
 * — are still recognised for removal.
 */
// front matter: one line; removeWorkflowFromReadme drops each line it matched inside the front matter.
function isChecklistLineForFile(line: string, fileName: string): boolean {
  const entryLink = workflowChecklistEntryLink(line.trim());
  if (entryLink !== undefined) return (entryLink.replace(/^\.\//, '').split('/').pop() ?? '') === fileName;
  const match = line.trim().match(/^(?:[-*+]\s+)?\[[ xX]\]\s*\[.*?\]\(([^)]+)\)/);
  if (!match) return false;
  const link = match[1].replace(/^\.\//, '');
  const linkFile = decodeChecklistLink(link.split('/').pop() ?? '');
  return linkFile === fileName;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)\s*$/;

/**
 * The bodies of the headings named "Related Workflows" at any level, each up
 * to the next heading of the same or a higher level, fences not considered
 * (or with the lines flagged in `skip` taken for no heading).
 * As in `findSectionMatches`, headings compare by {@link normalizeHeadingText}
 * only when none matches as written (#145). Exact headings at any level stay
 * in so deletion covers a superset of the add range: a stale entry under
 * `### Related Workflows` still goes.
 */
// front matter: the caller passes how many lines it has (`frontMatter`), left out.
function exactSections(lines: readonly string[], skip?: readonly boolean[], frontMatter = 0): { start: number; end: number }[] {
  const headings = lines.flatMap((line, i) => {
    const m = skip?.[i] || i < frontMatter ? null : HEADING_RE.exec(line.replace(/\r?\n$/, ''));
    return m ? [{ line: i, level: m[1].length, text: m[2] }] : [];
  });
  // ends[k]: line of the next heading at level 1..6 after heading k, or none (one reverse pass).
  const nextAt = new Array<number>(7).fill(lines.length);
  const ends = new Array<number>(headings.length);
  for (let k = headings.length - 1; k >= 0; k--) {
    ends[k] = Math.min(...nextAt.slice(1, headings[k].level + 1));
    nextAt[headings[k].level] = headings[k].line;
  }
  const wanted = normalizeHeadingText('Related Workflows');
  const exact = headings.some(h => h.text === 'Related Workflows');
  return headings.flatMap((h, k) =>
    (exact ? h.text === 'Related Workflows' : normalizeHeadingText(h.text) === wanted) ? [{ start: h.line + 1, end: ends[k] }] : []
  );
}

/**
 * Return README content with the checklist entry for `fileName` removed.
 *
 * Removes only the matching checklist line(s) and leaves every other line
 * byte-for-byte intact, rather than re-serialising the whole section. A
 * parse-and-regenerate approach would silently drop any sibling entry the
 * strict checklist parser cannot recognise (e.g. a manually created link with
 * a non-ASCII file name). (Code review MEDIUM.)
 *
 * When no entry references `fileName` the original content is returned with
 * `changed: false`, so the caller can still delete an unlisted file without
 * rewriting the README.
 */
export function removeWorkflowFromReadme(
  readmeContent: string,
  fileName: string
): RemoveWorkflowFromReadmeResult {
  // Keep each line's terminator so untouched bytes survive even mixed endings.
  const lines = readmeContent.split(/(?<=\n)/);
  // The section the add path writes to (translated or renamed heading, #298)
  // and every exact "Related Workflows" heading; within them a line in a closed
  // fence (either reading) is an example, not an entry, and stays. A range starts
  // only at a heading outside every closed fence, and headings in a closed fence
  // of the CommonMark reading are ignored, so an example heading neither starts a
  // section nor cuts one short. The add path's section is taken as it reads it and
  // with those headings ignored; its pick of the first section holding an entry
  // only when the add path makes that pick too (no heading names the section).
  // Front matter is YAML: no heading or entry in it is read, nor deleted, and no fence in it
  // pairs with one below (the fences are read from past it).
  const fm = frontMatterLineCount(readmeContent);
  const body = readmeFencedReadings(lines.slice(fm));
  const yaml = new Array<boolean>(fm).fill(false);
  const inCode = [...yaml, ...body.inCode];
  const plain = [...yaml, ...body.plain];
  const ranges = exactSections(lines, plain, fm).filter(r => !inCode[r.start - 1]);
  const addPath = workflowChecklistSectionRange(readmeContent);
  const addPathNamed = addPath !== undefined && isWorkflowSectionHeading(lines[addPath.header]);
  for (const skip of [undefined, plain]) {
    const workflow = workflowChecklistSectionRange(readmeContent, skip);
    if (!workflow || inCode[workflow.header]) continue;
    if (addPathNamed && !isWorkflowSectionHeading(lines[workflow.header])) continue;
    // With those headings ignored the add path's own section may run on further; a section
    // the add path does not read (another pick of the first section with an entry) is not it.
    if (skip && workflow.header !== addPath?.header) continue;
    // Clipped at the next `#` or `##` heading, as 0.140.2 and main (#442) delete: entries under
    // `# Notes` are that part's.
    ranges.push({ start: workflow.header + 1, end: Math.min(workflow.end, sectionBodyEnd(lines, workflow.header, 2)) });
  }
  // Union with what main (#442) deletes from the body, so this never removes less than main did
  // there. Main read the front matter as Markdown: read with it, a fence in the YAML moved what
  // main deleted below, so the same body lost other lines under another front matter.
  const bodyLines = lines.slice(fm);
  const drop = new Set([...v442DeletedLines(bodyLines.join(''), bodyLines, line => isChecklistLineForFile(line, fileName))].map(i => i + fm));
  // Nor a line in a closed fence or an HTML block as CommonMark reads them: main read a list
  // item's fence closer (`  ```` under `- ```md`) as an opener, and the example below as entries.
  for (const i of [...drop]) if (plain[i]) drop.delete(i);
  for (const { start, end } of ranges) {
    for (let i = start; i < Math.min(end, lines.length); i++) {
      if (!inCode[i] && isChecklistLineForFile(lines[i], fileName)) drop.add(i);
    }
  }

  if (drop.size === 0) {
    return { changed: false, content: readmeContent };
  }
  dropBlankLeftByEntries(lines, drop, lines.length, readmeContent.endsWith('\n'));

  const kept = lines.filter((_, i) => !drop.has(i));
  // A README without a final newline still has none when its last line goes. A lone CR
  // ending it ends its last line (CommonMark §2.1): the line now last keeps its break, as in main.
  if (drop.has(lines.length - 1) && !/[\r\n]$/.test(readmeContent) && kept.length > 0) {
    kept[kept.length - 1] = kept[kept.length - 1].replace(/\r?\n$/, '');
  }
  return { changed: true, content: kept.join('') };
}
