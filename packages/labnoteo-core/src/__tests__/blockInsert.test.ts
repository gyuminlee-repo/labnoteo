// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  extractMethodBody,
  findUnitOpMethodAt,
  findUnitOpMethodByIndex,
  planBlockInsert,
} from '../sections/blockInsert';
import { SW_PLACEHOLDERS, HW_PLACEHOLDERS } from '../lib/unitOpTemplate';

const NOTE = [
  '---',
  'title: t',
  '---',
  '## [WD010 Design]',
  '',
  '> 워크플로 설명',
  '',
  '---',
  '',
  '### [USW100 Sequence analysis] 헴 산화효소',
  '',
  '#### Input',
  SW_PLACEHOLDERS.Input,
  '',
  '#### Method',
  SW_PLACEHOLDERS.Method,
  '',
  '#### Environment',
  SW_PLACEHOLDERS.Environment,
  '',
  '---',
  '',
  '### [UHW010 Spin]',
  '',
  '#### Method',
  '- 4000 rpm, 10 min',
  '',
  '#### Output',
  HW_PLACEHOLDERS.Output,
  '',
  '## 결과',
  '',
  '여기에 적은 글',
  '',
].join('\n');

const at = (needle: string, delta = 0) => NOTE.indexOf(needle) + delta;

describe('findUnitOpMethodAt', () => {
  it('picks the Method of the unit operation the cursor is in', () => {
    const first = findUnitOpMethodAt(NOTE, at('#### Input'));
    expect(first?.unitOpHeading).toBe('### [USW100 Sequence analysis] 헴 산화효소');
    expect(first?.unitOpIndex).toBe(0);
    expect(NOTE.split('\n')[first!.methodLine]).toBe('#### Method');

    const second = findUnitOpMethodAt(NOTE, at('- 4000 rpm', 3));
    expect(second?.unitOpHeading).toBe('### [UHW010 Spin]');
    expect(second?.unitOpIndex).toBe(1);
  });

  it('counts the unit-operation heading line itself as inside', () => {
    expect(findUnitOpMethodAt(NOTE, at('[UHW010', 2))?.unitOpIndex).toBe(1);
  });

  it('tells a placeholder Method from one the researcher wrote', () => {
    expect(findUnitOpMethodAt(NOTE, at('#### Environment'))?.isPlaceholder).toBe(true);
    expect(findUnitOpMethodAt(NOTE, at('#### Output'))?.isPlaceholder).toBe(false);
    const hw = NOTE.replace('- 4000 rpm, 10 min', HW_PLACEHOLDERS.Method);
    expect(findUnitOpMethodAt(hw, hw.indexOf('#### Output'))?.isPlaceholder).toBe(true);
    const empty = NOTE.replace('- 4000 rpm, 10 min\n', '');
    expect(findUnitOpMethodAt(empty, empty.indexOf('#### Output'))?.isPlaceholder).toBe(true);
  });

  it('is null outside any unit operation', () => {
    expect(findUnitOpMethodAt(NOTE, at('워크플로 설명'))).toBeNull();
    expect(findUnitOpMethodAt(NOTE, 0)).toBeNull();
  });

  it("is null under the researcher's own heading after a unit operation", () => {
    expect(findUnitOpMethodAt(NOTE, at('여기에 적은 글'))).toBeNull();
  });

  it('is null when the unit operation has no Method subsection', () => {
    const noMethod = NOTE.replace('#### Method\n- 4000 rpm, 10 min\n\n', '');
    expect(findUnitOpMethodAt(noMethod, noMethod.indexOf('#### Output'))).toBeNull();
  });

  it('ignores headings inside code fences', () => {
    const fenced = NOTE.replace('- 4000 rpm, 10 min', '```\n## not a heading\n```');
    expect(findUnitOpMethodAt(fenced, fenced.indexOf('#### Output'))?.unitOpIndex).toBe(1);
  });
});

describe('findUnitOpMethodByIndex', () => {
  it('finds the same Method again after text above it changed', () => {
    const loc = findUnitOpMethodAt(NOTE, at('- 4000 rpm'))!;
    const edited = NOTE.replace('여기에', '앞에 추가\n\n여기에').replace('> 워크플로 설명', '> 설명\n> 둘째 줄');
    const again = findUnitOpMethodByIndex(edited, loc.unitOpIndex, loc.unitOpHeading);
    expect(edited.split('\n')[again!.methodLine]).toBe('#### Method');
    expect(again!.methodLine).toBe(loc.methodLine + 1);
  });

  it('is null when that unit operation was renamed or removed', () => {
    const loc = findUnitOpMethodAt(NOTE, at('- 4000 rpm'))!;
    const renamed = NOTE.replace('[UHW010 Spin]', '[UHW010 Spin] 2차');
    expect(findUnitOpMethodByIndex(renamed, loc.unitOpIndex, loc.unitOpHeading)).toBeNull();
    expect(findUnitOpMethodByIndex(NOTE, 5, loc.unitOpHeading)).toBeNull();
  });
});

describe('extractMethodBody', () => {
  it('takes only the Method body when the model rewrites the whole unit operation', () => {
    const out = [
      '### [USW100 Sequence analysis] 헴 산화효소',
      '#### Input',
      '- FASTA',
      '#### Method',
      '1. BLAST 검색',
      '2. 정렬',
      '#### Environment',
      '- conda',
    ].join('\n');
    expect(extractMethodBody(out)).toBe('1. BLAST 검색\n2. 정렬');
  });

  it('drops a leading heading and keeps deeper sub-headings', () => {
    expect(extractMethodBody('## Method draft\n\n##### 준비\n- step')).toBe('##### 준비\n- step');
  });

  it('unwraps a fenced reply and keeps `#` lines inside code', () => {
    expect(extractMethodBody('```markdown\n1. run\n```')).toBe('1. run');
    expect(extractMethodBody('1. run\n```bash\n# comment\n```')).toBe('1. run\n```bash\n# comment\n```');
  });
});

describe('planBlockInsert', () => {
  const apply = (text: string, cursor: number, block = '- a\n- b') => {
    const plan = planBlockInsert(text, cursor, block);
    return text.slice(0, plan.offset) + plan.text + text.slice(plan.offset);
  };

  it('never splits the line under the cursor', () => {
    expect(apply('헴 산화효소 문장\nnext', 1)).toBe('헴 산화효소 문장\n\n- a\n- b\n\nnext');
  });

  it('ends the document with a newline when the cursor line is last', () => {
    expect(apply('only line', 4)).toBe('only line\n\n- a\n- b\n');
  });

  it('fills a blank line, separated from text around it', () => {
    expect(apply('above\n\nbelow', 6)).toBe('above\n\n- a\n- b\n\nbelow');
    expect(apply('above\n\n\nbelow', 6)).toBe('above\n\n- a\n- b\n\nbelow');
  });

  it('trims blank lines around the block', () => {
    expect(apply('', 0, '\n\n- a\n\n')).toBe('- a\n');
  });
});
