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
import { appendUnitOpToWorkflowToc, findUnitOpInsertOffset, findUnitOpInsertPointAt, resolveGithubAnchor } from '../sections/workflowSectionParser';
import { extractMethodBody } from '../sections/blockInsert';
import { scanDocumentHead } from '../sections/documentHead';

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

  it('adds a TOC entry outside a fence when a list item fence closes later in the section', () => {
    const md = ['## Related Unit Operations', '- [UHW010 A](#uhw010-a)', '~~~', '- [UHW001 Ex](#x)', '~~~', '- ```md', '  ### [UHW040 Example]', '  ```', ''].join('\n');
    expect(appendUnitOpToWorkflowToc(md, 'UHW020', 'B').split('\n').slice(0, 3)).toEqual([
      '## Related Unit Operations',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
    ]);
  });

  it('adds a TOC entry outside a fence past list item fences their items end at once', () => {
    const md = ['## Related Unit Operations', '- [UHW050 E](#uhw050-e)', '- [Protocol](https://example.org/p)', '  ```', '# KEEP', '- [UHW001 Ex](#x)', '  ```', '~~~', '- [UHW010 A](#uhw010-a)', '~~~', ''].join('\n');
    const out = appendUnitOpToWorkflowToc(md, 'UHW020', 'B').split('\n');
    // `# KEEP` ends the section: the last entry in it, out of every fence, is `- [Protocol]`.
    expect(out.indexOf('- [UHW020 B](#uhw020-b)')).toBe(3);
  });

  // A `##` one to three spaces in is no section heading for these finders, as before: a section
  // taken from it read the code under it for its end and its blocks.
  describe('a unit operation section heading indented one to three spaces', () => {
    const A = '  ## Related Unit Operations\n\n~~~\n- [example](x)\n## Example\n~~~\n';
    const B = '  ## Related Unit Operations\n\n~~~\n## Example\n~~~\n';
    const C = '  ## Related Unit Operations\n\n~~~\n### [UHW010 Example]\n~~~\n';
    it('adds no TOC entry in the code under it', () => {
      expect(appendUnitOpToWorkflowToc(A, 'UHW099', 'New')).toBe(A);
    });
    it('puts a new unit operation past the code', () => {
      expect(findUnitOpInsertOffset(B)).toBe(49);
      expect(findUnitOpInsertPointAt(B, 30)).toEqual({ offset: 49, place: 'noSection' });
      expect(findUnitOpInsertPointAt(C, 30)).toEqual({ offset: 59, place: 'noSection' });
    });
  });

  it('numbers anchors of headings up to three spaces in, as GitHub does', () => {
    expect(resolveGithubAnchor(' # Same\n# Same\n', 'same')).toBe(0);
    expect(resolveGithubAnchor(' # Same\n# Same\n', 'same-1')).toBe(1);
  });

  it('adds a TOC entry outside a fence however other fences before it are indented', () => {
    // A list item fence above, and a fenced example with an NBSP after a run (no closer) below.
    const md = [
      "## Related Workflows",
      "",
      "- [ ] [A](./001_WD010_A.labnote.md)",
      "- [ ] [A](./001_WD010_A.labnote.md)",
      "```text",
      "alpha",
      "",
      "- [ ] [A](./001_WD010_A.labnote.md)",
      "",
      "beta",
      "```",
      "#### Method",
      "- ```md",
      "  ![[x.jpg]]",
      "  code",
      "  ## Inner heading",
      "  ```",
      "step",
      "",
      "## Related Unit Operations",
      "### [Group] alias",
      "",
      "- [UHW010 A](#uhw010-a)",
      "```",
      "```\u00a0",
      "- [UHW010 A](#uhw010-a)",
      "```",
      "",
      "",
      "   ## Other",
      "text",
      "",
    ].join('\n');
    const out = appendUnitOpToWorkflowToc(md, 'UHW020', 'B').split('\n');
    expect(out.indexOf('- [UHW020 B](#uhw020-b)')).toBe(23);
    expect(out.slice(24, 28)).toEqual(['```', '```\u00a0', '- [UHW010 A](#uhw010-a)', '```']);
  });

  it('takes a tilde fence with a backtick in its info string as wrapping a reply', () => {
    expect(extractMethodBody('~~~`markdown`\n#### Method\n1. step\n~~~')).toBe('1. step');
  });

  it('reads no heading in indented code above the note heading', () => {
    const md = '    ~~~\n    # Example\n    ~~~\n\n# Real\nbody\n';
    const head = scanDocumentHead(md.split('\n'));
    expect(head.firstHeadingLine).toBe(4);
    expect([...head.headingLines]).toEqual([4]);
  });

  it('unwraps a reply only when one fence at the start of its first line wraps all of it', () => {
    expect(extractMethodBody('- ~~~md\n  # KEEP\n  ~~~')).toBe('- ~~~md\n  # KEEP\n  ~~~');
    expect(extractMethodBody('~~~\n1. step\n## h\n~~~')).toBe('1. step');
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

  // A line the block reading classified is not judged again: no heading, indent or fence test on
  // the raw line beside a classification (kinds[...], isPlain, isFenced, .fenced).
  const REJUDGE = /(?:kinds\[|isPlain\(|isFenced\(|\.fenced\b)[^\n]*(?:\/\^[^/]*#|trimStart\(\)|startsWith\('#'\))/;

  it('judges no classified line again by its raw text', () => {
    expect(REJUDGE.test("if (isPlain(kinds[i]) && /^#{1,6}[ \\t]/.test(line))")).toBe(true);
    expect(REJUDGE.test("if (!lines[j].fenced && /^##[ \\t]/.test(lines[j].text))")).toBe(true);
    const found = files.flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(root, f)}:${i + 1}` }))
        .filter(({ line }) => REJUDGE.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .map(({ at }) => at)
    );
    expect(found).toEqual([]);
    const trimmed = files.filter(f => /classifyLines|classifyNote|lineReader/.test(readFileSync(f, 'utf8')) && /const trimmed = [^\n]*trimStart\(\)/.test(readFileSync(f, 'utf8')));
    expect(trimmed.map(f => relative(root, f))).toEqual([]);
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
