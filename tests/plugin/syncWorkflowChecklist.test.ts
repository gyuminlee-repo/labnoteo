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
  retitleWorkflowAfterRename,
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
    fileManager: {
      renameFile: async (file: TFile, newPath: string) => {
        calls.push(`rename ${file.path} -> ${newPath}`);
        await fs.write(newPath, await fs.read(file.path));
        await fs.remove(file.path);
      },
    },
    vault: {
      getFiles: () => Object.keys(fs.snapshot()).map(p => new TFile(p)),
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

  it('shortens a vault-absolute link to this folder, keeping its checkbox and label (#102)', async () => {
    const h = harness(
      {
        [README]: readme([`- [x] [WD030 Design](./${DIR}/${REGISTERED})`]),
        [`${DIR}/${REGISTERED}`]: '---\ntitle: WD030 Design\n---\n',
      },
      true
    );
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    const md = await h.fs.read(README);
    expect(md).toContain(`- [x] [WD030 Design](./${REGISTERED})`);
    expect(links(md)).toEqual([`WD030 Design -> ${REGISTERED}`]);
    expect(h.prompts).toEqual([]);
    expect(h.calls.at(-1)).toBe(
      'notify Workflow checklist updated: 0 added, 0 removed. 1 checklist link(s) fixed.'
    );
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

    // The note's own title is stale too (#71): it is fixed first, then the
    // label is planned from the new title.
    it('asks, showing old and new label, and applies on yes', async () => {
      const h = harness(files, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts[0]).toContain("These notes' title and heading do not match their file names.");
      expect(h.prompts[0]).toContain('- WD030 Design → WD030 Design 2차');
      expect(h.prompts[1]).toContain('These checklist labels do not match their file names.');
      expect(h.prompts[1]).toContain('- WD030 Design → WD030 Design 2차');
      expect(await h.fs.read(`${DIR}/${RENAMED}`)).toBe('---\ntitle: WD030 Design 2차\n---\n\n## [WD030 Design] 2차\n');
      expect(links(await h.fs.read(README))).toEqual([`WD030 Design 2차 -> ${RENAMED}`]);
      expect(h.calls.at(-1)).toBe(
        'notify Workflow checklist updated: 0 added, 0 removed. 1 note(s) updated. 1 label(s) updated.'
      );
    });

    it('changes nothing on no', async () => {
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(await h.fs.read(README)).toBe(files[README]);
      expect(await h.fs.read(`${DIR}/${RENAMED}`)).toBe(files[`${DIR}/${RENAMED}`]);
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });
  });

  // #71: a note renamed while 0.92.0 only moved its label.
  describe('notes whose title no longer matches their file', () => {
    const RENAMED = '002_WD030_Design_2차.labnote.md';
    const NOTE = '---\ntitle: WD030 Design\n---\n\n## [WD030 Design]\n';
    const files = {
      [README]: readme([`- [ ] [WD030 Design 2차](./${RENAMED})`]),
      [`${DIR}/${RENAMED}`]: NOTE,
    };

    it('asks, then fixes the title and heading without touching the label', async () => {
      const h = harness(files, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toContain('- WD030 Design → WD030 Design 2차');
      expect(await h.fs.read(`${DIR}/${RENAMED}`)).toBe('---\ntitle: WD030 Design 2차\n---\n\n## [WD030 Design] 2차\n');
      expect(await h.fs.read(README)).toBe(files[README]);
      expect(h.calls.at(-1)).toBe('notify Workflow checklist updated: 0 added, 0 removed. 1 note(s) updated.');
    });

    it('changes nothing on no', async () => {
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(await h.fs.read(`${DIR}/${RENAMED}`)).toBe(NOTE);
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });
  });

  // #83: the README author changed after the notes took it as their experimenter.
  describe('notes whose experimenter differs from the README author', () => {
    const NOTE =
      "---\ntitle: WD030 Design\nexperimenter: 홍길동\n---\n\n## [WD030 Design]\n\n- Experimenter: 홍길동\n- Experimenter: 김철수\n";
    const files = {
      [README]: `---\nauthor: 이영희\n---\n\n${readme([`- [ ] [WD030 Design](./${REGISTERED})`])}`,
      [`${DIR}/${REGISTERED}`]: NOTE,
    };

    it('asks with old and new name, then updates the note', async () => {
      const h = harness(files, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toContain("These notes' experimenter differs from the README author.");
      expect(h.prompts[0]).toContain(`- ${REGISTERED}: 홍길동 → 이영희`);
      expect(await h.fs.read(`${DIR}/${REGISTERED}`)).toBe(
        '---\ntitle: WD030 Design\nexperimenter: 이영희\n---\n\n## [WD030 Design]\n\n- Experimenter: 이영희\n- Experimenter: 김철수\n'
      );
      expect(h.calls.at(-1)).toBe('notify Workflow checklist updated: 0 added, 0 removed. 1 note(s) updated.');
    });

    it('changes nothing on no', async () => {
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(await h.fs.read(`${DIR}/${REGISTERED}`)).toBe(NOTE);
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });
  });

  describe('retitleWorkflowAfterRename (#71)', () => {
    const OLD = '002_WD030_Design_1차.labnote.md';
    const NEW = '002_WD030_Design_2차.labnote.md';

    it('gives the note the new alias when its title matched the old name', async () => {
      const h = harness({ [`${DIR}/${NEW}`]: '---\ntitle: WD030 Design 1차\n---\n\n## [WD030 Design] 1차\n' }, true);
      expect(await retitleWorkflowAfterRename(h.app, h.host, DIR, OLD, NEW)).toBe(true);
      expect(await h.fs.read(`${DIR}/${NEW}`)).toBe('---\ntitle: WD030 Design 2차\n---\n\n## [WD030 Design] 2차\n');
    });

    // #268: the ID was changed in the file name and "Rename back" declined.
    it('follows the next alias change after a file ID change that was kept', async () => {
      const kept = '002_WD040_Design_1차.labnote.md';
      const h = harness({ [`${DIR}/${NEW}`]: '---\ntitle: WD030 Design 1차\n---\n\n## [WD030 Design] 1차\n' }, true);
      expect(await retitleWorkflowAfterRename(h.app, h.host, DIR, kept, NEW)).toBe(true);
      expect(await h.fs.read(`${DIR}/${NEW}`)).toBe('---\ntitle: WD030 Design 2차\n---\n\n## [WD030 Design] 2차\n');
    });

    it('keeps a title edited by hand, and skips a note that is gone', async () => {
      const own = '---\ntitle: 내 워크플로\n---\n\n## [WD030 Design] 1차\n';
      const h = harness({ [`${DIR}/${NEW}`]: own }, true);
      expect(await retitleWorkflowAfterRename(h.app, h.host, DIR, OLD, NEW)).toBe(false);
      expect(await h.fs.read(`${DIR}/${NEW}`)).toBe(own);
      expect(await retitleWorkflowAfterRename(h.app, h.host, DIR, NEW, '003_WD030_Design_3차.labnote.md')).toBe(false);
      expect(h.calls).toEqual([]);
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

  // #94: a workflow note dragged into a subfolder of its experiment.
  describe('a workflow note in a subfolder', () => {
    const NOTE = '003_WD040_Assay.labnote.md';
    const base = (link: string) => ({
      [README]: readme([`- [ ] [WD030 Design](./${REGISTERED})`, `- [x] [WD040 Assay](${link})`]),
      [`${DIR}/${REGISTERED}`]: '---\ntitle: WD030 Design\n---\n',
      [`${DIR}/images/${NOTE}`]: '---\ntitle: WD040 Assay\n---\n',
    });

    it('asks to move it back instead of removing its entry (name-only link)', async () => {
      const h = harness(base(NOTE), true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toContain('These workflow notes are in a subfolder of this experiment.');
      expect(h.prompts[0]).toContain(`- ${NOTE} (images/)`);
      expect(h.calls).toContain(`rename ${DIR}/images/${NOTE} -> ${DIR}/${NOTE}`);
      expect(await h.fs.exists(`${DIR}/${NOTE}`)).toBe(true);
      expect(links(await h.fs.read(README))).toEqual([`WD030 Design -> ${REGISTERED}`, `WD040 Assay -> ${NOTE}`]);
      expect(h.calls.at(-1)).toBe(
        'notify Workflow checklist updated: 0 added, 0 removed. 1 note(s) moved back to the experiment folder.'
      );
    });

    it('points a subfolder link back at the experiment folder, keeping the check', async () => {
      const h = harness(base(`images/${NOTE}`), true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(await h.fs.read(README)).toContain(`- [x] [WD040 Assay](./${NOTE})`);
      expect(parseWorkflowChecklistFromReadme(await h.fs.read(README))).toHaveLength(2);
    });

    it('keeps the note and its entry when declined, and does not offer to remove it', async () => {
      const files = base(`images/${NOTE}`);
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(await h.fs.read(README)).toBe(files[README]);
      expect(await h.fs.exists(`${DIR}/images/${NOTE}`)).toBe(true);
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });

    it('does not move over a file of the same name in the experiment folder', async () => {
      const h = harness({ ...base(`images/${NOTE}`), [`${DIR}/${NOTE}`]: 'other' }, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(await h.fs.read(`${DIR}/${NOTE}`)).toBe('other');
      expect(await h.fs.exists(`${DIR}/images/${NOTE}`)).toBe(true);
      expect(h.calls).toContain(
        `notify images/${NOTE} was not moved: the experiment folder already has a file with that name.`
      );
    });

    it('only points at notes found in more than one subfolder', async () => {
      const h = harness({ ...base(NOTE), [`${DIR}/resources/${NOTE}`]: 'copy' }, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toEqual([]);
      expect(h.calls).toContain(
        `notify These workflow notes are in more than one subfolder of this experiment. Move the right one back to the experiment folder yourself: ${NOTE} (images/${NOTE}, resources/${NOTE})`
      );
      expect(h.calls.at(-1)).toBe('notify No changes made.');
    });
  });

  // #95: before 0.96.0 a bracketed alias broke the line, and each sync added it again.
  describe('a README broken by a bracketed alias', () => {
    const LOC = '004_WD010_Design_LOC-01.labnote.md';
    const label = 'WD010 Design LOC-01]';
    const files = {
      [README]: readme([
        `- [ ] [WD030 Design](./${REGISTERED})`,
        `- [x] [${label}](./${LOC})`,
        `- [ ] [${label}](./${LOC})`,
        `- [ ] [${label}](./${LOC})`,
      ]),
      [`${DIR}/${REGISTERED}`]: '---\ntitle: WD030 Design\n---\n',
      [`${DIR}/${LOC}`]: `---\ntitle: '${label}'\n---\n`,
    };

    it('asks to remove the duplicates and fixes the link text', async () => {
      const h = harness(files, true);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toContain('These workflow files are listed more than once in the checklist.');
      expect(h.prompts[0]).toContain(`- ${LOC}`);
      const md = await h.fs.read(README);
      expect(md).toBe(
        readme([`- [ ] [WD030 Design](./${REGISTERED})`, `- [x] [WD010 Design LOC-01\\]](./${LOC})`])
      );
      expect(h.calls.at(-1)).toBe(
        'notify Workflow checklist updated: 0 added, 0 removed. 2 duplicate entry(ies) removed. 3 checklist link(s) fixed.'
      );

      const again = harness({ ...files, [README]: md }, true);
      await syncWorkflowChecklistCommand(again.app, again.host, again.sync, DIR);
      expect(again.calls.at(-1)).toBe('notify The workflow checklist already matches the folder.');
    });

    it('still fixes the link text when the duplicates are kept', async () => {
      const h = harness(files, false);
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      expect(links(await h.fs.read(README))).toEqual([
        `WD030 Design -> ${REGISTERED}`,
        `${label} -> ${LOC}`,
        `${label} -> ${LOC}`,
        `${label} -> ${LOC}`,
      ]);
      expect(await h.fs.read(README)).not.toContain(`[${label}](`);
      expect(h.calls.at(-1)).toBe('notify Workflow checklist updated: 0 added, 0 removed. 3 checklist link(s) fixed.');
    });
  });

  it('warns when the README has no Related Workflows section', async () => {
    const h = harness({ [README]: '# Target\n', [`${DIR}/${REGISTERED}`]: 'x' }, true);
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    expect(await h.fs.read(README)).toBe('# Target\n');
    expect(h.calls.at(-1)).toBe('notify README.labnote.md has no "Related Workflows" section.');
  });
});
