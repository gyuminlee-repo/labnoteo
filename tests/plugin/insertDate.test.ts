import { describe, it, expect } from 'vitest';
import type { Editor, EditorPosition, EditorTransaction } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { focusOnNoteHeader, insertDateCommand } from '../../src/commands';

/** A plain-text editor recording how it was edited. */
function fakeEditor(text: string, cursor: number, cell?: { cm: unknown }) {
  let doc = text;
  const calls: string[] = [];
  const offsetToPos = (offset: number): EditorPosition => {
    const before = doc.slice(0, offset).split('\n');
    return { line: before.length - 1, ch: before[before.length - 1].length };
  };
  const posToOffset = (pos: EditorPosition): number =>
    doc.split('\n').slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
  let selection = offsetToPos(cursor);
  const editor = {
    ...cell,
    getValue: () => doc,
    getCursor: () => selection,
    posToOffset,
    offsetToPos,
    replaceSelection: (s: string) => {
      calls.push('replaceSelection');
      const at = posToOffset(selection);
      doc = doc.slice(0, at) + s + doc.slice(at);
    },
    replaceRange: () => calls.push('replaceRange'),
    setCursor: () => calls.push('setCursor'),
    transaction: (tx: EditorTransaction) => {
      calls.push('transaction');
      for (const c of tx.changes ?? []) {
        const from = posToOffset(c.from);
        const to = c.to ? posToOffset(c.to) : from;
        doc = doc.slice(0, from) + c.text + doc.slice(to);
      }
      if (tx.selection) selection = tx.selection.from;
    },
  };
  return { editor: editor as unknown as Editor, calls, text: () => doc, cursor: () => posToOffset(selection) };
}

const host = { notify: () => undefined, t: (s: string) => s } as unknown as LabnoteHost;

describe('insertDateCommand', () => {
  it('inserts in one transaction and leaves the cursor after the date (#303)', () => {
    const e = fakeEditor('# Note\n\nDone on \n', 16);
    expect(insertDateCommand(e.editor, host, '2026-10-24')).toBe(true);
    expect(e.text()).toBe('# Note\n\nDone on 2026-10-24\n');
    expect(e.calls).toEqual(['transaction']);
    expect(e.cursor()).toBe(26);
  });

  it('types into a table cell as it is, without reading the cell as a note (#303)', () => {
    // A cell editor's DOM sits inside the note's editor.
    const outer = { closest: () => outer };
    const cm = { dom: { parentElement: outer } };
    const original = EditorView.findFromDOM;
    const g = globalThis as { HTMLElement?: unknown };
    const hadElement = 'HTMLElement' in g;
    g.HTMLElement ??= Object;
    EditorView.findFromDOM = () => ({}) as EditorView;
    try {
      const e = fakeEditor('Start_date: ', 12, { cm });
      expect(insertDateCommand(e.editor, host, '2026-10-24 09:00')).toBe(true);
      expect(e.calls).toEqual(['replaceSelection']);
      expect(e.text()).toBe('Start_date: 2026-10-24 09:00');
    } finally {
      EditorView.findFromDOM = original;
      if (!hadElement) delete g.HTMLElement;
    }
  });
});

// #405: with a property focused, the date went to the body's last cursor line.
describe('focusOnNoteHeader', () => {
  const el = (inside: string | null) =>
    ({ closest: (sel: string) => (inside && sel.includes(inside) ? {} : null) }) as unknown as Element;

  it('tells the Properties box and the inline title from the body', () => {
    expect(focusOnNoteHeader(el('.metadata-container'))).toBe(true);
    expect(focusOnNoteHeader(el('.inline-title'))).toBe(true);
    expect(focusOnNoteHeader(el(null))).toBe(false);
    expect(focusOnNoteHeader(null)).toBe(false);
  });
});
