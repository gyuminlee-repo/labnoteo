/**
 * #41: "Renumber workflows" must leave the README intact whatever the user
 * answers to Obsidian's "update links?" prompt.
 *
 * The command pauses the README auto-sync while it moves files (so nothing
 * writes the README while a prompt is open), then rewrites the checklist once,
 * from the README as it was before the first move. These tests drive it against
 * a fake vault whose `renameFile` either relinks the README the way Obsidian
 * does or leaves it alone.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { parseWorkflowChecklistFromReadme } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import { renumberWorkflowsCommand, netRenames, type ReadmeSyncControl } from '../../src/commands';

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const A = '001_WD070_A.labnote.md';
const C_OLD = '003_WT020_C_형광_측정.labnote.md';
const C_NEW = '002_WT020_C_형광_측정.labnote.md';

const README_BEFORE = [
  '# Test',
  '',
  '## 🗂️ Related Workflows',
  '',
  `- [ ] [WD070 A](./${A})`,
  `- [ ] [WT020 C 형광 측정](./${C_OLD})`,
  '',
  '## Summary and Discussion',
  '',
  '요약 두 문장.',
  '',
].join('\n');

interface Harness {
  fs: MemFileSystem;
  calls: string[];
  app: App;
  host: LabnoteHost;
  sync: ReadmeSyncControl;
}

/**
 * `relink`: mimic Obsidian's link update on each rename (it drops the `./`).
 * `failOn`: the destination name whose rename throws.
 */
function harness(opts: { relink: boolean; failOn?: string }): Harness {
  const fs = new MemFileSystem({ [README]: README_BEFORE, [`${DIR}/${A}`]: 'a', [`${DIR}/${C_OLD}`]: 'c' });
  const calls: string[] = [];

  const app = {
    workspace: { getActiveFile: () => new TFile(README) },
    vault: {
      getFileByPath: (path: string) => (path in fs.snapshot() ? new TFile(path) : null),
      process: async (file: TFile, fn: (data: string) => string) => {
        calls.push('write');
        const next = fn(await fs.read(file.path));
        await fs.write(file.path, next);
        return next;
      },
    },
    fileManager: {
      renameFile: async (file: TFile, newPath: string) => {
        const to = newPath.split('/').pop() ?? newPath;
        if (to === opts.failOn) throw new Error('rename failed');
        calls.push(`rename ${file.name} -> ${to}`);
        await fs.write(newPath, await fs.read(file.path));
        await fs.remove(file.path);
        if (opts.relink) {
          const md = await fs.read(README);
          await fs.write(README, md.split(`(./${file.name})`).join(`(${to})`).split(`(${file.name})`).join(`(${to})`));
        }
      },
    },
  } as unknown as App;

  const host = {
    fs,
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    confirm: async () => true,
    notify: (_level: string, msg: string) => calls.push(`notify ${msg}`),
  } as unknown as LabnoteHost;

  const sync: ReadmeSyncControl = {
    flushNow: async dir => void calls.push(`flushNow ${dir}`),
    hold: dir => void calls.push(`hold ${dir}`),
    settle: async () => void calls.push('settle'),
    release: async (dir, o) => void calls.push(`release ${dir} drop=${o?.dropRenames}`),
  };
  return { fs, calls, app, host, sync };
}

const links = (md: string): string[] => parseWorkflowChecklistFromReadme(md).map(i => i.fileName);

describe('renumberWorkflowsCommand (#41)', () => {
  for (const relink of [false, true]) {
    it(`keeps the README intact when Obsidian ${relink ? 'relinks' : 'does not relink'}`, async () => {
      const h = harness({ relink });

      await renumberWorkflowsCommand(h.app, h.host, h.sync);

      const md = await h.fs.read(README);
      expect(links(md)).toEqual([A, C_NEW]);
      expect(md).toContain('\n\n## Summary and Discussion\n\n요약 두 문장.\n');
      expect(await h.fs.exists(`${DIR}/${C_NEW}`)).toBe(true);
    });
  }

  it('renames each file once and writes the README only while the sync is held', async () => {
    const h = harness({ relink: false });

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(h.calls).toEqual([
      `flushNow ${DIR}`,
      `hold ${DIR}`,
      `rename ${C_OLD} -> ${C_NEW}`,
      'settle',
      'write',
      `release ${DIR} drop=true`,
      'notify Renumbered 1 workflow file(s).',
    ]);
  });

  // #88: no README means no checklist follows the new numbers.
  it('renames and says the experiment has no README', async () => {
    const h = harness({ relink: false });
    await h.fs.remove(README);

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(await h.fs.exists(`${DIR}/${C_NEW}`)).toBe(true);
    expect(await h.fs.exists(README)).toBe(false);
    expect(h.calls.at(-1)).toBe('notify Renumbered 1 workflow file(s). This experiment has no README.labnote.md.');
  });

  it('still records finished moves and releases the sync when a rename fails', async () => {
    const B_OLD = '004_WB030_B.labnote.md';
    const h = harness({ relink: false, failOn: '003_WB030_B.labnote.md' });
    await h.fs.write(`${DIR}/${B_OLD}`, 'b');
    await h.fs.write(
      README,
      README_BEFORE.replace(
        `- [ ] [WT020 C 형광 측정](./${C_OLD})`,
        `- [ ] [WT020 C 형광 측정](./${C_OLD})\n- [ ] [WB030 B](./${B_OLD})`
      )
    );
    await expect(renumberWorkflowsCommand(h.app, h.host, h.sync)).rejects.toThrow('rename failed');

    expect(links(await h.fs.read(README))).toEqual([A, C_NEW, B_OLD]);
    expect(h.calls.slice(-3)).toEqual(['settle', 'write', `release ${DIR} drop=true`]);
  });
});

// #289: the checklist, not the file numbers, decides the order.
describe('renumberWorkflowsCommand follows the checklist order (#289)', () => {
  it('numbers by the checklist and shows each rename before asking', async () => {
    const h = harness({ relink: false });
    await h.fs.write(
      README,
      README_BEFORE.replace(
        `- [ ] [WD070 A](./${A})\n- [ ] [WT020 C 형광 측정](./${C_OLD})`,
        `- [ ] [WT020 C 형광 측정](./${C_OLD}) 메모\n- [ ] 할 일\n- [ ] [WD070 A](./${A})`
      )
    );
    const asked: string[] = [];
    h.host.confirm = async (message: string) => {
      asked.push(message);
      return true;
    };

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(asked[0]).toContain('New numbers follow the order of the README checklist.');
    expect(asked[0]).toContain(`${C_OLD} → 001_WT020_C_형광_측정.labnote.md`);
    expect(asked[0]).toContain(`${A} → 002_WD070_A.labnote.md`);
    const md = await h.fs.read(README);
    expect(md).toContain(
      '- [ ] [WT020 C 형광 측정](./001_WT020_C_형광_측정.labnote.md) 메모\n- [ ] 할 일\n- [ ] [WD070 A](./002_WD070_A.labnote.md)'
    );
  });

  it('says the README has no section instead of calling the numbers sequential (#298)', async () => {
    const h = harness({ relink: false });
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(README, '# Test\n\n## Notes\n');

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(h.calls.at(-1)).toBe('notify README.labnote.md has no "Related Workflows" section.');
  });
});

// #56: a workflow file the checklist does not list (moved in from another
// experiment) is renumbered too, so it must be registered in the same run.
describe('renumberWorkflowsCommand with unlisted files (#56)', () => {
  const MOVED = '001_WT100_Moved.labnote.md';

  for (const relink of [false, true]) {
    it(`registers an unlisted file that takes 001 (${relink ? 'relinked' : 'not relinked'})`, async () => {
      const h = harness({ relink });
      await h.fs.write(`${DIR}/${MOVED}`, '---\ntitle: WT100 Moved\n---\n');

      await renumberWorkflowsCommand(h.app, h.host, h.sync);

      const after = await h.fs.list(DIR);
      expect(after.sort()).toEqual(
        ['001_WD070_A.labnote.md', '002_WT100_Moved.labnote.md', '003_WT020_C_형광_측정.labnote.md', 'README.labnote.md'].sort()
      );
      expect(links(await h.fs.read(README))).toEqual([
        '001_WD070_A.labnote.md',
        '002_WT100_Moved.labnote.md',
        '003_WT020_C_형광_측정.labnote.md',
      ]);
      expect(h.calls.at(-1)).toBe('notify Added 1 workflow file(s) to the README checklist.');
    });
  }

  it('registers unlisted files even when no file needs a new number', async () => {
    const h = harness({ relink: false });
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(`${DIR}/002_WT100_Moved.labnote.md`, 'x');
    await h.fs.write(README, README_BEFORE.replace(`- [ ] [WT020 C 형광 측정](./${C_OLD})\n`, ''));

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(links(await h.fs.read(README))).toEqual([A, '002_WT100_Moved.labnote.md']);
    expect(h.calls).not.toContain('notify Workflow numbering already follows the README checklist.');
    expect(h.calls.at(-1)).toBe('notify Added 1 workflow file(s) to the README checklist.');
  });
});

// #60: "Export tables to CSV" names files after the note, so they must follow it.
describe('renumberWorkflowsCommand with table CSVs (#60)', () => {
  const csv = (note: string, n: number) => note.replace(/\.md$/, `_table${n}.csv`);

  it('moves each note\'s CSVs with it', async () => {
    const h = harness({ relink: false });
    await h.fs.write(`${DIR}/${csv(C_OLD, 1)}`, 'x');
    await h.fs.write(`${DIR}/${csv(C_OLD, 2)}`, 'y');
    await h.fs.write(`${DIR}/${csv(A, 1)}`, 'a');

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect((await h.fs.list(DIR)).sort()).toEqual(
      [A, csv(A, 1), C_NEW, csv(C_NEW, 1), csv(C_NEW, 2), 'README.labnote.md'].sort()
    );
    expect(await h.fs.read(`${DIR}/${csv(C_NEW, 2)}`)).toBe('y');
  });

  it('follows a note through its staging name when two notes trade places', async () => {
    const h = harness({ relink: false });
    const B1 = '001_WB030_B.labnote.md';
    const D1 = '001_WD070_A.labnote.md';
    const D2 = '002_WD070_A.labnote.md';
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(`${DIR}/${B1}`, 'b');
    await h.fs.write(`${DIR}/${D2}`, 'second');
    await h.fs.write(`${DIR}/${csv(D1, 1)}`, 'first-csv');
    await h.fs.write(`${DIR}/${csv(D2, 1)}`, 'second-csv');

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(await h.fs.read(`${DIR}/${D2}`)).toBe('a');
    expect(await h.fs.read(`${DIR}/${csv(D2, 1)}`)).toBe('first-csv');
    expect(await h.fs.read(`${DIR}/003_WD070_A.labnote.md`)).toBe('second');
    expect(await h.fs.read(`${DIR}/${csv('003_WD070_A.labnote.md', 1)}`)).toBe('second-csv');
    expect((await h.fs.list(DIR)).some(n => n.includes('staging'))).toBe(false);
  });

  it('leaves a CSV whose new name is taken and says so', async () => {
    const h = harness({ relink: false });
    await h.fs.write(`${DIR}/${csv(C_OLD, 1)}`, 'mine');
    await h.fs.write(`${DIR}/${csv(C_NEW, 1)}`, 'stale');

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(await h.fs.read(`${DIR}/${csv(C_OLD, 1)}`)).toBe('mine');
    expect(await h.fs.read(`${DIR}/${csv(C_NEW, 1)}`)).toBe('stale');
    expect(await h.fs.exists(`${DIR}/${C_NEW}`)).toBe(true);
    expect(h.calls.at(-1)).toBe(
      'notify 1 table CSV file(s) kept their old name: the new name was taken or the rename failed.'
    );
  });

  it('keeps renumbering when a CSV rename fails', async () => {
    const h = harness({ relink: false, failOn: csv(C_NEW, 1) });
    await h.fs.write(`${DIR}/${csv(C_OLD, 1)}`, 'x');

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(await h.fs.exists(`${DIR}/${C_NEW}`)).toBe(true);
    expect(await h.fs.exists(`${DIR}/${csv(C_OLD, 1)}`)).toBe(true);
    expect(links(await h.fs.read(README))).toEqual([A, C_NEW]);
  });
});

describe('sample sources after renumbering (#149)', () => {
  it('hands the net renames to the registry once, after the README', async () => {
    const h = harness({ relink: false });
    const seen: Array<[string, Array<[string, string]>]> = [];
    await renumberWorkflowsCommand(h.app, h.host, h.sync, async (dir, renames) => {
      h.calls.push('samples');
      seen.push([dir, [...renames]]);
    });
    expect(seen).toEqual([[DIR, [[C_OLD, C_NEW]]]]);
    expect(h.calls.indexOf('samples')).toBeGreaterThan(h.calls.indexOf(`release ${DIR} drop=true`));
  });

  it('netRenames follows staging names to the final one and drops round trips', () => {
    expect([
      ...netRenames([
        { from: 'a', to: 'tmp' },
        { from: 'b', to: 'a' },
        { from: 'tmp', to: 'b' },
        { from: 'c', to: 'x' },
        { from: 'x', to: 'c' },
      ]),
    ]).toEqual([
      ['b', 'a'],
      ['a', 'b'],
    ]);
  });
});

// #381: an entry left on a file's old name, and a file the checklist then misses.
describe('renumberWorkflowsCommand and entries whose file is gone', () => {
  const OLD = '003_WB030_DNA_Assembly.labnote.md';
  const NOW = '002_WB030_DNA_Assembly.labnote.md';
  const readme = (entries: string[]): string =>
    ['# Test', '', '## 🗂️ Related Workflows', '', ...entries, '', '## Summary and Discussion', ''].join('\n');

  it('points the entry back at the file instead of listing the file again', async () => {
    const h = harness({ relink: false });
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(`${DIR}/${NOW}`, 'b');
    await h.fs.write(README, readme([`- [x] [WD070 A](./${A})`, `- [ ] [WB030 DNA Assembly](${OLD})`]));
    const asked: string[] = [];
    h.host.confirm = async (m: string) => (asked.push(m), true);

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(links(await h.fs.read(README))).toEqual([A, NOW]);
    expect(asked[0]).toContain(`${OLD} → ${NOW}`);
    expect(h.calls).toContain('notify Pointed 1 README checklist entry(ies) back at their file.');
  });

  it('names an entry no file matches instead of saying the numbers already follow', async () => {
    const h = harness({ relink: false });
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(README, readme([`- [ ] [WD070 A](./${A})`, `- [ ] [WB030 DNA Assembly](${OLD})`]));

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(h.calls.at(-1)).toContain(`notify The README checklist lists 1 file(s) that are not in the folder: ${OLD}.`);
  });
});

// #382: a listed note whose number was deleted from its name.
describe('renumberWorkflowsCommand and a note without a number', () => {
  it('gives it the number of its place in the checklist', async () => {
    const h = harness({ relink: false });
    const bare = C_OLD.replace(/^003_/, '');
    await h.fs.remove(`${DIR}/${C_OLD}`);
    await h.fs.write(`${DIR}/${bare}`, 'c');
    await h.fs.write(README, README_BEFORE.replace(`./${C_OLD}`, bare));
    const asked: string[] = [];
    h.host.confirm = async (m: string) => (asked.push(m), true);

    await renumberWorkflowsCommand(h.app, h.host, h.sync);

    expect(asked[0]).toContain(`${bare} → ${C_NEW} (name format fixed)`);
    expect(await h.fs.exists(`${DIR}/${C_NEW}`)).toBe(true);
    expect(links(await h.fs.read(README))).toEqual([A, C_NEW]);
  });
});
