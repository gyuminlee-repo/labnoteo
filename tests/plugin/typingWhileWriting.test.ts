/**
 * A plugin write to an open note while the user keeps typing: a key goes into the editor on
 * every tick, through every await of the write. The view follows Obsidian 1.15.0's
 * TextFileView: typing asks for a save a moment later; a save writes what the editor holds;
 * a change to the file made while no save is under way is read back and, with typing not
 * saved yet, merged by text, where typed keys were lost (seen in Obsidian). The write goes
 * into the editor between two keys, so no such merge comes, and every key and the change are
 * in the file. LF and CRLF files; a whole note written (as the create_workflow tool writes the
 * README), a change applied, a direct note write and the last_updated_date stamp.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault, writeNoteThroughVault } from '../../src/commands';
import { processNote } from '../../src/openEditorWrite';
import { stampNote } from '../../src/lastUpdatedStamp';

const P = 'labnote/001_Test/README.labnote.md';
const ENTRY = '- [ ] [WD020 N](./002_WD020_N.labnote.md)';
const KEYS = 40;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
type Op = 'writeWhole' | 'process' | 'direct' | 'stamp';

async function run(nl: string, op: Op) {
  const start = ['---', 'status: ongoing', 'last_updated_date: 2026-11-01', '---', '# Test', '', '## Related Workflows', '', '## Notes', ''].join(nl);
  const disk = { text: start };
  const tf = new TFile(P);
  const view = new MarkdownView();
  let text = start.replace(/\r\n?/g, '\n');
  const merges: string[] = [];
  // Obsidian's requestSave: one save a moment after the first unsaved key.
  let pendingSave: ReturnType<typeof setTimeout> | undefined;
  const requestSave = () => {
    view.dirty = true;
    pendingSave ??= setTimeout(() => {
      pendingSave = undefined;
      void view.save();
    }, 5);
  };
  const editor = {
    getValue: () => text,
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
      requestSave();
    },
  };
  view.editor = editor;
  view.getViewData = () => text;
  const onModify = () => {
    if (view.savePromise !== null) return;
    void (async () => {
      await tick();
      const read = disk.text;
      const last = view.lastSavedData;
      view.lastSavedData = read;
      if (last === read) return;
      if (view.dirty && text !== read && text !== last) {
        // Obsidian merges by text here; typed keys were lost in that merge.
        merges.push(read);
        return;
      }
      view.data = read;
      text = read.replace(/\r\n?/g, '\n');
    })();
  };
  view.writeData = async (_f: TFile, t: string) => {
    await tick();
    disk.text = t;
    onModify();
  };
  view.file = tf;
  view.loadText(start);
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: () => tf,
      getAbstractFileByPath: () => tf,
      read: async () => {
        await tick();
        return disk.text;
      },
      process: async (_f: TFile, fn: (data: string) => string) => {
        disk.text = fn(disk.text);
        onModify();
        return disk.text;
      },
    },
  } as unknown as App;
  const host = {
    fs: {
      exists: async () => true,
      read: async () => {
        await tick();
        return disk.text;
      },
      write: async () => {},
    },
  } as unknown as LabnoteHost;

  // A key on every tick, at the end of the note.
  let typing = true;
  let typed = 0;
  const typist = (async () => {
    for (let i = 0; i < KEYS && typing; i++, typed++) {
      editor.replaceRange(`k${i} `, text.length, text.length);
      await tick();
    }
  })();
  for (let i = 0; i < 5; i++) await tick();
  const addEntry = (c: string) => c.replace('## Related Workflows' + (c.includes('\r') ? '\r\n' : '\n'), m => `${m}${ENTRY}${c.includes('\r') ? '\r\n' : '\n'}`);
  if (op === 'writeWhole') {
    // As the create_workflow tool: the README read, the entry added, the whole note written.
    const read = await host.fs.read(P);
    await writeNoteThroughVault(app, host, P, addEntry(read), read);
  } else if (op === 'process') {
    await processNoteThroughVault(app, host, P, addEntry);
  } else if (op === 'direct') {
    await processNote(app, tf as never, addEntry);
  } else {
    await stampNote(app, host, P, c => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10'));
  }
  // The keys went on while the write ran, and after it.
  const typedByThen = typed;
  await typist;
  typing = false;
  for (let i = 0; i < 20; i++) await tick();
  if (view.dirty) await view.save();
  for (let i = 0; i < 5; i++) await tick();
  return { file: disk.text, merges, typedByThen };
}

const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
const ops: Op[] = ['writeWhole', 'process', 'direct', 'stamp'];

describe('a plugin write to an open note while a key is typed on every tick', () => {
  it.each(endings.flatMap(([n, nl]) => ops.map(op => [op, n, nl] as const)))('%s (%s): every key and the change in the file, no merge', async (op, _n, nl) => {
    const { file, merges, typedByThen } = await run(nl, op);
    expect(typedByThen).toBeGreaterThan(5);
    expect(typedByThen).toBeLessThan(KEYS);
    expect(merges).toEqual([]);
    const keys = Array.from({ length: KEYS }, (_, i) => `k${i} `).join('');
    expect(file.replace(/\r\n?/g, '\n')).toContain(keys);
    if (op === 'stamp') expect(file).toContain('last_updated_date: 2026-11-10');
    else expect(file.split(ENTRY)).toHaveLength(2);
  });
});
