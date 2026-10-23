/**
 * #275: the confirmation before an experiment is marked completed names only
 * what it found. A "0 workflows" clause had users looking for nothing.
 */
import { describe, it, expect } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { confirmCompleted } from '../../src/commands';

const DIR = 'labnote/001_Test';
const A = '001_WD070_A.labnote.md';
const B = '002_WT020_B.labnote.md';

const note = (endDate: string): string => `---\ntitle: x\nend_date: ${endDate}\n---\n\nbody\n`;

const readme = (aDone: boolean, bDone: boolean): string =>
  [
    '# Test',
    '',
    '## 🗂️ Related Workflows',
    '',
    `- [${aDone ? 'x' : ' '}] [WD070 A](./${A})`,
    `- [${bDone ? 'x' : ' '}] [WT020 B](./${B})`,
    '',
  ].join('\n');

function harness(files: Record<string, string>): { host: LabnoteHost; asked: string[] } {
  const asked: string[] = [];
  const host = {
    fs: new MemFileSystem(files),
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    confirm: async (message: string) => {
      asked.push(message);
      return true;
    },
  } as unknown as LabnoteHost;
  return { host, asked };
}

describe('confirmCompleted (#275)', () => {
  it('names only the unchecked workflows when every note has an end_date', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('2026-10-02') });
    await confirmCompleted(host, DIR, readme(false, true));
    expect(asked).toEqual(['1 workflow(s) in the checklist are not checked. Mark the experiment completed anyway?']);
  });

  it('names only the notes without an end_date when every workflow is checked', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('') });
    await confirmCompleted(host, DIR, readme(true, true));
    expect(asked).toEqual(['1 workflow note(s) have no end_date. Mark the experiment completed anyway?']);
  });

  it('names both when both are found', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note(''), [`${DIR}/${B}`]: note('') });
    await confirmCompleted(host, DIR, readme(false, true));
    expect(asked).toEqual([
      '1 workflow(s) in the checklist are not checked and 2 workflow note(s) have no end_date. Mark the experiment completed anyway?',
    ]);
  });

  it('does not ask when nothing is left', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('2026-10-02') });
    expect(await confirmCompleted(host, DIR, readme(true, true))).toBe(true);
    expect(asked).toEqual([]);
  });
});
