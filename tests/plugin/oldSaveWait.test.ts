/**
 * Obsidian 1.12.4 and 1.14.5 save a note with no promise to wait on: the view sets `saving`
 * while `vault.modify` writes, a save called meanwhile only asks for another after it, and a
 * change to the file made while it saves is not read. A write to the note waits for that save
 * as for 1.15.0's, until the same deadline: past it nothing is written and it is said so; within
 * it the change goes in after the save and stays.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { createLabnoteTools, MemFileSystem, type LabnoteHost, type ToolContext } from '@labnoteo/core';
import { setNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { processNoteStamped } from '../../src/lastUpdatedStamp';
import { OPEN_SAVE_WAIT_MS, openEditorText, processNoteResult } from '../../src/openEditorWrite';

const DIR = 'labnote/001_Test';
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const README = `${DIR}/README.labnote.md`;
const BODY = ['---', 'title: T', '---', '## [WD010 A]', '', '### Results', 'r1', ''].join('\n');
const READMES = ['---', 'title: T', '---', '# T', '', '## Related Workflows', ''].join('\n');

/** TextFileView.save of Obsidian 1.12.4 and 1.14.5, in the order app.js runs it. */
class OldView extends MarkdownView {
  saving = false;
  saveAgain = false;
  modify: (file: TFile, text: string) => Promise<void> = async () => {};

  override async save(clear = false): Promise<void> {
    this.dirty = false;
    const file = this.file;
    if (!file) return;
    if (this.saving) {
      if (!clear) this.saveAgain = true;
      return;
    }
    this.saveAgain = false;
    const text = this.getViewData();
    if (this.lastSavedData === text || this.lastSavedData === null) return;
    const before = this.lastSavedData;
    this.data = text;
    this.lastSavedData = text;
    this.saving = true;
    try {
      await this.modify(file, text);
    } catch (err) {
      this.lastSavedData = before;
      throw err;
    } finally {
      this.saving = false;
      if (this.saveAgain && !clear) void this.save();
    }
  }
}

/** `path` open with typing not saved yet, and Obsidian's own save of it taking `delay` ms. */
function savingNote(path: string, disk: string, delay: number) {
  const fs = new MemFileSystem({ [path]: disk, [NOTE]: path === NOTE ? disk : BODY, [README]: path === README ? disk : READMES });
  const tf = new TFile(path);
  const view = new OldView();
  let text = disk.replace('# T', '# T typed').replace('r1', 'r1 typed');
  view.file = tf;
  view.lastSavedData = disk;
  view.editor = {
    getValue: () => text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (r: string, from: number, to: number) => {
      text = text.slice(0, from) + r + text.slice(to);
    },
  };
  view.getViewData = () => text;
  view.modify = async (f, t) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    await fs.write(f.path, t);
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }], getActiveFile: () => tf },
    metadataCache: { getFileCache: () => null },
    vault: {
      getFileByPath: (p: string) => new TFile(p),
      getAbstractFileByPath: (p: string) => new TFile(p),
      read: async (f: TFile) => fs.read(f.path),
      cachedRead: async (f: TFile) => fs.read(f.path),
      process: async (f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(f.path));
        await fs.write(f.path, next);
        return next;
      },
      modify: async (f: TFile, d: string) => fs.write(f.path, d),
      create: async (p: string, d: string) => fs.write(p, d),
    },
  } as unknown as App;
  const host = { fs, notify: () => undefined, t: (s: string) => s } as unknown as LabnoteHost;
  const ctx: ToolContext = {
    fs: Object.assign(Object.create(fs) as MemFileSystem, {
      read: async (p: string) => (await openEditorText(app, p)) ?? fs.read(p),
    }),
    workspaceRoot: '.',
    globalSampleFolder: 'resources/labsamples',
    processNote: (p, change, lone) => processNoteStamped(app, host, p, change, c => c, lone),
  };
  // Obsidian starts saving the typing.
  void view.save();
  /** The file once every save is over, the note saved once more as Obsidian does next. */
  const final = async () => {
    while (view.saving) await new Promise(resolve => setTimeout(resolve, 20));
    await view.save();
    return fs.read(path);
  };
  return { app, ctx, tf, final };
}

const tool = (name: string) => createLabnoteTools().find(t => t.name === name)!;
const count = (s: string, needle: string) => s.split(needle).length - 1;
const LATE = OPEN_SAVE_WAIT_MS + 1000;
const T = LATE + 10000;

describe('a write while Obsidian 1.12.4 / 1.14.5 is still saving the open note', () => {
  it('a section: past the wait, said not written, and not in the note', async () => {
    const s = savingNote(NOTE, BODY, LATE);
    const res = await tool('update_section').handler(s.ctx, { documentPath: NOTE, heading: 'Results', content: 'NEW', mode: 'append' });
    expect(res).toMatchObject({ ok: false, code: 'note_not_written' });
    expect(count(await s.final(), 'NEW')).toBe(0);
  }, T);

  it('a section: within the wait, written after the save, and kept', async () => {
    const s = savingNote(NOTE, BODY, 200);
    const res = await tool('update_section').handler(s.ctx, { documentPath: NOTE, heading: 'Results', content: 'NEW', mode: 'append' });
    expect(res.ok).toBe(true);
    const end = await s.final();
    expect(count(end, 'NEW')).toBe(1);
    expect(end).toContain('r1 typed');
  }, T);

  it('a workflow: past the wait, not said as listed, and not listed', async () => {
    const s = savingNote(README, READMES, LATE);
    const res = await tool('create_workflow').handler(s.ctx, { documentPath: README, workflowId: 'WD020' });
    expect(res.ok).toBe(true);
    expect((res.data as { registered: boolean }).registered).toBe(false);
    expect(count(await s.final(), 'WD020')).toBe(0);
  }, T);

  it('a workflow: within the wait, listed and kept', async () => {
    const s = savingNote(README, READMES, 200);
    const res = await tool('create_workflow').handler(s.ctx, { documentPath: README, workflowId: 'WD020' });
    expect((res.data as { registered: boolean }).registered).toBe(true);
    expect(count(await s.final(), '[WD020 ')).toBe(1);
  }, T);

  it('a note ID: past the wait, said not written, and not in the note', async () => {
    const s = savingNote(NOTE, BODY, LATE);
    expect(await processNoteResult(s.app, s.tf as never, data => setNoteId(data, 'LN-7K3M9QX2'))).toBe('timedOut');
    expect(count(await s.final(), 'LN-7K3M9QX2')).toBe(0);
  }, T);

  it('a note ID: within the wait, written and kept', async () => {
    const s = savingNote(NOTE, BODY, 200);
    expect(await processNoteResult(s.app, s.tf as never, data => setNoteId(data, 'LN-7K3M9QX2'))).toBe('written');
    expect(count(await s.final(), 'LN-7K3M9QX2')).toBe(1);
  }, T);
});
