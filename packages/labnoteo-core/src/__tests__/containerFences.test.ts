/**
 * A fence in a list item or a block quote opens and closes as CommonMark (and Obsidian) reads it:
 * `- ```md` opens one, the `  ```` under it closes it, and the item's or quote's end closes one
 * left open. Every fence reader goes through this, so the closer under a list marker opens no
 * fence that would hide the headings, tables and entries below it.
 */
import { describe, it, expect } from 'vitest';
import { markdownCodeLines } from '../sections/codeFences';
import { listHeadings } from '../sections/sectionEdit';
import { extractMarkdownTables } from '../lib/exportTablesCsv';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { insertWorkflowChecklistEntries } from '../lib/workflowStructure';
import { parseIssueMarkers } from '../lib/issueMarker';
import { findSampleListTableRanges } from '../lib/sampleUtils';
import { scanDocumentHead } from '../sections/documentHead';

const t = '```';
const A = '- [ ] [A](./001_WD010_A.labnote.md)';
const D = { done: false, title: 'D', fileName: '004_WD010_D.labnote.md' };
const headings = (md: string): string[] => listHeadings(md, { asNote: false }).map(h => h.text);

describe('readers after a list fence', () => {
  it('marks the lines of a list fence as code, and none after its closer', () => {
    expect(markdownCodeLines([`- ${t}md`, '  ## X', `  ${t}`, '## Y'])).toEqual([true, true, true, false]);
  });

  it('reads the heading below a list fence, and none in it', () => {
    expect(headings(`## Notes\n- ${t}md\n  ## Example\n  ${t}\n## Real\n`)).toEqual(['Notes', 'Real']);
  });

  it('reads the heading after a list item that ended with its fence open', () => {
    expect(headings(`- [ ] a\n  ${t}\n  x\nend\n## H\n${t}\n`)).toEqual(['H']);
  });

  it('exports the table below a list fence', () => {
    expect(extractMarkdownTables(`- ${t}md\n  ${t}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`)).toHaveLength(1);
  });
});

describe('a closing run with another space after it', () => {
  it.each(['\u00a0', '\u3000', '\u1680', '\ufeff'])('is no closer (%j), as CommonMark reads it', sp => {
    expect(headings(`${t}\n${t}${sp}\n## In\n${t}\n## Out\n`)).toEqual(['Out']);
  });

  it('a space or tab after it still closes', () => {
    expect(headings(`${t}\n${t} \t\n## Out\n`)).toEqual(['Out']);
  });
});

describe('readers with a fence rule of their own', () => {
  it('reads the issue marker below a list fence, and none in a fence an info line does not close', () => {
    expect(parseIssueMarkers(`- ${t}md\n  ${t}\ntext @issue;ISS-1;topic\n`).markers.map(m => m.id)).toEqual(['ISS-1']);
    expect(parseIssueMarkers(`${t}\nx\n${t}md\ntext @issue;ISS-1;topic\n${t}\n`).markers).toEqual([]);
  });

  it('finds the sample list below a list fence', () => {
    expect(findSampleListTableRanges(`- ${t}md\n  ${t}\n| ID | Name |\n|---|---|\n| S1 | a |\n`, [['ID', 'Name']])).toHaveLength(1);
  });

  it('reads the title below a list fence', () => {
    expect(scanDocumentHead([`- ${t}md`, `  ${t}`, '# Title']).firstHeadingLine).toBe(2);
  });
});

describe('a README entry after a list fence', () => {
  it('deletes the entry right below the list fence, which is no code', () => {
    const md = `## Related Workflows\n- ${t}md\n  ${t}\n${A}\n${t}\nx\n${t}\n`;
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md').content).toBe(`## Related Workflows\n- ${t}md\n  ${t}\n${t}\nx\n${t}\n`);
  });

  it('keeps an entry in the fence under the next heading', () => {
    const md = `## Related Workflows\n- ${t}md\n  ${t}\n## A\n${t}\n${A}\n${t}\n`;
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });

  it('adds an entry next to the last one, not into the fence below', () => {
    const md = `## Related Workflows\n- ${t}md\n  ${t}\n${A}\n${t}\nx\n${t}\n`;
    expect(insertWorkflowChecklistEntries(md, [D])).toBe(`## Related Workflows\n- ${t}md\n  ${t}\n${A}\n- [ ] [D](./004_WD010_D.labnote.md)\n${t}\nx\n${t}\n`);
  });

  it('adds an entry after the last one past a list fence and a lone closing tag', () => {
    const tail = `${t}text\n## Hidden\n${t}\n`;
    const head = `## Related Workflows\n- ${t}md\n${A}\n  ${t}\n</span>\n${t}\n\n1.  ${t}\n    x\n    ${t}\n${A}\n`;
    expect(insertWorkflowChecklistEntries(head + tail, [D])).toBe(`${head}- [ ] [D](./004_WD010_D.labnote.md)\n${tail}`);
  });

  it('adds an entry next to the last one, not into the HTML block below a list fence', () => {
    const head = `## Related Workflows\n${t}\n${A}\n${t}\n<!--\n${t}\n-->\n### Sub\n- ${t}\n  x\n- ${t}md\n${A}\n  ${t}\n`;
    expect(insertWorkflowChecklistEntries(`${head}<div>\n${t}\n`, [D])).toBe(`${head}- [ ] [D](./004_WD010_D.labnote.md)\n<div>\n${t}\n`);
  });
});
