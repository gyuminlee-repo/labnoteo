// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { joinLineBuffer, joinSplitKeepingCr, spliceLineBuffer, spliceLineBufferMany, splitKeepingCr, splitLineBuffer } from '../util/lineEnds';
import { setNoteId } from '../lib/noteId';
import { setRetryOf } from '../lib/labnoteStructure';
import { copyFrontMatterKeys, setFrontMatterKeys } from '../sections/frontMatter';
import { appendUnitOpToWorkflowToc, rebuildUnitOpToc } from '../sections/workflowSectionParser';
import { replaceSectionBody, replaceSectionBodyAt } from '../sections/sectionEdit';
import { insertScanEntries, removeScanEntry } from '../sections/scanInsert';
import {
  dedupeWorkflowChecklistEntries,
  insertWorkflowChecklistEntries,
  normalizeWorkflowChecklistLabels,
  parseWorkflowChecklistFromReadme,
  normalizeWorkflowChecklistLinks,
  reconcileWorkflowChecklist,
  relabelWorkflowChecklistEntries,
  relinkCopiedExperimentChecklist,
  relinkWorkflowChecklistEntries,
  removeWorkflowChecklistEntries,
  planWorkflowExperimenterSync,
  resetCopiedWorkflowDates,
  rewriteWorkflowTitle,
} from '../lib/workflowStructure';
import { reassignIssueMarkerIds, stripIssueMarkers } from '../lib/issueMarker';
import { touchLastUpdatedDate, updateAllDateFields } from '../lib/dateUtils';

// A line moved or added to the end of a README without a final newline keeps
// no line-break CR there, whichever line ending its neighbours use (#442 follow-up).
describe('the last line of a README with mixed line endings', () => {
  const a = '- [ ] [A](./001_WD010_A.labnote.md)';
  const b = '- [ ] [B](./002_WD010_B.labnote.md)';

  it('reads an entry renumbered to the end', () => {
    const md = `## Related Workflows\n${a}\r\n${b}`;
    const out = reconcileWorkflowChecklist(md, [{ from: '001_WD010_A.labnote.md', to: '008_WD010_A.labnote.md' }], { move: true }).content;
    expect(out).toBe(`## Related Workflows\n${b}\r\n- [ ] [A](./008_WD010_A.labnote.md)`);
    expect(parseWorkflowChecklistFromReadme(out).map(e => e.fileName)).toEqual(['002_WD010_B.labnote.md', '008_WD010_A.labnote.md']);
  });

  it('reads an entry added after an LF line that follows a CRLF heading', () => {
    const md = `## Related Workflows\r\n\n${a}`;
    const out = insertWorkflowChecklistEntries(md, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }]);
    expect(out).toBe(`## Related Workflows\r\n\n${a}\n- [ ] [D](./004_WD010_D.labnote.md)`);
    expect(parseWorkflowChecklistFromReadme(out)).toHaveLength(2);
  });
});

describe('splitKeepingCr and joinSplitKeepingCr', () => {
  it('takes off only the \\r the split added', () => {
    for (const text of ['a\r\nb', 'a\r\nb\r', 'a\r\nb\r\n', 'a\nb', 'a\r']) {
      expect(joinSplitKeepingCr(text, splitKeepingCr(text))).toBe(text);
    }
  });

  it('leaves a README that ends in a bare CR unchanged when nothing is renamed', () => {
    const md = '## Related Workflows\r\n- [ ] [A](./001_WD010_A.labnote.md)\r';
    expect(reconcileWorkflowChecklist(md, [{ from: '009_WD010_X.labnote.md', to: '010_WD010_X.labnote.md' }], { move: true })).toEqual({ changed: false, content: md });
  });
});

// A CRLF note without a final newline: a writer that edits, moves, drops or
// adds its last line leaves no bare LF and no trailing CR (#442 follow-up).
describe('writers on a CRLF note without a final newline', () => {
  const crlf = (lf: string): string => lf.replace(/\n/g, '\r\n');
  const a = '- [ ] [A](./002_WD010_A.labnote.md)';
  const b = '- [ ] [B](./003_WD010_B.labnote.md)';
  const readme = ['## Related Workflows', a, b].join('\n');
  const dupe = ['## Related Workflows', b, a, '- [x] [B](./003_WD010_B.labnote.md)'].join('\n');
  const fm = '---\ntitle: T\nlast_updated_date: 2026-01-01\n---';
  const cases: [string, string, (md: string) => string][] = [
    ['insertWorkflowChecklistEntries', readme, md => insertWorkflowChecklistEntries(md, [{ done: false, title: 'C', fileName: '004_WD010_C.labnote.md' }])],
    ['reconcileWorkflowChecklist (move)', readme, md => reconcileWorkflowChecklist(md, [{ from: '003_WD010_B.labnote.md', to: '001_WD010_B.labnote.md' }], { move: true }).content],
    ['removeWorkflowChecklistEntries', readme, md => removeWorkflowChecklistEntries(md, ['003_WD010_B.labnote.md'])],
    ['dedupeWorkflowChecklistEntries', dupe, md => dedupeWorkflowChecklistEntries(md, ['003_WD010_B.labnote.md'])],
    ['relinkWorkflowChecklistEntries', readme, md => relinkWorkflowChecklistEntries(md, [{ from: '003_WD010_B.labnote.md', to: '005_WD010_B.labnote.md' }])],
    ['relabelWorkflowChecklistEntries', readme, md => relabelWorkflowChecklistEntries(md, [{ fileName: '003_WD010_B.labnote.md', from: 'B', to: 'Bee' }])],
    ['normalizeWorkflowChecklistLabels', readme.replace('[B]', '[B\\]'), md => normalizeWorkflowChecklistLabels(md)],
    ['normalizeWorkflowChecklistLinks', readme.replace('(./003', '(exp/003'), md => normalizeWorkflowChecklistLinks(md, 'exp').content],
    ['relinkCopiedExperimentChecklist', readme.replace('(./003', '(labnote/002_X/003'), md => relinkCopiedExperimentChecklist(md, 'labnote/005_Y', ['003_WD010_B.labnote.md']).content],
    ['reassignIssueMarkerIds', 'x\n@issue;ISS-a;topic', md => reassignIssueMarkerIds(md, () => 'ISS-b').content],
    ['stripIssueMarkers', 'x\n@issue;ISS-a;topic', stripIssueMarkers],
    ['updateAllDateFields', fm, md => updateAllDateFields(md, 'last_updated_date', '2026-10-29')],
    ['touchLastUpdatedDate', fm, md => touchLastUpdatedDate(md, '2026-10-29')],
  ];

  it.each(cases)('%s', (_name, lf, write) => {
    const md = crlf(lf);
    const out = write(md);
    expect(out).not.toBe(md);
    expect(out).not.toMatch(/(^|[^\r])\n/);
    expect(out).not.toMatch(/\r(?!\n)/);
    expect(out.endsWith('\n')).toBe(false);
  });
});

describe('LineBuffer', () => {
  it('splits like split(/\\r?\\n/) and joins back to the text', () => {
    for (const text of ['a\r\nb\nc', 'a\nb\r\n', 'a\r\nb\r', '', 'a', 'a\n', 'a\r']) {
      const buf = splitLineBuffer(text);
      expect(buf.lines).toEqual(text.split(/\r?\n/));
      expect(joinLineBuffer(buf)).toBe(text);
    }
  });

  it('gives an added line the break above it and keeps every other break', () => {
    const buf = splitLineBuffer('a\r\nb\nc');
    spliceLineBuffer(buf, 1, 0, ['x']);
    expect(joinLineBuffer(buf)).toBe('a\r\nx\r\nb\nc');
    spliceLineBuffer(buf, 4, 0, ['y']);
    expect(joinLineBuffer(buf)).toBe('a\r\nx\r\nb\nc\ny');
    spliceLineBuffer(buf, 3, 2);
    expect(joinLineBuffer(buf)).toBe('a\r\nx\r\nb');
    spliceLineBuffer(buf, 0, 3, ['a', 'z', 'b']);
    expect(joinLineBuffer(buf)).toBe('a\r\nz\r\nb');
  });

  it('carries a line given by reference with its own break into a rewritten range', () => {
    const buf = splitLineBuffer('h\nx\r\nk\r\ny\nz');
    spliceLineBuffer(buf, 0, 4, ['h', 'new', { line: 2 }, 'after']);
    expect(joinLineBuffer(buf)).toBe('h\nnew\nk\r\nafter\r\nz');
  });
});

// A note or README with mixed line endings: a writer changes the lines it
// edits and leaves every other line's break as it was (it used to give every
// line the CRLF of the note's first one).
describe('writers on a note with mixed line endings', () => {
  it('setNoteId', () => {
    expect(setNoteId('---\r\ntitle: T\r\n---\nbody\r\nmore\n', 'LN-7K3M9QX2')).toBe(
      '---\r\ntitle: T\r\nlabnote_id: LN-7K3M9QX2\r\n---\nbody\r\nmore\n'
    );
  });

  const tail = '\n## Keep\nk1\r\nk2\nk3\r\n';
  const note = `---\r\ntitle: WD030 Design\r\nexperimenter: ''\r\ncreated_date: 2026-01-01\r\n---\n\n## [WD030 Design]\r\n\n## Related Unit Operations\n\n- [UHW020 B](#uhw020-b)\r\n- [UHW010 A](#uhw010-a)\n\n---\n\n### [UHW010 A]\r\n\n#### Method\n\nold\r\n\n### [UHW020 B]\n${tail}`;
  const cases: [string, (md: string) => string][] = [
    ['setNoteId', md => setNoteId(md, 'LN-7K3M9QX2')],
    ['setRetryOf', md => setRetryOf(md, '[[x|1]]')],
    ['setFrontMatterKeys', md => setFrontMatterKeys(md, { title: 'X', created_date: undefined, status: 'done' })],
    ['copyFrontMatterKeys', md => copyFrontMatterKeys('---\nauthor: Kim\n---\n', md, ['author'])],
    ['rewriteWorkflowTitle', md => rewriteWorkflowTitle(md, 'WD030', 'Design', 'alias')],
    ['planWorkflowExperimenterSync', md => planWorkflowExperimenterSync(md, 'Kim')!.content],
    ['resetCopiedWorkflowDates', md => resetCopiedWorkflowDates(md, '2026-10-30')],
    ['appendUnitOpToWorkflowToc', md => appendUnitOpToWorkflowToc(md, 'UHW030', 'C')],
    ['rebuildUnitOpToc', md => rebuildUnitOpToc(md)],
    ['replaceSectionBody', md => replaceSectionBody(md, 'Method', 'NEW').md],
    ['insertScanEntries', md => insertScanEntries(md, null, [{ page: 1, pageCount: 1, hash: 'aaaa', embed: '![[a.png]]', caption: 'c' }])],
  ];

  it.each(cases)('%s', (_name, write) => {
    const md = note;
    const out = write(md);
    expect(out).not.toBe(md);
    // The section below every edit keeps its breaks, and so does the line under the front matter.
    expect(out).toContain(tail);
    expect(out).toMatch(/---\n\n## \[WD030 Design\][^\n]*\r\n\n## Related Unit Operations\n/);
  });

  it('removeScanEntry', () => {
    const md = `## Results\r\nr\n\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/2 sha=aaaa -->\r\n![[a.png]]\n*c*\n\n<!-- labnoteo-scan page=2/2 sha=bbbb -->\r\n![[b.png]]\n*c*\n${tail}`;
    const out = removeScanEntry(md, 'bbbb').md;
    expect(out).toBe(`## Results\r\nr\n\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/2 sha=aaaa -->\r\n![[a.png]]\n*c*\n${tail}`);
  });
});

// No writer may join split lines with one line break for the whole text again.
// One pass over the lines, with no argument list as long as the input: a
// list of 64 000 or 96 000 items copies whole and in time.
// #517 keeps the comment of a key that goes; the lines around it keep their own breaks.
describe('setFrontMatterKeys dropping a key with a comment in mixed endings', () => {
  it('keeps the comment as a new line and every other line as written', () => {
    expect(setFrontMatterKeys('---\r\na: 1 # c\nb: 2\r\n---\nbody\r\n', { a: undefined })).toBe('---\r\n# c\r\nb: 2\r\n---\nbody\r\n');
    expect(setFrontMatterKeys('---\na: 1 # c\nb: 2\n---\nbody\n', { a: undefined })).toBe('---\n# c\nb: 2\n---\nbody\n');
  });
});

// A long list copied or spliced in goes as an array, never as a spread argument list (a
// stack overflow past about 100 000 items); spliceLineBuffer takes it in one call.
describe('writers on a long front matter list', () => {
  it('splices 200 000 lines in at once', () => {
    const buf = splitLineBuffer('a\nb');
    spliceLineBuffer(buf, 1, 0, Array(200_000).fill('x'));
    expect(buf.lines).toHaveLength(200_002);
    expect(buf.lines[200_001]).toBe('b');
  });

  it('copies a list item by item', () => {
    const items = Array.from({ length: 200 }, () => '  - a');
    const source = ['---', 'project:', ...items, '---', ''].join('\n');
    expect(copyFrontMatterKeys(source, '---\nproject: []\n---\nbody', ['project'])).toBe(['---', 'project:', ...items, '---', 'body'].join('\n'));
  });
});

describe('line-break guard', () => {
  it('finds no lines.join(newline) in the core sources', () => {
    const root = join(__dirname, '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
        return path.endsWith('.ts') ? [path] : [];
      });
    const offenders = files(root).flatMap(file =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/\b[a-zA-Z]+\.join\((newline|nl|eol)\)|join\([a-z]+\.includes\('\\r\\n'\)/.test(line) ? [`${file}:${i + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });
});

// Codex v7p: a lone CR ending the text is the last line's text (LineBuffer). A line added after
// it gives that line a break; LF there would read with the CR as one CRLF and take the CR off
// the line. The text's own break goes there instead, as B6 wrote: CRLF in a text with any.
describe('a line added after a lone CR ending the text', () => {
  // The break before the last line LF, CRLF, or LF in a text that has CRLF too (Codex's input).
  const bases = [
    ['LF', ['A', 'B', 'C\r'].join('\n')],
    ['CRLF', ['A', 'B', 'C\r'].join('\r\n')],
    ['mixed', 'A\r\nB\nC\r'],
  ];
  // What B6 wrote after the last line: the text's own break, the lone CR kept before it.
  const kept = (md: string) => md + (md.includes('\r\n') ? '\r\n' : '\n');

  it.each(bases)('insertScanEntries keeps the line as B6 did (%s)', (_name, md) => {
    const out = insertScanEntries(md, null, [{ page: 1, pageCount: 5, hash: 'aa', embed: '![[new.jpg]]', caption: 'new' }]);
    expect(out.startsWith(kept(md))).toBe(true);
  });

  it.each(bases)('appendUnitOpToWorkflowToc keeps the line as B6 did (%s)', (_name, md) => {
    const toc = md.replace(/^A/, '## Related Unit Operations').replace('C\r', '- [UHW010 A](#uhw010-a)\r');
    const out = appendUnitOpToWorkflowToc(toc, 'UHW020', 'B');
    expect(out.startsWith(kept(toc))).toBe(true);
  });

  it.each(bases)('replaceSectionBody and replaceSectionBodyAt keep the heading line as B6 did (%s)', (_name, md) => {
    const doc = md.replace(/^A/, '# T').replace('C\r', '## Z\r');
    const at = replaceSectionBodyAt(doc, 2, 'NEW');
    expect(at.ok && at.md.startsWith(kept(doc))).toBe(true);
    expect(at.removed?.lines).toBe(0);
    const named = replaceSectionBody(doc, 'Z', 'NEW');
    expect(named.ok && named.md.startsWith(kept(doc))).toBe(true);
  });

  it.each(bases)('both splices give the line its break so (%s)', (_name, md) => {
    for (const many of [false, true]) {
      const buf = splitLineBuffer(md);
      if (many) spliceLineBufferMany(buf, [{ start: 3, count: 0, body: ['D'] }]);
      else spliceLineBuffer(buf, 3, 0, ['D']);
      expect(joinLineBuffer(buf).startsWith(kept(md))).toBe(true);
    }
  });
});
