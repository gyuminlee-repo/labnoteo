/**
 * Adding a sample from the sidebar or the command generates its ID, so the
 * alias/description/location prompts are the only steps left — closing any of
 * them has to abandon the add, or a mistaken click leaves an empty sample
 * behind in the registry (#30).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createSampleInteractive, insertSampleReference } from '../../src/sampleActions';
import { promptModal } from '../../src/modals';
import type { EditTarget } from '@labnoteo/core';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/modals', () => ({
  promptModal: vi.fn(),
  confirmModal: vi.fn(),
  pickModal: vi.fn(),
}));

const FOLDER = 'labnote/001_Test/resources/labsamples';
const REGISTRY = `${FOLDER}/RNA.json`;

let fs: MemFileSystem;
let plugin: LabnotePlugin;

beforeEach(() => {
  vi.mocked(promptModal).mockReset();
  fs = new MemFileSystem();
  plugin = {
    fs,
    t: (key: string) => key,
    refreshSampleViews: vi.fn(),
  } as unknown as LabnotePlugin;
});

/** Answer the alias, description, and location prompts in order. */
const answer = (...values: (string | undefined)[]): void => {
  for (const v of values) vi.mocked(promptModal).mockResolvedValueOnce(v);
};

const add = () =>
  createSampleInteractive(new App(), plugin, { type: 'RNA', folder: FOLDER, mode: 'generate' });

describe('createSampleInteractive', () => {
  it.each([
    ['alias', [undefined], 1],
    ['description', ['R1', undefined], 2],
    ['location', ['R1', 'note', undefined], 3],
  ] as const)('registers nothing when the %s prompt is closed', async (_step, values, prompts) => {
    answer(...values);

    expect(await add()).toBeUndefined();
    expect(vi.mocked(promptModal)).toHaveBeenCalledTimes(prompts);
    expect(await fs.exists(REGISTRY)).toBe(false);
    expect(plugin.refreshSampleViews).not.toHaveBeenCalled();
  });

  it('registers a blank sample when every prompt is submitted empty', async () => {
    answer('', '', '');

    const created = await add();
    expect(created?.alias).toBeNull();
    const records = JSON.parse(await fs.read(REGISTRY));
    expect(records[created!.id]).toMatchObject({ alias: null, descriptions: [], location: null });
  });

  it('stores what was entered', async () => {
    answer(' R1 ', 'first run', 'Freezer-2 / Box-3 / A1');

    const created = await add();
    const records = JSON.parse(await fs.read(REGISTRY));
    expect(records[created!.id]).toMatchObject({
      alias: 'R1',
      descriptions: ['first run'],
      location: 'Freezer-2 / Box-3 / A1',
    });
    expect(plugin.refreshSampleViews).toHaveBeenCalledOnce();
  });
});

describe('insertSampleReference', () => {
  /** A minimal EditTarget backed by a mutable string + cursor. */
  function makeTarget(text: string, cursor: number) {
    const state = { text, revealed: -1 };
    const target: EditTarget = {
      path: 'labnote/001_Test/001_WD010_Design.labnote.md',
      getText: async () => state.text,
      getCursorOffset: async () => cursor,
      insertAtCursor: async (t: string) => {
        state.text = state.text.slice(0, cursor) + t + state.text.slice(cursor);
      },
      replaceRange: async (start: number, end: number, t: string) => {
        state.text = state.text.slice(0, start) + t + state.text.slice(end);
      },
      revealOffset: async (offset: number) => {
        state.revealed = offset;
      },
    };
    return { target, state };
  }

  const refPlugin = () =>
    ({
      settings: { customSampleTypes: [] },
      markUserEdit: vi.fn(),
    }) as unknown as LabnotePlugin;

  it('appends below the last section when the cursor sits in the front matter, and marks the edit', async () => {
    const doc = '---\nstatus: planned\n---\n\n## Summary\n';
    const { target, state } = makeTarget(doc, 10); // inside front matter
    const plugin = refPlugin();

    await insertSampleReference(plugin, target, 'RNA-1;siKIF');

    expect(state.text).toBe(doc + 'RNA-1;siKIF\n');
    expect(plugin.markUserEdit).toHaveBeenCalledWith(target.path);
    expect(state.revealed).toBeGreaterThanOrEqual(0);
  });

  it('appends to the line end when the cursor is on an existing reference', async () => {
    const doc = '## Samples\nused RNA-2;siX here\n';
    const cursor = doc.indexOf('RNA-2') + 2;
    const { target, state } = makeTarget(doc, cursor);

    await insertSampleReference(refPlugin(), target, 'RNA-1;siKIF');

    expect(state.text).toBe('## Samples\nused RNA-2;siX here RNA-1;siKIF\n');
  });
});
