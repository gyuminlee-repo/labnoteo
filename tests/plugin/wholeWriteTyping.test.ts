/**
 * A tool changing a whole note that is open with typing not saved yet: the change is made of
 * the editor's text as it is when written, typing and all, so there is nothing to merge and
 * no typing to lose or misplace; the last_updated_date stamp goes on the note as written.
 * Put into the editor change by change, the cursor stays by the text it was at.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { EditorSelection, EditorState } from '@codemirror/state';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { createLabnoteTools, MemFileSystem, type LabnoteHost, type ToolContext } from '@labnoteo/core';
import { processNoteStamped } from '../../src/lastUpdatedStamp';
import { changeExperimentStatusCommand, toggleDiscussionFlagCommand } from '../../src/commands';
import { OPEN_SAVE_WAIT_MS, openEditorText, processInOpenEditor } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const NOTE = ['---', 'title: T', 'last_updated_date: 2026-11-01', '---', '## A', 'body a', '', '## B', 'body b', '', '## C', 'body c', ''].join('\n');
const stamp = (c: string) => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10');

/** An editor over CodeMirror's state, as Obsidian's is: a change maps the cursor as there. */
function cmEditor(text: string, cursor = text.length) {
  let state = EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor) });
  return {
    getValue: () => state.doc.toString(),
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number = from) => {
      state = state.update({ changes: { from, to, insert: t } }).state;
    },
    // As Obsidian's `Editor.transaction`: every change at its place in the text before any.
    transaction: (tx: { changes: { from: number; to?: number; text: string }[] }) => {
      state = state.update({ changes: tx.changes.map(c => ({ from: c.from, to: c.to ?? c.from, insert: c.text })) }).state;
    },
    /** A key typed at the cursor. */
    type: (t: string) => {
      const at = state.selection.main.head;
      state = state.update({ changes: { from: at, insert: t }, selection: EditorSelection.cursor(at + t.length) }).state;
    },
    cursor: () => state.selection.main.head,
  };
}

/**
 * `path` open in a source view over `disk`, with `typed` in its editor not saved yet and the
 * cursor at `cursor` (the end by default). `save`: 'fails' throws, 'stuck' never ends.
 */
function openNote(path: string, disk: string, typed: string, cursor = typed.length, save: 'writes' | 'fails' | 'stuck' = 'writes') {
  const fs = new MemFileSystem({ [path]: disk });
  const tf = new TFile(path);
  const view = new MarkdownView();
  const editor = cmEditor(typed, cursor);
  view.file = tf;
  view.lastSavedData = disk;
  view.editor = editor;
  view.getViewData = () => editor.getValue();
  view.writeData = async (_f: TFile, t: string) => {
    if (save === 'fails') throw new Error('disk full');
    await fs.write(path, t);
  };
  if (save === 'stuck') view.savePromise = new Promise(() => {});
  const app = {
    workspace: { getLeavesOfType: () => [{ view }], getActiveFile: () => tf },
    vault: {
      getFileByPath: (p: string) => (p === path ? tf : null),
      read: async () => fs.read(path),
      process: async (_f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(path));
        await fs.write(path, next);
        return next;
      },
    },
  } as unknown as App;
  const notices: string[] = [];
  const host = {
    fs,
    t: (key: string, ...args: string[]) => key.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)]),
    notify: (_level: string, msg: string) => void notices.push(msg),
    pick: async () => 'completed',
    confirm: async () => 'keep',
  } as unknown as LabnoteHost;
  // As the plugin's tool context: the open note read as its editor holds it, written as it is then.
  const ctx: ToolContext = {
    fs: Object.assign(Object.create(fs) as MemFileSystem, {
      read: async (p: string) => (await openEditorText(app, p)) ?? fs.read(p),
    }),
    workspaceRoot: '.',
    globalSampleFolder: 'resources/labsamples',
    processNote: (p, change) => processNoteStamped(app, host, p, change, stamp),
  };
  return { fs, app, host, view, editor, ctx, notices };
}

const tool = (name: string) => createLabnoteTools().find(t => t.name === name)!;

describe('a whole note changed by a tool over typing not saved yet', () => {
  it.each([
    ['above', (t: string) => t.replace('body a', 'body a typed'), ['body a typed']],
    ['below', (t: string) => t.replace('body c', 'body c typed'), ['body c typed']],
    ['above and below', (t: string) => t.replace('body a', 'body a typed').replace('body c', 'body c typed'), ['body a typed', 'body c typed']],
    ['in the line next to the change', (t: string) => t.replace('## C', '## C typed'), ['## C typed']],
  ] as const)('typing %s: kept, with the change and the stamp', async (_name, type, kept) => {
    const { fs, app, host } = openNote(P, NOTE, type(NOTE));
    expect(await processNoteStamped(app, host, P, c => c.replace('body b', 'NEW B'), stamp)).toBe(true);
    const file = await fs.read(P);
    for (const k of kept) expect(file).toContain(k);
    expect(file).toContain('NEW B');
    expect(file).toContain('2026-11-10');
  });

  // A table row typed in, under a line the tool changes: the typing stays on its own row, not
  // on the row above, which reads the same but for one digit.
  it('keeps typing in a table row on that row, under a line the tool changes', async () => {
    const rows = [1, 2, 3, 4].map(k => `| 10 uL | sample_000${k} | ok |`);
    const disk = ['---', 'title: T', 'last_updated_date: 2026-11-10', '---', '## Samples', '| Volume | Sample | QC |', '|---|---|---|', ...rows, 'Checked by: -', '| 10 uL | sample_0005 | ok |', '', '## Notes', ''].join('\n');
    const typed = disk.replace('| 10 uL | sample_0005', '| 10 uL (re) | sample_0005');
    const { fs, app, host } = openNote(P, disk, typed);
    await processNoteStamped(app, host, P, c => c.replace('Checked by: -', 'Checked by: KLee'), stamp);
    expect(await fs.read(P)).toBe(typed.replace('Checked by: -', 'Checked by: KLee'));
  });

  // Typing far apart in a long note, a change between: each piece stays, however long the note.
  it('keeps typing in several places of a 10000-line note, a change between them', async () => {
    const lines = Array.from({ length: 10000 }, (_, k) => (k % 7 === 0 ? '| 10 uL | sample | ok |' : k % 5 === 0 ? '' : '- [ ] item'));
    const disk = `${lines.join('\n')}\n`;
    const typedLines = [...lines];
    for (const k of [100, 2500, 7500, 9900]) typedLines[k] += ` typed${k}`;
    const typed = `${typedLines.join('\n')}\n`;
    // The cursor where the third piece was typed, past the change.
    const cursor = typed.indexOf(' typed7500') + ' typed7500'.length;
    const { fs, app, host, editor } = openNote('notes/long.md', disk, typed, cursor);
    const change = (c: string) => {
      const l = c.split('\n');
      l[5000] = 'TOOL CHANGED LINE';
      return l.join('\n');
    };
    await processNoteStamped(app, host, 'notes/long.md', change, stamp);
    expect(await fs.read('notes/long.md')).toBe(change(typed));
    // Put in as its own edit, not one from the first piece to the last: the cursor stays.
    expect(editor.getValue().slice(0, editor.cursor()).endsWith(' typed7500')).toBe(true);
  });
});

// update_section appending to Notes while the user types at the end of Notes: the note as saved
// ends partway through a word, the editor has typed on past it. The appended text goes after the
// typing, and the cursor stays before it, so the word typed next joins the one being typed.
describe('a section appended to where the user is typing', () => {
  const head = '---\nstatus: ongoing\nlast_updated_date: 2026-11-01\n---\n# 841_UpdIn_LF\n\n## Plan\nPlan v0.\n\n## Notes\nKeep notes.\n\n';
  const saved = head + 'k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 k10 k11 k12 k';
  const typed = head + 'k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 k10 k11 k12 k13 k14 k15 k';
  const P2 = 'labnote/841_UpdIn_LF/README.labnote.md';

  it('puts the appended text after the typing and keeps the cursor before it', async () => {
    const { fs, editor, ctx } = openNote(P2, saved, typed);
    const res = await tool('update_section').handler(ctx, { documentPath: P2, heading: 'Notes', content: 'Appended by tool.', mode: 'append' });
    expect(res.ok).toBe(true);
    editor.type('16 k17');
    // The blank line under "## Notes" is the tool's own layout of a section body.
    const expected = `${head.replace('2026-11-01', '2026-11-10').replace('## Notes\nKeep', '## Notes\n\nKeep')}k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 k10 k11 k12 k13 k14 k15 k16 k17\n\nAppended by tool.\n`;
    expect(editor.getValue()).toBe(expected);
    expect(await fs.read(P2)).toBe(expected.replace('16 k17', ''));
  });
});

// Two changes apart, the cursor between them: it stays before the same text, not at the start
// of one replacement running from the first change to the last.
describe('the cursor between two changes a write makes', () => {
  it('stays before the text it was at', async () => {
    const disk = ['# Ops', '- [UHW010 A](#a)', '', '### [UHW010 A]', 'method a', 'typing here', '', '## Conclusions', ''].join('\n');
    const cursor = disk.indexOf('typing here') + 'typing'.length;
    const { app, editor } = openNote(P, disk, disk, cursor);
    const change = (c: string) =>
      c.replace('- [UHW010 A](#a)', '- [UHW010 A](#a)\n- [UHW020 B](#b)').replace('## Conclusions', '### [UHW020 B]\nmethod b\n\n## Conclusions');
    expect(await processInOpenEditor(app, new TFile(P) as never, change)).toBe(true);
    expect(editor.getValue()).toBe(change(disk));
    expect(editor.cursor()).toBe(change(disk).indexOf('typing here') + 'typing'.length);
  });
});

describe('a tool write over an open note', () => {
  // The approval shows what replace takes out, typing not saved yet included.
  it('previews the section body as the editor holds it', async () => {
    const typed = NOTE.replace('body b', 'body b typed not saved');
    const { ctx } = openNote(P, NOTE, typed);
    const preview = (await tool('update_section').describe!(ctx, { documentPath: P, heading: 'B', content: 'NEW B' })) as unknown as { removedText: string };
    expect(preview.removedText).toContain('body b typed not saved');
  });

  it('fails when a save of the open note does not end in time, nothing written', async () => {
    const { fs, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'stuck');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res).toMatchObject({ ok: false, code: 'note_not_written', params: [P] });
    expect(await fs.read(P)).toBe(NOTE);
  }, OPEN_SAVE_WAIT_MS + 10000);

  it('refuses a section the note no longer has as it is written, nothing written', async () => {
    const { fs, ctx } = openNote(P, NOTE, NOTE.replace('## B', '## Bx'));
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res).toMatchObject({ ok: false, code: 'section_not_found' });
    expect(await fs.read(P)).toBe(NOTE);
  });

  // The editor's save fails: the change is made again of the file, and that is what is reported.
  it('reports the change written last when it is made more than once', async () => {
    const { fs, ctx } = openNote(P, NOTE, NOTE.replace('body b', 'body b typed'), undefined, 'fails');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect((res.data as { previousBody: string }).previousBody).toBe('body b');
    expect(await fs.read(P)).toBe(stamp(NOTE).replace('## B\nbody b', '## B\n\nNEW B'));
  });
});

// The README's front matter as it is when written decides, and is read again there.
describe('front matter changed over typing not saved yet', () => {
  const DIR = 'labnote/001_Test';
  const README = `${DIR}/README.labnote.md`;
  const disk = ['---', 'title: T', 'status: ongoing', 'last_updated_date: 2026-11-01', '---', '# T', ''].join('\n');

  it('turns the discussion flag over as the editor has it, and says so', async () => {
    const typed = disk.replace('title: T\n', 'title: T\ndiscuss: true\n');
    const { app, host, notices } = openNote(README, disk, typed);
    await toggleDiscussionFlagCommand(app, host, stamp, DIR);
    expect(await host.fs.read(README)).toBe(stamp(disk));
    expect(notices.join('\n')).toContain('Discussion flag cleared.');
  });

  it('leaves the README alone when the front matter typed cannot be read', async () => {
    const typed = disk.replace('title: T', 'title: EXP: 3rd try');
    const { app, host, notices } = openNote(README, disk, typed);
    await changeExperimentStatusCommand(app, host, stamp, DIR);
    expect(await host.fs.read(README)).toBe(disk);
    expect(notices.join('\n')).toContain(`Front matter of ${README} could not be read`);
  });
});
