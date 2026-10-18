/**
 * VaultFileSystem — the Obsidian implementation of {@link LabnoteFs}.
 *
 * Backed by Obsidian's `DataAdapter` (`app.vault.adapter`), which speaks
 * vault-relative POSIX paths and is fully async. We deliberately use the
 * *adapter* rather than the `Vault`/`TFile` API because sample/workflow storage
 * files (`resources/labsamples/*.json`, catalog JSON) are plain data files that
 * may live outside the markdown file cache, and the adapter gives uniform
 * path-based access to them.
 *
 * Atomicity (see the `LabnoteFs.modify` contract): `modify` delegates to the
 * adapter's own `process()`, whose synchronous callback is exactly the shape the
 * contract requires. Two gaps `process()` cannot close are covered by a
 * per-path queue: creating a file that does not exist yet (`process` reads
 * first, so it cannot), and plain `write` calls landing in the middle of
 * someone else's read-modify-write. What none of this covers is a second
 * Obsidian process on the same vault — the queue is per plugin instance.
 */
import type { DataAdapter } from 'obsidian';
import type { LabnoteFs } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';

/**
 * `DataAdapter.process` is declared non-optional, but it is old enough that the
 * mobile adapter's declaration carries a later `@since` than our
 * `minAppVersion`. Probing for it at runtime keeps that floor where it is.
 */
interface MaybeAtomicAdapter {
  process?: (path: string, fn: (data: string) => string) => Promise<string>;
}

export class VaultFileSystem implements LabnoteFs {
  /** Tail of the pending operation chain for each path, keyed by normalized path. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly adapter: DataAdapter) {}

  /**
   * Run `task` after every operation already queued for `key`. A failed task
   * does not poison the chain: successors run regardless, and only the caller
   * that queued it sees the rejection.
   */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      // Only the current tail may clear the entry; a later queuer already
      // replaced it and is still waiting.
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(normalize(path));
  }

  async write(path: string, content: string): Promise<void> {
    const p = normalize(path);
    return this.enqueue(p, async () => {
      await this.ensureParent(p);
      await this.adapter.write(p, content);
    });
  }

  async modify(path: string, updater: (data: string) => string): Promise<void> {
    const p = normalize(path);
    return this.enqueue(p, async () => {
      await this.ensureParent(p);
      if (!(await this.adapter.exists(p))) {
        // `process` starts by reading, so a brand-new file has to be created
        // here. The queue is what makes this branch safe.
        await this.adapter.write(p, updater(''));
        return;
      }
      const atomic = (this.adapter as unknown as MaybeAtomicAdapter).process;
      if (typeof atomic === 'function') {
        await atomic.call(this.adapter, p, updater);
        return;
      }
      await this.adapter.write(p, updater(await this.adapter.read(p)));
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalize(path));
  }

  async mkdir(path: string): Promise<void> {
    const p = normalize(path);
    if (!(await this.adapter.exists(p))) {
      await this.adapter.mkdir(p);
    }
  }

  async list(dir: string): Promise<string[]> {
    const p = normalize(dir);
    if (!(await this.adapter.exists(p))) return [];
    const listed = await this.adapter.list(p);
    // The adapter returns full vault-relative paths for both files and folders;
    // LabnoteFs.list is specified to return bare entry names.
    return [...listed.files, ...listed.folders].map(entry => posix.basename(entry));
  }

  async remove(path: string): Promise<void> {
    const p = normalize(path);
    if (await this.adapter.exists(p)) {
      await this.adapter.remove(p);
    }
  }

  async rmdir(path: string): Promise<void> {
    const p = normalize(path);
    if (!(await this.adapter.exists(p))) return;
    // Check emptiness rather than relying on the adapter to refuse: the
    // contract's "no-op if not empty" must not depend on which error a given
    // host throws. `recursive` stays true because the desktop adapter removes
    // with `fs.rm`, which throws EISDIR for any folder without it.
    const listed = await this.adapter.list(p);
    if (listed.files.length > 0 || listed.folders.length > 0) return;
    await this.adapter.rmdir(p, true);
  }

  /**
   * Create the parent directory of a file path. One `mkdir` suffices: the
   * adapter creates intermediate folders, which is why writing
   * `.../resources/labsamples/DNA.json` works with neither folder present.
   */
  private async ensureParent(filePath: string): Promise<void> {
    const dir = posix.dirname(filePath);
    if (dir && dir !== '.' && dir !== '/' && !(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }
  }
}

/**
 * Normalise an incoming path to the vault-relative POSIX form the adapter
 * expects. A leading `/` is stripped since the adapter roots everything at the
 * vault folder.
 */
function normalize(path: string): string {
  const p = posix.normalize(path);
  return p.startsWith('/') ? p.slice(1) : p;
}
