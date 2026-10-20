/**
 * #216: in reading view a note's editor is hidden, and what is written to it is
 * never saved. The edit target reads the note's own text there, puts the
 * cursor at its end, and switches the view to editing before the first write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, Notice, TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createObsidianHost, isReadingViewTarget } from '../../src/obsidianHost';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';

/** A one-line editor whose positions are plain offsets. */
function fakeEditor(initial: string) {
  const editor = {
    text: initial,
    cursor: 0,
    getValue: () => editor.text,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    posToOffset: (pos: { ch: number }) => pos.ch,
    getCursor: () => ({ line: 0, ch: editor.cursor }),
    replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => {
      editor.text = editor.text.slice(0, from.ch) + text + editor.text.slice(to.ch);
    },
    replaceSelection: (text: string) => editor.replaceRange(text, { ch: editor.cursor }, { ch: editor.cursor }),
    setCursor: vi.fn(),
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
  };
  return editor;
}

const t = (key: string) => key;

function setup(opts: { mode: 'source' | 'preview'; data: string; editorText: string; reload?: string }) {
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
  view.mode = opts.mode;
  view.data = opts.data;
  const editor = fakeEditor(opts.editorText);
  view.editor = editor;
  const setState = vi.spyOn(view, 'setState').mockImplementation(async state => {
    if (state.mode) view.mode = state.mode;
    // Obsidian refills the editor from the note when it switches to editing.
    editor.text = opts.reload ?? view.data;
  });
  const app = {
    workspace: { getActiveViewOfType: () => view, getMostRecentLeaf: () => null },
  } as unknown as App;
  const host = createObsidianHost(app, new MemFileSystem(), t);
  return { view, editor, setState, host };
}

describe('editTarget in reading view (#216)', () => {
  beforeEach(() => Notice.reset());

  it('reads the note text and puts the cursor at its end, without switching', async () => {
    const { host, setState } = setup({ mode: 'preview', data: 'saved note\n', editorText: 'stale buffer' });
    const target = host.editTarget()!;

    expect(await target.getText()).toBe('saved note\n');
    expect(await target.getCursorOffset!()).toBe('saved note\n'.length);
    expect(isReadingViewTarget(target)).toBe(true);
    expect(setState).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
  });

  it('switches to editing once before the first write and writes into the reloaded editor', async () => {
    const { host, view, editor, setState } = setup({ mode: 'preview', data: 'A\nB\n', editorText: 'stale' });
    const first = host.editTarget()!;
    await first.insertAtCursor('C\n');

    expect(view.mode).toBe('source');
    expect(editor.text).toBe('A\nB\nC\n');

    const second = host.editTarget()!;
    expect(isReadingViewTarget(second)).toBe(false);
    await second.replaceRange(0, 1, 'Z');
    await first.revealOffset!(0);

    expect(editor.text).toBe('Z\nB\nC\n');
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls[0][0]).toMatchObject({ mode: 'source' });
    expect(Notice.shown).toEqual([
      'This note was in reading view, so it was switched to editing view to make the change.',
    ]);
  });

  it('refuses to write when the editor does not hold the text the command read', async () => {
    const { host, editor } = setup({ mode: 'preview', data: 'A\n', editorText: 'stale', reload: 'A\nchanged\n' });
    const target = host.editTarget()!;

    await expect(target.replaceRange(0, 0, 'X')).rejects.toThrow(
      'The note changed while switching to editing view. Run the command again.'
    );
    expect(editor.text).toBe('A\nchanged\n');
  });

  it('leaves editing view as it was', async () => {
    const { host, editor, setState } = setup({ mode: 'source', data: 'old', editorText: 'live text' });
    editor.cursor = 4;
    const target = host.editTarget()!;

    expect(await target.getText()).toBe('live text');
    expect(await target.getCursorOffset!()).toBe(4);
    await target.insertAtCursor('!');
    expect(editor.text).toBe('live! text');
    expect(setState).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
  });
});
