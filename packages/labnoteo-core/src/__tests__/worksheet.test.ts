import { classifyUnitOp, listWorksheetUnitOps, paginateWorksheet, sectionWeight } from '../lib/worksheet';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '../sections/workflowSectionParser';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown, buildSwUnitOpMarkdown } from '../lib/unitOpTemplate';

function buildNote(blocks: string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim');
  for (const block of blocks) {
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

const meta = { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' };
const hw = (opId: string) => buildHwUnitOpMarkdown({ opId, opName: `Op ${opId}`, opDescription: 'Lab step' }, meta);
const sw = (opId: string) => buildSwUnitOpMarkdown({ opId, opName: `Op ${opId}`, opDescription: 'Code step' }, meta);

describe('classifyUnitOp', () => {
  it('goes by catalog prefix, then by a Software line', () => {
    expect(classifyUnitOp('UHW010', ['- Software: x'])).toBe('hw');
    expect(classifyUnitOp('USW010', [])).toBe('sw');
    expect(classifyUnitOp('UXX010', ['- Software:'])).toBe('sw');
    expect(classifyUnitOp('UXX010', ['- Equipment: x'])).toBe('hw');
  });
});

describe('listWorksheetUnitOps', () => {
  it('prints written text, checkboxes for steps, and blanks for placeholders', () => {
    const md = buildNote([hw('UHW010'), sw('USW020')]).replace(
      '#### Method\n- (method used in this step)',
      '#### Method\n1. Thaw cells\n2. Spin at 300 g\n   for 5 min'
    );
    const [lab, code] = listWorksheetUnitOps(md);
    expect(lab).toMatchObject({ index: 1, opId: 'UHW010', kind: 'hw', description: 'Lab step' });
    expect(code).toMatchObject({ index: 2, kind: 'sw' });
    expect(lab.sections.find(s => s.title === 'Method')).toEqual({
      type: 'steps',
      title: 'Method',
      steps: ['Thaw cells', 'Spin at 300 g for 5 min'],
    });
    expect(lab.sections.find(s => s.title === 'Reagent')).toMatchObject({ type: 'blank' });
    const metaSection = lab.sections.find(s => s.type === 'meta');
    expect(metaSection).toMatchObject({
      fields: [
        { label: 'Experimenter', value: 'Dr. Kim' },
        { label: 'Start_date', value: '2026-10-15 10:00' },
        { label: 'End_date', value: '' },
      ],
    });
  });

  it('skips the Worksheet scans section', () => {
    const md = buildNote([hw('UHW010')]).replace(
      '#### Results & Discussions',
      '#### Worksheet scans\n\n![[x.jpg]]\n\n#### Results & Discussions'
    );
    expect(listWorksheetUnitOps(md)[0].sections.map(s => s.title)).not.toContain('Worksheet scans');
  });
});

describe('paginateWorksheet', () => {
  it('starts each unit operation on a page and splits long ones at sections', () => {
    const md = buildNote([hw('UHW010'), hw('UHW020')]);
    const ops = listWorksheetUnitOps(md);
    const total = ops[0].sections.reduce((n, s) => n + sectionWeight(s), 0);
    const pages = paginateWorksheet(ops, Math.ceil(total / 2) + 3);
    const first = pages.filter(p => p.unitOp.index === 1);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every(p => p.pageCount === first.length)).toBe(true);
    expect(first.flatMap(p => p.sections)).toEqual(ops[0].sections);
    expect(pages.filter(p => p.unitOp.index === 2)[0].page).toBe(1);
  });

  it('fits a template lab unit operation, with room to write, on two pages', () => {
    const [op] = listWorksheetUnitOps(buildNote([hw('UHW010')]));
    const pages = paginateWorksheet([op]);
    expect(pages.map(p => `${p.page}/${p.pageCount}`)).toEqual(['1/2', '2/2']);
    expect(pages.flatMap(p => p.sections)).toEqual(op.sections);
  });
});
