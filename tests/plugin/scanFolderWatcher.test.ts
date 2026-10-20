import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PcStore } from '../../src/scan/pcStore';
import type { ScanInput, ScanResult } from '../../src/scan/scanPipeline';
import {
  FAILED_DIR,
  PROCESSED_DIR,
  ScanFolderWatcher,
  isInsideFolder,
  outcomeOf,
  pruneHistory,
  selectReadyFiles,
  type FolderEntry,
} from '../../src/scan/scanFolderWatcher';

const DAY = 24 * 60 * 60 * 1000;

describe('selectReadyFiles', () => {
  const now = 1_000_000;
  const entry = (name: string, over: Partial<FolderEntry> = {}): FolderEntry => ({ name, size: 10, mtimeMs: now - 10_000, ...over });

  it('takes settled scan files new since the folder was set, on the second look', () => {
    const lastSizes = new Map<string, number>();
    const entries = [
      entry('a.jpg'),
      entry('old.jpg', { mtimeMs: now - 100_000 }),
      entry('notes.txt'),
      entry('.hidden.jpg'),
      entry('growing.pdf', { mtimeMs: now - 500 }),
      entry('empty.png', { size: 0 }),
    ];
    const opts = { since: now - 50_000, now, handled: () => false, lastSizes };
    expect(selectReadyFiles(entries, opts)).toEqual({ ready: [], waiting: 3 });
    expect(selectReadyFiles(entries, opts).ready.map(e => e.name)).toEqual(['a.jpg']);
  });

  it('takes settled files at once on a manual run, and old ones when asked', () => {
    const entries = [entry('a.jpg'), entry('old.jpg', { mtimeMs: now - 100_000 })];
    const ready = selectReadyFiles(entries, {
      since: now - 50_000,
      now,
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
      includeExisting: true,
    }).ready;
    expect(ready.map(e => e.name)).toEqual(['a.jpg', 'old.jpg']);
  });

  it('forgets the size of files that left the folder', () => {
    const lastSizes = new Map([['gone.jpg', 5]]);
    selectReadyFiles([], { since: 0, now, handled: () => false, lastSizes });
    expect(lastSizes.size).toBe(0);
  });
});

describe('watcher helpers', () => {
  it('drops history older than 90 days', () => {
    const now = 100 * DAY;
    expect(pruneHistory({ old: now - 91 * DAY, recent: now - 89 * DAY }, now)).toEqual({ recent: now - 89 * DAY });
  });

  it('sends a file to the failed folder only when nothing came of it', () => {
    const r = (status: ScanResult['status']): ScanResult => ({ source: 'a', status });
    expect(outcomeOf([r('unmatched'), r('error')])).toBe('failed');
    expect(outcomeOf([r('unmatched'), r('filed')])).toBe('processed');
    expect(outcomeOf([r('blank')])).toBe('processed');
    expect(outcomeOf([])).toBe('processed');
  });

  it('tells a folder inside the vault, whatever the slashes and case', () => {
    expect(isInsideFolder('C:\\Vault\\scans', 'c:/vault')).toBe(true);
    expect(isInsideFolder('C:/Vault', 'C:/Vault/')).toBe(true);
    expect(isInsideFolder('C:/Vault2/scans', 'C:/Vault')).toBe(false);
  });
});

describe('ScanFolderWatcher.tick', () => {
  let dir: string;
  let saved: Map<string, unknown>;
  let store: PcStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labnoteo-scans-'));
    saved = new Map();
    store = { get: <T>(k: string) => saved.get(k) as T | undefined, set: (k, v) => void saved.set(k, v) };
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write `name` with a modification time `ageMs` ago. */
  function put(name: string, ageMs: number): void {
    const p = path.join(dir, name);
    fs.writeFileSync(p, name);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }

  function watcher(statusOf: (name: string) => ScanResult['status']) {
    const runs: { names: string[]; skipNoQr?: boolean }[] = [];
    const reports: boolean[] = [];
    const w = new ScanFolderWatcher(
      {
        store,
        t: (s: string) => s,
        run: async (inputs: ScanInput[], opts) => {
          runs.push({ names: inputs.map(i => i.name), skipNoQr: opts.skipNoQr });
          return inputs.map(i => ({ source: i.name, input: i.name, status: statusOf(i.name) }));
        },
        report: (_results, manual) => reports.push(manual),
        notify: () => undefined,
      },
      { fs, path }
    );
    return { w, runs, reports };
  }

  it('dedicated mode: reads new files only and moves each original by its outcome', async () => {
    put('before.jpg', 60_000);
    saved.set('scanFolder', { path: dir, mode: 'dedicated', since: Date.now() - 30_000 });
    put('good.jpg', 10_000);
    put('bad.jpg', 10_000);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'nested.jpg'), 'x');
    const { w, runs, reports } = watcher(name => (name === 'bad.jpg' ? 'unmatched' : 'filed'));

    await w.tick({ manual: true });
    expect(runs.map(r => ({ ...r, names: [...r.names].sort() }))).toEqual([{ names: ['bad.jpg', 'good.jpg'], skipNoQr: false }]);
    expect(reports).toEqual([true]);
    expect(fs.readdirSync(path.join(dir, PROCESSED_DIR))).toEqual(['good.jpg']);
    expect(fs.readdirSync(path.join(dir, FAILED_DIR))).toEqual(['bad.jpg']);
    expect(fs.existsSync(path.join(dir, 'before.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub', 'nested.jpg'))).toBe(true);
  });

  it('shared mode: leaves originals in place, passes over non-worksheet photos and remembers what it read', async () => {
    saved.set('scanFolder', { path: dir, mode: 'shared', since: Date.now() - 30_000 });
    put('photo.jpg', 10_000);
    const { w, runs } = watcher(() => 'skipped');

    await w.tick({ manual: true });
    await w.tick({ manual: true });
    expect(runs).toEqual([{ names: ['photo.jpg'], skipNoQr: true }]);
    expect(fs.readdirSync(dir)).toEqual(['photo.jpg']);
    expect(Object.keys(saved.get('scanFolderHistory') as object)).toHaveLength(1);
  });

  it('reads files that were there before only when asked', async () => {
    put('before.jpg', 60_000);
    saved.set('scanFolder', { path: dir, mode: 'shared', since: Date.now() - 30_000 });
    const { w, runs } = watcher(() => 'filed');
    expect(await w.tick({ manual: true })).toEqual([]);
    await w.tick({ manual: true, includeExisting: true });
    expect(runs.map(r => r.names)).toEqual([['before.jpg']]);
  });

  it('does nothing without a folder', async () => {
    const { w, runs } = watcher(() => 'filed');
    expect(await w.tick()).toBeUndefined();
    expect(runs).toEqual([]);
  });
});
