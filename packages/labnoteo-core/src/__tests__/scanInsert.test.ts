import {
  insertScanEntries,
  listScanHashes,
  listUnitOpBlocks,
  removeScanEntry,
  resolveScanTarget,
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

  it('does not read entries inside code blocks', () => {
    expect(listScanHashes('```\n<!-- labnoteo-scan page=1/1 sha=abcd -->\n```\n').size).toBe(0);
  });
});
