/**
 * #42: plugin operations and AI writes stamp `last_updated_date`, and the
 * stamp reaches an open editor without rewriting the whole document.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
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

  it('keeps the date with the default (setting off) stamp', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, note());
    await changeExperimentStatusCommand(makeApp(), makeHost(fs, 'in-progress'));
    expect(await fs.read(README)).toContain('last_updated_date: 2026-10-01');
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
