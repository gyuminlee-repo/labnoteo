/**
 * The front matter as Obsidian finds it (getFrontMatterInfo, 1.14.5): an empty block `---\n---`
 * ends at its second line, and nothing below is swallowed. Each parser leaves it out, so a
 * `## …` YAML comment in it is no heading and a line in it no entry.
 */
import { describe, it, expect } from 'vitest';
import { stripFrontMatter } from '../sections/frontMatter';
import { listUnitOpBlocks, removeScanEntry } from '../sections/scanInsert';
import { replaceSectionBody } from '../sections/sectionEdit';
import { parseWorkflowHeading, rewriteWorkflowTitle } from '../lib/workflowStructure';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { findPairedMetaDate } from '../lib/dateUtils';
import { findEnclosingHeading } from '../lib/issueMarker';

describe('the front matter boundary', () => {
  // Expected as Obsidian 1.14.5 getFrontMatterInfo gives contentStart for each.
  it.each([
    ['---\n---\n## A\n', '## A\n'],
    ['---\n---', ''],
    ['---\r\n---\r\nx', 'x'],
    ['--- \nx\n---\n', '--- \nx\n---\n'],
    ['---\nx\n--- \nb\n---\n', ''],
    ['---\nx\n...\n', '---\nx\n...\n'],
    ['---\nx\n----\n---\n', ''],
    ['---\nx\n---', ''],
  ])('%j leaves the body %j', (md, body) => {
    expect(stripFrontMatter(md)).toBe(body);
  });

  it('an empty block swallows no scan entry below it', () => {
    const md = ['---', '---', '## Worksheet scans', '<!-- labnoteo-scan page=1/1 sha=aaaaaaaaaaaa -->', '![[old.jpg]]', '', '---', '## Other', ''].join('\n');
    expect(removeScanEntry(md, 'aaaaaaaaaaaa').removed).toBe(true);
    expect(replaceSectionBody(md, 'Other', 'NEW').ok).toBe(true);
  });
});

describe('parsers that leave the front matter out', () => {
  it('the workflow heading is the body one', () => {
    const md = '---\n## [WD010 Fake]\nx: 1\n---\n## [WD010 Real]\n';
    expect(parseWorkflowHeading(md)?.name).toBe('Real');
    expect(rewriteWorkflowTitle(md, 'WD010', 'Real', 'B', { title: false })).toBe('---\n## [WD010 Fake]\nx: 1\n---\n## [WD010 Real] B\n');
  });

  it('deleting a workflow leaves a line of the front matter alone', () => {
    const md = '---\n## Related Workflows\nx: |\n  - [ ] [A](./001_WD010_A.labnote.md)\n---\n# Exp\n';
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });

  it('a Meta date pairs with none in the front matter', () => {
    const lines = '---\n#### Meta\nexample:\n  - Start_date: 2099-01-01\n---\n- End_date: 2026-11-11'.split('\n');
    expect(findPairedMetaDate(lines, 5)).toBeUndefined();
  });

  it('a marker under no body heading has none from the front matter', () => {
    const md = '---\n## Fake\nx: 1\n---\nbody @issue\n';
    expect(findEnclosingHeading(md, 4)).toBeUndefined();
  });

  it('unit operations are the body ones', () => {
    const md = '---\n### [UHW999 Example]\ntitle: Important\n---\n## [WD010 Real]\n### [UHW010 Spin]\n#### Method\nactual\n';
    expect(listUnitOpBlocks(md).map(b => b.opId)).toEqual(['UHW010']);
  });
});
