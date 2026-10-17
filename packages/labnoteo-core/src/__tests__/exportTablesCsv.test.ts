// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { classifyCsvOverwrites, extractMarkdownTables, tableToCsv, UTF8_BOM } from '../lib/exportTablesCsv';

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

  it('keeps a ``` line inside a ~~~ block from closing it', () => {
    const md = `~~~\n\`\`\`\n| a |\n|---|\n| 1 |\n~~~\n| b |\n|---|\n| 2 |\n`;
    expect(extractMarkdownTables(md)).toEqual([{ index: 0, rows: [['b'], ['2']] }]);
  });

  // #72: an escaped pipe in a sample alias stays inside one cell.
  it('keeps an escaped pipe as one cell', () => {
    const md = '| 시료 | 비고 |\n|---|---|\n| Equip-1;DNase \\| 등급 | ok |\n';
    expect(extractMarkdownTables(md)[0].rows[1]).toEqual(['Equip-1;DNase | 등급', 'ok']);
  });
});
