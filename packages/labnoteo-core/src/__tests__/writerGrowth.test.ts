// Globals convention (no `import ... from 'vitest'`), see sampleDefinition.test.ts.
// The writers read the fences of a document once, not once per section, and not at
// all when there is nothing to change. Two checks, neither a timing ratio: the number
// of whole-document fence readings, which must not grow with the number of sections,
// and (as in workflowReadmeInputs.test.ts) inputs large enough that a reading per
// section (quadratic, tens of seconds) and one per document (linear, well under a
// second) are far apart under one generous bound.
import * as fences from '../sections/codeFences';
import { removeAllScanEntries, removeScanEntry } from '../sections/scanInsert';
import { insertWorkflowChecklistEntries, removeWorkflowChecklistEntries } from '../lib/workflowStructure';
import { appendUnitOpToWorkflowToc, rebuildUnitOpToc } from '../sections/workflowSectionParser';
import { insertScanEntries } from '../sections/scanInsert';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { copyFrontMatterKeys, setFrontMatterKeys } from '../sections/frontMatter';
import { noteIdUnwritable } from '../lib/noteId';
import { resetCopiedWorkflowDates } from '../lib/workflowStructure';
import { sectionBodyAt } from '../sections/sectionEdit';

vi.mock('../sections/codeFences', async importOriginal => {
  const real = await importOriginal<typeof import('../sections/codeFences')>();
  return {
    ...real,
    markdownCodeLines: vi.fn(real.markdownCodeLines),
    closedFencedLines: vi.fn(real.closedFencedLines),
    closedFenceSpans: vi.fn(real.closedFenceSpans),
  };
});

const entry = (hash: string): string => `<!-- labnoteo-scan page=1/1 sha=${hash} -->`;
const readings = (run: () => void): number => {
  vi.mocked(fences.markdownCodeLines).mockClear();
  vi.mocked(fences.closedFencedLines).mockClear();
  run();
  return vi.mocked(fences.markdownCodeLines).mock.calls.length + vi.mocked(fences.closedFencedLines).mock.calls.length;
};

describe('whole-document fence readings per writer call', () => {
  it('removeWorkflowChecklistEntries reads no fence when there is nothing to remove', () => {
    const md = ['## Related Workflows', ...Array(200).fill('~'.repeat(80))].join('\n');
    expect(readings(() => expect(removeWorkflowChecklistEntries(md, ['001_WD010_A.labnote.md'])).toBe(md))).toBe(0);
  });

  it('appendUnitOpToWorkflowToc reads no extra fence for a toc with no entry yet', () => {
    const md = ['## Related Unit Operations', '', ...Array(200).fill('~'.repeat(80))].join('\n');
    expect(readings(() => appendUnitOpToWorkflowToc(md, 'U3', 'C'))).toBe(0);
  });
});

// How many lines the fence readings read in one call (the lines handed to each reading).
const linesRead = (run: () => void): number => {
  const fns = [fences.markdownCodeLines, fences.closedFencedLines, fences.closedFenceSpans].map(f => vi.mocked(f));
  fns.forEach(f => f.mockClear());
  run();
  return fns.reduce((sum, f) => sum + f.mock.calls.reduce((n, c) => n + (c[0] as readonly string[]).length, 0), 0);
};

// L5: the blank line a removed workflow entry leaves is judged from the lines up to it; a long
// README after the entry is read no more than B6 read it (removeWorkflowFromReadme reads
// all of it once in each of its two closed-fence readings, as B6 did).
describe('workflow entry removal and the README after it', () => {
  const readme = (n: number): string =>
    ['## Related Workflows', '', '- [ ] [A](./001_WD010_A.labnote.md)', '', ...Array(n).fill('~~~'), ''].join('\n');
  it('removeWorkflowChecklistEntries reads no further than the entries it removes', () => {
    const at = (n: number): number => linesRead(() => removeWorkflowChecklistEntries(readme(n), ['001_WD010_A.labnote.md']));
    expect(at(4000)).toBe(at(2000));
  });
  it('removeWorkflowFromReadme reads the rest only as B6 did', () => {
    const at = (n: number): number => linesRead(() => removeWorkflowFromReadme(readme(n), '001_WD010_A.labnote.md'));
    expect(at(4000) - at(2000)).toBeLessThanOrEqual(2 * 2000);
  });
});

// A closing fence run costs its characters, not an array entry per character (#v7b-4): the
// closed-blocks reading keeps one entry per closing line at most, whatever the run lengths.
describe('closed fence reading and long fence runs', () => {
  const arrays = (run: () => void): number[] => {
    const sizes: number[] = [];
    const set = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (Array.isArray(v)) sizes.push(v.length);
      return set.call(this, k, v);
    };
    try { run(); } finally { Map.prototype.set = set; }
    return sizes;
  };
  it.each([['```', '~'], ['~~~', '`']])('keeps no entry per character of a run (%s around %s runs)', (open, ch) => {
    const lines = (n: number): string[] => [open, ch.repeat(n), 'x', ch.repeat(n), ch.repeat(3)];
    const at = (n: number): number[] => arrays(() => fences.closedFenceSpans(lines(n)));
    expect(Math.max(0, ...at(1000))).toBeLessThanOrEqual(lines(1000).length);
    expect(at(4000)).toEqual(at(1000));
  });
});

// Work, not time: how many array elements the array helpers visit and how many regular
// expressions run during one call. A walk over every section per section (the list searched
// with find for each one) makes these grow with the square of the sections; one pass per
// note keeps them within twice plus a constant when the note doubles.
describe('writer work grows with the note, not its square', () => {
  const work = (run: () => void): number => {
    const A = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const names = ['find', 'findIndex', 'some', 'every', 'filter', 'map', 'forEach', 'reduce'];
    const saved = names.map(n => A[n]);
    const reTest = RegExp.prototype.test, reExec = RegExp.prototype.exec;
    let n = 0;
    names.forEach((name, k) => {
      A[name] = function (this: unknown[], ...args: unknown[]) {
        const f = args[0] as (...a: unknown[]) => unknown;
        if (typeof f !== 'function') return saved[k].apply(this, args);
        return saved[k].apply(this, [function (this: unknown, ...a: unknown[]) { n++; return f.apply(this, a); }, ...args.slice(1)]);
      };
    });
    RegExp.prototype.test = function (s: string) { n++; return reTest.call(this, s); };
    RegExp.prototype.exec = function (s: string) { n++; return reExec.call(this, s); };
    // Copies too: each element pushed, and each element a slice copies.
    const push = A.push, slice = A.slice;
    A.push = function (this: unknown[], ...items: unknown[]) { n += items.length; return push.apply(this, items); };
    A.slice = function (this: unknown[], ...args: unknown[]) { const out = slice.apply(this, args) as unknown[]; n += out.length; return out; };
    try { run(); } finally {
      names.forEach((name, k) => { A[name] = saved[k]; });
      A.push = push;
      A.slice = slice;
      RegExp.prototype.test = reTest;
      RegExp.prototype.exec = reExec;
    }
    return n;
  };
  const linear = (make: (n: number) => () => void): void => {
    const a = work(make(2000)), b = work(make(4000));
    expect(b).toBeLessThanOrEqual(2 * a + 2000);
  };
  const scans = (n: number, every: number): string =>
    Array.from({ length: n }, (_, i) => (every && i % every === 0 ? ['## Worksheet scans', entry(i % 2 ? 'aaaa' : 'bbbb'), '![[a.png]]', '*c*'] : ['## Worksheet scans'])).flat().join('\n');

  it.each([['no entry', 0]])('removeAllScanEntries over scans headings, %s', (_, every) => {
    linear(n => { const md = scans(n, every === 1e9 ? n : every); return () => removeAllScanEntries(md); });
  });

  it('removeScanEntry of a scan before many other headings', () => {
    linear(n => { const md = ['## Worksheet scans', entry('aaaa'), '![[a.png]]', ...Array(n).fill('## X')].join('\n'); return () => removeScanEntry(md, 'aaaa'); });
  });

  it('copyFrontMatterKeys of a long list', () => {
    linear(n => {
      const source = ['---', 'project:', ...Array(n).fill('  - a'), '---', ''].join('\n');
      return () => copyFrontMatterKeys(source, '---\nproject: []\n---\nbody', ['project']);
    });
  });

  it.each([['in the first section', 'bbbb']])('removeScanEntry over scans headings, hash %s', (_, hash) => {
    linear(n => { const md = scans(n, n); return () => removeScanEntry(md, hash); });
  });

  it('insertScanEntries over scans headings', () => {
    linear(n => { const md = scans(n, 10); return () => insertScanEntries(md, null, [{ page: 2, pageCount: 3, hash: 'cccc', embed: '![[c.jpg]]', caption: 'C' }]); });
  });

  it('appendUnitOpToWorkflowToc over toc headings', () => {
    linear(n => { const md = Array.from({ length: n }, () => '## Related Unit Operations\n- [U1 A](#u1-a)').join('\n'); return () => appendUnitOpToWorkflowToc(md, 'U3', 'C'); });
  });

  it('setFrontMatterKeys removing every key of a long front matter', () => {
    linear(n => {
      const md = ['---', ...Array.from({ length: n }, (_, i) => `k${i}: x # c${i % 2 ? '' : 'omment'}`), '---', ''].join('\n');
      const values = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i % 3 ? undefined : 'y']));
      return () => setFrontMatterKeys(md, values);
    });
  });

  it('resetCopiedWorkflowDates over a front matter of date keys', () => {
    linear(n => {
      const md = ['---', ...Array.from({ length: n }, (_, i) => ['created_date: 2020-01-01', 'end_date: 2020-01-02', 'x: 1'][i % 3]), '---', ''].join('\r\n');
      return () => resetCopiedWorkflowDates(md, '2026-11-02');
    });
  });

  // Whether a note's labnote_id can be written is read off its front matter, not its body.
  it('noteIdUnwritable does not read the body', () => {
    const at = (n: number): number => work(() => noteIdUnwritable(['---', 'labnote_id:', '  LN-AAAAAAAA', '---', ...Array(n).fill('body')].join('\n')));
    expect(at(4000)).toBe(at(2000));
  });

  // The body ends at the first heading out of code; the fences after it are not read at all.
  it('sectionBodyAt does not read past the next heading', () => {
    const at = (n: number, run: (md: string) => unknown): number => {
      const md = ['## A', 'old', '## B', ...Array(n).fill('~'.repeat(8))].join('\n');
      return work(() => run(md));
    };
    // Less the split into lines every writer makes (a regular expression run per line).
    const read = (n: number): number => at(n, md => sectionBodyAt(md, 0)) - at(n, md => md.split(/\r?\n/));
    expect(read(4000)).toBeLessThanOrEqual(read(2000) + 50);
  });

  // README fence readings in one pass: openers that never close cost no rescans, and the
  // exact sections are found among many lookalike headings (moved from wall-time bounds).
  it('removeWorkflowFromReadme and insertWorkflowChecklistEntries over fence openers that never close', () => {
    const a = '- [ ] [A](./001_WD010_A.labnote.md)';
    linear(n => {
      const md = ['## Related Workflows', a, ...Array.from({ length: n }, (_, i) => (i % 2 ? '````x' : '  ```x')), ''].join('\n');
      return () => {
        removeWorkflowFromReadme(md, '001_WD010_A.labnote.md');
        insertWorkflowChecklistEntries(md, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }]);
      };
    });
  });

  it('removeWorkflowFromReadme among many lookalike headings', () => {
    linear(n => {
      const md = ['## Related Workflows', '- [ ] [A](./001_WD010_A.labnote.md)', ...Array(n).fill('### Related Workflows'), ''].join('\n');
      return () => removeWorkflowFromReadme(md, '001_WD010_A.labnote.md');
    });
  });

  it.each([['no entry', 0], ['entries', 10]])('removeWorkflowChecklistEntries and removeWorkflowFromReadme over workflow headings, %s', (_, every) => {
    linear(n => {
      const md = Array.from({ length: n }, (_, i) => (every && i % every === 0 ? '## Related Workflows\n- [ ] [A](./001_WD010_A.labnote.md)' : '## Related Workflows')).join('\n');
      return () => { removeWorkflowChecklistEntries(md, ['001_WD010_A.labnote.md']); removeWorkflowFromReadme(md, '001_WD010_A.labnote.md'); };
    });
  });
});

// rebuildUnitOpToc pairs the current TOC entries with the headings once per call: the
// pairing is the only Map of entry index to line index (number to number) the rebuild fills,
// so the Maps filled that way count the pairings. Twice doubles the work on a long TOC.
describe('unit operation TOC rebuild pairs its entries once', () => {
  const pairings = (run: () => void): number => {
    const maps = new Set<Map<unknown, unknown>>();
    const set = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === 'number' && typeof v === 'number') maps.add(this);
      return set.call(this, k, v);
    };
    try { run(); } finally { Map.prototype.set = set; }
    return maps.size;
  };
  it.each([['LF', '\n'], ['CRLF', '\r\n']])('one pairing for a TOC to reorder (%s)', (_n, nl) => {
    const ops = Array.from({ length: 50 }, (_, i) => `UHW${String(10 + i).padStart(3, '0')}`);
    const toc = [...ops].reverse().map(id => `- [${id} Op](#${id.toLowerCase()}-op)`);
    const md = ['## Related Unit Operations', '', ...toc, '', '---', '', ...ops.flatMap(id => [`### [${id} Op]`, '', 'x', ''])].join(nl);
    let out = '';
    expect(pairings(() => { out = rebuildUnitOpToc(md); })).toBe(1);
    expect(out).not.toBe(md);
  });
});
