/**
 * The last_updated_date stamp of note A while its view opens note B during the read before
 * the stamp: A is stamped in its file and B, now in the editor, is left as it is.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { stampNote } from '../../src/lastUpdatedStamp';

const PA = 'labnote/001_Test/001_WD010_A.labnote.md';
const PB = 'labnote/002_X/001_WD010_B.labnote.md';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the stamp of a note whose view opens another note meanwhile', () => {
  it('stamps the note in its file, not the other note in the editor', async () => {
    const disk: Record<string, string> = {
      [PA]: '---\nlast_updated_date: 2026-11-01\n---\nA\n',
      [PB]: '---\nlast_updated_date: 2026-10-01\n---\nB\n',
    };
    const tA = new TFile(PA);
    const tB = new TFile(PB);
    const view = new MarkdownView();
    view.file = tA;
    view.lastSavedData = disk[PA];
    let text = disk[PA];
    view.editor = {
      getValue: () => text,
      offsetToPos: (o: number) => o,
      replaceRange: (t: string, a: number, b: number) => {
        text = text.slice(0, a) + t + text.slice(b);
      },
    };
    let switched = false;
    const app = {
      workspace: { getLeavesOfType: () => [{ view }] },
      vault: {
        getFileByPath: (p: string) => (p === PA ? tA : tB),
        read: async (f: TFile) => {
          await tick();
          const read = disk[f.path];
          // The view opens B while A is read.
          if (!switched) {
            switched = true;
            view.file = tB;
            text = disk[PB];
            view.lastSavedData = disk[PB];
          }
          return read;
        },
        process: async (f: TFile, fn: (s: string) => string) => (disk[f.path] = fn(disk[f.path])),
      },
    } as unknown as App;
    const host = { fs: { exists: async (p: string) => p in disk, read: async (p: string) => disk[p], write: async () => {} } } as unknown as LabnoteHost;
    await stampNote(app, host, PA, c => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10'));
    expect(text).toBe(disk[PB]);
    expect(disk[PB]).toContain('2026-10-01');
    expect(disk[PA]).toContain('last_updated_date: 2026-11-10');
  });
});
