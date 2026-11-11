// Globals convention (no `import ... from 'vitest'`), see sampleDefinition.test.ts.
// Every finder of headings, tables, entries and sections reads a note's lines from one block
// reading (classifyLines): the front matter, fences, HTML blocks, comments and containers as
// CommonMark and Obsidian have them. A finder that read them its own way saw a different note.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { classifyLines, classifyNote } from '../sections/codeFences';
import { planSampleListRowRemoval } from '../lib/sampleUtils';
import { parseWorksheetBlocks } from '../lib/worksheet';
import { scanMarkdownTables } from '../lib/exportTablesCsv';
import { listHeadings, replaceSectionBody } from '../sections/sectionEdit';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';

describe('one block reading for every finder', () => {
  it('finds no sample list table in the front matter', () => {
    const md = '---\ndescription: |\n  ~~~\n  | ID | Name |\n  |---|---|\n  | DNA-1 | a |\n  ~~~\n---\n# Note\n';
    expect(planSampleListRowRemoval(md, [['ID', 'Name']], 'DNA-1')).toEqual([]);
  });

  it('keeps the last line of a fence its list item ends as code', () => {
    expect(parseWorksheetBlocks(['1. prepare', '   ~~~', '   pipette 10 uL', '   incubate 5 min', '2. measure'])).toEqual([
      { kind: 'item', level: 0, text: 'prepare' },
      { kind: 'code', lines: ['   pipette 10 uL', '   incubate 5 min'] },
      { kind: 'item', level: 0, text: 'measure' },
    ]);
  });

  it('reads a comment past a fence its block quote ended, as the tables are read', () => {
    const md = '> ~~~\n> example\n\n%%\n\n| a | b |\n|---|---|\n| 1 | 2 |\n%%\n';
    expect(scanMarkdownTables(md)).toEqual({ tables: [], notRendered: 0, hidden: 1 });
  });

  it('ends a section at no heading inside an HTML block', () => {
    const out = replaceSectionBody('## A\n<!--\n~~~\n## B\n~~~\n-->\n## C\nkeep\n', 'A', 'new');
    expect(out).toMatchObject({ ok: true, md: '## A\n\nnew\n\n## C\nkeep\n' });
  });

  it('reads an NBSP after a tag as no HTML block start', () => {
    const out = removeWorkflowFromReadme('## Related Workflows\n<span>\u00a0\n- [ ] [A](./001_WD010_A.labnote.md)\n\n', '001_WD010_A.labnote.md');
    expect(out).toEqual({ changed: true, content: '## Related Workflows\n<span>\u00a0\n\n' });
  });

  it('classifies each line once: front matter, fences, HTML, comments and containers', () => {
    const lines = ['---', 'a: |', '  ```', '---', '- ```md', '  x', 'y', '<div>', '## h', '', '%%', 'hidden', '%%', '> q'];
    const kinds = classifyNote(lines);
    expect(kinds.map(k => k.kind)).toEqual([
      'front', 'front', 'front', 'front', 'opener', 'code', 'text', 'html', 'html', 'html', 'text', 'text', 'text', 'text',
    ]);
    expect(kinds[5]).toMatchObject({ content: 'x', depth: 1, closed: true, ends: true });
    expect(kinds.map(k => k.comment === true)).toEqual([false, false, false, false, false, false, false, false, false, false, true, true, true, false]);
    expect(kinds[13]).toMatchObject({ content: 'q', depth: 1 });
    // A fence left open runs to the end, not closed.
    expect(classifyLines(['```', 'x']).map(k => [k.kind, k.closed])).toEqual([['opener', false], ['code', false]]);
    // The empty piece after the last line break ends no block quote: the fence stays open.
    expect(classifyLines('> - ~~~\n>   x\n'.split('\n')).map(k => k.closed)).toEqual([false, false, false]);
    // A dash under a paragraph is its setext underline: a tag line after it starts an HTML block.
    expect(classifyLines(['text', '-', '<span>']).map(k => k.kind)).toEqual(['text', 'text', 'html']);
    // A paragraph ends with its block quote: a tag line after the quote starts an HTML block.
    expect(classifyLines(['> a', '', '<span>']).map(k => k.kind)).toEqual(['text', 'text', 'html']);
  });
});

// The fence state machine and its regular expressions live in codeFences.ts alone; a finder that
// stepped fences itself would read a note apart from the others. workflowDeleteV442.ts is the
// deletion main shipped, reproduced as it read (its own reading, to take the union with it).
describe('no finder reads fences its own way', () => {
  const root = join(__dirname, '..', '..', '..', '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sources(path);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });
  const own = new Set(['packages/labnoteo-core/src/sections/codeFences.ts', 'packages/labnoteo-core/src/lib/workflowDeleteV442.ts']);
  const files = [...sources(join(root, 'packages', 'labnoteo-core', 'src')), ...sources(join(root, 'src'))].filter(
    f => !own.has(relative(root, f).split('\\').join('/'))
  );
  // A fence run in a regular expression, or a fence reader stepped by hand.
  const ADHOC = /`\{3,?\d*\}|~\{3,?\d*\}|\bstepFence\b|\bfenceView\b|\bOpenFence\b/;

  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(50);
    // The check catches what it looks for.
    expect(ADHOC.test('const next = stepFence(view[i], fence);')).toBe(true);
    expect(ADHOC.test('/^ {0,3}(`{3,}|~{3,})/')).toBe(true);
  });

  it('finds no fence reading outside codeFences.ts', () => {
    const found = files.flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(root, f)}:${i + 1}` }))
        .filter(({ line }) => ADHOC.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .map(({ at }) => at)
    );
    expect(found).toEqual([]);
  });

  // CommonMark whitespace after a heading's hashes or a list marker is a space or a tab: `\s`
  // there also takes an NBSP. (The front matter is YAML, read by its own rules.)
  const UNICODE_SPACE = /#(?:\{(?:[^{}]|\{[^}]*\})*\}|#)\)?\\{1,2}s|\(\?:\\{1,2}s\|\$\)/;

  it('reads no NBSP as the space after a heading mark or a list marker', () => {
    expect(UNICODE_SPACE.test('/^(#{1,6})\\s+(.*)$/')).toBe(true);
    expect(UNICODE_SPACE.test('new RegExp(`^#{1,${level}}\\\\s`)')).toBe(true);
    expect(UNICODE_SPACE.test('/^\\s*(?:[-*+]|\\d+[.)])(?:\\s|$)/')).toBe(true);
    const found = files
      .filter(f => !f.endsWith('frontMatter.ts'))
      .flatMap(f =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(root, f)}:${i + 1}` }))
          .filter(({ line }) => UNICODE_SPACE.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line))
          .map(({ at }) => at)
      );
    expect(found).toEqual([]);
    expect(listHeadings('#\u00a0x\n## y\n')).toEqual([{ line: 1, level: 2, text: 'y', parentHeading: '' }]);
  });
});
