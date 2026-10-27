/**
 * Reporting lab note usages to partbank: only lab notes, only references to
 * partbank-linked samples, only what changed since last time, and never a
 * Notice for a server that is down or too old.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { PartbankError } from '../../src/partbank/client';
import {
  PartbankUsageSync,
  cachedResolver,
  noteUsage,
  serverKey,
} from '../../src/partbank/partbankUsageSync';
import { resolveSampleDefinition } from '../../src/sampleActions';
import type { PcStore } from '../../src/scan/pcStore';
import type LabnotePlugin from '../../src/main';

const WEB = 'https://partbank.example';
const GLOBAL = 'resources/labsamples';
const EXP = 'labnote/001_GFP_expression';
const LOCAL = `${EXP}/resources/labsamples`;
const NOTE = `${EXP}/002_WB140.labnote.md`;
const OTHER = `${EXP}/003_WT060.labnote.md`;
const PART = '507f1f77bcf86cd799439011';
const PART2 = '507f1f77bcf86cd799439022';

const source = (id: string, origin = WEB) => ({
  system: 'partbank',
  connection: 'web',
  origin,
  type: 'part',
  id,
  kid: null,
});

let fs: MemFileSystem;
let notes: Map<string, string>;
let stored: Map<string, unknown>;
let client: {
  kind: 'web';
  origin: string;
  putNoteUsages: ReturnType<typeof vi.fn>;
  pruneNoteUsages: ReturnType<typeof vi.fn>;
};
let plugin: LabnotePlugin;
let sync: PartbankUsageSync;

const store: PcStore = {
  get: <T>(key: string) => stored.get(key) as T | undefined,
  set: (key, value) => {
    if (value === undefined) stored.delete(key);
    else stored.set(key, JSON.parse(JSON.stringify(value)));
  },
};

/** Every note sent, in order, as `path: [sample ids]`. */
const sentNotes = () =>
  client.putNoteUsages.mock.calls.flatMap(([body]) =>
    (body.notes as Array<{ note_path: string; refs: Array<{ sample_id: string }> }>).map(
      n => `${n.note_path}: ${n.refs.map(r => r.sample_id).join(',')}`
    )
  );

async function writeRegistry(folder: string, records: Record<string, unknown>): Promise<void> {
  await fs.write(`${folder}/DNA.json`, JSON.stringify(records));
}

beforeEach(async () => {
  fs = new MemFileSystem();
  notes = new Map();
  stored = new Map();
  client = {
    kind: 'web',
    origin: WEB,
    putNoteUsages: vi.fn().mockResolvedValue({ stored: 0, skipped: [] }),
    pruneNoteUsages: vi.fn().mockResolvedValue({ deleted: 0 }),
  };
  plugin = {
    fs,
    t: (key: string) => key,
    settings: { globalSampleFolder: GLOBAL, customSampleTypes: [], partbankSendUsages: true },
    app: {
      vault: {
        getMarkdownFiles: () => [...notes.keys()].map(p => new TFile(p)),
        getAbstractFileByPath: (p: string) => (notes.has(p) ? new TFile(p) : null),
        cachedRead: async (f: TFile) => notes.get(f.path) ?? '',
        getName: () => 'lab',
      },
    },
    partbank: {
      available: () => [{ kind: 'web', url: WEB, apiKey: 'pbk_1' }],
      client: () => client,
      clientForSource: (s: { connection: string; origin: string }) =>
        s.connection === 'web' && s.origin === WEB ? client : undefined,
      notifyError: vi.fn(),
    },
  } as unknown as LabnotePlugin;
  await writeRegistry(GLOBAL, {
    'DNA-1': { alias: 'pTrc', location: null, source: source(PART) },
    'DNA-2': { alias: null, location: null },
    'DNA-3': { alias: null, location: null, source: source(PART2, 'https://elsewhere.example') },
  });
  sync = new PartbankUsageSync(plugin, store);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what is sent', () => {
  it('sends the partbank-linked references of lab notes with their sections', async () => {
    notes.set(NOTE, ['# Run', '## Methods', 'Mix @DNA;DNA-1 and @DNA;DNA-2.', '## Results', 'Band of @DNA;DNA-1.'].join('\n'));

    await sync.syncAll();

    expect(client.putNoteUsages).toHaveBeenCalledTimes(1);
    const body = client.putNoteUsages.mock.calls[0][0];
    expect(body.vault_name).toBe('lab');
    expect(body.client_id).toEqual(expect.any(String));
    expect(body.notes).toEqual([
      {
        note_path: NOTE,
        note_title: '002_WB140',
        experiment: '001_GFP_expression',
        refs: [
          {
            type: 'part',
            id: PART,
            sample_type: 'DNA',
            sample_id: 'DNA-1',
            alias: 'pTrc',
            headings: ['Run › Methods', 'Run › Results'],
          },
        ],
      },
    ]);
  });

  it('leaves out AI callouts, other servers, and notes that are not lab notes', async () => {
    notes.set(NOTE, ['> [!note] AI suggestion', '> try @DNA;DNA-1', '', 'Use @DNA;DNA-3.'].join('\n'));
    notes.set('daily/2026-10-27.md', 'Used @DNA;DNA-1 today.');
    notes.set('templates/run.md', '@DNA;DNA-1');

    await sync.syncAll();

    expect(sentNotes()).toEqual([]);
  });

  it('sends a note outside any experiment without one', async () => {
    notes.set('scratch/idea.labnote.md', '@DNA;DNA-1');

    await sync.syncAll();

    expect(client.putNoteUsages.mock.calls[0][0].notes[0]).toMatchObject({
      note_title: 'idea',
      experiment: null,
    });
  });

  it('sends nothing when turned off or with no connection', async () => {
    notes.set(NOTE, '@DNA;DNA-1');
    plugin.settings.partbankSendUsages = false;
    await sync.syncAll();
    plugin.settings.partbankSendUsages = true;
    (plugin.partbank as unknown as { available: () => unknown[] }).available = () => [];
    await sync.syncAll();

    expect(client.putNoteUsages).not.toHaveBeenCalled();
  });
});

describe('changes only', () => {
  beforeEach(async () => {
    notes.set(NOTE, '@DNA;DNA-1');
    notes.set(OTHER, 'nothing linked');
    await sync.syncAll();
    client.putNoteUsages.mockClear();
    client.pruneNoteUsages.mockClear();
  });

  it('does not resend a note whose references did not change', async () => {
    notes.set(NOTE, 'Edited text, same @DNA;DNA-1.');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    await sync.syncAll();

    expect(client.putNoteUsages).not.toHaveBeenCalled();
    expect(client.pruneNoteUsages).not.toHaveBeenCalled();
  });

  it('sends a note again when its references changed, and empty when they are gone', async () => {
    notes.set(NOTE, '## Results\n@DNA;DNA-1');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    notes.set(NOTE, 'no references left');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    sync.markDirty(NOTE);
    await sync.syncDirty();

    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`, `${NOTE}: `]);
  });

  it('clears a renamed or deleted note', async () => {
    const moved = `${EXP}/004_moved.labnote.md`;
    notes.delete(NOTE);
    notes.set(moved, '@DNA;DNA-1');
    sync.markDirty(NOTE);
    sync.markDirty(moved);
    await sync.syncDirty();

    expect(sentNotes().sort()).toEqual([`${moved}: DNA-1`, `${NOTE}: `].sort());
  });

  it('notices a note deleted while the plugin was off on the next full pass', async () => {
    notes.delete(NOTE);

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: `]);
  });

  it('picks up a registry change in a note that did not change', async () => {
    await writeRegistry(GLOBAL, { 'DNA-1': { alias: 'pTrc', location: null } });

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: `]);
  });
});

describe('backfill', () => {
  it('tags the first pass with a generation and prunes the rest once it went through', async () => {
    notes.set(NOTE, '@DNA;DNA-1');

    await sync.syncAll();

    const generation = client.putNoteUsages.mock.calls[0][0].generation;
    expect(client.pruneNoteUsages).toHaveBeenCalledWith({
      client_id: client.putNoteUsages.mock.calls[0][0].client_id,
      generation,
    });
  });

  it('does not prune after a failed batch, and starts over next time', async () => {
    notes.set(NOTE, '@DNA;DNA-1');
    client.putNoteUsages.mockRejectedValueOnce(new PartbankError('offline', undefined, 'down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sync.syncAll();
    expect(client.pruneNoteUsages).not.toHaveBeenCalled();

    await sync.syncAll();
    const [first, second] = client.putNoteUsages.mock.calls.map(([b]) => b.generation);
    expect(second).not.toBe(first);
    expect(client.pruneNoteUsages).toHaveBeenCalledWith(expect.objectContaining({ generation: second }));
  });

  it('runs again when the key changes', async () => {
    notes.set(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    (plugin.partbank as unknown as { available: () => unknown[] }).available = () => [
      { kind: 'web', url: WEB, apiKey: 'pbk_2' },
    ];

    await sync.syncAll();

    expect(client.putNoteUsages).toHaveBeenCalledTimes(2);
    expect(client.pruneNoteUsages).toHaveBeenCalledTimes(2);
  });
});

describe('failures', () => {
  beforeEach(() => {
    notes.set(NOTE, '@DNA;DNA-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it.each([404, 405])('stops sending to a server that answers %i for the session', async status => {
    client.putNoteUsages.mockRejectedValue(new PartbankError(status === 404 ? 'notFound' : 'server', status, ''));

    await sync.syncAll();
    sync.markDirty(NOTE);
    await sync.syncDirty();
    await sync.syncAll();

    expect(client.putNoteUsages).toHaveBeenCalledTimes(1);
    expect(plugin.partbank.notifyError).not.toHaveBeenCalled();
  });

  it('keeps the note queued across restarts while the server is down', async () => {
    vi.useFakeTimers();
    client.putNoteUsages.mockRejectedValue(new PartbankError('offline', undefined, 'down'));
    sync.markDirty(NOTE);
    await sync.syncDirty();
    expect(stored.get('partbankUsageDirty')).toEqual([NOTE]);

    client.putNoteUsages.mockResolvedValue({ stored: 1, skipped: [] });
    const restarted = new PartbankUsageSync(plugin, store);
    await restarted.syncDirty();

    expect(sentNotes().at(-1)).toBe(`${NOTE}: DNA-1`);
    expect(stored.has('partbankUsageDirty')).toBe(false);
  });

  it('tells about a refused key once', async () => {
    client.putNoteUsages.mockRejectedValue(new PartbankError('unauthorized', 401, ''));

    await sync.syncAll();
    await sync.syncAll();

    expect(plugin.partbank.notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('turning it off', () => {
  it('prunes everything this PC sent and forgets it', async () => {
    notes.set(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    client.pruneNoteUsages.mockClear();

    await sync.disable();

    const [{ client_id, generation }] = client.pruneNoteUsages.mock.calls[0];
    expect(client_id).toBe(stored.get('partbankUsageClientId'));
    expect(generation).toMatch(/^off-/);
    expect(stored.has('partbankUsageSent')).toBe(false);
    expect(stored.has('partbankUsageBackfill')).toBe(false);
  });
});

describe('cachedResolver', () => {
  it('names the same sample as Go to definition (Local first, then Global)', async () => {
    await writeRegistry(LOCAL, { 'DNA-1': { alias: 'local copy', location: null, source: source(PART2) } });
    const resolve = cachedResolver(plugin);

    for (const [id, docPath] of [
      ['DNA-1', NOTE],
      ['DNA-1', 'scratch/x.labnote.md'],
      ['DNA-2', NOTE],
      ['DNA-9', NOTE],
    ]) {
      expect(await resolve('DNA', id, docPath)).toEqual(
        await resolveSampleDefinition(plugin, { type: 'DNA', id, docPath })
      );
    }
    expect((await resolve('DNA', 'DNA-1', NOTE))?.record.alias).toBe('local copy');
  });
});

describe('helpers', () => {
  it('keys a server by kind and origin', () => {
    expect(serverKey({ kind: 'web', origin: 'https://PB.example' })).toBe('web:https://pb.example');
  });

  it('sorts refs so the same note always hashes the same', () => {
    const a = { type: 'part' as const, id: 'b', sample_type: 'DNA', sample_id: '1', headings: [] };
    const b = { type: 'part' as const, id: 'a', sample_type: 'DNA', sample_id: '2', headings: [] };
    expect(noteUsage(NOTE, [a, b])).toEqual(noteUsage(NOTE, [b, a]));
  });
});
