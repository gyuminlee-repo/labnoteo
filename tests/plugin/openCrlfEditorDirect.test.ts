/**
 * The direct note writes (an ID, the dates and title of a copy, the outline tidy) go through
 * processNote: into the editor a note is open in while its file has CRLF, through the vault
 * otherwise.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { processNote } from '../../src/openEditorWrite';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';

function setup(disk: string, open: boolean) {
  const state = { disk, editor: disk.replace(/\r\n/g, '\n'), processed: 0 };
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
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
});
