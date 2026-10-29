/**
 * Pure helper for the "Delete Workflow" command (issue #38 follow-up).
 *
 * Removes a single workflow entry from the README "Related Workflows" checklist
 * while preserving section order, the instruction blockquote, and every other
 * section. The filesystem side (moving the file to trash, sample cleanup) is
 * handled by the command; this module stays pure and unit-testable.
 */
import { decodeChecklistLink } from './workflowStructure';
import { findSectionMatches, sectionBodyEnd, stepFence, type OpenFence } from '../sections/sectionEdit';

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
function isChecklistLineForFile(line: string, fileName: string): boolean {
  const match = line.trim().match(/^(?:[-*+]\s+)?\[[ xX]\]\s*\[.*?\]\(([^)]+)\)/);
  if (!match) return false;
  const link = match[1].replace(/^\.\//, '');
  const linkFile = decodeChecklistLink(link.split('/').pop() ?? '');
  return linkFile === fileName;
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
  const drop = new Set<number>();
  for (const section of findSectionMatches(readmeContent, 'Related Workflows')) {
    const end = sectionBodyEnd(lines, section.line, section.level);
    let fence: OpenFence | null = null;
    for (let i = section.line + 1; i < end; i++) {
      const next = stepFence(lines[i], fence);
      const inCode = fence !== null || next !== null;
      fence = next;
      if (!inCode && isChecklistLineForFile(lines[i], fileName)) drop.add(i);
    }
  }

  if (drop.size === 0) {
    return { changed: false, content: readmeContent };
  }

  return { changed: true, content: lines.filter((_, i) => !drop.has(i)).join('') };
}
