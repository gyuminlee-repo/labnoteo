/**
 * A note ID written into an open note whose save keeps failing is kept by its editor alone. The
 * note's ID is then the editor's: asked again, the same ID comes back, not a new one that would
 * cut the note off from worksheets printed with the first. Before it is shown or printed, that
 * the disk does not carry it yet is said.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { NoteIdService } from '../../src/barcode/noteIdService';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const START = '---\ntitle: A\n---\n# A\n';
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

function harness() {
  let disk = START;
  let text = START;
  const state = { fails: true };
  const tf = new TFile(P);
  const view = new MarkdownView();
  view.file = tf;
  view.lastSavedData = START;
  view.editor = {
    getValue: () => text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (r: string, from: number, to: number) => {
      text = text.slice(0, from) + r + text.slice(to);
    },
  };
  view.getViewData = () => text;
  view.writeData = async (_f: TFile, data: string) => {
    if (state.fails) throw new Error('disk full');
    disk = data;
  };
  const notices: string[] = [];
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: () => tf,
      getAbstractFileByPath: () => tf,
      getMarkdownFiles: () => [],
      read: async () => disk,
      process: async (_f: TFile, fn: (s: string) => string) => (disk = fn(disk)),
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  const host = { notify: (level: string, msg: string) => notices.push(`${level} ${msg}`), t, confirm: async () => true } as unknown as LabnoteHost;
  return { service: new NoteIdService(app, host), tf, view, state, notices, disk: () => disk, text: () => text };
}

describe('a note ID kept by the editor of a note whose save keeps failing', () => {
  it('is the note ID asked again, not a new one', async () => {
    const h = harness();
    const first = await h.service.ensureId(h.tf as never);
    expect(first).toBeDefined();
    expect(readNoteId(h.text())).toBe(first);
    expect(readNoteId(h.disk())).toBeUndefined();
    expect(await h.service.ensureId(h.tf as never)).toBe(first);
    expect(readNoteId(h.text())).toBe(first);
  });

  it('is said before it is shown or printed while the disk lacks it, and not once the note is saved', async () => {
    const h = harness();
    const id = (await h.service.ensureId(h.tf as never))!;
    await h.service.warnIfIdNotOnDisk(h.tf as never, id);
    expect(h.notices).toEqual([
      `warn ${P} has the note ID ${id} only in its open editor: the note could not be saved yet. Save the note before printing, or a worksheet printed now may not find it.`,
    ]);
    h.state.fails = false;
    await h.view.save();
    expect(readNoteId(h.disk())).toBe(id);
    await h.service.warnIfIdNotOnDisk(h.tf as never, id);
    expect(h.notices).toHaveLength(1);
  });
});
