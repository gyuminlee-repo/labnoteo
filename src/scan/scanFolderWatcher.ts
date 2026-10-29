/**
 * The PC scan folder: a folder on this computer (usually outside the vault —
 * a Google Drive folder, the scanner's network share, KakaoTalk's download
 * folder) checked at startup, every 30 seconds and whenever the OS reports a
 * change. Desktop only.
 *
 * - Dedicated mode: originals are moved to `labnote-processed/` or
 *   `labnote-failed/` inside the folder once handled.
 * - Shared mode: originals stay put (the folder holds other photos too); what
 *   was handled is remembered for 90 days, and photos without a worksheet QR
 *   code are passed over quietly.
 *
 * Only files directly in the folder are read, never subfolders, so the two
 * folders above are not read again. Only files that appeared after the folder
 * was set are read, unless asked to process existing files too.
 */
import type { Translator } from '@labnoteo/core';
import type { PcStore } from './pcStore';
import type { RunOptions, ScanInput, ScanResult } from './scanPipeline';

export type ScanFolderMode = 'dedicated' | 'shared';

export interface ScanFolderConfig {
  path: string;
  mode: ScanFolderMode;
  /** When the folder was set (ms). Only read for folders set before `baseline` existed. */
  since: number;
  /**
   * {@link historyKey} of every scan file in the folder when it was set: those
   * are the ones to pass over. A copied file keeps its modification time, so
   * going by the time alone skipped it as well (#247). Missing in folders set
   * before 0.116.0.
   */
  baseline?: string[];
}

export const PROCESSED_DIR = 'labnote-processed';
export const FAILED_DIR = 'labnote-failed';
export const SCAN_FILE_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$/i;
export const POLL_MS = 30_000;
const HISTORY_DAYS = 90;
/** A file still growing (being copied, synced, scanned) is left for the next look. */
const SETTLE_MS = 2_000;

const CONFIG_KEY = 'scanFolder';
const HISTORY_KEY = 'scanFolderHistory';

export interface FolderEntry {
  name: string;
  size: number;
  mtimeMs: number;
  /** When the file appeared here; Windows sets it anew on a copy. 0 where the file system has none. */
  birthtimeMs?: number;
}

/** Key remembering a file in shared mode: a re-saved or edited photo counts as new. */
export const historyKey = (e: FolderEntry): string => `${e.name}|${e.size}|${Math.round(e.mtimeMs)}`;

/**
 * Whether a file was already in the folder when it was set. With a
 * {@link ScanFolderConfig.baseline} that is simply the list taken then. In
 * older folders there is no list, so the time is all there is: a copy keeps
 * its modification time but Windows gives it a new creation time, so the
 * later of the two decides (#247).
 */
function wasThereBefore(e: FolderEntry, since: number, baseline?: ReadonlySet<string>): boolean {
  if (baseline) return baseline.has(historyKey(e));
  return Math.max(e.mtimeMs, e.birthtimeMs ?? 0) < since;
}

/**
 * Files to read now: scan files that were not in the folder when it was set
 * (or all, with `includeExisting`), not handled before, and done being
 * written — same size as at the previous look (`lastSizes`) and untouched for
 * a moment.
 */
export function selectReadyFiles(
  entries: readonly FolderEntry[],
  opts: {
    since: number;
    now: number;
    includeExisting?: boolean;
    /** {@link historyKey}s of the files the folder already had. */
    baseline?: ReadonlySet<string>;
    handled: (e: FolderEntry) => boolean;
    lastSizes: Map<string, number>;
    /** A manual run does not wait for a second look. */
    manual?: boolean;
  }
): { ready: FolderEntry[]; waiting: number } {
  const ready: FolderEntry[] = [];
  let waiting = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!SCAN_FILE_RE.test(e.name) || e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (!opts.includeExisting && wasThereBefore(e, opts.since, opts.baseline)) continue;
    if (opts.handled(e)) continue;
    seen.add(e.name);
    const settled = opts.now - e.mtimeMs >= SETTLE_MS && e.size > 0;
    const sameSize = opts.lastSizes.get(e.name) === e.size;
    opts.lastSizes.set(e.name, e.size);
    if (settled && (sameSize || opts.manual)) ready.push(e);
    else waiting++;
  }
  for (const name of [...opts.lastSizes.keys()]) if (!seen.has(name)) opts.lastSizes.delete(name);
  return { ready, waiting };
}

export function pruneHistory(history: Record<string, number>, now: number): Record<string, number> {
  const cutoff = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return Object.fromEntries(Object.entries(history).filter(([, at]) => at >= cutoff));
}

/** A file handled without anything filed from it goes to the failed folder. */
export function outcomeOf(results: readonly ScanResult[]): 'processed' | 'failed' {
  const failed = (r: ScanResult) => r.status === 'unmatched' || r.status === 'unsupported' || r.status === 'error';
  return results.length > 0 && results.every(failed) ? 'failed' : 'processed';
}

/** Whether `folder` is the vault or inside it (both absolute). */
export function isInsideFolder(folder: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = norm(folder);
  const v = norm(parent);
  return f === v || f.startsWith(`${v}/`);
}

export interface WatcherDeps {
  store: PcStore;
  t: Translator;
  run(inputs: ScanInput[], opts: RunOptions): Promise<ScanResult[]>;
  report(results: ScanResult[], manual: boolean): void;
  notify(message: string): void;
}

type NodeFs = typeof import('fs');
type NodePath = typeof import('path');

export class ScanFolderWatcher {
  private running = false;
  private watcher?: { close(): void };
  private retryTimer?: number;
  private readonly lastSizes = new Map<string, number>();

  constructor(
    private readonly deps: WatcherDeps,
    private readonly node: { fs: NodeFs; path: NodePath }
  ) {}

  config(): ScanFolderConfig | undefined {
    const cfg = this.deps.store.get<ScanFolderConfig>(CONFIG_KEY);
    return cfg && typeof cfg.path === 'string' && cfg.path ? cfg : undefined;
  }

  /** Set (or clear, with an empty path) the folder; files already in it count as old. */
  setConfig(path: string, mode: ScanFolderMode): void {
    const prev = this.config();
    const trimmed = path.trim();
    if (!trimmed) this.deps.store.set(CONFIG_KEY, undefined);
    else if (prev && prev.path === trimmed) {
      // Only the mode changed: the folder is the same one, so keep its baseline.
      this.deps.store.set(CONFIG_KEY, { ...prev, mode } satisfies ScanFolderConfig);
    } else {
      const config: ScanFolderConfig = { path: trimmed, mode, since: Date.now(), baseline: this.readBaseline(trimmed) };
      this.deps.store.set(CONFIG_KEY, config);
    }
    this.lastSizes.clear();
    this.restart();
  }

  /** What the folder holds right now, as the list of files to pass over (#247). */
  private readBaseline(folder: string): string[] {
    const { fs, path } = this.node;
    let names: import('fs').Dirent[];
    try {
      names = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return []; // Not there (yet): nothing to pass over.
    }
    const keys: string[] = [];
    for (const d of names) {
      if (!d.isFile() || !SCAN_FILE_RE.test(d.name)) continue;
      try {
        const st = fs.statSync(path.join(folder, d.name));
        keys.push(historyKey({ name: d.name, size: st.size, mtimeMs: st.mtimeMs }));
      } catch {
        // Gone meanwhile.
      }
    }
    return keys;
  }

  /** Watch the folder for changes; the plugin calls {@link tick} on its own interval too. */
  start(): void {
    this.stopWatching();
    const cfg = this.config();
    if (!cfg) return;
    try {
      this.watcher = this.node.fs.watch(cfg.path, { persistent: false }, () => this.scheduleTick(SETTLE_MS + 500));
      (this.watcher as unknown as { on?(ev: string, cb: () => void): void }).on?.('error', () => this.stopWatching());
    } catch {
      // Cloud drives (Google Drive streaming) may not report changes; polling covers them.
    }
    this.scheduleTick(1_000);
  }

  stop(): void {
    this.stopWatching();
    window.clearTimeout(this.retryTimer);
  }

  private restart(): void {
    this.stop();
    this.start();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private scheduleTick(ms: number): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.tick(), ms);
  }

  /** Read what is ready in the folder now. Returns undefined when nothing ran. */
  async tick(opts: { manual?: boolean; includeExisting?: boolean } = {}): Promise<ScanResult[] | undefined> {
    const { t } = this.deps;
    const cfg = this.config();
    if (!cfg) {
      if (opts.manual) this.deps.notify(t('Set a scan folder first: Settings → Labnote Assistant → Barcode & scans.'));
      return undefined;
    }
    if (this.running) {
      if (opts.manual) this.deps.notify(t('The scan folder is being processed already.'));
      return undefined;
    }
    this.running = true;
    try {
      const { fs, path } = this.node;
      let names: import('fs').Dirent[];
      try {
        names = await fs.promises.readdir(cfg.path, { withFileTypes: true });
      } catch (err) {
        if (opts.manual) this.deps.notify(t('The scan folder {0} could not be read: {1}', cfg.path, String(err)));
        return undefined;
      }
      const entries: FolderEntry[] = [];
      for (const d of names) {
        if (!d.isFile() || !SCAN_FILE_RE.test(d.name)) continue;
        try {
          const st = await fs.promises.stat(path.join(cfg.path, d.name));
          entries.push({ name: d.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
        } catch {
          // Gone meanwhile.
        }
      }
      const now = Date.now();
      let history = pruneHistory(this.deps.store.get<Record<string, number>>(HISTORY_KEY) ?? {}, now);
      // A file taken out of the folder leaves the baseline, so putting it back
      // in (the same photo once more) reads it.
      const stillThere = this.pruneBaseline(cfg, entries);
      const { ready, waiting } = selectReadyFiles(entries, {
        since: cfg.since,
        now,
        includeExisting: opts.includeExisting,
        baseline: stillThere && new Set(stillThere),
        handled: e => historyKey(e) in history,
        lastSizes: this.lastSizes,
        manual: opts.manual,
      });
      if (waiting > 0) this.scheduleTick(SETTLE_MS + 1_000);
      if (ready.length === 0) {
        if (opts.manual) this.deps.notify(this.nothingNewMessage(stillThere, !!opts.includeExisting));
        return [];
      }
      const inputs: ScanInput[] = [];
      const read: FolderEntry[] = [];
      for (const e of ready) {
        try {
          const buf = await fs.promises.readFile(path.join(cfg.path, e.name));
          inputs.push({ name: e.name, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
          read.push(e);
        } catch (err) {
          console.warn('[labnoteo] could not read scan', e.name, err);
        }
      }
      const results = await this.deps.run(inputs, { skipNoQr: cfg.mode === 'shared' });
      for (const e of read) {
        const own = results.filter(r => (r.input ?? r.source) === e.name);
        history[historyKey(e)] = now;
        if (cfg.mode === 'dedicated') await this.moveOriginal(cfg.path, e.name, outcomeOf(own));
      }
      history = pruneHistory(history, now);
      this.deps.store.set(HISTORY_KEY, history);
      this.deps.report(results, !!opts.manual);
      return results;
    } finally {
      this.running = false;
    }
  }

  /**
   * The baseline with the keys of files no longer in the folder dropped, saved
   * when it changed. `undefined` for a folder set before baselines existed.
   */
  private pruneBaseline(cfg: ScanFolderConfig, entries: readonly FolderEntry[]): string[] | undefined {
    if (!cfg.baseline) return undefined;
    const present = new Set(entries.map(historyKey));
    const kept = cfg.baseline.filter(key => present.has(key));
    if (kept.length !== cfg.baseline.length) this.deps.store.set(CONFIG_KEY, { ...cfg, baseline: kept });
    return kept;
  }

  /** Why a manual run found nothing, and what to do about files it passes over. */
  private nothingNewMessage(baseline: string[] | undefined, includeExisting: boolean): string {
    const { t } = this.deps;
    const nothing = t('No new files in the scan folder.');
    if (includeExisting) return nothing;
    if (baseline === undefined) {
      return `${nothing} ${t('Files that were already in the folder when it was set are skipped. Read them with "{0}", or set the folder again to take what is in it now as the starting point.', t('Process existing files too'))}`;
    }
    if (baseline.length === 0) return nothing;
    return `${nothing} ${t('{0} file(s) that were already in the folder when it was set are skipped. Read them with "{1}".', String(baseline.length), t('Process existing files too'))}`;
  }

  private async moveOriginal(folder: string, name: string, outcome: 'processed' | 'failed'): Promise<void> {
    const { fs, path } = this.node;
    const dir = path.join(folder, outcome === 'processed' ? PROCESSED_DIR : FAILED_DIR);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let target = path.join(dir, name);
      for (let i = 2; await exists(fs, target); i++) target = path.join(dir, `${stem}_${i}${ext}`);
      await fs.promises.rename(path.join(folder, name), target);
    } catch (err) {
      // Remembered in the history either way, so it is not read again.
      console.warn('[labnoteo] could not move scan original', name, err);
    }
  }
}

async function exists(fs: NodeFs, p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}
