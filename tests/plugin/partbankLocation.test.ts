/**
 * The location refresh writes to `record.location` rather than resolving on
 * every draw, so the sample tree, search, the sample table and the MCP tools
 * keep working unchanged and the last known location survives being offline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MemFileSystem, type SampleSource } from '@labnoteo/core';
import { loadSamplesByType, upsertSampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { __setRequestUrlHandler, type RequestUrlResponse } from '../stubs/obsidian';
import {
  PartbankLocationProvider,
  applyLocationChanges,
  checkedByDefault,
  linkedSamplesIn,
  locationChangesOf,
  type LocationChange,
} from '../../src/partbank/partbankLocation';
import { PartbankFeature } from '../../src/partbank/partbankFeature';
import type LabnotePlugin from '../../src/main';

const WEB = 'https://partbank.kbiofoundry.kr';
const LOCAL = 'labnote/001_Exp/resources/labsamples';
const GLOBAL = 'resources/labsamples';

const source = (overrides: Partial<SampleSource> = {}): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin: WEB,
  type: 'part',
  id: '507f1f77bcf86cd799439011',
  kid: 'KBp_aa0001',
  ...overrides,
});

/** A plugin stand-in with only what these functions read. */
function fakePlugin(fs: MemFileSystem): LabnotePlugin {
  let changed = 0;
  const plugin = {
    fs,
    t: (key: string) => key,
    settings: {
      customSampleTypes: [],
      globalSampleFolder: GLOBAL,
      partbankDesktopUrl: 'http://127.0.0.1:47830',
      partbankWebUrl: WEB,
      partbankDefaultConnection: 'web',
    },
    samplesChanged: () => {
      changed++;
    },
    get samplesChangedCount(): number {
      return changed;
    },
  };
  return plugin as unknown as LabnotePlugin;
}

/** A feature whose key store lives in memory, so no vault is needed. */
function fakeFeature(plugin: LabnotePlugin, apiKey = 'pbk_x'): PartbankFeature {
  const kept: Record<string, unknown> = { partbank: { web: apiKey } };
  return new PartbankFeature(plugin, {
    get: <T,>(key: string) => kept[key] as T | undefined,
    set: (key, value) => {
      kept[key] = value;
    },
  });
}

afterEach(() => __setRequestUrlHandler(null));

describe('PartbankLocationProvider', () => {
  const stocks = (items: unknown[]): void => {
    __setRequestUrlHandler(
      () => ({ status: 200, text: JSON.stringify({ items }), headers: {} }) as RequestUrlResponse
    );
  };

  it('reads the location partbank reports', async () => {
    const plugin = fakePlugin(new MemFileSystem());
    stocks([{ storage: { name: 'Freezer-2' }, stock_box: { name: 'Box-3' }, hole_position: 'A1' }]);
    const provider = new PartbankLocationProvider(fakeFeature(plugin));
    await expect(provider.fetch(source())).resolves.toBe('Freezer-2 / Box-3 / A1');
  });

  it('reads an item with no visible stock as no location', async () => {
    const plugin = fakePlugin(new MemFileSystem());
    stocks([]);
    await expect(new PartbankLocationProvider(fakeFeature(plugin)).fetch(source())).resolves.toBeNull();
  });

  // Offline, the last known location is still the best answer available.
  it('falls back to the stored location when the lookup fails', async () => {
    const plugin = fakePlugin(new MemFileSystem());
    __setRequestUrlHandler(() => {
      throw new Error('ECONNREFUSED');
    });
    const provider = new PartbankLocationProvider(fakeFeature(plugin));
    await expect(
      provider.getLocation({
        type: 'DNA',
        id: 'DNA-1',
        record: { type: 'DNA', alias: null, descriptions: [], sources: [], location: 'Freezer-1', source: source() },
      })
    ).resolves.toBe('Freezer-1');
  });

  it('leaves an unlinked sample to the local field without calling out', async () => {
    const plugin = fakePlugin(new MemFileSystem());
    // No handler installed: the stub throws if anything calls out.
    const provider = new PartbankLocationProvider(fakeFeature(plugin));
    await expect(
      provider.getLocation({
        type: 'DNA',
        id: 'DNA-1',
        record: { type: 'DNA', alias: null, descriptions: [], sources: [], location: 'Shelf A' },
      })
    ).resolves.toBe('Shelf A');
  });

  // A link to a server that is not set up must not be fetched from another.
  it('refuses a link no configured connection matches', async () => {
    const plugin = fakePlugin(new MemFileSystem());
    const provider = new PartbankLocationProvider(fakeFeature(plugin));
    await expect(provider.fetch(source({ origin: 'https://other.kr' }))).rejects.toMatchObject({
      kind: 'notFound',
    });
  });
});

describe('linkedSamplesIn', () => {
  it('finds the linked samples in both scopes and skips the rest', async () => {
    const fs = new MemFileSystem();
    const plugin = fakePlugin(fs);
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-1', {
      alias: 'a',
      description: null,
      source: source(),
    });
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-2', { alias: 'b', description: null });
    await upsertSampleRecord(fs, GLOBAL, 'Primer', 'Primer-1', {
      alias: 'p',
      description: null,
      source: source({ type: 'primer' }),
    });

    const linked = await linkedSamplesIn(plugin, [LOCAL, GLOBAL, '']);
    expect(linked.map(l => l.id).sort()).toEqual(['DNA-1', 'Primer-1']);
    expect(linked.find(l => l.id === 'Primer-1')?.folder).toBe(GLOBAL);
  });
});

describe('locationChangesOf / checkedByDefault', () => {
  const row = (before: string | null, after: string | null): LocationChange => ({
    type: 'DNA',
    id: 'DNA-1',
    alias: 'a',
    folder: LOCAL,
    before,
    after,
  });

  it('keeps only the rows whose text actually differs', () => {
    expect(
      locationChangesOf([row('A', 'A'), row(null, ''), row('A', 'B'), row(null, 'C')])
    ).toHaveLength(2);
  });

  // partbank showing no stock is often a sharing boundary, not a move, and
  // the text may have been typed by hand.
  it('leaves a change that would empty the location unticked', () => {
    expect(checkedByDefault(row('A', 'B'))).toBe(true);
    expect(checkedByDefault(row('A', null))).toBe(false);
    expect(checkedByDefault(row('A', ''))).toBe(false);
  });
});

describe('applyLocationChanges', () => {
  it('writes the new location and leaves the rest of the record alone', async () => {
    const fs = new MemFileSystem();
    const plugin = fakePlugin(fs);
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: 'KBp_aa0001',
      source: source(),
    });
    await applyLocationChanges(plugin, [
      { type: 'DNA', id: 'DNA-1', alias: 'gfp', folder: LOCAL, before: null, after: 'Freezer-2 / Box-3 / A1' },
    ]);

    const rec = (await loadSamplesByType(fs, LOCAL, 'DNA'))['DNA-1'];
    expect(rec.location).toBe('Freezer-2 / Box-3 / A1');
    expect(rec.alias).toBe('gfp');
    expect(rec.descriptions).toEqual(['KBp_aa0001']);
    // Losing the link here would make the next refresh impossible.
    expect(rec.source).toEqual(source());
  });

  it('skips a sample that is gone and writes nothing for an empty list', async () => {
    const fs = new MemFileSystem();
    const plugin = fakePlugin(fs);
    await applyLocationChanges(plugin, [
      { type: 'DNA', id: 'DNA-9', alias: null, folder: LOCAL, before: null, after: 'X' },
    ]);
    expect(await loadSamplesByType(fs, LOCAL, 'DNA')).toEqual({});
  });
});
