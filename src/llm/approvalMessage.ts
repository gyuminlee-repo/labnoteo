/**
 * The text of the "allow this write?" prompt, shared by the MCP server and the
 * built-in AI so both describe a write the same way.
 */
import type { SectionEditPreview, Translator } from '@labnoteo/core';

/**
 * `prompt`, then the write target, then what the write removes (#69): an empty
 * `update_section` once wiped recorded results behind a prompt that named only
 * the tool and the note.
 */
export function buildApprovalMessage(
  t: Translator,
  prompt: string,
  target: string | null,
  preview?: SectionEditPreview
): string {
  const parts = [prompt];
  if (target) parts.push(t('Target: {0}', target));
  if (preview) parts.push(describeSectionEdit(t, preview));
  return parts.join('\n\n');
}

function describeSectionEdit(t: Translator, p: SectionEditPreview): string {
  const section = p.parentHeading ? `${p.parentHeading} > ${p.heading}` : p.heading;
  const lines = String(p.removedLines);
  const head = p.clearing
    ? t('This empties section "{0}", which now has {1} line(s).', section, lines)
    : t('This replaces section "{0}", which now has {1} line(s).', section, lines);
  return p.removedSubheadings > 0
    ? `${head} ${t('Its {0} nested heading(s) are replaced too.', String(p.removedSubheadings))}`
    : head;
}
