/**
 * Two plugin writes to one open LF note at about the same time, with typing not saved yet.
 * The first write saves the typing first; that save is still writing when the second write
 * comes, so the second waits for it too: both changes and the typing end up in the file, and
 * each write says it was made. The view follows Obsidian 1.15.0's TextFileView (a save sets
 * what it saved before its write lands; a change to the file is read back when no save is
 * under way). The second write comes after `gap` ticks; the vault reads take `slow` ticks.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault, registerWorkflowInReadme } from '../../src/commands';

const P = 'labnote/001_Test/README.labnote.md';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const START = ['---', 'status: ongoing', 'last_updated_date: 2026-11-01', '---', '# Test', '', 'Notes.', '', '## Related Workflows', ''].join('\n');

async function run(kind: 'register' | 'id', gap: number, slow: number) {
  const disk = { text: START };
  const tf = new TFile(P);
  const reloads: Promise<void>[] = [];
  const view = new MarkdownView();
  let text = START.replace('Notes.', 'Notes. typed');
  const wait = async () => {
    for (let i = 0; i < slow; i++) await tick();
  };
  const vault = {
    getFileByPath: () => tf,
    getAbstractFileByPath: () => tf,
    read: async () => {
      await wait();
      return disk.text;
    },
    process: async (_f: TFile, fn: (data: string) => string) => {
      disk.text = fn(disk.text);
      onModify();
      return disk.text;
    },
  };
  const onModify = () => {
    if (view.savePromise !== null) return;
    reloads.push(
      (async () => {
        const read = await vault.read();
        const last = view.lastSavedData;
        view.lastSavedData = read;
        if (last === read) return;
        // Obsidian would merge typing made since by text; none is pending here.
        if (view.dirty && text !== read && text !== last) throw new Error('a merge was needed');
        view.data = read;
        text = read;
      })()
    );
  };
  // An edit in the editor leaves the view to be saved, as Obsidian's requestSave does.
  view.editor = {
    getValue: () => text,
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
      view.dirty = true;
    },
  };
  view.getViewData = () => text;
  // As Obsidian's save writes: the file changes a tick later, then the modify comes.
  view.writeData = async (_f: TFile, t: string) => {
    await tick();
    disk.text = t;
    onModify();
  };
  view.file = tf;
  view.loadText(START);
  view.dirty = true;
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => disk.text, write: async () => {} }, notify: () => {}, t: (s: string) => s } as unknown as LabnoteHost;

  const first =
    kind === 'id'
      ? processNoteThroughVault(app, host, P, c => c.replace('status: ongoing', 'status: ongoing\nlabnote_id: LN-7K3M9QX2'))
      : registerWorkflowInReadme(app, host, P, { title: 'WD020 N', fileName: '002_WD020_N.labnote.md' });
  for (let i = 0; i < gap; i++) await tick();
  const second = processNoteThroughVault(app, host, P, c => c.replace('# Test', '# Test retitled'));
  const results = [await first, await second];
  for (let i = 0; i < 6; i++) {
    await Promise.all(reloads);
    await tick();
  }
  if (view.dirty) await view.save();
  await Promise.all(reloads);
  return { results, file: disk.text };
}

const cases = (['register', 'id'] as const).flatMap(kind => [1, 2, 3].flatMap(slow => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(gap => [kind, gap, slow] as const)));

describe('two writes to an open note with unsaved typing', () => {
  it.each(cases)('%s, then a retitle %i ticks later (reads take %i): both in the file, with the typing', async (kind, gap, slow) => {
    const { results, file } = await run(kind, gap, slow);
    expect(results).toEqual([kind === 'id' ? true : 'registered', true]);
    expect(file).toContain(kind === 'id' ? 'labnote_id: LN-7K3M9QX2' : '002_WD020_N.labnote.md');
    expect(file).toContain('# Test retitled');
    expect(file).toContain('Notes. typed');
  });
});
