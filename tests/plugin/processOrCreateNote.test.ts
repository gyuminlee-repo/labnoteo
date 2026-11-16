/**
 * `processOrCreateNote` is the seam that keeps an AI or sync-driven edit from
 * being silently undone.
 *
 * When a note is open, Obsidian's editor holds its own buffer and flushes it on
 * its own schedule. A write that goes straight to the vault *adapter* is
 * invisible to that buffer, so the next flush overwrites it. Routing through
 * `vault.process` makes the editor observe the change instead. Picking the
 * wrong branch loses user data with no error anywhere, which is exactly the
 * kind of failure a unit test has to catch.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile, TFolder } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { processOrCreateNote } from '../../src/commands';

/** Records which path each write took, so a silent fallback cannot pass. */
function makeApp(indexed: Record<string, TFile | TFolder>) {
  const processed: Array<{ path: string; content: string }> = [];
  const app = {
    vault: {
      getFileByPath: (path: string) => indexed[path] ?? null,
      process: async (file: TFile, fn: (data: string) => string) => {
        const next = fn('previous contents');
        processed.push({ path: file.path, content: next });
        return next;
      },
    },
  };
  return { app: app as unknown as App, processed };
}

function makeHost(fs: MemFileSystem) {
  return { fs } as unknown as LabnoteHost;
}

const NOTE = 'labnote/001_Test/README.labnote.md';

describe('processOrCreateNote', () => {
  it('routes through vault.process when the note is in the vault index', async () => {
    const { app, processed } = makeApp({ [NOTE]: new TFile(NOTE) });
    const fs = new MemFileSystem({ [NOTE]: 'on disk' });

    expect(await processOrCreateNote(app, makeHost(fs), NOTE, () => 'new content')).toBe(true);

    expect(processed).toEqual([{ path: NOTE, content: 'new content' }]);
    // The adapter must NOT also be written: that is the path the open editor
    // cannot see, and doing both would defeat the point.
    expect(await fs.read(NOTE)).toBe('on disk');
  });

  it('makes the change of the text as it is when written, not of an earlier read', async () => {
    const { app, processed } = makeApp({ [NOTE]: new TFile(NOTE) });

    await processOrCreateNote(app, makeHost(new MemFileSystem({ [NOTE]: 'read earlier' })), NOTE, c => `${c}!`);

    expect(processed[0].content).toBe('previous contents!');
  });

  it('writes a note the change leaves as it is through the vault all the same', async () => {
    const { app, processed } = makeApp({ [NOTE]: new TFile(NOTE) });

    await processOrCreateNote(app, makeHost(new MemFileSystem({ [NOTE]: 'x' })), NOTE, c => c);

    expect(processed).toEqual([{ path: NOTE, content: 'previous contents' }]);
  });

  it('makes a note that does not exist of an empty one, on the adapter', async () => {
    const { app, processed } = makeApp({});
    const fs = new MemFileSystem();

    expect(await processOrCreateNote(app, makeHost(fs), NOTE, c => `${c}brand new`)).toBe(true);

    expect(processed).toEqual([]);
    expect(await fs.read(NOTE)).toBe('brand new');
  });

  it('falls back when the path resolves to a folder rather than a file', async () => {
    // `getFileByPath` is typed as returning a TFile, but a stale or odd index
    // entry must not reach `vault.process`, which would throw.
    const folder = new TFolder();
    folder.path = NOTE;
    const { app, processed } = makeApp({ [NOTE]: folder });
    const fs = new MemFileSystem({ [NOTE]: 'old' });

    await processOrCreateNote(app, makeHost(fs), NOTE, () => 'content');

    expect(processed).toEqual([]);
    expect(await fs.read(NOTE)).toBe('content');
  });

  it('preserves content exactly, including trailing newlines and unicode', async () => {
    const { app, processed } = makeApp({ [NOTE]: new TFile(NOTE) });
    const content = '# 실험 노트\n\n- 항목 1\n\n';

    await processOrCreateNote(app, makeHost(new MemFileSystem({ [NOTE]: 'x' })), NOTE, () => content);

    expect(processed[0].content).toBe(content);
  });

  it('writes an empty document rather than skipping the write', async () => {
    const { app, processed } = makeApp({ [NOTE]: new TFile(NOTE) });

    await processOrCreateNote(app, makeHost(new MemFileSystem({ [NOTE]: 'x' })), NOTE, () => '');

    expect(processed).toEqual([{ path: NOTE, content: '' }]);
  });
});
