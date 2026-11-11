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
