/**
 * A write to an open note while Obsidian's own save of it is still writing (text typed, the
 * save started, its write not on the file yet). The write waits for that save, so neither is
 * lost: the change is in the file once, with the typed text, and what it returns is what
 * happened. Past the wait for a save that does not end, nothing is written and the caller
 * says so: false, a README entry not written, the warning for a note ID not written.
 * The view follows Obsidian 1.15.0's TextFileView (save, savePromise, the re-read on modify).
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault, registerWorkflowInReadme } from '../../src/commands';
import { NoteIdService } from '../../src/barcode/noteIdService';
import { BarcodeFeature } from '../../src/barcode/barcodeFeature';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/README.labnote.md';
const TYPED = 'Typed line.';
const ENTRY = '- [ ] [WD020 New](./002_WD020_New.labnote.md)';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
type Op = 'register' | 'counted' | 'noteId' | 'assign';

async function run(nl: string, op: Op, release: 'soon' | 'never') {
  const start = ['---', 'title: x', '---', '# Test', '', '## Related Workflows', ''].join(nl);
  const disk = { text: start };
  const tf = new TFile(P);
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  const view = new MarkdownView();
  let text = '';
  view.editor = {
    getValue: () => text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
    },
  };
  view.getViewData = () => text;
  // Obsidian re-reads a file changed while no save of its own is under way.
  let reload: Promise<void> = Promise.resolve();
  const onModify = () => {
    if (view.savePromise !== null) return;
    reload = (async () => {
      await tick();
      const read = disk.text;
      const last = view.lastSavedData;
      view.lastSavedData = read;
      if (last === read || (view.dirty && text === read)) return;
      view.data = read;
      text = read.replace(/\r\n?/g, '\n');
    })();
  };
  view.writeData = async (_f: TFile, t: string) => {
    if (gate) await gate;
    disk.text = t;
    onModify();
  };
  view.file = tf;
  view.loadText(start);
  text = start.replace(/\r\n?/g, '\n');
  const vault = {
    getFileByPath: () => tf,
    getAbstractFileByPath: () => tf,
    getMarkdownFiles: () => [],
    read: async () => disk.text,
    process: async (_f: TFile, fn: (data: string) => string) => {
      disk.text = fn(disk.text);
      onModify();
      return disk.text;
    },
  };
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault, metadataCache: { getFileCache: () => null } } as unknown as App;
  const notices: { level: string; msg: string }[] = [];
  const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
  const host = {
    fs: { exists: async () => true, read: async () => disk.text, write: async () => {} },
    notify: (level: string, msg: string) => notices.push({ level, msg }),
    t,
  } as unknown as LabnoteHost;

  // Typed, and Obsidian's save of it started; its write waits at the gate.
  text = text.replace('# Test\n', `# Test\n${TYPED}\n`);
  view.dirty = true;
  gate = new Promise(resolve => (open = resolve));
  const obsidianSave = view.save();
  await tick();

  const write =
    op === 'register'
      ? registerWorkflowInReadme(app, host, P, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })
      : op === 'counted'
        ? processNoteThroughVault(app, host, P, c => c.replace('title: x', 'title: y'))
        : op === 'noteId'
          ? new NoteIdService(app, host).ensureId(tf as never, { reassign: true })
          : assignId(app, host, t, tf);
  if (release === 'soon') {
    await tick();
    await tick();
    gate = null;
    open();
  }
  const result = await write;
  if (release === 'never') {
    gate = null;
    open();
  }
  await obsidianSave;
  await reload;
  await tick();
  // Leaving the note later: Obsidian saves the buffer when it differs from what it read.
  await view.save(true);
  return { result, file: disk.text, notices };
}

/** The Assign note ID command on `file`. */
function assignId(app: App, host: LabnoteHost, t: unknown, file: TFile): Promise<void> {
  const f = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
  Object.assign(f, { plugin: { app, host, t }, noteIds: new NoteIdService(app, host) });
  return (f as unknown as { assignId(x: TFile): Promise<void> }).assignId(file);
}

const endings = [['CRLF', '\r\n'], ['LF', '\n']] as const;
const ops: Op[] = ['register', 'counted', 'noteId'];

describe("a write while Obsidian's own save of the open note is writing", () => {
  it.each(endings.flatMap(([n, nl]) => ops.map(op => [op, n, nl] as const)))('%s (%s): the change once, the typed text kept', async (op, _n, nl) => {
    const { result, file } = await run(nl, op, 'soon');
    expect(file).toContain(TYPED);
    if (op === 'register') {
      expect(result).toBe('registered');
      expect(file.split(ENTRY)).toHaveLength(2);
    } else if (op === 'counted') {
      expect(result).toBe(true);
      expect(file.split('title: y')).toHaveLength(2);
    } else {
      expect(result).toMatch(/^LN-[0-9A-Z]{8}$/);
      expect(readNoteId(file)).toBe(result);
    }
  });

  // Past the wait nothing is written (Obsidian's save would write over it), and the caller says so.
  const late: Op[] = ['register', 'counted', 'assign'];
  it.each(endings.flatMap(([n, nl]) => late.map(op => [op, n, nl] as const)))('%s (%s): a save that does not end in time, nothing written', async (op, _n, nl) => {
    const started = Date.now();
    const { result, file, notices } = await run(nl, op, 'never');
    expect(Date.now() - started).toBeGreaterThanOrEqual(OPEN_SAVE_WAIT_MS);
    expect(Date.now() - started).toBeLessThan(OPEN_SAVE_WAIT_MS + 2000);
    expect(file).toContain(TYPED);
    expect(file).not.toContain(ENTRY);
    expect(file).not.toContain('title: y');
    expect(readNoteId(file)).toBeUndefined();
    if (op === 'register') expect(result).toBe('notWritten');
    else if (op === 'counted') expect(result).toBe(false);
    else {
      expect(notices.filter(n => n.level === 'info')).toEqual([]);
      expect(notices.filter(n => n.level === 'warn').map(n => n.msg)).toEqual([
        `The labnote_id of ${P} could not be written, so its value was left as it is: write it on one line (labnote_id: LN-…) and try again.`,
      ]);
    }
  }, OPEN_SAVE_WAIT_MS + 10000);
});
