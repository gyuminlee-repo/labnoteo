/**
 * A view that goes to another note while a write to its note waits: the other note's editor
 * and last saved text are not this note's, even when the two notes read alike, so the change
 * goes to the note asked for, through the vault, and the other note is left as it is.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { MemFileSystem, type LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault } from '../../src/commands';
import { openEditorText } from '../../src/openEditorWrite';

const A = 'labnote/001_Test/001_WD010_A.labnote.md';
const B = 'labnote/001_Test/002_WD020_B.labnote.md';
const SAME = 'same\n';

/** A view on A whose leaf goes to B while A is read (`switchOn` read of A). */
function switching(switchOn: number) {
  const fs = new MemFileSystem({ [A]: SAME, [B]: SAME });
  const files: Record<string, TFile> = { [A]: new TFile(A), [B]: new TFile(B) };
  const texts: Record<string, string> = { [A]: SAME, [B]: SAME };
  const view = new MarkdownView();
  view.file = files[A];
  view.lastSavedData = SAME;
  const at = () => view.file!.path;
  view.editor = {
    getValue: () => texts[at()],
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      texts[at()] = texts[at()].slice(0, from) + text + texts[at()].slice(to);
    },
  };
  view.getViewData = () => texts[at()];
  view.writeData = async (f: TFile, text: string) => fs.write(f.path, text);
  let reads = 0;
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: (p: string) => files[p] ?? null,
      read: async (f: TFile) => {
        const text = await fs.read(f.path);
        if (f.path === A && ++reads === switchOn) {
          // The leaf opens B, which reads as A did.
          view.file = files[B];
          view.lastSavedData = SAME;
        }
        return text;
      },
      process: async (f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(f.path));
        await fs.write(f.path, next);
        return next;
      },
    },
  } as unknown as App;
  const host = { fs, notify: () => undefined, t: (s: string) => s } as unknown as LabnoteHost;
  return { app, host, fs, texts };
}

describe('a view that goes to another note, alike, while the write waits', () => {
  const add = (c: string) => `${c}ADDED\n`;

  it('changes the note asked for, not the one the view went to', async () => {
    const { app, host, fs, texts } = switching(1);
    expect(await processNoteThroughVault(app, host, A, add, true)).toBe(true);
    expect(await fs.read(A)).toBe(`${SAME}ADDED\n`);
    expect(await fs.read(B)).toBe(SAME);
    expect(texts[B]).toBe(SAME);
  });

  it('reads the note asked for from the file, not the editor of the one the view went to', async () => {
    const { app, texts } = switching(1);
    texts[B] = 'typed in B\n';
    expect(await openEditorText(app, A)).toBeUndefined();
  });
});

describe('a view that saves the note and goes to another as it does', () => {
  // What the save wrote is not known from the view gone to B (its editor B's now): the change
  // may or may not be in it, here it is.
  it('says the change may or may not be there, typing the save took in and all', async () => {
    const { app, host, fs, texts } = switching(0);
    const view = (app.workspace as unknown as { getLeavesOfType(): { view: MarkdownView }[] }).getLeavesOfType()[0].view;
    view.save = async () => {
      // Typed as the save starts, written, and the leaf opens B.
      texts[A] = `typed\n${texts[A]}`;
      await fs.write(A, texts[A]);
      view.lastSavedData = texts[A];
      view.file = new TFile(B);
    };
    expect(await processNoteThroughVault(app, host, A, c => `${c}ADDED\n`, true)).toBe('uncertain');
    expect(await fs.read(A)).toBe(`typed\n${SAME}ADDED\n`);
    expect(await fs.read(B)).toBe(SAME);
  });
});

