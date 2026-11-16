/**
 * Front matter is YAML: a `### [ID …]` or `#### Method` comment in it is no heading, and a
 * fence-like line in a block scalar opens nothing. Every parser of headings, sections, unit
 * operations, filed scans and the README checklist skips it, as 0.140.2 did for this input.
 */
import { describe, it, expect } from 'vitest';
import { listHeadings, replaceSectionBody } from '../sections/sectionEdit';
import { listUnitOpBlocks, listFiledScans, listScanHashes } from '../sections/scanInsert';
import { extractMethodBody, listUnitOpMethods } from '../sections/blockInsert';
import { unitOpsAllEnded, hasWorkflowChecklistSection, parseWorkflowChecklistFromReadme } from '../lib/workflowStructure';
import { parseFrontMatterYaml } from '../sections/frontMatter';

const FRONT = ['---', 'description: |', '  ```inline```', '### [UHW999 Example]', '#### Method', 'example: |', '  ```', '---'];
const NOTE = [...FRONT, '## Related Unit Operations', '### [UHW010 Spin]', '#### Method', 'keep', ''].join('\n');

describe('a note whose front matter has YAML comments that read like headings', () => {
  it('is valid YAML', () => {
    expect(parseFrontMatterYaml(NOTE).parseError).toBeUndefined();
  });

  it.each(['\n', '\r\n'])('replaces the body Method, keeping the front matter (%j)', nl => {
    const md = NOTE.split('\n').join(nl);
    const { ok, md: out } = replaceSectionBody(md, 'Method', 'NEW');
    expect(ok).toBe(true);
    expect(out.startsWith(FRONT.join(nl) + nl)).toBe(true);
    expect(out).toContain('NEW');
    expect(out).not.toContain('keep');
  });

  it('lists the body headings and unit operations only', () => {
    expect(listHeadings(NOTE).map(h => h.text)).toEqual(['Related Unit Operations', '[UHW010 Spin]', 'Method']);
    expect(listUnitOpBlocks(NOTE).map(b => b.opId)).toEqual(['UHW010']);
    expect(listUnitOpMethods(NOTE).length).toBe(1);
  });

  it('finds no scans in the front matter', () => {
    const md = NOTE.replace('#### Method\nexample', '<!-- labnote-scan:1/1:aaaaaaaaaaaa -->\n![[x.jpg]]\n#### Method\nexample');
    expect(listScanHashes(md).size).toBe(0);
    expect(listFiledScans(md)).toEqual([]);
  });

  it('reads no unit operation of the front matter as ended or not', () => {
    const md = ['---', '#### Meta', '- End_date: 2020-01-01', 'x: 1', '---', '## Related Unit Operations', '### [UHW010 Spin]', '#### Meta', '- End_date:', ''].join('\n');
    expect(unitOpsAllEnded(md, '2026-11-11 10:00')).toBe(false);
  });
});

describe('a README whose front matter has a ## comment and an entry-like line', () => {
  const README = ['---', '## Related Workflows', 'x: |', '  - [ ] [A](./001_WD010_A.labnote.md)', '---', '# Exp', ''].join('\n');
  it('has no checklist section and no entries', () => {
    expect(parseFrontMatterYaml(README).parseError).toBeUndefined();
    expect(hasWorkflowChecklistSection(README)).toBe(false);
    expect(parseWorkflowChecklistFromReadme(README)).toEqual([]);
  });
});

// A model's reply is no note: a `---` it starts with is a rule, and the headings below it count.
describe('a reply that starts with a rule', () => {
  it('still has its Method section read', () => {
    const reply = ['---', '', '### [UHW010 A]', '', '#### Method', '', 'old', '', '---', ''].join('\n');
    expect(extractMethodBody(reply)).toBe('old\n\n---');
  });
});
