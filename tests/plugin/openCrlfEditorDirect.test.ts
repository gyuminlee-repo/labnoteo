/**
 * The direct note writes (an ID, the dates and title of a copy, the outline tidy) go through
 * processNote: into the editor a note is open in while its file has CRLF, through the vault
 * otherwise.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { overUnsaved, processInOpenEditor, processNote } from '../../src/openEditorWrite';

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
    expect(await processInOpenEditor(app, new TFile(NOTE) as never, data => data.replace('body', 'text'))).toBe(true);
    expect(state.editor).toBe('---\ntitle: x\n---\ntext\n');
    expect(state.disk).toBe('---\r\ntitle: x\r\n---\r\ntext\r\n');
    expect(view.saved).toBe(1);
    expect(state.processed).toBe(1);
  });

  it('applies the change in the editor and saves when the file has LF, to the same bytes', async () => {
    const disk = '---\ntitle: x\n---\nbody\n';
    const { app, view, state } = setup(disk, true);
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.disk).toBe(disk.replace('body', 'text'));
    expect(view.saved).toBe(1);
    expect(state.processed).toBe(0);
  });

  it.each([
    ['not open', '---\r\ntitle: x\r\n---\r\nbody\r\n', false],
  ] as const)('writes through the vault when %s', async (_name, disk, open) => {
    const { app, view, state } = setup(disk, open);
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.disk).toBe(disk.replace('body', 'text'));
    expect(state.processed).toBe(1);
    expect(view.saved).toBe(0);
  });

  // In reading mode no typing comes: written through the vault, the view not saved, the CRLF kept.
  it('writes a note open in reading mode through the vault, without saving its view', async () => {
    const disk = '---\r\ntitle: x\r\n---\r\nbody\r\n';
    const { app, view, state } = setup(disk, true);
    view.mode = 'preview';
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(state.disk).toBe(disk.replace('body', 'text'));
    expect(view.saved).toBe(0);
  });

  // Typed and not saved yet: the change goes in with it and the note is saved, typing and all.
  it('writes in the editor, with the unsaved typing, and saves once', async () => {
    const { app, view, state } = setup('---\ntitle: x\n---\nbody\n', true);
    state.editor += 'typed\n';
    await processNote(app, new TFile(NOTE) as never, data => data.replace('body', 'text'));
    expect(view.saved).toBe(1);
    expect(state.processed).toBe(0);
    expect(state.disk).toBe('---\ntitle: x\n---\ntext\ntyped\n');
  });
});

// A whole note made from `base`, over typing made since: kept where it does not touch the change.
describe('overUnsaved', () => {
  const base = 'a\nb\nc\n';
  it.each([
    ['typing after the change', 'a\nb\nc\ntyped\n', 'a\nB\nc\n', 'a\nB\nc\ntyped\n'],
    ['typing before the change', 'typed\na\nb\nc\n', 'a\nb\nC\n', 'typed\na\nb\nC\n'],
    ['no typing', base, 'a\nB\nc\n', 'a\nB\nc\n'],
    ['no change', 'a\nb\nc\ntyped\n', base, 'a\nb\nc\ntyped\n'],
    ['typing right after what the change rewrites', 'a\nbX\nc\n', 'a\nB\nc\n', 'a\nBX\nc\n'],
    ['typing in what the change rewrites: the content', 'a\nY\nc\n', 'a\nB\nc\n', 'a\nB\nc\n'],
  ] as const)('%s', (_name, text, content, expected) => {
    expect(overUnsaved(text, base, content)).toBe(expected);
  });

  it('without a base, the content', () => {
    expect(overUnsaved('anything', undefined, 'content')).toBe('content');
  });
});
