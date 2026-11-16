/**
 * The last_updated_date stamp of an open README, typed in, and a plugin write to it (a new
 * workflow entry) in the same moments. The view follows Obsidian 1.15.0's TextFileView: a save
 * writes what the editor holds when it differs from what was last read or saved; a change to
 * the file is read back a moment later, when no save is under way; leaving the note saves it.
 *   - The stamp went into the editor and is not saved yet when the entry is written, and the
 *     note is left before Obsidian reads the entry back (the workflow note opens in its place).
 *   - The stamp is due just after the entry is written, before Obsidian reads it back.
 * Either way the entry, the typed text and the date are in the file once.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { registerWorkflowInReadme } from '../../src/commands';
import { stampNote } from '../../src/lastUpdatedStamp';

const P = 'labnote/001_Test/README.labnote.md';
const TYPED = 'Typed line.';
const ENTRY = '- [ ] [WD020 New](./002_WD020_New.labnote.md)';
const TODAY = 'last_updated_date: 2026-11-10';
const stamp = (content: string) => content.replace(/last_updated_date: .*/, TODAY);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(nl: string) {
  const start = ['---', 'status: ongoing', 'last_updated_date: 2026-11-01', '---', '# Test', '', '## Related Workflows', ''].join(nl);
  const disk = { text: start };
  const tf = new TFile(P);
  const view = new MarkdownView();
  let text = '';
  // An edit in the editor leaves the view to be saved, as Obsidian's requestSave does.
  view.editor = {
    getValue: () => text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
      view.dirty = true;
    },
  };
  view.getViewData = () => text;
  // A change to the file is read back a moment later, unless a save of the view is under way.
  let reload: Promise<void> = Promise.resolve();
  const onModify = () => {
    if (view.savePromise !== null) return;
    reload = (async () => {
      await tick();
      if (!view.file) return;
      const read = disk.text;
      const last = view.lastSavedData;
      view.lastSavedData = read;
      if (last === read) return;
      // Obsidian merges what was typed since by text; none is pending in these orders.
      if (view.dirty && text !== last) throw new Error('merged an editor edit made while the file was changing');
      view.data = read;
      text = read.replace(/\r\n?/g, '\n');
    })();
  };
  view.writeData = async (_f: TFile, t: string) => {
    disk.text = t;
    onModify();
  };
  view.file = tf;
  view.loadText(start);
  text = start.replace(/\r\n?/g, '\n');
  const app = {
    workspace: { getLeavesOfType: () => (view.file ? [{ view }] : []) },
    vault: {
      getFileByPath: () => tf,
      getAbstractFileByPath: () => tf,
      read: async () => disk.text,
      process: async (_f: TFile, fn: (data: string) => string) => {
        disk.text = fn(disk.text);
        onModify();
        return disk.text;
      },
    },
  } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => disk.text, write: async () => {} }, notify: () => {}, t: (s: string) => s } as unknown as LabnoteHost;
  return {
    app,
    host,
    view,
    disk,
    reload: () => reload,
    /** Typed, then saved by Obsidian two seconds later. */
    async type() {
      text = text.replace('# Test\n', `# Test\n${TYPED}\n`);
      view.dirty = true;
      await view.save();
      await reload;
    },
    /** Leave the note: Obsidian saves it and closes the view. */
    async leave() {
      await view.save(true);
      view.file = null;
    },
  };
}

const register = (s: ReturnType<typeof setup>) =>
  registerWorkflowInReadme(s.app, s.host, P, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' }, stamp);

const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;

describe('the stamp of an open README and a write to it, typed in', () => {
  it.each(endings)('the stamp unsaved in the editor, the note left before the entry is read back (%s)', async (_n, nl) => {
    const s = setup(nl);
    await s.type();
    await stampNote(s.app, s.host, P, stamp);
    expect(await register(s)).toBe('registered');
    await s.leave();
    await s.reload();
    expect(s.disk.text.split(ENTRY)).toHaveLength(2);
    expect(s.disk.text).toContain(TYPED);
    expect(s.disk.text.split(TODAY)).toHaveLength(2);
  });

  it.each(endings)('the stamp due before the entry is read back (%s)', async (_n, nl) => {
    const s = setup(nl);
    await s.type();
    const write = register(s);
    // Due as the entry lands: once the write is on the file, before the read back.
    const stamped = (async () => {
      while (!s.disk.text.includes(ENTRY)) await new Promise(resolve => setImmediate(resolve));
      await stampNote(s.app, s.host, P, stamp);
    })();
    expect(await write).toBe('registered');
    await stamped;
    await s.reload();
    await s.leave();
    await s.reload();
    expect(s.disk.text.split(ENTRY)).toHaveLength(2);
    expect(s.disk.text).toContain(TYPED);
    expect(s.disk.text.split(TODAY)).toHaveLength(2);
  });
});
