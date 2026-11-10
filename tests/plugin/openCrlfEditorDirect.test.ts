/**
 * The direct note writes (an ID, the dates and title of a copy, the outline tidy) go through
 * processNote: into the editor a note is open in while its file has CRLF, through the vault
 * otherwise.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { processInOpenCrlfEditor, processNote } from '../../src/openEditorWrite';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';

function setup(disk: string, open: boolean, save: 'writes' | 'fails' | 'writes nothing' = 'writes') {
  const state = { disk, editor: disk.replace(/\r\n/g, '\n'), processed: 0 };
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
  // Read as Obsidian reads it: the file's own text.
  view.lastSavedData = disk;
  // What the view holds is the editor's text, as Obsidian's getViewData gives it.
  view.getViewData = () => state.editor;
  // Saving writes the editor's text to the file, as Obsidian does; or fails, or (the view
  // closing) ends without writing.
  view.save = async () => {
    view.saved++;
    if (save === 'fails') throw new Error('save failed');
    if (save === 'writes') state.disk = state.editor;
  };
  view.editor = {
    getValue: () => state.editor,
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      state.editor = state.editor.slice(0, from) + text + state.editor.slice(to);
    },
  };
  const app = {
    workspace: { getLeavesOfType: () => (open ? [{ view }] : []) },
    vault: {
      read: async () => state.disk,
      process: async (_file: TFile, fn: (data: string) => string) => {
        state.processed++;
        state.disk = fn(state.disk);
        return state.disk;
      },
    },
  } as unknown as App;
  return { app, view, state };
}

describe('processNote', () => {
  it('applies the change in the editor and saves when the file has CRLF', async () => {
    const { app, view, state } = setup('---\r\ntitle: x\r\n---\r\nbody\r\n', true);
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.editor).toBe('---\ntitle: x\n---\ntext\n');
    expect(view.saved).toBe(1);
    expect(state.processed).toBe(0);
  });

  // The editor holds the change either way; the file gets it through the vault.
  it.each(['fails', 'writes nothing'] as const)('writes the change through the vault when the save %s', async save => {
    const { app, view, state } = setup('---\r\ntitle: x\r\n---\r\nbody\r\n', true, save);
    expect(await processInOpenCrlfEditor(app, new TFile(NOTE) as never, data => data.replace('body', 'text'))).toBe(true);
    expect(state.editor).toBe('---\ntitle: x\n---\ntext\n');
    expect(state.disk).toBe('---\r\ntitle: x\r\n---\r\ntext\r\n');
    expect(view.saved).toBe(1);
    expect(state.processed).toBe(1);
  });

  it.each([
    ['open with LF in its file', '---\ntitle: x\n---\nbody\n', true],
    ['not open', '---\r\ntitle: x\r\n---\r\nbody\r\n', false],
  ] as const)('writes through the vault when %s', async (_name, disk, open) => {
    const { app, view, state } = setup(disk, open);
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.disk).toBe(disk.replace('body', 'text'));
    expect(state.processed).toBe(1);
    expect(view.saved).toBe(0);
  });

  // Held as LF in the view, with nothing typed: no edit to save first, so the CRLF stays.
  it('does not save a view in reading mode first when only its line ends differ', async () => {
    const disk = '---\r\ntitle: x\r\n---\r\nbody\r\n';
    const { app, view, state } = setup(disk, true);
    view.mode = 'preview';
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.disk).toBe(disk.replace('body', 'text'));
    expect(view.saved).toBe(0);
  });

  // Typed and not saved yet: saved first, so the write is not saved over when the note is left.
  it('saves a view first when it holds unsaved typing', async () => {
    const { app, view, state } = setup('---\ntitle: x\n---\nbody\n', true);
    state.editor += 'typed\n';
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(view.saved).toBe(1);
    expect(state.disk).toBe('---\ntitle: x\n---\ntext\ntyped\n');
  });
});
