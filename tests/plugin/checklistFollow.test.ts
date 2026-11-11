/**
 * Writes made on their own after workflow notes are renamed or deleted, or a note is dated,
 * while Obsidian is still saving the note past the wait: nothing runs again for the checklist,
 * so the user is told how to bring it up to date; a date is tried once more a while later.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { syncReadmeAndSamplesOnDelete, syncReadmeOrderOnRename } from '../../src/commands';
import { STAMP_RETRY_MS, stampNote } from '../../src/lastUpdatedStamp';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const LISTED = ['---', 'title: x', '---', '# Test', '', '## Related Workflows', '', '- [ ] [WD010 A](./001_WD010_A.labnote.md)', ''].join('\n');
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);
const FOLLOW = `${README} was not written: it was still being saved, so its checklist does not follow the renamed or deleted workflow notes yet. Run "Sync workflow checklist with folder" to update it.`;

/** `path` open with a save of it under way: `ends` ms long, or never. */
function saving(files: Record<string, string>, path: string, ends?: number) {
  const fs = new MemFileSystem(files);
  const notices: { level: string; msg: string }[] = [];
  const view: { file: TFile; savePromise: Promise<unknown> | null } = { file: new TFile(path), savePromise: null };
  view.savePromise =
    ends === undefined
      ? new Promise(() => {})
      : new Promise(resolve => setTimeout(resolve, ends)).then(() => {
          view.savePromise = null;
        });
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      adapter: {},
      getFileByPath: (p: string) => new TFile(p),
      getAbstractFileByPath: (p: string) => new TFile(p),
      read: async (f: TFile) => fs.read(f.path),
      process: async (f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(f.path));
        await fs.write(f.path, next);
        return next;
      },
    },
  } as unknown as App;
  const host = { fs, t, notify: (level: string, msg: string) => notices.push({ level, msg }) } as unknown as LabnoteHost;
  return { app, host, fs, notices };
}

const T = OPEN_SAVE_WAIT_MS + 10000;

describe('the README checklist after workflow notes change, its save not ending in time', () => {
  it('a rename: said, with the command that updates it', async () => {
    const s = saving({ [README]: LISTED, [`${DIR}/002_WD010_A.labnote.md`]: '# A\n' }, README);
    await syncReadmeOrderOnRename(s.app, s.host, DIR, [{ from: '001_WD010_A.labnote.md', to: '002_WD010_A.labnote.md' }]);
    expect(await s.fs.read(README)).toBe(LISTED);
    expect(s.notices).toEqual([{ level: 'warn', msg: FOLLOW }]);
  }, T);

  it('a delete: said, with the command that updates it, and nothing counted', async () => {
    const s = saving({ [README]: LISTED }, README);
    expect(await syncReadmeAndSamplesOnDelete(s.app, s.host, DIR, [NOTE])).toBe(0);
    expect(await s.fs.read(README)).toBe(LISTED);
    expect(s.notices).toEqual([{ level: 'warn', msg: FOLLOW }]);
  }, T);
});

describe('a date for a note whose save ends past the wait', () => {
  it('is tried once more a while later, and written then', async () => {
    const s = saving({ [NOTE]: '---\nlast_updated_date: 2026-01-01\n---\n' }, NOTE, OPEN_SAVE_WAIT_MS + 300);
    const stamp = (c: string) => c.replace('2026-01-01', '2026-11-11');
    await stampNote(s.app, s.host, NOTE, stamp);
    expect(await s.fs.read(NOTE)).toContain('2026-01-01');
    await new Promise(resolve => setTimeout(resolve, STAMP_RETRY_MS + 500));
    expect(await s.fs.read(NOTE)).toContain('2026-11-11');
  }, T);
});
