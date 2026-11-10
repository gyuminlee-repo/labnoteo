/**
 * A view that has the CRLF note's file but has not read it yet holds an empty editor, and its
 * save writes nothing. A change then goes to the file through the vault, as for a closed note:
 * the note keeps its text. An editor with text typed and not saved yet is loaded: the change
 * goes into it, and the typed text stays too.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault, registerWorkflowInReadme } from '../../src/commands';
import { NoteIdService } from '../../src/barcode/noteIdService';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const BODY = 'Important body text.';
const note = ['---', 'title: A', 'last_updated_date: 2026-01-01', '---', '# A', '', BODY, ''].join('\r\n');

function setup(disk: string, editorText: string, data: string | null) {
  const state = { disk, editor: editorText };
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
  (view as unknown as { data: string | null }).data = data;
  view.editor = {
    getValue: () => state.editor,
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      state.editor = state.editor.slice(0, from) + text + state.editor.slice(to);
    },
  };
  // A loading view's save writes nothing; a loaded one writes the editor's text.
  view.save = async () => {
    view.saved++;
    if (data !== null && state.editor !== '') state.disk = state.editor;
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    metadataCache: { getFileCache: () => null },
    vault: {
      getFileByPath: () => new TFile(NOTE),
      getAbstractFileByPath: () => new TFile(NOTE),
      getMarkdownFiles: () => [],
      read: async () => state.disk,
      process: async (_file: TFile, fn: (data: string) => string) => (state.disk = fn(state.disk)),
    },
  } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => state.disk, write: async () => {} }, notify: () => {}, t: (s: string) => s } as unknown as LabnoteHost;
  return { app, host, state, view };
}

describe('a write to a CRLF note whose view is still loading it', () => {
  // Its `data` is null until read, or (a view without that) its editor is empty.
  describe.each([
    ['data not read yet', null],
    ['an empty editor', ''],
  ] as const)('%s', (_name, data) => {
    it('changes a front matter key and keeps the text', async () => {
      const { app, host, state } = setup(note, '', data);
      expect(await processNoteThroughVault(app, host, NOTE, c => c.replace('title: A', 'title: B'))).toBe(true);
      expect(state.disk).toBe(note.replace('title: A', 'title: B'));
    });
    it('adds a front matter line and keeps the text', async () => {
      const { app, host, state } = setup(note, '', data);
      expect(await processNoteThroughVault(app, host, NOTE, c => c.replace(/^---(\r?\n)/, '---$1title2: B$1'))).toBe(true);
      expect(state.disk).toContain('title2: B');
      expect(state.disk).toContain(BODY);
    });
    it('gives a new note ID and keeps the text', async () => {
      const { app, host, state } = setup(note, '', data);
      const id = await new NoteIdService(app, host).ensureId(new TFile(NOTE) as never, { reassign: true });
      expect(id).toMatch(/^LN-[0-9A-Z]{8}$/);
      expect(readNoteId(state.disk)).toBe(id);
      expect(state.disk).toContain(BODY);
    });
  });
});

describe('a write to an open CRLF README with text typed and not saved yet', () => {
  it('adds the workflow entry and keeps the typed text', async () => {
    const readme = ['---', 'status: ongoing', '---', '# Test', '', '## Related Workflows', ''].join('\r\n');
    const typed = readme.replace(/\r\n/g, '\n').replace('# Test\n', '# Test\nTyped, not saved.\n');
    const { app, host, state, view } = setup(readme, typed, typed);
    expect(await registerWorkflowInReadme(app, host, NOTE, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })).toBe('registered');
    expect(view.saved).toBe(1);
    expect(state.disk).toContain('Typed, not saved.');
    expect(state.disk).toContain('- [ ] [WD020 New](./002_WD020_New.labnote.md)');
  });
});
