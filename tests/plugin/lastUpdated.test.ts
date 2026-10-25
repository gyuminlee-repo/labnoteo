/**
 * #42: plugin operations and AI writes stamp `last_updated_date`, and the
 * stamp reaches an open editor without rewriting the whole document.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost, PickItem } from '@labnoteo/core';
import { EXPERIMENT_STATUSES } from '@labnoteo/core';
import { touchLastUpdatedDate } from '@labnoteo/core/lib/dateUtils';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { changeExperimentStatusCommand, toggleDiscussionFlagCommand } from '../../src/commands';
import { stampNote, writeNoteStamped } from '../../src/lastUpdatedStamp';

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const WORKFLOW = `${DIR}/001_WD010_Design.labnote.md`;
const TODAY = '2026-10-13';
const stamp = (c: string) => touchLastUpdatedDate(c, TODAY);

const note = (extra = '') =>
  `---\nstatus: planned\ncreated_date: 2026-10-01\nlast_updated_date: 2026-10-01${extra}\n---\n\n# Body\n`;

/** No note is in the vault index, so writes fall back to the adapter (`fs`). */
function makeApp(leaves: MarkdownView[] = []) {
  const app = {
    workspace: {
      getActiveFile: () => new TFile(README),
      getLeavesOfType: () => leaves.map(view => ({ view })),
    },
    vault: { getFileByPath: () => null },
  };
  return app as unknown as App;
}

function makeHost(fs: MemFileSystem, picked?: string) {
  return {
    fs,
    t: (s: string) => s,
    notify: () => {},
    pick: async () => picked,
  } as unknown as LabnoteHost;
}

describe('plugin operations stamp last_updated_date', () => {
  it('changes status and the date together', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    await changeExperimentStatusCommand(makeApp(), makeHost(fs, 'in-progress'), stamp);
    const out = await fs.read(README);
    expect(out).toContain('status: in-progress');
    expect(out).toContain(`last_updated_date: ${TODAY}`);
  });

  it('stamps when toggling the discussion flag', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    await toggleDiscussionFlagCommand(makeApp(), makeHost(fs), stamp);
    expect(await fs.read(README)).toContain(`last_updated_date: ${TODAY}`);
  });

  // #108: the flag lives in the README, whichever experiment note it was run from.
  it('says which README it changed when run from a workflow note', async () => {
    const run = async (active: string): Promise<string> => {
      const fs = new MemFileSystem();
      await fs.write(README, note());
      const shown: string[] = [];
      const app = {
        workspace: { getActiveFile: () => new TFile(active), getLeavesOfType: () => [] },
        vault: { getFileByPath: () => null },
      } as unknown as App;
      const host = {
        fs,
        t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
        notify: (_kind: string, message: string) => shown.push(message),
      } as unknown as LabnoteHost;
      await toggleDiscussionFlagCommand(app, host, stamp);
      return shown.at(-1) ?? '';
    };
    expect(await run(WORKFLOW)).toMatch(/ Changed 001_Test's README, not this note\.$/);
    expect(await run(README)).not.toContain("README, not this note");
  });

  it('keeps the date with the default (setting off) stamp', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    await changeExperimentStatusCommand(makeApp(), makeHost(fs, 'in-progress'));
    expect(await fs.read(README)).toContain('last_updated_date: 2026-10-01');
  });
});

// #79: needs-review opens a review issue only through the automation.
describe('changing the status to needs-review', () => {
  async function notified(files: Record<string, string>, picked: string): Promise<string[]> {
    const fs = new MemFileSystem({ [README]: note(), ...files });
    const shown: string[] = [];
    const host = { ...makeHost(fs, picked), notify: (_: string, m: string) => shown.push(m) };
    await changeExperimentStatusCommand(makeApp(), host as unknown as LabnoteHost);
    return shown;
  }
  const WORKFLOW_YML = '.github/workflows/experiment-issues.yml';

  it('says to run the setup when the automation is not installed', async () => {
    expect(await notified({}, 'needs-review')).toEqual([
      'Experiment status changed ({0}): {1} → {2}. To open a review issue, run "Setup research automation" first.',
    ]);
  });

  it('says the vault is not a git repository yet', async () => {
    const [message] = await notified({ [WORKFLOW_YML]: '' }, 'needs-review');
    expect(message).toContain('so no review issue will open');
  });

  it('adds nothing when the automation is ready, or for another status', async () => {
    expect(await notified({ [WORKFLOW_YML]: '', '.git': '' }, 'needs-review')).toEqual([
      'Experiment status changed ({0}): {1} → {2}.',
    ]);
    expect(await notified({}, 'in-progress')).toEqual(['Experiment status changed ({0}): {1} → {2}.']);
  });
});

// #126: from a workflow note, Ctrl+Z cannot reach the README the command changed.
describe('the status-change notice', () => {
  async function shownFrom(active: string, dir?: string, readme = note()): Promise<string> {
    const fs = new MemFileSystem({ [README]: readme });
    const shown: string[] = [];
    const app = {
      workspace: { getActiveFile: () => new TFile(active), getLeavesOfType: () => [] },
      vault: { getFileByPath: () => null },
    } as unknown as App;
    const host = {
      fs,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      notify: (_kind: string, message: string) => shown.push(message),
      pick: async () => 'discontinued',
    } as unknown as LabnoteHost;
    await changeExperimentStatusCommand(app, host, undefined, dir);
    return shown.at(-1) ?? '';
  }

  it('shows the old and new status', async () => {
    expect(await shownFrom(README)).toBe('Experiment status changed (001_Test): planned → discontinued.');
  });

  it('names the README and how to undo when run from another note', async () => {
    expect(await shownFrom(WORKFLOW)).toBe(
      "Experiment status changed (001_Test): planned → discontinued. Changed 001_Test's README, not this note. " +
        'To undo, run "Change experiment status" again and pick planned.'
    );
  });

  it('says (none) and offers no undo for a README without a status', async () => {
    const shown = await shownFrom(WORKFLOW, undefined, '---\ncreated_date: 2026-10-01\n---\n\n# Body\n');
    expect(shown).toContain('(none) → discontinued');
    expect(shown).not.toContain('To undo');
  });

  it('changes the experiment it is handed, whatever note is active (#128)', async () => {
    expect(await shownFrom('labnote/002_Other/README.labnote.md', DIR)).toContain("Changed 001_Test's README");
  });

  // #141: the palette command would change the open experiment, not this one.
  it('points back to the workflow view when handed another experiment than the open one', async () => {
    const shown = await shownFrom('labnote/002_Other/README.labnote.md', DIR);
    expect(shown).toContain('To undo, right-click this experiment in the workflow view again and pick planned.');
    expect(await shownFrom(WORKFLOW, DIR)).toContain('To undo, run "Change experiment status" again');
  });

  // #141, #143
  it('names the experiment in the picker and flags a status outside the list', async () => {
    const fs = new MemFileSystem({ [README]: note().replace('status: planned', 'status: Failed') });
    let opts: { title?: string; placeholder?: string } = {};
    const host = {
      fs,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      notify: () => {},
      pick: async (_items: unknown, o: typeof opts) => {
        opts = o;
        return undefined;
      },
    } as unknown as LabnoteHost;
    await changeExperimentStatusCommand(makeApp(), host, undefined, DIR);
    expect(opts.title).toBe('Change experiment status: 001_Test');
    expect(opts.placeholder).toContain('"Failed" is not an allowed value');
  });

  // #249: the stored values are English, so the list has to say what they mean.
  it('explains every status and gives it search words', async () => {
    const fs = new MemFileSystem({ [README]: note() });
    let items: PickItem<string>[] = [];
    const host = {
      fs,
      t: (s: string) => s,
      notify: () => {},
      pick: async (list: PickItem<string>[]) => {
        items = list;
        return undefined;
      },
    } as unknown as LabnoteHost;
    await changeExperimentStatusCommand(makeApp(), host, undefined, DIR);

    expect(items.map(i => i.value)).toEqual([...EXPERIMENT_STATUSES]);
    for (const item of items) {
      expect(item.detail).toBeTruthy();
      expect(item.keywords?.length).toBeGreaterThan(0);
    }
    expect(items.find(i => i.value === 'needs-review')?.detail).toContain('GitHub issue');
    expect(items.find(i => i.value === 'needs-repeat')?.keywords).toContain('repeat');
  });
});

// #174: completed is what the automation drafts papers from.
describe('changing the status to completed', () => {
  const readme = (checklist: string) =>
    `${note()}\n## 🗂️ 관련 워크플로 (Related Workflows)\n\n${checklist}\n`;
  async function run(files: Record<string, string>, confirmed: boolean) {
    const fs = new MemFileSystem(files);
    const asked: string[] = [];
    const host = {
      ...makeHost(fs, 'completed'),
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      confirm: async (m: string) => {
        asked.push(m);
        return confirmed;
      },
    } as unknown as LabnoteHost;
    await changeExperimentStatusCommand(makeApp(), host);
    return { asked, out: await fs.read(README) };
  }
  const wf = (end: string) => `---\ntitle: X\nend_date: ${end}\n---\n`;

  it('asks when workflows are unchecked or have no end_date, and stops on no', async () => {
    const { asked, out } = await run(
      {
        [README]: readme('- [x] [WD010 A](./001_WD010_A.labnote.md)\n- [ ] [WD020 B](./002_WD020_B.labnote.md)'),
        [`${DIR}/001_WD010_A.labnote.md`]: wf("''"),
        [`${DIR}/002_WD020_B.labnote.md`]: wf('2026-10-10'),
      },
      false
    );
    expect(asked).toEqual([
      '1 workflow(s) in the checklist are not checked. 1 workflow note(s) have no end_date in their properties: 001_WD010_A.labnote.md. Mark the experiment completed anyway?',
    ]);
    expect(out).toContain('status: planned');
  });

  // #380: completed with the discussion flag on can turn the flag off too.
  it('clears the discussion flag when that is picked', async () => {
    const fs = new MemFileSystem({ [README]: note('\ndiscuss: true') });
    const picks = ['completed', 'clear'];
    const shown: string[] = [];
    const host = {
      fs,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      notify: (_k: string, m: string) => shown.push(m),
      pick: async () => picks.shift(),
    } as unknown as LabnoteHost;
    await changeExperimentStatusCommand(makeApp(), host);
    const out = await fs.read(README);
    expect(out).toContain('status: completed');
    expect(out).not.toContain('discuss');
    expect(shown[0]).toContain('Discussion flag cleared.');
  });

  it('goes ahead without asking when everything is done', async () => {
    const { asked, out } = await run(
      {
        [README]: readme('- [x] [WD010 A](./001_WD010_A.labnote.md)'),
        [`${DIR}/001_WD010_A.labnote.md`]: wf('2026-10-10'),
      },
      false
    );
    expect(asked).toEqual([]);
    expect(out).toContain('status: completed');
  });

  it('toggles the flag of the experiment it is handed, whatever note is active (#134)', async () => {
    const fs = new MemFileSystem({ [README]: note() });
    const shown: string[] = [];
    const app = {
      workspace: { getActiveFile: () => new TFile('labnote/002_Other/README.labnote.md'), getLeavesOfType: () => [] },
      vault: { getFileByPath: () => null },
    } as unknown as App;
    const host = {
      fs,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      notify: (_kind: string, message: string) => shown.push(message),
    } as unknown as LabnoteHost;

    await toggleDiscussionFlagCommand(app, host, stamp, DIR);

    const out = await fs.read(README);
    expect(out).toContain('discuss: true');
    expect(out).toContain(`last_updated_date: ${TODAY}`);
    expect(shown.at(-1)).toContain("Changed 001_Test's README");
  });

  // #379: markers keep the experiment under "Something to discuss".
  it('names the markers left when the flag is turned off', async () => {
    const fs = new MemFileSystem({
      [README]: note('\ndiscuss: true'),
      [`${DIR}/001_WB090_A.labnote.md`]: '---\ntitle: A\n---\n\n## Method\n- 37도 @issue;ISS-a;온도 확인\n',
    });
    const shown: string[] = [];
    const host = {
      fs,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
      notify: (_kind: string, message: string) => shown.push(message),
    } as unknown as LabnoteHost;
    await toggleDiscussionFlagCommand(makeApp(), host, stamp, DIR);
    expect(await fs.read(README)).not.toContain('discuss');
    expect(shown.at(-1)).toContain(
      '1 @issue marker(s) remain, so the experiment stays under "Something to discuss": 001_WB090_A.labnote.md:6.'
    );
  });
});

describe('writeNoteStamped (AI writes)', () => {
  it('stamps a workflow note and its experiment README', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    await writeNoteStamped(makeApp(), makeHost(fs), WORKFLOW, note('\n'), stamp);
    expect(await fs.read(WORKFLOW)).toContain(`last_updated_date: ${TODAY}`);
    expect(await fs.read(README)).toContain(`last_updated_date: ${TODAY}`);
  });

  it('writes other notes unchanged', async () => {
    const fs = new MemFileSystem();
    await writeNoteStamped(makeApp(), makeHost(fs), 'wiki/Home.md', note(), stamp);
    expect(await fs.read('wiki/Home.md')).toBe(note());
  });

  it('skips a missing README', async () => {
    const fs = new MemFileSystem();
    await writeNoteStamped(makeApp(), makeHost(fs), WORKFLOW, note(), stamp);
    expect(await fs.exists(README)).toBe(false);
  });
});

describe('stampNote', () => {
  function openView(path: string, text: string, mode: 'source' | 'preview' = 'source') {
    const edits: Array<{ text: string; from: number; to: number }> = [];
    const view = new MarkdownView();
    view.file = new TFile(path);
    view.mode = mode;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (t: string, from: number, to: number) => edits.push({ text: t, from, to }),
    };
    return { view, edits };
  }

  it('edits only the date span in an open editor', async () => {
    const fs = new MemFileSystem();
    const text = note();
    await fs.write(README, text);
    const { view, edits } = openView(README, text);

    await stampNote(makeApp([view]), makeHost(fs), README, stamp);

    expect(edits).toHaveLength(1);
    const { text: inserted, from, to } = edits[0];
    expect(text.slice(0, from) + inserted + text.slice(to)).toBe(stamp(text));
    expect(to - from).toBeLessThanOrEqual('2026-10-01'.length);
    expect(await fs.read(README)).toBe(text);
  });

  it('writes the file when the note is only open in reading mode', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    const { view, edits } = openView(README, note(), 'preview');

    await stampNote(makeApp([view]), makeHost(fs), README, stamp);

    expect(edits).toEqual([]);
    expect(await fs.read(README)).toContain(`last_updated_date: ${TODAY}`);
  });
});
