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
import { renumberWorkflowsCommand, type ReadmeSyncControl } from '../../src/commands';

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
    const h = harness({ relink: true });

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
    expect(h.calls).not.toContain('notify Workflow numbering is already sequential.');
    expect(h.calls.at(-1)).toBe('notify Added 1 workflow file(s) to the README checklist.');
  });
});
