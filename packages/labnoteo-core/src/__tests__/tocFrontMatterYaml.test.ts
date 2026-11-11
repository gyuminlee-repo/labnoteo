/**
 * Front matter is YAML, not Markdown: a code fence in a block scalar opens nothing, and a
 * `## Related Unit Operations` comment between fields is no heading. The TOC goes under the
 * body's heading only, and the front matter still reads.
 */
import { describe, it, expect } from 'vitest';
import { rebuildUnitOpToc, refreshUnitOpTocEntries } from '../sections/workflowSectionParser';
import { parseFrontMatterYaml, stripFrontMatter } from '../sections/frontMatter';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../lib/unitOpTemplate';
import { findUnitOpInsertOffset } from '../sections/workflowSectionParser';
import { hasRecordedResults } from '../lib/noteResults';

// A fence opened in one block scalar and closed in the next, the comment between them; and each
// closed in its own, the comment after both.
const ACROSS = ['description: |', '  ```', '  code', '## Related Unit Operations', 'example: |', '  more', '  ```'];
const EACH = ['description: |', '  ```', '  code', '  ```', '## Related Unit Operations', 'example: |', '  ```', '  more', '  ```'];

function note(YAML_FIELDS: readonly string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, { noteId: 'LN-00000000' });
  const block = buildHwUnitOpMarkdown({ opId: 'UHW010', opName: 'Op UHW010', opDescription: 'step' }, { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' });
  const off = findUnitOpInsertOffset(md);
  md = md.slice(0, off) + block + md.slice(off);
  // The fields go first in the front matter, as a user may write them.
  return md.replace(/^---\n/, `---\n${YAML_FIELDS.join('\n')}\n`);
}

describe('a TOC rebuilt in a note whose front matter has fences and a ## comment', () => {
  it.each([
    ['rebuildUnitOpToc', 'across', rebuildUnitOpToc, ACROSS],
    ['rebuildUnitOpToc', 'each', rebuildUnitOpToc, EACH],
    ['refreshUnitOpTocEntries', 'across', refreshUnitOpTocEntries, ACROSS],
    ['refreshUnitOpTocEntries', 'each', refreshUnitOpTocEntries, EACH],
  ] as const)('%s, a fence %s, leaves the front matter as it was', (_name, _how, rebuild, fields) => {
    const md = note(fields);
    expect(parseFrontMatterYaml(md).parseError).toBeUndefined();
    const head = md.slice(0, md.length - stripFrontMatter(md).length);
    const out = rebuild(md);
    expect(out.startsWith(head)).toBe(true);
    expect(parseFrontMatterYaml(out).parseError).toBeUndefined();
  });

  it.each([
    ['across', ACROSS],
    ['each', EACH],
  ] as const)('puts the entry in the body TOC, a fence %s', (_how, fields) => {
    const out = rebuildUnitOpToc(note(fields));
    expect(stripFrontMatter(out)).toMatch(/- \[UHW010 Op UHW010\]/);
  });
});

describe('the results of a note whose front matter has a ## comment', () => {
  it('are not read from the YAML under it', () => {
    const md = note(['## Extra fields', 'reviewer: Dr. Lee', 'batch: 7']);
    expect(parseFrontMatterYaml(md).parseError).toBeUndefined();
    expect(hasRecordedResults(md)).toBe(false);
  });
});
