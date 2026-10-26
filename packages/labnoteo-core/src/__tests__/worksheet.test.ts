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
      steps: [
        { text: 'Thaw cells', sub: [] },
        { text: 'Spin at 300 g for 5 min', sub: [] },
      ],
    });
    expect(lab.sections.find(s => s.title === 'Reagent')).toEqual({ type: 'blank', title: 'Reagent' });
    const metaSection = lab.sections.find(s => s.type === 'meta');
    expect(metaSection).toMatchObject({
      fields: [
        { label: 'Experimenter', value: 'Dr. Kim' },
        { label: 'Start_date', value: '2026-10-15 10:00' },
        { label: 'End_date', value: '' },
      ],
    });
  });

  it('leaves the AI draft line out of the Method steps (#280)', () => {
    const md = buildNote([hw('UHW010')]).replace(
      '#### Method\n- (method used in this step)',
      '#### Method\n> [!note] AI draft (llama3.1, 2026-10-24) — review it, then delete this line\n\n1. Thaw cells\n2. Spin'
    );
    expect(listWorksheetUnitOps(md)[0].sections.find(s => s.title === 'Method')).toEqual({
      type: 'steps',
      title: 'Method',
      steps: [
        { text: 'Thaw cells', sub: [] },
        { text: 'Spin', sub: [] },
      ],
    });
  });

  // #400: a template line left above what was written printed as text or as step 1.
  it('leaves out the template lines kept above what was written', () => {
    const md = buildNote([hw('UHW010')])
      .replace('#### Input\n- (samples from the previous step)', '#### Input\n- (samples from the previous step)\n- DNA-1')
      .replace(
        '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)',
        '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)\n| A |\n| --- |\n| 1 |'
      )
      .replace('#### Method\n- (method used in this step)', '#### Method\n- (method used in this step)\n1. Thaw\n2. Spin');
    const sections = listWorksheetUnitOps(md)[0].sections;
    expect(sections.find(s => s.title === 'Input')).toEqual({
      type: 'text',
      title: 'Input',
      blocks: [{ kind: 'item', level: 0, text: 'DNA-1' }],
    });
    expect(sections.find(s => s.title === 'Results & Discussions')).toEqual({
      type: 'text',
      title: 'Results & Discussions',
      blocks: [{ kind: 'table', rows: [['A'], ['1']] }],
    });
    expect(sections.find(s => s.title === 'Method')).toEqual({
      type: 'steps',
      title: 'Method',
      steps: [
        { text: 'Thaw', sub: [] },
        { text: 'Spin', sub: [] },
      ],
    });
  });

  it('drops blank lines from written text', () => {
    const md = buildNote([hw('UHW010')]).replace(
      '#### Results & Discussions\n- (Any results and discussions. Link file path if needed)',
      '#### Results & Discussions\nYield was low.\n\n\nRepeat tomorrow.\n'
    );
    expect(listWorksheetUnitOps(md)[0].sections.find(s => s.title === 'Results & Discussions')).toEqual({
      type: 'text',
      title: 'Results & Discussions',
      blocks: [
        { kind: 'para', text: 'Yield was low.' },
        { kind: 'para', text: 'Repeat tomorrow.' },
      ],
    });
  });

  it('reads a text section as list items, paragraphs and tables (#253)', () => {
    const md = buildNote([hw('UHW010')]).replace(
      '#### Equipment\n- (e.g. centrifuge, spectrophotometer, etc.)',
      '#### Equipment\n- Acoustic liquid dispenser\n  - 384-well head\n\n뒷정리 필요'
    );
    expect(listWorksheetUnitOps(md)[0].sections.find(s => s.title === 'Equipment')).toEqual({
      type: 'text',
      title: 'Equipment',
      blocks: [
        { kind: 'item', level: 0, text: 'Acoustic liquid dispenser' },
        { kind: 'item', level: 1, text: '384-well head' },
        { kind: 'para', text: '뒷정리 필요' },
      ],
    });
  });

  it('keeps the note\'s step numbers, nesting what is indented under a step (#254)', () => {
    const md = buildNote([hw('UHW090')]).replace(
      '#### Method\n- (method used in this step)',
      [
        '#### Method',
        '1. 컴피턴트 세포 준비',
        '    - BL21(DE3) 50 µL',
        '    - 얼음 위 10분',
        '2. 전기천공 조건',
        '',
        '| 전압 | 큐벳 | 시간상수 |',
        '| --- | --- | --- |',
        '| 1.8 kV | 1 mm | 5 ms |',
        '',
        '3. 회복 배양 1시간',
      ].join('\n')
    );
    expect(listWorksheetUnitOps(md)[0].sections.find(s => s.title === 'Method')).toEqual({
      type: 'steps',
      title: 'Method',
      steps: [
        { text: '컴피턴트 세포 준비', sub: ['BL21(DE3) 50 µL', '얼음 위 10분'] },
        {
          text: '전기천공 조건',
          sub: [],
          table: [
            ['전압', '큐벳', '시간상수'],
            ['1.8 kV', '1 mm', '5 ms'],
          ],
        },
        { text: '회복 배양 1시간', sub: [] },
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

  // #383: a caution written under the title was dropped from the sheet.
  it('prints what is written above the first section first, without a heading', () => {
    const md = buildNote([hw('UHW010')]).replace(
      '### [UHW010 Op UHW010]\n',
      '### [UHW010 Op UHW010]\n\n- 주의: 피커 2번 핀이 휘어 있음. 1번 핀만 쓸 것\n'
    );
    const [op] = listWorksheetUnitOps(md);
    expect(op.description).toBe('Lab step');
    expect(op.sections[0]).toEqual({
      type: 'text',
      title: '',
      blocks: [{ kind: 'item', level: 0, text: '주의: 피커 2번 핀이 휘어 있음. 1번 핀만 쓸 것' }],
    });
    expect(op.sections[1].title).toBe('Meta');
    expect(listWorksheetUnitOps(buildNote([hw('UHW010')]))[0].sections[0].title).toBe('Meta');
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

  it('fits a template lab unit operation on one page', () => {
    const [op] = listWorksheetUnitOps(buildNote([hw('UHW010')]));
    const pages = paginateWorksheet([op]);
    expect(pages.map(p => `${p.page}/${p.pageCount}`)).toEqual(['1/1']);
    expect(pages.flatMap(p => p.sections)).toEqual(op.sections);
  });
});
