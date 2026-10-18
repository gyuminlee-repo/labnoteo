/**
 * The text of the "allow this write?" prompt, shared by the MCP server and the
 * built-in AI so both describe a write the same way.
 */
import type { SampleCreatePreview, SectionEditPreview, ToolPreview, Translator } from '@labnoteo/core';

/**
 * `prompt`, then the write target, then what the write changes (#69, #113):
 * an empty `update_section` once wiped recorded results behind a prompt that
 * named only the tool and the note.
 */
export function buildApprovalMessage(
  t: Translator,
  prompt: string,
  target: string | null,
  preview?: Exclude<ToolPreview, { error: string }>
): string {
  const parts = [prompt];
  if (target) parts.push(t('Target: {0}', target));
  if (preview?.kind === 'sectionEdit') parts.push(describeSectionEdit(t, preview));
  if (preview?.kind === 'sampleCreate') parts.push(describeSampleCreate(t, preview));
  return parts.join('\n\n');
}

function describeSectionEdit(t: Translator, p: SectionEditPreview): string {
  const section = p.parentHeading ? `${p.parentHeading} > ${p.heading}` : p.heading;
  const lines = String(p.removedLines);
  const head = p.clearing
    ? t('This empties section "{0}", which now has {1} line(s).', section, lines)
    : t('This replaces section "{0}", which now has {1} line(s).', section, lines);
  const parts = [head];
  if (p.removedSubheadings > 0) {
    parts.push(t('Its {0} nested heading(s) are replaced too.', String(p.removedSubheadings)));
  }
  // Repeated headings read the same otherwise (#114).
  if (p.total > 1) {
    parts.push(
      t('It is occurrence {0} of {1}, with its heading on line {2}.', String(p.occurrence), String(p.total), String(p.line))
    );
  }
  return parts.join(' ');
}

function describeSampleCreate(t: Translator, p: SampleCreatePreview): string {
  const lines = [
    p.id === undefined
      ? t('This creates a {0} sample with a new ID.', p.type)
      : p.existing
        ? t('This adds to {0} sample {1}.', p.type, p.id)
        : t('This creates {0} sample {1}.', p.type, p.id),
  ];
  if (p.alias) lines.push(t('Alias: {0}', p.alias));
  if (p.location) lines.push(t('Storage location: {0}', p.location));
  lines.push(
    p.scope === 'global'
      ? t('Saved in the global samples folder {0}.', p.folder)
      : t('Saved in the local samples folder {0}.', p.folder)
  );
  return lines.join('\n');
}
