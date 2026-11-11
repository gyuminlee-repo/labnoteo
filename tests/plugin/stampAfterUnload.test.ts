/**
 * A last_updated_date stamp whose timer ran before the plugin was unloaded, unloaded while the
 * open note's file is read: nothing is changed after the read, in the editor or the file.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { stampNote } from '../../src/lastUpdatedStamp';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('a stamp the plugin is unloaded during', () => {
  it('changes nothing after the read', async () => {
    const disk: Record<string, string> = { [P]: '---\nlast_updated_date: 2026-11-01\n---\nA\n' };
    const tf = new TFile(P);
    const view = new MarkdownView();
    view.file = tf;
    view.lastSavedData = disk[P];
    let text = disk[P];
    let edits = 0;
    view.editor = {
      getValue: () => text,
      offsetToPos: (o: number) => o,
      replaceRange: (t: string, a: number, b: number) => {
        edits++;
        text = text.slice(0, a) + t + text.slice(b);
      },
    };
    let unloaded = false;
    const app = {
      workspace: { getLeavesOfType: () => [{ view }] },
      vault: {
        getFileByPath: () => tf,
        read: async (f: TFile) => {
          await tick();
          unloaded = true;
          return disk[f.path];
        },
        process: async (f: TFile, fn: (s: string) => string) => (disk[f.path] = fn(disk[f.path])),
      },
    } as unknown as App;
    const host = { fs: { exists: async (p: string) => p in disk, read: async (p: string) => disk[p], write: async () => {} } } as unknown as LabnoteHost;
    const stamp = (c: string) => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10');
    await (stampNote as (...args: unknown[]) => Promise<void>)(app, host, P, stamp, () => !unloaded);
    expect(edits).toBe(0);
    expect(text).toContain('2026-11-01');
    expect(disk[P]).toContain('2026-11-01');
  });
});
