/**
 * Pure helper for the "Delete Workflow" command (issue #38 follow-up).
 *
 * Removes a single workflow entry from the README "Related Workflows" checklist
 * while preserving section order, the instruction blockquote, and every other
 * section. The filesystem side (moving the file to trash, sample cleanup) is
 * handled by the command; this module stays pure and unit-testable.
 */
import { decodeChecklistLink } from './workflowStructure';

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
  const lines = readmeContent.split('\n');
  const kept: string[] = [];
  let changed = false;

  for (const line of lines) {
    if (isChecklistLineForFile(line, fileName)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }

  if (!changed) {
    return { changed: false, content: readmeContent };
  }

  return { changed: true, content: kept.join('\n') };
}
