/**
 * Adding a sample from the sidebar or the command generates its ID, so the
 * alias/description/location prompts are the only steps left — closing any of
 * them has to abandon the add, or a mistaken click leaves an empty sample
 * behind in the registry (#30).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createSampleInteractive } from '../../src/sampleActions';
import { promptModal } from '../../src/modals';
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
