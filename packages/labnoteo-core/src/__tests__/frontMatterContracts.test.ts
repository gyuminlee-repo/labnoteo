/**
 * Each reader takes the text its callers give it: the whole note (front matter left out as
 * Obsidian finds it), lines split on `\n` with each CR kept, or a body with no front matter.
 * A front matter boundary read another way ends it on a line Obsidian does not (`--- `), or
 * misses the end of a CRLF one.
 */
import { describe, it, expect } from 'vitest';
import { isInFrontMatter, isOffsetBeforeBody } from '../sections/documentHead';
import { planBlockInsert } from '../sections/blockInsert';
import { sectionText } from '../sections/summaryInsert';
import { markdownCodeLines } from '../sections/codeFences';
import { resolveGithubAnchor } from '../sections/workflowSectionParser';
import { scanMarkdownTables } from '../lib/exportTablesCsv';
import { findEnclosingHeading } from '../lib/issueMarker';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { insertWorkflowChecklistEntries } from '../lib/workflowStructure';
import { appendUnitOpToWorkflowToc } from '../sections/workflowSectionParser';
import { planWorkflowExperimenterSync, resetCopiedWorkflowDates, unnamedWorkflowIds } from '../lib/workflowStructure';

describe('lines split on \\n with each CR kept', () => {
  const md = '---\r\nauthor: \r\n---\r\nbody';

  it('have their CRLF front matter found', () => {
    expect(isInFrontMatter(md, 13)).toBe(true);
    expect(isOffsetBeforeBody(md, 13)).toBe(true);
  });

  it('put no block inside a CRLF front matter', () => {
    const plan = planBlockInsert(md, 13, 'X');
    expect(plan.atEnd).toBe(true);
    expect(plan.offset).toBe(md.length);
  });

  it('read a summary callout past a CRLF front matter', () => {
    // The callout ends the note: a line with no CR, as the editor's text has none.
    const note = '---\r\nx: |\r\n  ```\r\n---\r\n> [!note] AI summary';
    expect(sectionText(note, 'Summary', ['AI summary'])).toBe('> [!note] AI summary');
  });
});

describe('a section with no heading above its callout', () => {
  it('runs from past the front matter, whose comment is no heading', () => {
    const note = '---\n## c: 1\n---\n> [!note] AI summary\n> text\n';
    expect(sectionText(note, 'Summary', ['AI summary'])).toBe('> [!note] AI summary\n> text');
  });
});

describe('a note body, its front matter already taken off', () => {
  it('reads its first `---` pair as breaks, not front matter', () => {
    const body = '---\n## Objective\nMeasure yield @issue[a1] check\n\n---\n## Methods\n';
    expect(findEnclosingHeading(body, 3, { asNote: false })).toBe('Objective');
  });
});

describe('the front matter as Obsidian finds it, where `--- ` opens none', () => {
  it('leaves code below it to the code reading', () => {
    expect(markdownCodeLines(['--- ', '```', '---', 'y', '```'])[3]).toBe(true);
  });

  it('numbers the heading anchors of the body from the top', () => {
    expect(resolveGithubAnchor('--- \n## A\n---\n## A\n', 'a-1')).toBe(3);
  });

  it('exports no table from the front matter', () => {
    expect(scanMarkdownTables('---\nt: x\n\n| a | b |\n|---|---|\n---\nbody\n').tables).toHaveLength(0);
  });

  it('takes no workflow ID from a `# …` comment in the front matter', () => {
    const notes = new Map([['001_A.labnote.md', '---\n# WD999 Fake\n---\nbody\n']]);
    expect(unnamedWorkflowIds(['001_A.labnote.md'], '', notes).hints.size).toBe(0);
  });

  it('resets a copied Meta date that is body text', () => {
    expect(resetCopiedWorkflowDates('--- \n- Start_date: 2026-01-01\n---\n', '2026-11-11')).toBe("--- \n- Start_date: ''\n---\n");
  });

  it('syncs the experimenter only below the front matter', () => {
    const note = '---\nexperimenter:\nx: |\n  --- \n  - Experimenter:\n---\n### [UHW010 Spin]\n- Experimenter:\n';
    const plan = planWorkflowExperimenterSync(note, 'Kim', '2026-11-11');
    expect(plan?.content).toContain('  - Experimenter:\n---');
  });
});

// One reader, two scans of the same lines (headings or rows, and code or comments): both start
// past the front matter, so a fence in its YAML reaches neither.
describe('a fence in the front matter', () => {
  const yaml = '---\ndescription: |\n  ```\n---\n';

  it('hides no comment mark below it: a table in a comment stays hidden', () => {
    const md = `${yaml}\n%%\n\n| secret | value |\n| --- | --- |\n| hidden | 42 |\n%%\n`;
    expect(scanMarkdownTables(md).tables).toHaveLength(0);
  });

  it('makes no heading below it code', () => {
    expect(findEnclosingHeading(`${yaml}## Real\nx\n`, 6)).toBe('Real');
  });

  it('pairs with no fence below it: the entry above that fence is deleted', () => {
    const md = `${yaml}## Related Workflows\n- [ ] [A](./001_WD010_A.labnote.md)\n\n\`\`\`\ncode\n`;
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md').content).toBe(`${yaml}## Related Workflows\n\n\`\`\`\ncode\n`);
  });
});

// The same note with and without its front matter: a writer acts on the body alike.
describe('what the front matter holds reaches no writer of the body', () => {
  it('a fence there moves no checklist entry into a code example below', () => {
    const fm = '---\n```\n---\n';
    const body = '## Related Workflows\n\n- [x] [B](./002_WD010_B.labnote.md)\n```text\nalpha\n\n- [ ] [A](./001_WD010_A.labnote.md)\n\nbeta\n```\n';
    const items = [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }];
    expect(insertWorkflowChecklistEntries(fm + body, items)).toBe(fm + insertWorkflowChecklistEntries(body, items));
  });

  it('an HTML comment there lets no TOC entry into a code example below', () => {
    const fm = '---\n<!--\n-->\n---\n';
    const body = '## Related Unit Operations\n\n### Notes\n~~~\n*x*\n- [ ] [A](./001_WD010_A.labnote.md)\n~~~';
    expect(appendUnitOpToWorkflowToc(fm + body, 'UHW020', 'B')).toBe(fm + appendUnitOpToWorkflowToc(body, 'UHW020', 'B'));
  });
});
