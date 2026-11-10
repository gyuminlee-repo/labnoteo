/**
 * A note open in an editor while its file has CRLF line ends: Obsidian holds it as LF in the
 * editor and saves that buffer over the file later, so a write made through the vault in
 * between is lost. Such a write goes into the editor and the note is saved; a note that is
 * not open, or open with LF in its file, is written through the vault as before.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { registerWorkflowInReadme, writeNoteThroughVault } from '../../src/commands';

const README = 'labnote/001_Test/README.labnote.md';
const ENTRY = '- [ ] [WD020 New](./002_WD020_New.labnote.md)';
const lines = ['---', 'status: ongoing', '---', '# Test', '', '## Notes', 'Keep notes.', '', '## Related Workflows', ''];

async function setup(nl: string, open: 'source' | 'preview' | 'closed') {
  const fs = new MemFileSystem();
  await fs.write(README, lines.join(nl));
  const processed: string[] = [];
  const editor = { text: lines.join('\n') };
  const view = new MarkdownView();
  view.file = new TFile(README);
  // Read as Obsidian reads it: the file's own text.
  view.lastSavedData = lines.join(nl);
  if (open !== 'closed') view.mode = open;
  view.editor = {
    getValue: () => editor.text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      editor.text = editor.text.slice(0, from) + text + editor.text.slice(to);
    },
  };
  // What the view holds is the editor's text, as Obsidian's getViewData gives it.
  view.getViewData = () => editor.text;
  // Saving writes the editor's text to the file, as Obsidian does.
  view.save = async () => {
    view.saved++;
    await fs.write(README, editor.text);
  };
  const app = {
    workspace: { getLeavesOfType: () => (open === 'closed' ? [] : [{ view }]) },
    vault: {
      getFileByPath: (path: string) => (path === README ? new TFile(README) : null),
      read: async () => fs.read(README),
      process: async (_file: TFile, fn: (data: string) => string) => {
        const next = fn(await fs.read(README));
        processed.push(next);
        await fs.write(README, next);
        return next;
      },
    },
  } as unknown as App;
  return { app, host: { fs } as unknown as LabnoteHost, fs, view, editor, processed };
}

describe('a write to a note open in an editor while its file has CRLF', () => {
  it('adds the new workflow entry in the editor and saves the README', async () => {
    const { app, host, view, editor, processed } = await setup('\r\n', 'source');
    expect(await registerWorkflowInReadme(app, host, README, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })).toBe('registered');
    expect(editor.text).toBe([...lines.slice(0, -1), '', ENTRY, ''].join('\n'));
    expect(view.saved).toBe(1);
    expect(processed).toEqual([]);
  });

  it('writes the whole note in the editor, as LF, and saves it', async () => {
    const { app, host, view, editor, processed } = await setup('\r\n', 'source');
    await writeNoteThroughVault(app, host, README, ['# New', 'text', ''].join('\r\n'));
    expect(editor.text).toBe('# New\ntext\n');
    expect(view.saved).toBe(1);
    expect(processed).toEqual([]);
  });

  // The rest is written through the vault as before, byte for byte.
  it.each([
    ['open with LF in its file', '\n', 'source'],
    ['not open, CRLF in its file', '\r\n', 'closed'],
    ['not open, LF in its file', '\n', 'closed'],
  ] as const)('writes through the vault when %s', async (_name, nl, open) => {
    const { app, host, fs, view, editor, processed } = await setup(nl, open);
    expect(await registerWorkflowInReadme(app, host, README, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })).toBe('registered');
    expect(await fs.read(README)).toBe([...lines.slice(0, -1), '', ENTRY, ''].join(nl));
    expect(processed).toHaveLength(1);
    expect(editor.text).toBe(lines.join('\n'));
    expect(view.saved).toBe(0);
  });
});
