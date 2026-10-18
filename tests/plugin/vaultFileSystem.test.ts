/**
 * `VaultFileSystem` against the shared {@link runLabnoteFsContract} suite.
 *
 * The contract's atomicity case is the point of this file: core's sample
 * storage runs its whole scan-and-prune inside `fs.modify`, so a `modify` that
 * is really a read-await-write silently reintroduces the `{Type}.json`
 * lost-update bug. Both adapter shapes are exercised — one exposing Obsidian's
 * atomic `process()`, one without it (older/edge hosts take the fallback path).
 */
import { describe, it, expect } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { runLabnoteFsContract } from '../../packages/labnoteo-core/src/__tests__/labnoteFsContract';
import { VaultFileSystem } from '../../src/vaultFileSystem';

/** Yield to the microtask queue so concurrent callers can interleave. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

interface ErrnoError extends Error {
  code?: string;
}

/**
 * In-memory stand-in for Obsidian's `DataAdapter`, without `process()`.
 *
 * Every async method awaits a real timer first, which is what makes the
 * interleaving in the atomicity test observable — without it a read-await-write
 * `modify` could pass by luck.
 */
class FakeAdapter {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  async exists(p: string): Promise<boolean> {
    await tick();
    return this.files.has(p) || this.dirs.has(p);
  }

  async read(p: string): Promise<string> {
    await tick();
    const v = this.files.get(p);
    if (v === undefined) {
      const err = new Error(`ENOENT: no such file, open '${p}'`) as ErrnoError;
      err.code = 'ENOENT';
      throw err;
    }
    return v;
  }

  async write(p: string, data: string): Promise<void> {
    await tick();
    this.files.set(p, data);
  }

  /**
   * Obsidian's `mkdir` creates intermediate folders — the plugin relies on it
   * (`resources/labsamples/DNA.json` works even when `resources` is absent,
   * and `VaultFileSystem.ensureParent` only ever calls `mkdir` once).
   */
  async mkdir(p: string): Promise<void> {
    await tick();
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    await tick();
    const prefix = p.endsWith('/') ? p : `${p}/`;
    const files: string[] = [];
    const folders: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) files.push(key);
    }
    for (const key of this.dirs) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) folders.push(key);
    }
    return { files, folders };
  }

  async remove(p: string): Promise<void> {
    await tick();
    this.files.delete(p);
  }

  async rmdir(p: string, _recursive: boolean): Promise<void> {
    await tick();
    this.dirs.delete(p);
  }
}

/**
 * The same fake plus Obsidian's atomic `process()`, which deliberately does NOT
 * await between its read and its write.
 */
class AtomicFakeAdapter extends FakeAdapter {
  async process(p: string, fn: (data: string) => string): Promise<string> {
    const current = this.files.get(p);
    if (current === undefined) {
      const err = new Error(`ENOENT: no such file, open '${p}'`) as ErrnoError;
      err.code = 'ENOENT';
      throw err;
    }
    // No `await` between read and write: this is the atomic span.
    const next = fn(current);
    this.files.set(p, next);
    await tick();
    return next;
  }
}

const asAdapter = (fake: FakeAdapter): DataAdapter => fake as unknown as DataAdapter;

runLabnoteFsContract(
  'VaultFileSystem (adapter.process)',
  () => new VaultFileSystem(asAdapter(new AtomicFakeAdapter()))
);

runLabnoteFsContract(
  'VaultFileSystem (no adapter.process)',
  () => new VaultFileSystem(asAdapter(new FakeAdapter()))
);

describe('VaultFileSystem path handling', () => {
  it('strips a leading slash so the adapter sees a vault-relative path', async () => {
    const adapter = new FakeAdapter();
    const fs = new VaultFileSystem(asAdapter(adapter));
    await fs.write('/labnote/001_Exp/note.md', 'x');
    expect([...adapter.files.keys()]).toEqual(['labnote/001_Exp/note.md']);
  });

  it('list returns bare entry names for both files and folders', async () => {
    const adapter = new FakeAdapter();
    const fs = new VaultFileSystem(asAdapter(adapter));
    await fs.write('dir/a.txt', '1');
    await fs.mkdir('dir/sub');
    expect((await fs.list('dir')).sort()).toEqual(['a.txt', 'sub']);
  });

  it('serializes a plain write against a concurrent modify on the same path', async () => {
    const adapter = new FakeAdapter();
    const fs = new VaultFileSystem(asAdapter(adapter));
    await fs.write('c.json', JSON.stringify({ n: 0, tag: 'start' }));

    // `saveSamplesByType` still writes wholesale while `saveSamplesFromDocument`
    // goes through `modify`; without a shared per-path queue the write lands in
    // the middle of the read-modify-write and one of the two updates vanishes.
    await Promise.all([
      fs.modify('c.json', raw => {
        const obj = JSON.parse(raw) as { n: number; tag: string };
        obj.n += 1;
        return JSON.stringify(obj);
      }),
      fs.write('c.json', JSON.stringify({ n: 0, tag: 'overwritten' })),
    ]);

    const final = JSON.parse(await fs.read('c.json')) as { n: number; tag: string };
    // Whichever order they settle in, the loser must be a whole operation --
    // never a torn mix of both.
    const outcomes = [
      { n: 1, tag: 'start' },
      { n: 0, tag: 'overwritten' },
      { n: 1, tag: 'overwritten' },
    ];
    expect(outcomes).toContainEqual(final);
  });
});

/** Desktop Obsidian removes with `fs.rm`, which throws EISDIR for a folder unless recursive. */
class FsRmAdapter extends FakeAdapter {
  async rmdir(p: string, recursive: boolean): Promise<void> {
    if (!recursive) {
      const err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`) as ErrnoError;
      err.code = 'EISDIR';
      throw err;
    }
    await super.rmdir(p, recursive);
  }
}

describe('VaultFileSystem rmdir on the desktop adapter', () => {
  it('removes an empty folder', async () => {
    const adapter = new FsRmAdapter();
    const fs = new VaultFileSystem(asAdapter(adapter));
    await fs.mkdir('resources/labsamples');
    await fs.rmdir('resources/labsamples');
    expect(adapter.dirs.has('resources/labsamples')).toBe(false);
  });

  it('leaves a folder that still has files', async () => {
    const adapter = new FsRmAdapter();
    const fs = new VaultFileSystem(asAdapter(adapter));
    await fs.write('resources/labsamples/DNA.json', '{}');
    await fs.rmdir('resources/labsamples');
    expect(adapter.dirs.has('resources/labsamples')).toBe(true);
    expect(adapter.files.has('resources/labsamples/DNA.json')).toBe(true);
  });
});
