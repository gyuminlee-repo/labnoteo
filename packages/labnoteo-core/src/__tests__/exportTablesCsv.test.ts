// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  classifyCsvOverwrites,
  csvRowCount,
  extractMarkdownTables,
  scanMarkdownTables,
  firstDifferingRow,
  tableToCsv,
  UTF8_BOM,
} from '../lib/exportTablesCsv';

// #110
describe('csvRowCount / firstDifferingRow', () => {
  it('counts data rows, keeping quoted line breaks in one row', () => {
    expect(csvRowCount('\uFEFFa\n1\n2\n')).toBe(2);
    expect(csvRowCount('a\r\n"x\ny"\r\n')).toBe(1);
    expect(csvRowCount('a\n')).toBe(0);
    expect(csvRowCount('')).toBe(0);
  });

  it('finds the first data row that differs', () => {
    expect(firstDifferingRow('a\n1\n2\n', 'a\n1\n3\n')).toEqual({ row: 2, from: '2', to: '3' });
    expect(firstDifferingRow('a\n1\n', 'a\n1\n2\n')).toEqual({ row: 2, from: '', to: '2' });
    expect(firstDifferingRow('a\n"x\ny"\n', 'a\n"x\nz"\n')).toEqual({ row: 1, from: '"x\ny"', to: '"x\nz"' });
    expect(firstDifferingRow('a\n1\n', 'b\n1\n')).toBeUndefined();
  });
});

// #80, #92
describe('classifyCsvOverwrites', () => {
  const T1 = 'Name,Mass\nA,1\nB,2\n';
  const T2 = 'Sample,OD\nX,0.5\n';

  it('tells new, unchanged and updated tables apart', () => {
    expect(
      classifyCsvOverwrites(
        [
          { fresh: T1 },
          { fresh: T2, old: T2 },
          { fresh: 'Sample,OD\nX,0.9\n', old: 'Sample,OD\nX,0.7\n' },
        ],
        3
      )
    ).toEqual(['new', 'same', 'updated']);
  });

  it('overwrites a renamed header when the values are the same', () => {
    expect(classifyCsvOverwrites([{ fresh: 'Name,Mass (mg)\nA,1\nB,2\n', old: T1 }], 1)).toEqual(['updated']);
  });

  it('asks about a header change when the values changed too', () => {
    expect(classifyCsvOverwrites([{ fresh: 'Name,Mass (mg)\nA,3\n', old: T1 }], 1)).toEqual(['headerChanged']);
  });

  it('does not match a header-only table by its (empty) values', () => {
    expect(classifyCsvOverwrites([{ fresh: 'Other\n', old: 'Name\n' }], 1)).toEqual(['headerChanged']);
  });

  it('reports a table added above as moved', () => {
    expect(classifyCsvOverwrites([{ fresh: T2, old: T1 }, { fresh: T1 }], 1)).toEqual(['moved', 'new']);
  });

  it('reports the first table removed as moved, by the table count', () => {
    expect(classifyCsvOverwrites([{ fresh: 'Sample,OD\nY,0.1\n', old: T1 }], 2)).toEqual(['moved']);
  });

  it('reports a moved header as moved', () => {
    expect(
      classifyCsvOverwrites(
        [
          { fresh: 'Sample,OD\nY,0.1\n', old: T1 },
          { fresh: 'Name,Mass\nC,9\n', old: T2 },
        ],
        2
      )
    ).toEqual(['moved', 'moved']);
  });

  it('keeps a renamed header unasked while old CSVs make the count differ', () => {
    expect(classifyCsvOverwrites([{ fresh: 'Name,Mass (mg)\nA,1\nB,2\n', old: T1 }], 3)).toEqual(['updated']);
  });

  it('reads a header with a line break inside quotes as one record', () => {
    expect(classifyCsvOverwrites([{ fresh: '"Name\nlong",Mass\nA,1\nB,2\n', old: T1 }], 1)).toEqual(['updated']);
  });

  // #117: both tables share a header, so the header check alone said `updated`.
  const RNA = '샘플,값\nRNA,1\n';
  const DNA = '샘플,값\nDNA,2\n';
  const PRO = '샘플,값\nPRO,3\n';

  it('asks when the first of two same-header tables is removed', () => {
    expect(classifyCsvOverwrites([{ fresh: DNA, old: RNA }], 2, [DNA])).toEqual(['moved']);
  });

  it('asks when the first of three same-header tables is removed', () => {
    expect(
      classifyCsvOverwrites(
        [
          { fresh: DNA, old: RNA },
          { fresh: PRO, old: DNA },
        ],
        3,
        [PRO]
      )
    ).toEqual(['moved', 'moved']);
  });

  it('still overwrites edited values without asking while a kept CSV is left over (#92)', () => {
    expect(classifyCsvOverwrites([{ fresh: '샘플,값\nDNA,5\n', old: DNA }], 2, [DNA])).toEqual(['updated']);
  });
});

describe('tableToCsv', () => {
  const rows = [
    ['조성', '탄소원', 'OD600'],
    ['M1', '포도당', '1.82'],
  ];

  it('emits plain UTF-8 CSV by default', () => {
    expect(tableToCsv(rows)).toBe('조성,탄소원,OD600\nM1,포도당,1.82\n');
  });

  // #24: Korean Windows Excel reads BOM-less UTF-8 as CP949 and garbles Hangul.
  it('prefixes a UTF-8 BOM when asked, leaving the body unchanged', () => {
    const csv = tableToCsv(rows, { bom: true });
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.slice(UTF8_BOM.length)).toBe(tableToCsv(rows));
    expect(new TextEncoder().encode(csv).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  it('quotes cells containing commas, quotes, or newlines', () => {
    expect(tableToCsv([['a,b', 'say "hi"', 'plain']])).toBe('"a,b","say ""hi""",plain\n');
  });

  // #122: Excel evaluates these instead of showing them.
  it('puts a tab inside quotes before cells Excel would read as a formula', () => {
    const cells = ['=2:1', '=B2*1.5', '@reagent;Reagent-1;완충액', '+82-2-000-0000', '-20 °C', '＝1+1', '＠x', '－a'];
    expect(tableToCsv(cells.map(c => [c]))).toBe(cells.map(c => `"\t${c}"`).join('\n') + '\n');
  });

  it('leaves signed numbers and a lone dash as they are', () => {
    const cells = ['-80', '+5', '-1.2e3', '-0.5', '-.5', '-80%', '－80', '-', '+'];
    expect(tableToCsv(cells.map(c => [c]))).toBe(cells.join('\n') + '\n');
    expect(tableToCsv([['-1,250']])).toBe('"-1,250"\n');
  });

  it('still doubles quotes in a protected cell with a comma', () => {
    expect(tableToCsv([['=A1,"x"']])).toBe('"\t=A1,""x"""\n');
  });

  // #138: Excel shows a lone sign next to `+/-` cells as an error or a blank.
  it('protects a lone + or - in a column of growth scores', () => {
    const csv = tableToCsv([['균주', '생장'], ['A', '+++'], ['B', '+/-'], ['C', '+'], ['D', '-']]);
    expect(csv).toBe('균주,생장\nA,"\t+++"\nB,"\t+/-"\nC,"\t+"\nD,"\t-"\n');
  });

  it('leaves a lone - as it is in a number column', () => {
    expect(tableToCsv([['시료', 'OD600'], ['A', '-0.2'], ['B', '-'], ['C', '+5']])).toBe(
      '시료,OD600\nA,-0.2\nB,-\nC,+5\n'
    );
  });

  it('judges the column by its data rows, not the header', () => {
    expect(tableToCsv([['+/-', '-'], ['-', '1']])).toBe('"\t+/-",-\n-,1\n');
    expect(tableToCsv([['-', '점수'], ['-', '++']])).toBe('-,점수\n-,"\t++"\n');
  });
});

describe('extractMarkdownTables', () => {
  it('finds a pipe table and drops the separator row', () => {
    const md = '| 조성 | 비고 |\n|---|---|\n| M1 | ok |\n';
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['조성', '비고'], ['M1', 'ok']] }]);
  });

  // #76: the CSV must match the rendered table.
  it('drops cells beyond the header width and pads short rows', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 | extra |\n| 3 |\n';
    expect(extractMarkdownTables(md)[0].rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', ''],
    ]);
  });

  it('turns <br> variants into a newline inside the cell', () => {
    const md = '| a |\n|---|\n| x<br>y<br/>z<BR />w |\n';
    const rows = extractMarkdownTables(md)[0].rows;
    expect(rows[1]).toEqual(['x\ny\nz\nw']);
    expect(tableToCsv(rows)).toBe('a\n"x\ny\nz\nw"\n');
  });

  // #90: the reading view shows a fenced block as text, not as a table.
  it('skips pipe tables inside fenced code blocks', () => {
    const example = '| 예시 | 값 |\n|---|---|\n| a | 1 |\n';
    const real = '| 조성 | 비고 |\n|---|---|\n| M1 | ok |\n';
    const md = `\`\`\`\n${example}\`\`\`\n\n${real}\n~~~md\n${example}~~~\n`;
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['조성', '비고'], ['M1', 'ok']] }]);
  });

  // #209: four spaces after a blank line is an indented code block.
  it('skips a table in an indented code block', () => {
    const md = '기록 양식(코드):\n\n    | 시료 | OD |\n    | --- | --- |\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['a', 'b'], ['1', '2']] }]);
  });

  it('still finds a table indented under a list item', () => {
    const md = '- 측정 결과\n\n    | a | b |\n    | --- | --- |\n    | 1 | 2 |\n';
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['a', 'b'], ['1', '2']] }]);
  });

  // #205: the reading view renders a table inside a quote or callout.
  it('finds tables inside a callout and a blockquote', () => {
    const md = [
      '> [!note] 반복 측정',
      '> | 회차 | 기준법 |',
      '> | --- | --- |',
      '> | 1 | 12.4 |',
      '',
      '> | 장비 | 보정일 |',
      '> |---|---|',
      '> | pH | 10-01 |',
      '',
    ].join('\n');
    expect(extractMarkdownTables(md)).toEqual([
      { index: 0, rows: [['회차', '기준법'], ['1', '12.4']] },
      { index: 1, rows: [['장비', '보정일'], ['pH', '10-01']] },
    ]);
  });

  // #221: right under a paragraph the rows only continue it in the reading view.
  describe('a table must start a block', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';

    it('skips rows right under paragraph text, and counts them', () => {
      const md = `측정값은 다음과 같다\n${table}\n\n${table}\n`;
      expect(scanMarkdownTables(md)).toEqual({
        tables: [{ index: 0, rows: [['a', 'b'], ['1', '2']] }],
        notRendered: 1,
      });
    });

    it('skips rows right under a list item or a quote paragraph', () => {
      expect(scanMarkdownTables(`- 결과\n${table}\n`).notRendered).toBe(1);
      expect(scanMarkdownTables(`> 설명문\n> ${table.replace(/\n/g, '\n> ')}\n`).notRendered).toBe(1);
      expect(scanMarkdownTables(`> 설명문\n${table}\n`).notRendered).toBe(1);
    });

    it('finds a table at the start, after a heading, a thematic break or a code block', () => {
      for (const before of ['', '## 결과\n', '---\n', '***\n', '```\ncode\n```\n']) {
        expect(scanMarkdownTables(`${before}${table}\n`), JSON.stringify(before)).toEqual({
          tables: [{ index: 0, rows: [['a', 'b'], ['1', '2']] }],
          notRendered: 0,
        });
      }
    });

    it('finds a table that opens a quote under a paragraph', () => {
      expect(extractMarkdownTables(`설명\n> ${table.replace(/\n/g, '\n> ')}\n`)).toHaveLength(1);
    });
  });

  it('ends a quoted table where the quote depth changes', () => {
    const md = '> | a |\n> |---|\n> | 1 |\n| 2 |\n';
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['a'], ['1']] }]);
  });

  it('keeps a ``` line inside a ~~~ block from closing it', () => {
    const md = `~~~\n\`\`\`\n| a |\n|---|\n| 1 |\n~~~\n| b |\n|---|\n| 2 |\n`;
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['b'], ['2']] }]);
  });

  // #72: an escaped pipe in a sample alias stays inside one cell.
  it('keeps an escaped pipe as one cell', () => {
    const md = '| 시료 | 비고 |\n|---|---|\n| Equip-1;DNase \\| 등급 | ok |\n';
    expect(extractMarkdownTables(md)[0].rows[1]).toEqual(['Equip-1;DNase | 등급', 'ok']);
  });

  // #139: the reading view hides these marks, so the CSV does too.
  it('strips bold, italic and code marks', () => {
    const md = '| **조성** | 비고 |\n|---|---|\n| __M1__ | *재측정* `0.5 mM` _확인_ |\n| ***x*** | ` a ` |\n';
    expect(extractMarkdownTables(md)[0].rows).toEqual([
      ['조성', '비고'],
      ['M1', '재측정 0.5 mM 확인'],
      ['x', 'a'],
    ]);
  });

  it('drops struck-through text with its marks', () => {
    const md = '| 값 |\n|---|\n| ~~0.10~~ 0.12 |\n| 0.10 ~~x~~ 0.12 |\n| ~~취소~~ |\n';
    expect(extractMarkdownTables(md)[0].rows.slice(1)).toEqual([['0.12'], ['0.10 0.12'], ['']]);
  });

  it('keeps marks inside a word, escaped marks and code contents', () => {
    const md = '| a | b | c | d |\n|---|---|---|---|\n| 2*3 | sample_id_1 | \\*x\\* | `~~x~~ **y**` |\n';
    expect(extractMarkdownTables(md)[0].rows[1]).toEqual(['2*3', 'sample_id_1', '\\*x\\*', '~~x~~ **y**']);
  });

  it('checks for a formula after stripping the marks', () => {
    const md = '| 점수 |\n|---|\n| **+/-** |\n| ~~0~~ - |\n';
    const rows = extractMarkdownTables(md)[0].rows;
    expect(rows.slice(1)).toEqual([['+/-'], ['-']]);
    expect(tableToCsv(rows)).toBe('점수\n"\t+/-"\n"\t-"\n');
  });
});
