/**
 * #275: the confirmation before an experiment is marked completed names only
 * what it found. A "0 workflows" clause had users looking for nothing.
 */
import { describe, it, expect } from 'vitest';
import type { LabnoteHost, PickItem } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { confirmCompleted } from '../../src/commands';

const DIR = 'labnote/001_Test';
const A = '001_WD070_A.labnote.md';
const B = '002_WT020_B.labnote.md';

const note = (endDate: string, body = 'body'): string => `---\ntitle: x\nend_date: ${endDate}\n---\n\n${body}\n`;

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

function harness(
  files: Record<string, string>,
  picked?: string
): { host: LabnoteHost; asked: string[]; offered: string[] } {
  const asked: string[] = [];
  const offered: string[] = [];
  const host = {
    fs: new MemFileSystem(files),
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    confirm: async (message: string) => {
      asked.push(message);
      return true;
    },
    pick: async <T,>(items: PickItem<T>[], opts?: { title?: string }) => {
      asked.push(opts?.title ?? '');
      offered.push(...items.map(i => String(i.value)));
      return items.find(i => i.value === picked)?.value;
    },
  } as unknown as LabnoteHost;
  return { host, asked, offered };
}

describe('confirmCompleted (#275)', () => {
  it('names only the unchecked workflows when every note has an end_date', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('2026-10-02') });
    await confirmCompleted(host, DIR, readme(false, true));
    expect(asked).toEqual(['1 workflow(s) in the checklist are not checked. Mark the experiment completed anyway?']);
  });

  it('names the notes without an end_date when every workflow is checked', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('') });
    await confirmCompleted(host, DIR, readme(true, true));
    expect(asked).toEqual([
      `1 workflow note(s) have no end_date in their properties: ${B}. Mark the experiment completed anyway?`,
    ]);
  });

  it('names both when both are found', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note(''), [`${DIR}/${B}`]: note('') });
    await confirmCompleted(host, DIR, readme(false, true));
    expect(asked).toEqual([
      `1 workflow(s) in the checklist are not checked. 2 workflow note(s) have no end_date in their properties: ${A}, ${B}. Mark the experiment completed anyway?`,
    ]);
  });

  it('does not ask when nothing is left', async () => {
    const { host, asked } = harness({ [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('2026-10-02') });
    expect(await confirmCompleted(host, DIR, readme(true, true))).toBe('keep');
    expect(asked).toEqual([]);
  });
});

// #355: the unit operations' End_date is where the work is marked done.
describe('confirmCompleted and unit operation End_date', () => {
  const ops = (a: string, b: string): string =>
    ['### [UHW010 A]', '#### Meta', `- End_date: '${a}'`, '', '### [UHW020 B]', '#### Meta', `- End_date: '${b}'`].join(
      '\n'
    );

  it('does not count a note whose unit operations have all ended', async () => {
    const { host, asked } = harness({
      [`${DIR}/${A}`]: note('', ops('2026-10-25 08:37', '2026-10-25 08:38')),
      [`${DIR}/${B}`]: note('2026-10-02'),
    });
    expect(await confirmCompleted(host, DIR, readme(true, true))).toBe('keep');
    expect(asked).toEqual([]);
  });

  it('still counts it when one unit operation has no End_date', async () => {
    const { host, asked } = harness({
      [`${DIR}/${A}`]: note('', ops('2026-10-25 08:37', '')),
      [`${DIR}/${B}`]: note('2026-10-02'),
    });
    await confirmCompleted(host, DIR, readme(true, true));
    expect(asked[0]).toContain(`no end_date in their properties: ${A}.`);
  });
});

// #380: an experiment still up for discussion is named before it is closed.
describe('confirmCompleted and discussion', () => {
  const done = { [`${DIR}/${A}`]: note('2026-10-01'), [`${DIR}/${B}`]: note('2026-10-02') };

  it('offers to clear the discussion flag', async () => {
    const { host, asked, offered } = harness(done, 'clear');
    expect(await confirmCompleted(host, DIR, readme(true, true), true)).toBe('clear');
    expect(asked).toEqual(['The discussion flag is on. Mark the experiment completed anyway?']);
    expect(offered).toEqual(['clear', 'keep', 'cancel']);
  });

  it('cancels when asked to', async () => {
    const { host } = harness(done, 'cancel');
    expect(await confirmCompleted(host, DIR, readme(true, true), true)).toBeUndefined();
  });

  it('names the markers left, by note and line', async () => {
    const { host, asked } = harness({
      ...done,
      [`${DIR}/${B}`]: note('2026-10-02', '## Method\n\n- 37도 @issue;ISS-a;온도 확인\n\n`@issue;ISS-x;예시`'),
    });
    expect(await confirmCompleted(host, DIR, readme(true, true))).toBe('keep');
    expect(asked).toEqual([`1 @issue marker(s) remain: ${B}:8. Mark the experiment completed anyway?`]);
  });
});
