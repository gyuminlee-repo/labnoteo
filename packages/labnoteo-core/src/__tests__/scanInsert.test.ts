import {
  insertScanEntries,
  listFiledScans,
  listScanHashes,
  listUnitOpBlocks,
  removeAllScanEntries,
  removeScanEntry,
  resolveScanTarget,
  scanEntryLine,
  type ScanEntry,
} from '../sections/scanInsert';
import {
  computeUnitOpSyncEdits,
  findUnitOpInsertOffset,
  rebuildUnitOpToc,
} from '../sections/workflowSectionParser';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../lib/unitOpTemplate';
import { unitOpFingerprint } from '../lib/scanPayload';

function buildNote(ops: string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, {
    noteId: 'LN-7K3M9QX2',
  });
  for (const opId of ops) {
    const block = buildHwUnitOpMarkdown(
      { opId, opName: `Op ${opId}`, opDescription: 'step' },
      { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

const entry = (page: number, hash: string): ScanEntry => ({
  page,
  pageCount: 3,
  hash,
  embed: `![[LN-7K3M9QX2_u2_p${page}.jpg]]`,
  caption: `Printout ${page}/3`,
});

describe('listUnitOpBlocks', () => {
  it('numbers the blocks and stops each before the separator of the next', () => {
    const md = buildNote(['UHW010', 'UHW020', 'UHW010']);
    const lines = md.split('\n');
    const blocks = listUnitOpBlocks(md);
    expect(blocks.map(b => [b.index, b.opId])).toEqual([
      [1, 'UHW010'],
      [2, 'UHW020'],
      [3, 'UHW010'],
    ]);
    expect(lines[blocks[0].contentEndLine - 1]).toBe(lines.slice(0, blocks[1].headingLine).filter(l => l.startsWith('- (')).pop());
    expect(lines.slice(blocks[0].contentEndLine, blocks[0].endLine).every(l => l === '' || l === '---')).toBe(true);
  });
});

describe('resolveScanTarget', () => {
  const blocks = listUnitOpBlocks(buildNote(['UHW010', 'UHW020', 'UHW010']));

  it('takes the block at the printed position while it is still that unit operation', () => {
    expect(resolveScanTarget(blocks, 2, 'UHW020')).toMatchObject({ kind: 'block', by: 'index', block: { index: 2 } });
  });

  it('falls back to the only block with that opId', () => {
    expect(resolveScanTarget(blocks, 1, 'UHW020')).toMatchObject({ kind: 'block', by: 'opId', block: { index: 2 } });
  });

  it('asks when the opId is ambiguous or gone, and files position 0 under the note', () => {
    expect(resolveScanTarget(blocks, 2, 'UHW010')).toMatchObject({ kind: 'ambiguous' });
    expect(resolveScanTarget(blocks, 1, 'UHW999')).toEqual({ kind: 'missing' });
    expect(resolveScanTarget(blocks, 0, '')).toEqual({ kind: 'note' });
  });
});

describe('resolveScanTarget with a block fingerprint (#304)', () => {
  /** Two UHW010 blocks told apart by alias, as in the issue. */
  const note = (aliases: string[]): string => {
    const left = [...aliases];
    return buildNote(aliases.map(() => 'UHW010')).replace(/^### \[UHW010 Op UHW010\]$/gm, h => `${h} ${left.shift()}`);
  };
  const fp = (alias: string) => unitOpFingerprint('Op UHW010', alias);

  it('takes the block at the printed position only when its name and alias still match', () => {
    const blocks = listUnitOpBlocks(note(['조건 A', '조건 B']));
    expect(resolveScanTarget(blocks, 2, 'UHW010', fp('조건 B'))).toMatchObject({ kind: 'block', by: 'index', block: { index: 2 } });
  });

  it('finds the block after the one above it was removed', () => {
    const blocks = listUnitOpBlocks(note(['조건 B', '조건 C']));
    expect(resolveScanTarget(blocks, 1, 'UHW010', fp('조건 C'))).toMatchObject({
      kind: 'block',
      by: 'fingerprint',
      block: { index: 2, alias: '조건 C' },
    });
  });

  it('reports a renamed block instead of guessing, even when one block of the ID is left', () => {
    const blocks = listUnitOpBlocks(note(['조건 Z']));
    expect(resolveScanTarget(blocks, 1, 'UHW010', fp('조건 A'))).toMatchObject({ kind: 'renamed', candidates: [{ index: 1 }] });
    expect(resolveScanTarget(blocks, 1, 'UHW999', fp('조건 A'))).toEqual({ kind: 'missing' });
  });

  it('asks when two blocks have the same name and alias', () => {
    const blocks = listUnitOpBlocks(note(['조건 A', '조건 A']));
    expect(resolveScanTarget(blocks, 3, 'UHW010', fp('조건 A'))).toMatchObject({ kind: 'ambiguous' });
  });
});

describe('scan entries kept in a rewritten section keep their line endings', () => {
  const head = '## Worksheet scans\n\n';
  const a1 = '<!-- labnoteo-scan page=1/3 sha=aa -->\r\n![[a.jpg]]\r\n*a*\r\n';
  const b = '<!-- labnoteo-scan page=2/3 sha=bb -->\r\n![[b.jpg]]\r\n*KEEP*\r\n';
  const a3 = '<!-- labnoteo-scan page=3/3 sha=aa -->\r\n![[a.jpg]]\r\n*a*\r\n';

  it('when entries around them go', () => {
    expect(removeScanEntry(`${head}${a1}\r\n${b}\r\n${a3}`, 'aa').md).toBe(`${head}${b}`);
  });

  it('when entries go in before and after them', () => {
    const add = (page: number, hash: string) => ({ page, pageCount: 3, hash, embed: `![[${hash}.jpg]]`, caption: hash });
    const out = insertScanEntries(`${head}${b}`, null, [add(1, 'cc'), add(3, 'dd')]);
    expect(out).toContain(b);
    expect(out.indexOf('sha=cc')).toBeLessThan(out.indexOf('sha=bb'));
    expect(out.indexOf('sha=bb')).toBeLessThan(out.indexOf('sha=dd'));
  });
});

describe('scan listing and editing read code fences the same way', () => {
  it('neither lists nor removes a scan in an example fence that never closes', () => {
    const md = '## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[real.jpg]]\n\n## Example\n~~~\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[example.jpg]]\nKEEP';
    const kept = '\n## Example\n~~~\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[example.jpg]]\nKEEP';
    expect(listFiledScans(md).map(s => s.embed)).toEqual(['![[real.jpg]]']);
    expect(removeAllScanEntries(md)).toEqual({ md: kept, count: 1 });
    expect(removeScanEntry(md, 'aa')).toEqual({ md: kept, removed: true });
  });

  it('neither lists nor puts in the toc a heading after an opener that never closes', () => {
    const md = '### [UHW010 A]\n\n```\nnot closed\n\n### [UHW020 B]\n\nb\n';
    expect(listUnitOpBlocks(md).map(b => b.index)).toEqual([1]);
    expect(rebuildUnitOpToc(`## Related Unit Operations\n\n---\n\n${md}`)).not.toContain('- [UHW020 B](#uhw020-b)');
  });
});

// The entry goes as the section is rendered again: any caption insertScanEntries wrote goes whole.
describe('removeScanEntry and a caption over several lines', () => {
  it.each([
    ['LF', 'source\nname.png'],
    ['CR', 'source\rname.png'],
    ['U+2028', 'source\u2028name.png'],
    ['U+2029', 'source\u2029name.png'],
    ['blank line', 'a\n\nb'],
    ['trailing backslash', 'a\\'],
    ['numbered list', 'source\n1. item'],
    ['bullet list', 'source\n- item\n* other'],
    ['emphasis', '**bold** and _it_ and *em*'],
    ['emphasis over lines', 'a *b\nc* d'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['list, table and blank line', '1. a\n\n| x |\n- *y*'],
  ])('removes the whole caption (%s)', (_name, caption) => {
    for (const note of ['# Note\n', '# Note\r\n']) {
      const md = insertScanEntries(note, null, [{ page: 1, pageCount: 1, hash: 'aa', embed: '![[a.jpg]]', caption }]);
      expect(removeScanEntry(md, 'aa')).toEqual({ md: note, removed: true });
      expect(removeAllScanEntries(md)).toEqual({ md: note, count: 1 });
    }
  });

  it('removes the lines after the caption with the entry, as before', () => {
    const md = '## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[a.jpg]]\n*cap\nmore*\nUSER\n';
    expect(removeScanEntry(md, 'aa')).toEqual({ md: '', removed: true });
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('keeps the blank line after the preface when the last scan goes (%s)', (_name, nl) => {
    const md = ['## Worksheet scans', '', 'intro', '', '<!-- labnoteo-scan page=1/1 sha=aa -->', '![[a.png]]', '*A*', ''].join(nl);
    expect(removeScanEntry(md, 'aa')).toEqual({ md: ['## Worksheet scans', '', 'intro', '', ''].join(nl), removed: true });
  });
});

// A code block right under an entry's caption stays right under it, with no blank line put before it.
describe('scan sections and a code block written right under a caption', () => {
  const cases = ['~~~', '```', '  ~~~'].flatMap(fence => [['LF', '\n'], ['CRLF', '\r\n']].map(([n, nl]) => [`${fence} ${n}`, fence, nl]));
  const note = (fence: string, nl: string, withB: boolean) =>
    [
      '## Worksheet scans',
      '',
      '<!-- labnoteo-scan page=1/2 sha=aa -->',
      '![[a.jpg]]',
      '*A*',
      fence,
      'KEEP',
      fence,
      ...(withB ? ['', '<!-- labnoteo-scan page=2/2 sha=bb -->', '![[b.jpg]]', '*B*'] : []),
      '',
    ].join(nl);

  it.each(cases)('removes the entry after it (%s)', (_name, fence, nl) => {
    expect(removeScanEntry(note(fence, nl, true), 'bb')).toEqual({ md: note(fence, nl, false), removed: true });
  });

  it.each(cases)('adds an entry after it and removes it again (%s)', (_name, fence, nl) => {
    const md = note(fence, nl, true);
    const out = insertScanEntries(md, null, [{ page: 1, pageCount: 2, hash: 'cc', embed: '![[c.jpg]]', caption: 'C' }]);
    expect(out).toContain(['*A*', fence, 'KEEP', fence, ''].join(nl));
    expect(removeScanEntry(out, 'cc').md).toBe(md);
  });
});

// The blank lines before kept code stay as written; a line after the code goes with its entry, as before.
describe('scan sections and the lines around a kept code block', () => {
  it.each([0, 1, 2, 3])('keeps %i blank lines before the code when the entry after it goes', n => {
    const head = ['## Worksheet scans', '', '<!-- labnoteo-scan page=1/3 sha=aa -->', '![[aa.jpg]]', '*aa*', ...Array(n).fill(''), '~~~', 'code', '~~~'];
    const md = [...head, '', '<!-- labnoteo-scan page=3/3 sha=bb -->', '![[bb.jpg]]', '*bb*', ''].join('\n');
    expect(removeScanEntry(md, 'bb')).toEqual({ md: [...head, ''].join('\n'), removed: true });
  });

});

describe('insertScanEntries / removeScanEntry', () => {
  it('adds a Worksheet scans section at the end of the block, in page order', () => {
    const md = buildNote(['UHW010', 'UHW020', 'UHW030']);
    const block = listUnitOpBlocks(md)[1];
    const out = insertScanEntries(md, block, [entry(2, 'bbbb'), entry(1, 'aaaa')]);
    const after = listUnitOpBlocks(out)[1];
    const lines = out.split('\n');
    const heading = lines.indexOf('#### Worksheet scans');
    expect(heading).toBeGreaterThan(after.headingLine);
    expect(heading).toBeLessThan(after.endLine);
    expect(lines.slice(heading, heading + 9)).toEqual([
      '#### Worksheet scans',
      '',
      '<!-- labnoteo-scan page=1/3 sha=aaaa -->',
      '![[LN-7K3M9QX2_u2_p1.jpg]]',
      '*Printout 1/3*',
      '',
      '<!-- labnoteo-scan page=2/3 sha=bbbb -->',
      '![[LN-7K3M9QX2_u2_p2.jpg]]',
      '*Printout 2/3*',
    ]);
    const rest = lines.slice(heading + 9, after.endLine);
    expect(rest).toContain('---');
    expect(rest.every(l => l === '' || l === '---')).toBe(true);
    expect([...listScanHashes(out)]).toEqual(['aaaa', 'bbbb']);
  });

  it('appends the full-size link to the caption without escaping it', () => {
    const md = buildNote(['UHW010']);
    const out = insertScanEntries(md, listUnitOpBlocks(md)[0], [
      { ...entry(1, 'aaaa'), caption: 'Printout *1/3*', fullSizeLink: '[[LN-7K3M9QX2_u2_p1.jpg|Open full size]]' },
    ]);
    expect(out.split('\n')).toContain('*Printout \\*1/3\\* · [[LN-7K3M9QX2_u2_p1.jpg|Open full size]]*');
  });

  it('merges later scans into the section and keeps the earlier scan of a page first', () => {
    const md = buildNote(['UHW010']);
    let out = insertScanEntries(md, listUnitOpBlocks(md)[0], [entry(3, 'cccc'), entry(1, 'aaaa')]);
    out = insertScanEntries(out, listUnitOpBlocks(out)[0], [entry(2, 'bbbb'), entry(1, 'dddd')]);
    expect([...listScanHashes(out)]).toEqual(['aaaa', 'dddd', 'bbbb', 'cccc']);
    expect(out.match(/#### Worksheet scans/g)).toHaveLength(1);
  });

  it('leaves the TOC and separators alone', () => {
    const md = buildNote(['UHW010', 'UHW020']);
    const out = insertScanEntries(md, listUnitOpBlocks(md)[0], [entry(1, 'aaaa')]);
    expect(rebuildUnitOpToc(out)).toBe(out);
    expect(computeUnitOpSyncEdits(out)).toEqual([]);
  });

  it('undoes an insertion exactly, section included', () => {
    const md = buildNote(['UHW010', 'UHW020']);
    const one = insertScanEntries(md, listUnitOpBlocks(md)[1], [entry(1, 'aaaa')]);
    const two = insertScanEntries(one, listUnitOpBlocks(one)[1], [entry(2, 'bbbb')]);
    expect(removeScanEntry(two, 'bbbb')).toEqual({ md: one, removed: true });
    expect(removeScanEntry(one, 'aaaa')).toEqual({ md, removed: true });
    expect(removeScanEntry(md, 'aaaa')).toEqual({ md, removed: false });
  });

  it('files note-level pages in a section at the end of the note, and keeps CRLF', () => {
    const md = buildNote(['UHW010']).replace(/\n/g, '\r\n');
    const out = insertScanEntries(md, null, [entry(1, 'aaaa')]);
    expect(out).toMatch(/\r\n## Worksheet scans\r\n\r\n<!-- labnoteo-scan page=1\/3 sha=aaaa -->/);
    expect(out.trimEnd().endsWith('*Printout 1/3*')).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(removeScanEntry(out, 'aaaa').md).toBe(md);
  });

  it('removes every filed scan from a copied note, keeping a hand-written preface (#350)', () => {
    const md = buildNote(['UHW010', 'UHW020']);
    let out = insertScanEntries(md, listUnitOpBlocks(md)[0], [entry(1, 'aaaa'), entry(1, 'aaaa')]);
    out = insertScanEntries(out, null, [entry(2, 'bbbb')]);
    expect(removeAllScanEntries(out)).toEqual({ md, count: 3 });
    const kept = out.replace('#### Worksheet scans\n', '#### Worksheet scans\n\n손으로 적은 설명\n');
    const stripped = removeAllScanEntries(kept);
    expect(stripped.count).toBe(3);
    expect(stripped.md).toContain('#### Worksheet scans\n\n손으로 적은 설명');
    expect(listScanHashes(stripped.md).size).toBe(0);
    expect(removeAllScanEntries(md)).toEqual({ md, count: 0 });
  });

  it('does not read entries inside code blocks', () => {
    expect(listScanHashes('```\n<!-- labnoteo-scan page=1/1 sha=abcd -->\n```\n').size).toBe(0);
  });

  it('finds the line a filed scan starts on, outside code blocks (#549)', () => {
    const md = [
      '# Note',
      '```',
      '<!-- labnoteo-scan page=1/1 sha=abcd -->',
      '```',
      '#### Worksheet scans',
      '',
      '<!-- labnoteo-scan page=1/2 sha=ab -->',
      '<!-- labnoteo-scan page=2/2 sha=abcd -->',
    ].join('\r\n');
    expect(scanEntryLine(md, 'abcd')).toBe(7);
    expect(scanEntryLine(md, 'ab')).toBe(6);
    expect(scanEntryLine(md, 'ffff')).toBeUndefined();
  });
});

describe('scan removal and an entry comment in code', () => {
  it.each([['\n'], ['\r\n']])('keeps the user line after an entry with image and caption too (%j)', nl => {
    const md = ['## Worksheet scans', '', '<!-- labnoteo-scan page=1/3 sha=aa -->', '![[aa.jpg]]', '*aa*', '```md', '<!-- labnoteo-scan page=2/3 sha=bb -->', '```', 'KEEP', ''].join(nl);
    expect(removeScanEntry(md, 'aa').md.split(nl)).toContain('KEEP');
  });

  it.each([['\n'], ['\r\n']])('counts the scans removeAllScanEntries removed (%j)', nl => {
    const md = ['---', 'description: |', '  ~~~', '---', '~~~', '#### Worksheet scans', '~~~', '- ~~~md', '<!-- labnoteo-scan page=2/3 sha=bb -->', '![[bb.jpg]]', '*bb*', '  ```', '<!-- labnoteo-scan page=1/3 sha=aa -->', '![[aa.jpg]]', '*aa*', ''].join(nl);
    const r = removeAllScanEntries(md);
    const left = (t: string): number => t.split(nl).filter(l => l.startsWith('<!-- labnoteo-scan')).length;
    expect(r.count).toBe(left(md) - left(r.md));
  });
});

// Only an entry's comment and the paragraph under it (embed, caption) go when it is removed: a
// code block, a paragraph or a list the researcher wrote under it stays.
describe('removing a scan keeps what the researcher wrote under it', () => {
  const entry = (h: string, page: number) => [`<!-- labnoteo-scan page=${page}/2 sha=${h} -->`, `![[${h}.jpg]]`, `*${h}*`];
  const mine = ['~~~', 'KEEP', '~~~', 'user text', '- item'];
  const md = ['## Worksheet scans', '', ...entry('aa', 1), ...mine, '', ...entry('bb', 2), ''].join('\n');

  it('removeScanEntry: the lines stay where they were', () => {
    expect(removeScanEntry(md, 'aa').md).toBe(['## Worksheet scans', '', ...mine, '', ...entry('bb', 2), ''].join('\n'));
  });

  it('removeAllScanEntries: the section stays with them', () => {
    expect(removeAllScanEntries(md)).toEqual({ md: ['## Worksheet scans', '', ...mine, '', ''].join('\n'), count: 2 });
  });

  it('an undo that keeps the section keeps them too', () => {
    expect(removeScanEntry(md, 'aa', { keepSection: true }).md).toBe(['## Worksheet scans', '', ...mine, '', ...entry('bb', 2), ''].join('\n'));
  });

  it('a later entry keeps the lines of the one removed before it', () => {
    const two = ['## Worksheet scans', '', ...entry('bb', 2), '', ...entry('aa', 1), '', 'user text', ''].join('\n');
    expect(removeScanEntry(two, 'aa').md).toBe(['## Worksheet scans', '', ...entry('bb', 2), '', 'user text', ''].join('\n'));
  });
});

describe('removing a scan reads the section as the note shows it', () => {
  it('keeps the fences, and what a caption left open runs into, under a removed entry', () => {
    const md = [
      '## Worksheet scans',
      '',
      '<!-- labnoteo-scan page=1/3 sha=aa -->',
      '![[aa.jpg]]',
      '*cap*',
      '',
      '~~~',
      '<!-- labnoteo-scan page=2/3 sha=ee -->',
      '~~~',
      'USER',
      '<!-- labnoteo-scan page=3/3 sha=bb -->',
      '![[bb.jpg]]',
      '*a\\*',
      '~~~',
      '## Inner heading',
      '# KEEP',
      '*x*',
      '',
    ].join('\n');
    const out = removeAllScanEntries(md).md.split('\n');
    for (const line of ['<!-- labnoteo-scan page=2/3 sha=ee -->', 'USER', '## Inner heading', '# KEEP', '*x*']) expect(out).toContain(line);
    expect(out.filter(l => l === '~~~')).toHaveLength(3);
    expect(out.join('\n')).not.toMatch(/sha=(aa|bb)/);
  });
});
