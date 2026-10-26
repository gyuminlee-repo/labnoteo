/**
 * The reorder filter must fold the TOC/separator cleanup into the very
 * transaction that moved a block (one undo step), and stay out of every other
 * edit: IME composition, undo/redo, non-workflow notes and plain typing.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { applyTextEdits, computeUnitOpSyncEdits, findUnitOpInsertOffset, rebuildUnitOpToc } from '@labnoteo/core';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { createUnitOpReorderFilter } from '../../src/unitOpReorderFilter';

const WORKFLOW_PATH = 'labnote/001_Exp/001_WD010_Design.labnote.md';

function buildNote(): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim');
  for (const [opId, opName] of [['UHW010', 'Alpha'], ['UHW020', 'Beta'], ['UHW030', 'Gamma']]) {
    const block = buildHwUnitOpMarkdown(
      { opId, opName, opDescription: `${opName} step` },
      { experimenter: 'Dr. Kim', dateTime: '2026-09-29 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

/** Outline drag of Gamma before Alpha, as one transaction (delete + insert). */
function dragGammaBeforeAlpha(doc: string): TransactionSpec {
  const from = doc.indexOf('### [UHW030 Gamma]');
  const to = doc.indexOf('## Conclusions and Discussion');
  const at = doc.indexOf('### [UHW010 Alpha]');
  return {
    changes: [
      { from: at, insert: doc.slice(from, to) },
      { from, to },
    ],
  };
}

function setup(opts: { path?: string | null; enabled?: boolean } = {}) {
  const doc = buildNote();
  const state = EditorState.create({
    doc,
    extensions: [
      createUnitOpReorderFilter({
        isEnabled: () => opts.enabled ?? true,
        getFilePath: () => (opts.path === undefined ? WORKFLOW_PATH : opts.path),
      }),
    ],
  });
  return { doc, state };
}

describe('createUnitOpReorderFilter', () => {
  it('folds the cleanup into the drag transaction', () => {
    const { doc, state } = setup();
    const tr = state.update(dragGammaBeforeAlpha(doc));
    const dragged = EditorState.create({ doc }).update(dragGammaBeforeAlpha(doc)).newDoc.toString();
    const expected = applyTextEdits(dragged, computeUnitOpSyncEdits(dragged));

    expect(expected).not.toBe(dragged);
    expect(tr.newDoc.toString()).toBe(expected);
    // One transaction: its change set alone maps the old document to the tidy one.
    expect(tr.changes.apply(state.doc).toString()).toBe(expected);
    const toc = [...expected.matchAll(/^- \[(UHW\d+) /gm)].map(m => m[1]);
    expect(toc).toEqual(['UHW030', 'UHW010', 'UHW020']);
  });

  it('adds nothing once the note is already tidy', () => {
    const { doc, state } = setup();
    const tidy = state.update(dragGammaBeforeAlpha(doc)).state;
    const at = tidy.doc.toString().indexOf('### [UHW010 Alpha]');
    const tr = tidy.update({ changes: { from: at, to: at + 5, insert: '### [' } });
    expect(tr.newDoc.toString()).toBe(tidy.doc.toString());
  });

  it.each([
    ['IME composition', { userEvent: 'input.type.compose' }],
    ['a file reload (Outline drag)', { userEvent: 'set' }],
    ['undo', { userEvent: 'undo' }],
    ['redo', { userEvent: 'redo' }],
  ])('skips %s', (_label, extra) => {
    const { doc, state } = setup();
    const tr = state.update({ ...dragGammaBeforeAlpha(doc), ...extra });
    const plain = EditorState.create({ doc }).update(dragGammaBeforeAlpha(doc));
    expect(tr.newDoc.toString()).toBe(plain.newDoc.toString());
  });

  it('skips non-workflow notes and editors without a file', () => {
    for (const path of ['labnote/001_Exp/README.labnote.md', 'notes/free.md', null]) {
      const { doc, state } = setup({ path });
      const tr = state.update(dragGammaBeforeAlpha(doc));
      const plain = EditorState.create({ doc }).update(dragGammaBeforeAlpha(doc));
      expect(tr.newDoc.toString()).toBe(plain.newDoc.toString());
    }
  });

  it('skips when the setting is off', () => {
    const { doc, state } = setup({ enabled: false });
    const tr = state.update(dragGammaBeforeAlpha(doc));
    const plain = EditorState.create({ doc }).update(dragGammaBeforeAlpha(doc));
    expect(tr.newDoc.toString()).toBe(plain.newDoc.toString());
  });

  it('skips single-character typing that does not touch a unit-op heading', () => {
    // Start from a mis-ordered TOC: only a heading-touching edit may fix it here.
    const { doc } = setup();
    const moved = EditorState.create({ doc }).update(dragGammaBeforeAlpha(doc)).newDoc.toString();
    const state = EditorState.create({
      doc: moved,
      extensions: [createUnitOpReorderFilter({ isEnabled: () => true, getFilePath: () => WORKFLOW_PATH })],
    });
    const tr = state.update({ changes: { from: moved.length, insert: 'x' }, userEvent: 'input.type' });
    expect(tr.newDoc.toString()).toBe(moved + 'x');
  });

  it('reports every document change with whether it came from undo/redo', () => {
    const calls: [string, boolean][] = [];
    const make = (path: string | null, enabled = true) =>
      EditorState.create({
        doc: 'abc',
        extensions: [
          createUnitOpReorderFilter({
            isEnabled: () => enabled,
            getFilePath: () => path,
            onDocChange: (p, h) => calls.push([p, h]),
          }),
        ],
      });
    const edit = { changes: { from: 0, insert: 'x' } };

    make(WORKFLOW_PATH).update({ ...edit, userEvent: 'input.type' });
    make(WORKFLOW_PATH).update({ ...edit, userEvent: 'set' });
    make(WORKFLOW_PATH).update({ ...edit, userEvent: 'undo' });
    make(WORKFLOW_PATH).update({ ...edit, userEvent: 'redo' });
    make('notes/free.md').update(edit);
    make(WORKFLOW_PATH, false).update({ ...edit, userEvent: 'undo' });
    make(null).update(edit);
    make(WORKFLOW_PATH).update({ selection: { anchor: 1 } });

    expect(calls).toEqual([
      [WORKFLOW_PATH, false],
      [WORKFLOW_PATH, false],
      [WORKFLOW_PATH, true],
      [WORKFLOW_PATH, true],
      ['notes/free.md', false],
      [WORKFLOW_PATH, true],
    ]);
  });

  // #207: real undo/redo are dispatched with `filter: false` and skip filters.
  describe('with real history', () => {
    function historyState(doc: string, onDocChange?: (p: string, h: boolean) => void) {
      return EditorState.create({
        doc,
        extensions: [
          history(),
          createUnitOpReorderFilter({ isEnabled: () => true, getFilePath: () => WORKFLOW_PATH, onDocChange }),
        ],
      });
    }
    function run(state: EditorState, command: typeof undo): EditorState {
      let next = state;
      command({ state, dispatch: tr => (next = tr.state) });
      return next;
    }

    it('reports undo and redo as history changes', () => {
      const calls: boolean[] = [];
      let state = historyState('abc', (_p, h) => calls.push(h));
      state = state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }).state;
      state = run(state, undo);
      state = run(state, redo);
      expect(state.doc.toString()).toBe('xabc');
      expect(calls).toEqual([false, true, true]);
    });

    it('drops a deleted block from the TOC in the same undo step', () => {
      const doc = buildNote();
      const from = doc.indexOf('### [UHW020 Beta]');
      const to = doc.indexOf('### [UHW030 Gamma]');
      let state = historyState(doc);
      state = state.update({ changes: { from, to }, userEvent: 'delete.cut' }).state;

      const toc = [...state.doc.toString().matchAll(/^- \[(UHW\d+) /gm)].map(m => m[1]);
      expect(toc).toEqual(['UHW010', 'UHW030']);
      expect(state.doc.toString()).toBe(rebuildUnitOpToc(doc.slice(0, from) + doc.slice(to)));

      state = run(state, undo);
      expect(state.doc.toString()).toBe(doc);
    });

    it('leaves the TOC alone while a heading is deleted character by character', () => {
      const doc = buildNote();
      const at = doc.indexOf('### [UHW020 Beta]') + '### [UHW020 Bet'.length;
      const state = historyState(doc).update({ changes: { from: at, to: at + 1 }, userEvent: 'delete.backward' }).state;
      expect(state.doc.toString()).toBe(doc.slice(0, at) + doc.slice(at + 1));
    });
  });

  describe('change kind', () => {
    const NOTE = "---\nstatus: active\nlast_updated_date: '2026-10-01'\n---\n# Body\n";

    function kindOf(spec: TransactionSpec) {
      let kind: unknown;
      EditorState.create({
        doc: NOTE,
        extensions: [
          createUnitOpReorderFilter({
            isEnabled: () => true,
            getFilePath: () => WORKFLOW_PATH,
            onDocChange: (_p, _h, k) => (kind = k),
          }),
        ],
      }).update(spec);
      return kind;
    }

    const typeBody = { changes: { from: NOTE.length, insert: 'x' } };

    it.each(['input.type', 'input.type.compose', 'input.paste', 'delete.backward', 'move.drop'])(
      'treats %s as a user edit',
      userEvent => {
        expect(kindOf({ ...typeBody, userEvent })).toEqual({ userEdit: true, dateEdited: false });
      }
    );

    it.each([['set'], ['undo'], ['redo'], [undefined]])('does not treat %s as a user edit', userEvent => {
      expect(kindOf({ ...typeBody, userEvent })).toEqual({ userEdit: false, dateEdited: false });
    });

    it('flags typing that changes last_updated_date', () => {
      const at = NOTE.indexOf('2026-10-01') + '2026-10-0'.length;
      const spec = { changes: { from: at, to: at + 1, insert: '5' }, userEvent: 'input.type' };
      expect(kindOf(spec)).toEqual({ userEdit: true, dateEdited: true });
    });

    it('does not flag a whole front matter rewrite that only changes status', () => {
      const end = NOTE.indexOf('# Body');
      const insert = NOTE.slice(0, end).replace('status: active', 'status: done');
      const spec = { changes: { from: 0, to: end, insert }, userEvent: 'input.paste' };
      expect(kindOf(spec)).toEqual({ userEdit: true, dateEdited: false });
    });

    it('does not flag a programmatic date change', () => {
      const from = NOTE.indexOf('2026-10-01');
      const spec = { changes: { from, to: from + 10, insert: '2026-10-13' } };
      expect(kindOf(spec)).toEqual({ userEdit: false, dateEdited: false });
    });
  });
});

// #406: with sorting off, a deleted block still takes its entry with it.
describe('createUnitOpReorderFilter with sorting off', () => {
  function offState(doc: string) {
    return EditorState.create({
      doc,
      extensions: [history(), createUnitOpReorderFilter({ isEnabled: () => false, getFilePath: () => WORKFLOW_PATH })],
    });
  }
  const tocOf = (s: EditorState): string[] => [...s.doc.toString().matchAll(/^- \[(UHW\d+) /gm)].map(m => m[1]);
  const blockRange = (doc: string) => ({ from: doc.indexOf('### [UHW020 Beta]'), to: doc.indexOf('### [UHW030 Gamma]') });

  it('drops the entry of a deleted block in the same undo step', () => {
    const doc = buildNote();
    let state = offState(doc).update({ changes: blockRange(doc), userEvent: 'delete.backward' }).state;
    expect(tocOf(state)).toEqual(['UHW010', 'UHW030']);
    undo({ state, dispatch: tr => (state = tr.state) });
    expect(state.doc.toString()).toBe(doc);
  });

  it('keeps the entry of a cut block, which is usually pasted back', () => {
    const doc = buildNote();
    const state = offState(doc).update({ changes: blockRange(doc), userEvent: 'delete.cut' }).state;
    expect(tocOf(state)).toEqual(['UHW010', 'UHW020', 'UHW030']);
  });

  it('keeps the entry while a heading is deleted character by character', () => {
    const doc = buildNote();
    const at = doc.indexOf('### [UHW020 Beta]') + '### [UHW020 Bet'.length;
    const state = offState(doc).update({ changes: { from: at, to: at + 1 }, userEvent: 'delete.backward' }).state;
    expect(tocOf(state)).toEqual(['UHW010', 'UHW020', 'UHW030']);
  });

  it('does not reorder the TOC after a drag', () => {
    const doc = buildNote();
    const state = offState(doc).update(dragGammaBeforeAlpha(doc)).state;
    expect(tocOf(state)).toEqual(['UHW010', 'UHW020', 'UHW030']);
  });
});
