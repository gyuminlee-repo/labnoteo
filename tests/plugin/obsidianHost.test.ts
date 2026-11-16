/**
 * #216: in reading view a note's editor is hidden, and what is written to it is
 * never saved. The edit target reads the note's own text there, puts the
 * cursor at its end, and switches the view to editing before the first write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, Notice, TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createObsidianHost, isReadingViewTarget, tableCellEditorOf } from '../../src/obsidianHost';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';

/** A one-line editor whose positions are plain offsets. */
function fakeEditor(initial: string) {
  const editor = {
    text: initial,
    cursor: 0,
    selectionEnd: undefined as number | undefined,
    getValue: () => editor.text,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    posToOffset: (pos: { ch: number }) => pos.ch,
    getCursor: (which?: 'from' | 'to') => ({ line: 0, ch: which === 'to' ? editor.selectionEnd ?? editor.cursor : editor.cursor }),
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

  // #302
  it('gives the selection in editing view only', async () => {
    const { host, editor } = setup({ mode: 'source', data: 'old', editorText: 'live text' });
    const target = host.editTarget()!;
    expect(await target.getSelectionRange!()).toBeUndefined();
    editor.cursor = 5;
    editor.selectionEnd = 9;
    expect(await target.getSelectionRange!()).toEqual({ start: 5, end: 9 });

    const reading = setup({ mode: 'preview', data: 'saved', editorText: 'live text' });
    reading.editor.selectionEnd = 4;
    expect(await reading.host.editTarget()!.getSelectionRange!()).toBeUndefined();
  });
});

/**
 * #543: Obsidian 1.14 keeps `view.editor` on the note while a table cell is
 * focused, so the cell went unnoticed and blocks landed inside the table.
 */
describe('editTarget with a table cell focused', () => {
  const TABLE = 'intro\n\n| ID | Alias |\n| --- | --- |\n| DNA-1 | a |\n\nafter\n';

  /** The note's CodeMirror view; `environment: node` has no DOM for a real one. */
  function cellSetup(text: string) {
    const state = { text, focused: false };
    const cellDom = {} as HTMLElement;
    const view = {
      state: {
        doc: { toString: () => state.text },
        selection: { main: { head: 0 } },
      },
      posAtDOM: (dom: HTMLElement) => (dom === cellDom ? text.indexOf('| DNA-1') : 0),
      dispatch: (tr: { changes?: { from: number; to: number; insert: string } }) => {
        const c = tr.changes;
        if (c) state.text = state.text.slice(0, c.from) + c.insert + state.text.slice(c.to);
      },
      focus: () => {
        state.focused = true;
      },
    };
    const cellEditor = { ...fakeEditor('DNA-1 | a'), cm: { dom: cellDom } };
    const noteEditor = {
      ...fakeEditor(text),
      cm: view,
      editorComponent: { tableCell: { editor: cellEditor } },
    };
    const mdView = new MarkdownView();
    mdView.file = new TFile(NOTE);
    mdView.mode = 'source';
    mdView.editor = noteEditor;
    const app = {
      workspace: { getActiveViewOfType: () => mdView, getMostRecentLeaf: () => null },
    } as unknown as App;
    return { host: createObsidianHost(app, new MemFileSystem(), t), state, cellEditor, noteEditor };
  }

  it('sends an insert to the note below the table, not into the cell', async () => {
    const { host, state, noteEditor } = cellSetup(TABLE);
    const target = host.editTarget()!;

    expect(await target.getCursorOffset!()).toBe(TABLE.indexOf('\n\nafter'));
    await target.insertAtCursor('| extra |');

    expect(state.text).toBe(TABLE.replace('| DNA-1 | a |\n', '| DNA-1 | a |\n| extra |\n'));
    // The note editor is the table itself, so writing through it would break it.
    expect(noteEditor.text).toBe(TABLE);
  });

  it('hands out the cell editor for text that fits in a cell', () => {
    const { host, cellEditor } = cellSetup(TABLE);
    expect(tableCellEditorOf(host.editTarget()!)).toBe(cellEditor);
  });

  it('leaves a note with no cell focused on its own editor', async () => {
    const { host, state } = cellSetup(TABLE);
    host.editTarget(); // the cell path above, for contrast
    const plain = setup({ mode: 'source', data: TABLE, editorText: TABLE });
    const target = plain.host.editTarget()!;

    expect(tableCellEditorOf(target)).toBeUndefined();
    await target.insertAtCursor('x');
    expect(plain.editor.text).toBe(`x${TABLE}`);
    expect(state.text).toBe(TABLE);
  });
});

// #291: "View usages" opened each note at its top.
describe('openFile', () => {
  function openSetup(mode: 'source' | 'preview') {
    const view = new MarkdownView();
    view.mode = mode;
    const editor = fakeEditor('text');
    view.editor = editor;
    const leaf = { view, openFile: vi.fn(async () => undefined) };
    const app = {
      vault: { getAbstractFileByPath: (p: string) => new TFile(p) },
      workspace: { getLeaf: () => leaf },
    } as unknown as App;
    return { host: createObsidianHost(app, new MemFileSystem(), t), leaf, editor };
  }

  it('puts the cursor on the given line and column', async () => {
    const { host, leaf, editor } = openSetup('source');
    await host.openFile(NOTE, { line: 12, ch: 4 });
    expect(leaf.openFile).toHaveBeenCalledWith(expect.any(TFile), { eState: { line: 12 } });
    expect(editor.setCursor).toHaveBeenCalledWith({ line: 12, ch: 4 });
    expect(editor.scrollIntoView).toHaveBeenCalled();
  });

  it('leaves the cursor alone without a position or in reading view', async () => {
    const plain = openSetup('source');
    await plain.host.openFile(NOTE);
    expect(plain.leaf.openFile).toHaveBeenCalledWith(expect.any(TFile), undefined);
    expect(plain.editor.setCursor).not.toHaveBeenCalled();

    const reading = openSetup('preview');
    await reading.host.openFile(NOTE, { line: 3 });
    expect(reading.leaf.openFile).toHaveBeenCalledWith(expect.any(TFile), { eState: { line: 3 } });
    expect(reading.editor.setCursor).not.toHaveBeenCalled();
  });
});

// The view gone to another note between two calls (a prompt, a read in between): its editor is
// that note's now, so the target neither reads nor changes it as this one.
describe('editTarget after its view went to another note', () => {
  it('refuses to read or write', async () => {
    const { host, view, editor } = setup({ mode: 'source', data: 'note A\n', editorText: 'note A\n' });
    const target = host.editTarget()!;
    expect(await target.getText()).toBe('note A\n');
    view.file = new TFile('labnote/001_Test/002_WD020_B.labnote.md');
    editor.text = 'note B\n';
    const switched = 'The note was switched to another while the command ran, so it was not changed. Run the command again.';
    await expect(target.getText()).rejects.toThrow(switched);
    await expect(target.replaceRange(0, 0, 'X')).rejects.toThrow(switched);
    expect(editor.text).toBe('note B\n');
  });
});

// The view goes to another note, alike, while the target switches it to editing: nothing is
// written into that note.
describe('editTarget whose view goes to another note as it switches to editing', () => {
  it('refuses the write', async () => {
    const { host, view, editor, setState } = setup({ mode: 'preview', data: 'same\n', editorText: 'same\n' });
    setState.mockImplementation(async state => {
      if (state.mode) view.mode = state.mode;
      view.file = new TFile('labnote/001_Test/002_WD020_B.labnote.md');
      editor.text = 'same\n';
    });
    const target = host.editTarget()!;
    await expect(target.replaceRange(0, 0, 'X')).rejects.toThrow('The note was switched to another while the command ran, so it was not changed. Run the command again.');
    expect(editor.text).toBe('same\n');
  });
});

// In editing view too: the target's own wait, with nothing to wait for, still lets the view go
// to another note before the editor is touched.
describe('editTarget whose view goes to another note in editing view, as a call waits', () => {
  it.each(['replaceRange', 'revealOffset'] as const)('%s refuses', async method => {
    const { host, view, editor } = setup({ mode: 'source', data: 'AAAA', editorText: 'AAAA' });
    const target = host.editTarget()!;
    const call = method === 'replaceRange' ? target.replaceRange(0, 0, 'X') : target.revealOffset!(1);
    view.file = new TFile('labnote/001_Test/002_WD020_B.labnote.md');
    editor.text = 'BBBB';
    await expect(call).rejects.toThrow('The note was switched to another while the command ran, so it was not changed. Run the command again.');
    expect(editor.text).toBe('BBBB');
    expect(editor.setCursor).not.toHaveBeenCalled();
  });
});

