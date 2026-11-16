import { describe, it, expect } from 'vitest';
import { linkedNames, mayLinkName } from '../../src/scan/noteLinks';

const NAME = 'LN-7K3M9QX2_u1_p1_20261111.jpg';

describe('the file names a note links', () => {
  it.each([
    [`![](labnote/Assay(pilot)/images/scans/${NAME})`],
    [`![](<labnote/Assay pilot/scans/${NAME}>)`],
    [`![alt](scans/${NAME} "title")`],
    [`![alt](scans/${NAME} 'title')`],
    [`![alt](scans/${NAME} (title))`],
    [`![](labnote/A\\(b\\)/${NAME})`],
    [`![](labnote/A%20B/${NAME.replace('_', '%5F')})`],
    [`[ref]: labnote/Assay(pilot)/${NAME}`],
    [`[ref]: <labnote/Assay pilot/${NAME}> "t"`],
    [`![[${NAME}]]`],
    [`![[${NAME}|100]]`],
    [`[[folder/${NAME}|alias]]`],
    [`[[${NAME}#heading]]`],
    [`[[${NAME}^block]]`],
  ])('%s', text => {
    expect(linkedNames(text).has(NAME.toLowerCase())).toBe(true);
    expect(mayLinkName(text, NAME)).toBe(true);
  });

  it('reads no link where there is none', () => {
    expect(mayLinkName(`![](scans/X${NAME})`, NAME)).toBe(false);
    expect(mayLinkName('![](scans/other.jpg)', NAME)).toBe(false);
  });

  // Links of every form above, in paths with spaces, parentheses, escapes and encodings, around
  // other text: none is missed.
  it('misses no link the fuzzer writes', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const dirs = ['', 'scans/', 'labnote/Assay(pilot)/images/scans/', 'a b/', 'x(y(z))/', 'é/', 'A_B-C.d/'];
    const names = [NAME, 'scan (1).jpg', 'a b.jpg', 'x_y.png', 'p(q).jpeg'];
    const encode = (p: string): string => pick([p, encodeURI(p), p.replace(/ /g, '%20'), p.replace(/[()]/g, c => `\\${c}`)]);
    const forms = [
      (p: string) => `![](${encode(p).replace(/ /g, '%20')})`,
      (p: string) => `![alt](<${p}>)`,
      (p: string) => `[x](${encode(p).replace(/ /g, '%20')} "t")`,
      (p: string) => `![[${p}]]`,
      (p: string) => `![[${p}|${pick(['100', 'alias', '200x100'])}]]`,
      (p: string) => `[[${p}${pick(['#h', '^b', ''])}]]`,
      (p: string) => `\n[r${Math.floor(rnd() * 9)}]: <${p}>\n`,
    ];
    const missed: string[] = [];
    for (let k = 0; k < 3000; k++) {
      const name = pick(names);
      const link = pick(forms)(pick(dirs) + name);
      const text = `${pick(['', 'text ', '- ', '> '])}${link}${pick(['', ' tail', '\n## Notes'])}`;
      if (!linkedNames(text).has(name.toLowerCase()) || !mayLinkName(text, name)) missed.push(text);
    }
    expect(missed).toEqual([]);
  });
});
