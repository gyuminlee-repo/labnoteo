/**
 * #52/#44: workflow files that reached an experiment folder some other way than
 * "Create workflow" (moved in, copied, renamed) must be registrable in the
 * README checklist, and entries whose file left the folder removable.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { parseWorkflowChecklistFromReadme } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import {
  addWorkflowFileToChecklist,
  syncWorkflowChecklistCommand,
  syncReadmeOrderOnRename,
  type ReadmeSyncControl,
} from '../../src/commands';

const DIR = 'labnote/002_Target';
const README = `${DIR}/README.labnote.md`;
const REGISTERED = '002_WD030_Design.labnote.md';
const MOVED_IN = '001_WT030_Seq_moved.labnote.md';

const readme = (entries: string[]) =>
  ['# Target', '', '## 🗂️ Related Workflows', '', ...entries, '', '## Summary', '', '요약.', ''].join('\n');

function harness(files: Record<string, string>, answer: boolean) {
  const fs = new MemFileSystem(files);
  const calls: string[] = [];
  const prompts: string[] = [];
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
  } as unknown as App;
  const host = {
    fs,
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    confirm: async (message: string) => {
      prompts.push(message);
      return answer;
    },
    notify: (_level: string, msg: string) => calls.push(`notify ${msg}`),
  } as unknown as LabnoteHost;
  const sync: ReadmeSyncControl = {
    flushNow: async dir => void calls.push(`flushNow ${dir}`),
    hold: () => undefined,
    settle: async () => undefined,
    release: async () => undefined,
  };
  return { fs, calls, prompts, app, host, sync };
}

const links = (md: string) => parseWorkflowChecklistFromReadme(md).map(i => `${i.title} -> ${i.fileName}`);

describe('syncWorkflowChecklistCommand', () => {
  it('registers a moved-in workflow under its front-matter title, in NNN order', async () => {
    const h = harness(
      {
        [README]: readme([`- [x] [WD030 Design](./${REGISTERED})`]),
        [`${DIR}/${REGISTERED}`]: '---\ntitle: WD030 Design\n---\n',
        [`${DIR}/${MOVED_IN}`]: "---\ntitle: 'WT030 Seq moved'\n---\n",
      },
      true
    );

    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);

    const md = await h.fs.read(README);
    expect(links(md)).toEqual([`WT030 Seq moved -> ${MOVED_IN}`, `WD030 Design -> ${REGISTERED}`]);
    expect(md).toContain('## Summary\n\n요약.');
    expect(h.prompts).toEqual([]);
    expect(h.calls).toEqual([`flushNow ${DIR}`, 'write', 'notify Workflow checklist updated: 1 added, 0 removed.']);
  });

  it('asks before removing entries whose file is not in the folder', async () => {
    const md0 = readme([
      `- [ ] [WD030 Design](./${REGISTERED})`,
      '- [ ] [Gone](./003_WD040_Gone.labnote.md)',
      '- [ ] [Moved](../003_Other/001_WT030_X.labnote.md)',
    ]);
    const files = { [README]: md0, [`${DIR}/${REGISTERED}`]: 'x' };

    const declined = harness(files, false);
    await syncWorkflowChecklistCommand(declined.app, declined.host, declined.sync, DIR);
    expect(await declined.fs.read(README)).toBe(md0);
    expect(declined.prompts[0]).toContain('- 003_WD040_Gone.labnote.md (file not found)');
    expect(declined.prompts[0]).toContain('- ../003_Other/001_WT030_X.labnote.md (in another folder)');
    expect(declined.calls.at(-1)).toBe('notify No changes made.');

    const accepted = harness(files, true);
    await syncWorkflowChecklistCommand(accepted.app, accepted.host, accepted.sync, DIR);
    expect(links(await accepted.fs.read(README))).toEqual([`WD030 Design -> ${REGISTERED}`]);
    expect(accepted.calls.at(-1)).toBe('notify Workflow checklist updated: 0 added, 2 removed.');
  });

  it('says so when the checklist already matches, without writing', async () => {
    const h = harness(
      { [README]: readme([`- [ ] [WD030 Design](./${REGISTERED})`]), [`${DIR}/${REGISTERED}`]: 'x' },
      true
    );
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    expect(h.calls).toEqual([`flushNow ${DIR}`, 'notify The workflow checklist already matches the folder.']);
  });

  it('adds a single renamed copy without touching other unlisted files (#44)', async () => {
    const COPY = '003_WD030_Design.labnote.md';
    const h = harness(
      {
        [README]: readme([`- [ ] [WD030 Design](./${REGISTERED})`]),
        [`${DIR}/${REGISTERED}`]: 'x',
        [`${DIR}/${MOVED_IN}`]: 'x',
        [`${DIR}/${COPY}`]: '---\ntitle: WD030 Design\n---\n',
      },
      true
    );
    expect(await addWorkflowFileToChecklist(h.app, h.host, DIR, COPY)).toBe(true);
    expect(links(await h.fs.read(README))).toEqual([
      `WD030 Design -> ${REGISTERED}`,
      `WD030 Design -> ${COPY}`,
    ]);
    expect(await addWorkflowFileToChecklist(h.app, h.host, DIR, COPY)).toBe(false);
  });

  // #68: a label left behind by a rename is fixed only after asking.
  describe('labels that no longer match their file', () => {
    const RENAMED = '002_WD030_Design_2차.labnote.md';
    const files = {
      [README]: readme([`- [ ] [WD030 Design](./${RENAMED})`]),
      [`${DIR}/${RENAMED}`]: '---\ntitle: WD030 Design\n---\n\n## [WD030 Design]\n',
    };

    it('asks, showing old and new label, and applies on yes', async () => {
      const h = harness(files, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts[0]).toContain('- WD030 Design → WD030 Design 2차');
      expect(links(await h.fs.read(README))).toEqual([`WD030 Design 2차 -> ${RENAMED}`]);
      expect(h.calls.at(-1)).toBe('notify Workflow checklist updated: 0 added, 0 removed. 1 label(s) updated.');
    });

    it('changes nothing on no', async () => {
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(await h.fs.read(README)).toBe(files[README]);
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });
  });

  it('relabels on rename only the labels that matched the old name (#68)', async () => {
    const OLD = '002_WD030_Design.labnote.md';
    const NEW = '002_WD030_Design_2차.labnote.md';
    const OTHER_OLD = '003_WT020_X.labnote.md';
    const OTHER_NEW = '003_WT020_X_v2.labnote.md';
    const h = harness(
      {
        [README]: readme([`- [ ] [WD030 Design](./${OLD})`, `- [ ] [내 라벨](./${OTHER_OLD})`]),
        [`${DIR}/${NEW}`]: '---\ntitle: WD030 Design\n---\n\n## [WD030 Design]\n',
        [`${DIR}/${OTHER_NEW}`]: 'x',
      },
      true
    );
    await syncReadmeOrderOnRename(h.app, h.host, DIR, [
      { from: OLD, to: NEW },
      { from: OTHER_OLD, to: OTHER_NEW },
    ]);
    expect(links(await h.fs.read(README))).toEqual([`WD030 Design 2차 -> ${NEW}`, `내 라벨 -> ${OTHER_NEW}`]);
  });

  it('warns when the README has no Related Workflows section', async () => {
    const h = harness({ [README]: '# Target\n', [`${DIR}/${REGISTERED}`]: 'x' }, true);
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    expect(await h.fs.read(README)).toBe('# Target\n');
    expect(h.calls.at(-1)).toBe('notify README.labnote.md has no "Related Workflows" section.');
  });
});
