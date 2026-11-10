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
import { changeExperimentStatusCommand, changeNotWritten, processNoteThroughVault, toggleDiscussionFlagCommand } from '../../src/commands';
import { OPEN_SAVE_WAIT_MS, editsBetween, openEditorText, processInOpenEditor } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const NOTE = ['---', 'title: T', 'last_updated_date: 2026-11-01', '---', '## A', 'body a', '', '## B', 'body b', '', '## C', 'body c', ''].join('\n');
const stamp = (c: string) => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10');
/** What another writer puts in the file. */
const OTHER = '# written by another\n';

/** An editor over CodeMirror's state, as Obsidian's is: a change maps the cursor as there. */
function cmEditor(text: string, cursor = text.length) {
  let state = EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor) });
  /** How many times the editor was changed (one undo step each). */
  const applied = { count: 0 };
  return {
    applied,
    getValue: () => state.doc.toString(),
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number = from) => {
      applied.count++;
      state = state.update({ changes: { from, to, insert: t } }).state;
    },
    // As Obsidian's `Editor.transaction`: every change at its place in the text before any.
    transaction: (tx: { changes: { from: number; to?: number; text: string }[] }) => {
      applied.count++;
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
 * cursor at `cursor` (the end by default). `save`: 'fails' throws, 'stuck' never ends, 'leaves'
 * ends without writing, the view gone from the note, 'reloads' ends without writing, another
 * writer having changed the file and the view reading it again. `files`: others in the vault.
 * `interject`: another writer, run as a failing save writes (the first or the second, `n`).
 */
function openNote(
  path: string,
  disk: string,
  typed: string,
  cursor = typed.length,
  save: 'writes' | 'fails' | 'stuck' | 'leaves' | 'reloads' = 'writes',
  files: Record<string, string> = {},
  interject?: (n: number) => Promise<void>
) {
  const fs = new MemFileSystem({ ...files, [path]: disk });
  const tf = new TFile(path);
  const view = new MarkdownView();
  const editor = cmEditor(typed, cursor);
  view.file = tf;
  view.lastSavedData = disk;
  view.editor = editor;
  view.getViewData = () => editor.getValue();
  let failed = 0;
  view.writeData = async (_f: TFile, t: string) => {
    if (save === 'fails') {
      await interject?.(++failed);
      throw new Error('disk full');
    }
    await fs.write(path, t);
  };
  if (save === 'stuck') view.savePromise = new Promise(() => {});
  if (save === 'leaves') {
    view.save = async () => {
      view.file = null;
    };
  }
  if (save === 'reloads') {
    view.save = async () => {
      await fs.write(path, OTHER);
      view.lastSavedData = null;
    };
  }
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
    processNote: (p, change, lone) => processNoteStamped(app, host, p, change, stamp, lone),
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

  // The save fails, and Obsidian starts a save of its own, of the editor with the change in it,
  // that does not end before the note is saved again: that one is waited for no longer than
  // any, and the change, in the editor and in that save, is not to be asked for again.
  it('reports the change the editor keeps when a save Obsidian starts before it is saved again does not end in time', async () => {
    const { fs, view, editor, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'fails');
    const save = view.save.bind(view);
    let saves = 0;
    view.save = async () => {
      try {
        await save();
      } finally {
        if (++saves === 1) view.savePromise = new Promise(() => {});
      }
    };
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect(saves).toBe(1);
    expect(editor.getValue()).toContain('## B\n\nNEW B');
    expect(await fs.read(P)).toBe(NOTE);
  }, OPEN_SAVE_WAIT_MS + 10000);

  // The first save fails, another writer changing the file while it is saved: the view, saving,
  // does not read that, so its editor keeps the change for its next save.
  it('reports the change the editor keeps when another writer changes the file as it is first saved', async () => {
    let fsRef: MemFileSystem | undefined;
    const { fs, editor, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'fails', {}, async n => {
      if (n === 1) await fsRef!.write(P, OTHER);
    });
    fsRef = fs;
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect(editor.getValue()).toContain('## B\n\nNEW B');
    expect(await fs.read(P)).toBe(OTHER);
  });

  // A change the editor holds, its save failing, asked for again: it is in the note as the
  // note is (the editor's), not said to be not written for the file still without it.
  it('finds a change in the editor not saved yet when it is asked for again', async () => {
    const { fs, app, host, editor } = openNote(P, NOTE, NOTE, undefined, 'fails');
    const add = (c: string) => (c.includes('ADDED') ? c : c.replace('body c', 'body c ADDED'));
    expect(await processNoteThroughVault(app, host, P, add)).toBe(true);
    expect(editor.getValue()).toContain('body c ADDED');
    expect(await fs.read(P)).toBe(NOTE);
    expect(await changeNotWritten(app, host, P, add)).toBe(false);
  });

  it('refuses a section the note no longer has as it is written, nothing written', async () => {
    const { fs, ctx } = openNote(P, NOTE, NOTE.replace('## B', '## Bx'));
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res).toMatchObject({ ok: false, code: 'section_not_found' });
    expect(await fs.read(P)).toBe(NOTE);
  });

  // The editor's save fails, twice, with the view still on the note: the editor keeps the change
  // and saves it next, so that is what is reported; the file is not written meanwhile.
  it('reports the change the editor holds when its save fails', async () => {
    const typed = NOTE.replace('body b', 'body b typed');
    const { fs, editor, ctx } = openNote(P, NOTE, typed, undefined, 'fails');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect((res.data as { previousBody: string }).previousBody).toBe('body b typed');
    expect(editor.getValue()).toBe(stamp(typed).replace('## B\nbody b typed', '## B\n\nNEW B'));
    expect(await fs.read(P)).toBe(NOTE);
  });

  // A section typed and not saved yet, filled by the tool, the save failing: the change the
  // editor holds is the result, not the file's refusal of it.
  it('fills a section typed and not saved when the save fails, as the editor has it', async () => {
    const typed = `${NOTE}## Results\n(typing)\n`;
    const { fs, editor, ctx } = openNote(P, NOTE, typed, undefined, 'fails');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'Results', content: 'RESULT BODY' });
    expect(res.ok).toBe(true);
    expect(editor.getValue()).toContain('RESULT BODY');
    expect(await fs.read(P)).toBe(NOTE);
  });

  // A heading one of two in the file, told apart in the editor: the same.
  it('changes the one section of the editor when the file has two, the save failing', async () => {
    const disk = NOTE.replace('## B\nbody b', '## B\nbody b\n\n## B\nother');
    const typed = disk.replace('## B\nother', '## Bx\nother');
    const { fs, editor, ctx } = openNote(P, disk, typed, undefined, 'fails');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect(editor.getValue()).toContain('NEW B');
    expect(await fs.read(P)).toBe(disk);
  });

  // The view left the note: its editor's change is not saved, and the file's text refuses the
  // change, so the tool fails and the file stays as it was.
  it('fails when the view left the note and the file refuses the change', async () => {
    const { fs, ctx } = openNote(P, NOTE, `${NOTE}## Results\n(typing)\n`, undefined, 'leaves');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'Results', content: 'RESULT BODY' });
    expect(res).toMatchObject({ ok: false, code: 'section_not_found' });
    expect(await fs.read(P)).toBe(NOTE);
  });

  // Both saves fail, and another writer changes the file while it is saved again: the view,
  // saving, does not read that (Obsidian skips a change made while it saves), so its editor
  // keeps the change, and its next save writes it over that file.
  it('reports the change the editor keeps when another writer changes the file as it is saved again', async () => {
    let fsRef: MemFileSystem | undefined;
    const { fs, editor, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'fails', {}, async n => {
      if (n === 2) await fsRef!.write(P, OTHER);
    });
    fsRef = fs;
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res.ok).toBe(true);
    expect(editor.getValue()).toContain('## B\n\nNEW B');
    expect(await fs.read(P)).toBe(OTHER);
  });

  // The save fails, and another writer changes the file before it is saved again; the view,
  // not dirty after its failed save, reads that over its editor: the change is in neither,
  // however alike they read.
  it('fails when the save fails and the view reads another writer\'s file over its editor', async () => {
    let at: { fs: MemFileSystem; editor: ReturnType<typeof cmEditor>; view: MarkdownView } | undefined;
    const { fs, editor, view, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'fails', {}, async n => {
      if (n !== 1) return;
      await at!.fs.write(P, OTHER);
      // Its event handled once the save is over: the view reads the file over its editor and
      // holds it as last saved, as onModify does.
      setTimeout(() => {
        at!.view.lastSavedData = OTHER;
        at!.editor.replaceRange(OTHER, 0, at!.editor.getValue().length);
      }, 0);
    });
    at = { fs, editor, view };
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res).toMatchObject({ ok: false, code: 'note_not_written' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await fs.read(P)).toBe(OTHER);
    expect(editor.getValue()).toBe(OTHER);
  });

  // The save writes nothing, the view reading the file another writer changed: the change is
  // not in it, and the view's reading puts the file over the editor.
  it('fails when the save writes nothing and the view reads the file another writer changed', async () => {
    const { fs, ctx } = openNote(P, NOTE, NOTE.replace('body a', 'body a typed'), undefined, 'reloads');
    const res = await tool('update_section').handler(ctx, { documentPath: P, heading: 'B', content: 'NEW B' });
    expect(res).toMatchObject({ ok: false, code: 'note_not_written' });
    expect(await fs.read(P)).toBe(OTHER);
  });

  // A README whose checklist section was typed and not saved yet, the save failing: the new
  // workflow is listed as the editor has it.
  it('lists a new workflow in a checklist section typed and not saved, the save failing', async () => {
    const README = 'labnote/001_Test/README.labnote.md';
    const disk = ['---', 'title: T', '---', '# T', ''].join('\n');
    const typed = `${disk}\n## Related Workflows\n`;
    const { fs, editor, ctx } = openNote(README, disk, typed, undefined, 'fails');
    const res = await tool('create_workflow').handler(ctx, { documentPath: README, workflowId: 'WD010' });
    expect(res).toMatchObject({ ok: true, data: { registered: true } });
    expect(editor.getValue()).toMatch(/## Related Workflows\n+- \[ \] \[WD010 /);
    expect(await fs.read(README)).toBe(disk);
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

// A new workflow listed in its open README: the entry and the README's date go in as one change,
// one undo step; with no checklist section, the date alone, as before.
describe('a workflow created while its README is open', () => {
  const README = 'labnote/001_Test/README.labnote.md';
  const disk = ['---', 'title: T', 'last_updated_date: 2026-11-01', '---', '# T', '', '## Related Workflows', ''].join('\n');

  it('changes the README editor once, entry and date together', async () => {
    const typed = disk.replace('# T', '# T typed');
    const { fs, editor, ctx } = openNote(README, disk, typed);
    const res = await tool('create_workflow').handler(ctx, { documentPath: README, workflowId: 'WD010' });
    expect(res).toMatchObject({ ok: true, data: { registered: true } });
    expect(editor.applied.count).toBe(1);
    expect(editor.getValue()).toContain('last_updated_date: 2026-11-10');
    expect(editor.getValue()).toMatch(/- \[ \] \[WD010 /);
    expect(await fs.read(README)).toBe(editor.getValue());
  });

  it('dates a README with no checklist section, once, and lists nothing', async () => {
    const bare = disk.replace('## Related Workflows\n', '');
    const { editor, ctx } = openNote(README, bare, bare);
    const res = await tool('create_workflow').handler(ctx, { documentPath: README, workflowId: 'WD010' });
    expect(res).toMatchObject({ ok: true, data: { registered: false } });
    expect(editor.applied.count).toBe(1);
    expect(editor.getValue()).toBe(stamp(bare));
  });
});

/**
 * A note open in a view modelled on Obsidian 1.15.0's TextFileView: save (dirty cleared, the
 * write awaited, the text last saved put back when it fails), onModify (no reading while a save
 * writes) and loadFileInternal (a dirty editor merged with the file read; the merge here puts
 * each change from the text last saved to the editor's where the text before it is found in the
 * file, standing in for Obsidian's diff-match-patch one). `typed` goes in while a save writes;
 * saves fail until `heal()`.
 */
function obsidianNote(path: string, disk: string, typed: string) {
  const fs = new MemFileSystem({ [path]: disk });
  const tf = new TFile(path);
  const view = new MarkdownView();
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  let text = disk;
  let dirty = false;
  let fail = true;
  let typedOnce = false;
  const edit = (from: number, to: number, t: string) => {
    text = text.slice(0, from) + t + text.slice(to);
    dirty = true;
  };
  view.file = tf;
  view.lastSavedData = disk;
  view.data = disk;
  view.editor = {
    getValue: () => text,
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number = from) => edit(from, to, t),
    transaction: (tx: { changes: { from: number; to?: number; text: string }[] }) => {
      for (const c of [...tx.changes].sort((x, y) => y.from - x.from)) edit(c.from, c.to ?? c.from, c.text);
    },
  };
  view.getViewData = () => text;
  const merge = (base: string, mine: string, theirs: string) => {
    let out = theirs;
    for (const e of editsBetween(base, mine).reverse()) {
      const pre = base.slice(Math.max(0, e.start - 24), e.start);
      const mid = base.slice(e.start, e.end);
      const at = out.indexOf(pre + mid);
      if (at === -1) continue;
      const s = at + pre.length;
      out = out.slice(0, s) + e.text + out.slice(s + mid.length);
    }
    return out;
  };
  const loadFileInternal = async () => {
    let r = await fs.read(path);
    const n = view.lastSavedData;
    view.lastSavedData = r;
    if (n) {
      if (n === r) return;
      if (dirty) {
        if (text === r) return;
        if (text !== n) r = merge(n, text, r);
      }
    }
    text = r;
  };
  const onModify = () =>
    setTimeout(() => {
      if (view.savePromise === null) void loadFileInternal();
    }, 0);
  view.save = async () => {
    dirty = false;
    while (view.savePromise !== null) await view.savePromise.catch(() => undefined);
    const r = text;
    if (view.lastSavedData === r || view.lastSavedData === null) return;
    const n = view.lastSavedData;
    view.data = r;
    view.lastSavedData = r;
    view.savePromise = (async () => {
      await tick();
      if (!typedOnce) {
        typedOnce = true;
        text += typed;
        dirty = true;
      }
      await tick();
      if (fail) {
        view.lastSavedData = n;
        throw new Error('disk full');
      }
      await fs.write(path, r);
      onModify();
    })();
    try {
      await view.savePromise;
    } finally {
      view.savePromise = null;
    }
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }], getActiveFile: () => tf },
    vault: {
      getFileByPath: (p: string) => (p === path ? tf : null),
      read: async () => fs.read(path),
      process: async (_f: TFile, fn: (s: string) => string) => {
        const data = await fs.read(path);
        const next = fn(data);
        if (next !== data) {
          await fs.write(path, next);
          onModify();
        }
        return next;
      },
    },
  } as unknown as App;
  const host = { fs } as unknown as LabnoteHost;
  const ctx: ToolContext = {
    fs: Object.assign(Object.create(fs) as MemFileSystem, {
      read: async (p: string) => (await openEditorText(app, p)) ?? fs.read(p),
    }),
    workspaceRoot: '.',
    globalSampleFolder: 'resources/labsamples',
    processNote: (p, change, lone) => processNoteStamped(app, host, p, change, stamp, lone),
  };
  /** Obsidian's next save, the disk taking writes again, and what the note ends as. */
  const heal = async () => {
    for (let i = 0; i < 5; i++) await tick();
    fail = false;
    await view.save();
    for (let i = 0; i < 5; i++) await tick();
    return { disk: await fs.read(path), editor: text };
  };
  return { fs, ctx, heal };
}

// A tool putting text in while the save of the open note fails and the user types during it:
// the text goes in once, the typing once, on the file and in the editor alike.
describe('an insertion made while the save fails and the user types', () => {
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it('lists a new workflow once', async () => {
    const README = 'labnote/001_Test/README.labnote.md';
    const disk = ['---', 'title: T', '---', '# T', '', '## Related Workflows', '', '- [ ] [WD005 X](./000_WD005_X.labnote.md)', ''].join('\n');
    const { ctx, heal } = obsidianNote(README, disk, 'TYPED');
    const res = await tool('create_workflow').handler(ctx, { documentPath: README, workflowId: 'WD010' });
    expect(res).toMatchObject({ ok: true, data: { registered: true } });
    const end = await heal();
    for (const text of [end.disk, end.editor]) {
      expect(count(text, '[WD010 ')).toBe(1);
      expect(count(text, 'TYPED')).toBe(1);
    }
  });

  it('inserts a unit operation once', async () => {
    const { ctx, heal } = obsidianNote(P, NOTE, 'TYPED');
    const res = await tool('insert_unit_operation').handler(ctx, { documentPath: P, opId: 'UHW010' });
    expect(res.ok).toBe(true);
    // As often as the operation is in the note it makes on a note not open.
    const plain = new MemFileSystem({ [P]: NOTE });
    await tool('insert_unit_operation').handler({ fs: plain, workspaceRoot: '.', globalSampleFolder: 'resources/labsamples' }, { documentPath: P, opId: 'UHW010' });
    const once = count(await plain.read(P), 'UHW010');
    const end = await heal();
    for (const text of [end.disk, end.editor]) {
      expect(count(text, 'UHW010')).toBe(once);
      expect(count(text, 'TYPED')).toBe(1);
    }
  });
});
