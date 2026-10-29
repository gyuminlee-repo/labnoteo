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
  historyKey,
  isInsideFolder,
  outcomeOf,
  pruneHistory,
  selectReadyFiles,
  type FolderEntry,
  type ScanFolderConfig,
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

  it('passes over only what the folder already held, whatever the file times say (#247)', () => {
    const copied = entry('copied.jpg', { mtimeMs: now - 100_000 });
    const known = entry('was-here.jpg', { mtimeMs: now - 100_000 });
    const ready = selectReadyFiles([copied, known], {
      since: now - 50_000,
      now,
      baseline: new Set([historyKey(known)]),
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
    }).ready;
    expect(ready.map(e => e.name)).toEqual(['copied.jpg']);
  });

  it('without a baseline, takes a file the file system says appeared after the folder was set (#247)', () => {
    const copied = entry('copied.jpg', { mtimeMs: now - 100_000, birthtimeMs: now - 10_000 });
    const old = entry('old.jpg', { mtimeMs: now - 100_000, birthtimeMs: now - 100_000 });
    const ready = selectReadyFiles([copied, old], {
      since: now - 50_000,
      now,
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
    }).ready;
    expect(ready.map(e => e.name)).toEqual(['copied.jpg']);
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
  const started: ScanFolderWatcher[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labnoteo-scans-'));
    saved = new Map();
    store = { get: <T>(k: string) => saved.get(k) as T | undefined, set: (k, v) => void saved.set(k, v) };
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });
  });

  afterEach(() => {
    // setConfig starts an fs.watch; left running it fires after the globals go.
    while (started.length > 0) started.pop()!.stop();
    vi.restoreAllMocks();
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
    const notices: string[] = [];
    const w = new ScanFolderWatcher(
      {
        store,
        t: (s: string, ...args: Array<string | number | boolean>) =>
          args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s),
        run: async (inputs: ScanInput[], opts) => {
          runs.push({ names: inputs.map(i => i.name), skipNoQr: opts.skipNoQr });
          return inputs.map(i => ({ source: i.name, input: i.name, status: statusOf(i.name) }));
        },
        report: (_results, manual) => reports.push(manual),
        notify: message => void notices.push(message),
      },
      { fs, path }
    );
    started.push(w);
    return { w, runs, reports, notices };
  }

  it('dedicated mode: reads new files only and moves each original by its outcome', async () => {
    const { w, runs, reports } = watcher(name => (name === 'bad.jpg' ? 'unmatched' : 'filed'));
    put('before.jpg', 60_000);
    w.setConfig(dir, 'dedicated');
    put('good.jpg', 10_000);
    put('bad.jpg', 10_000);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'nested.jpg'), 'x');

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

  it.each(['shared', 'dedicated'] as const)('%s mode retries unreadable originals in a mixed batch without changing metadata', async mode => {
    saved.set('scanFolder', { path: dir, mode, since: Date.now() - 30_000 });
    put('retry.jpg', 10_000);
    put('good.jpg', 10_000);
    const before = fs.statSync(path.join(dir, 'retry.jpg'));
    const { w, runs } = watcher(() => 'filed');
    const readFile = fs.promises.readFile.bind(fs.promises);
    const read = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === path.join(dir, 'retry.jpg')) throw new Error('temporarily locked');
      return readFile(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await w.tick({ manual: true });
    expect(runs[0].names).toEqual(['good.jpg']);
    expect.soft(fs.existsSync(path.join(dir, 'retry.jpg'))).toBe(true);
    expect.soft(Object.keys(saved.get('scanFolderHistory') as object)).toEqual([
      expect.stringMatching(/^good\.jpg\|/),
    ]);
    if (mode === 'dedicated') expect.soft(fs.readdirSync(path.join(dir, PROCESSED_DIR))).toEqual(['good.jpg']);

    read.mockRestore();
    await w.tick({ manual: true });
    expect(runs.flatMap(r => r.names)).toEqual(['good.jpg', 'retry.jpg']);
    const original = mode === 'shared' ? path.join(dir, 'retry.jpg') : path.join(dir, PROCESSED_DIR, 'retry.jpg');
    expect(fs.statSync(original).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(original).size).toBe(before.size);
    await w.tick({ manual: true });
    expect(runs.flatMap(r => r.names)).toEqual(['good.jpg', 'retry.jpg']);
  });

  it('reads files that were there before only when asked', async () => {
    const { w, runs } = watcher(() => 'filed');
    put('before.jpg', 60_000);
    w.setConfig(dir, 'shared');
    expect(await w.tick({ manual: true })).toEqual([]);
    await w.tick({ manual: true, includeExisting: true });
    expect(runs.map(r => r.names)).toEqual([['before.jpg']]);
  });

  it('reads a copied file whose modification time is old, and passes over what was there when the folder was set (#247)', async () => {
    put('was-here.jpg', 60_000);
    const { w, runs } = watcher(() => 'filed');
    w.setConfig(dir, 'shared');
    put('copied.jpg', 60_000);

    await w.tick({ manual: true });
    expect(runs.map(r => r.names)).toEqual([['copied.jpg']]);
  });

  it('reads a file that left the folder and came back (#247)', async () => {
    put('photo.jpg', 60_000);
    const { w, runs } = watcher(() => 'skipped');
    w.setConfig(dir, 'shared');
    expect(await w.tick({ manual: true })).toEqual([]);

    fs.rmSync(path.join(dir, 'photo.jpg'));
    expect(await w.tick({ manual: true })).toEqual([]);
    expect((saved.get('scanFolder') as ScanFolderConfig).baseline).toEqual([]);

    put('photo.jpg', 60_000);
    await w.tick({ manual: true });
    expect(runs.map(r => r.names)).toEqual([['photo.jpg']]);
  });

  it('keeps the baseline when only the mode changes', () => {
    put('was-here.jpg', 60_000);
    const { w } = watcher(() => 'filed');
    w.setConfig(dir, 'shared');
    const before = saved.get('scanFolder') as ScanFolderConfig;
    w.setConfig(dir, 'dedicated');
    expect(saved.get('scanFolder')).toEqual({ ...before, mode: 'dedicated' });
  });

  it('says how many files it passes over when a manual run finds nothing new (#247)', async () => {
    put('was-here.jpg', 60_000);
    const { w, notices } = watcher(() => 'filed');
    w.setConfig(dir, 'shared');

    await w.tick({ manual: true });
    expect(notices.join(' ')).toContain('1 file(s) that were already in the folder');
  });

  it('does nothing without a folder', async () => {
    const { w, runs } = watcher(() => 'filed');
    expect(await w.tick()).toBeUndefined();
    expect(runs).toEqual([]);
  });
});
