/**
 * How long a write waits for the saves Obsidian has under way on an open note: once, for the
 * whole write, up to OPEN_SAVE_WAIT_MS however many views or waits there are; and until no
 * view the note is open in has one under way, a save started after another included.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault } from '../../src/commands';
import { OPEN_SAVE_WAIT_MS, processNote } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/README.labnote.md';

function setup(count: number, disk: string) {
  const state = { disk, order: [] as string[] };
  const tf = new TFile(P);
  const views = Array.from({ length: count }, () => {
    const view = new MarkdownView();
    view.file = tf;
    view.lastSavedData = disk;
    let text = disk.replace(/\r\n/g, '\n');
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (t: string, from: number, to: number) => {
        text = text.slice(0, from) + t + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      state.disk = t;
      state.order.push('save');
    };
    return view;
  });
  const app = {
    workspace: { getLeavesOfType: () => views.map(view => ({ view })) },
    vault: {
      getFileByPath: () => tf,
      read: async () => state.disk,
      process: async (_f: TFile, fn: (data: string) => string) => {
        state.disk = fn(state.disk);
        state.order.push('process');
        return state.disk;
      },
    },
  } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => state.disk, write: async () => {} } } as unknown as LabnoteHost;
  return { app, host, state, views };
}

/** A save under way in `view` that ends after `ms`, or never. */
function saving(view: MarkdownView, ms: number | 'never', state: { order: string[] }, name: string): Promise<void> {
  const promise = new Promise<void>(resolve => {
    if (ms !== 'never') {
      setTimeout(() => {
        state.order.push(name);
        view.savePromise = null;
        resolve();
      }, ms);
    }
  });
  view.savePromise = promise;
  return promise;
}

describe('the wait for saves under way on an open note', () => {
  it.each([
    ['one view, LF', 1, 'a\nb\n'],
    ['one view, CRLF', 1, 'a\r\nb\r\n'],
    ['two views, CRLF', 2, 'a\r\nb\r\n'],
  ] as const)('a save that never ends is waited for once, for the whole write (%s)', async (_name, count, disk) => {
    const { app, host, state, views } = setup(count, disk);
    for (const view of views) void saving(view, 'never', state, 'never');
    const started = Date.now();
    expect(await processNoteThroughVault(app, host, P, c => c.replace('b', 'B'))).toBe(true);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(OPEN_SAVE_WAIT_MS - 5);
    expect(waited).toBeLessThan(OPEN_SAVE_WAIT_MS + 500);
    expect(state.order).toEqual(['process']);
  });

  // The first view's save ends, then the other's, and only then the first starts another.
  it('writes only after every save, one started in a view already waited for included', async () => {
    // An LF note: the write goes through the vault right after the wait.
    const { app, state, views } = setup(2, 'a\nb\n');
    void saving(views[0], 20, state, 'first save');
    void saving(views[1], 30, state, 'other view save').then(() => void saving(views[0], 30, state, 'second save'));
    // A direct note write, which waits once.
    await processNote(app, new TFile(P) as never, c => c.replace('b', 'B'));
    expect(state.order).toEqual(['first save', 'other view save', 'second save', 'process']);
    expect(state.disk).toBe('a\nB\n');
  });
});
