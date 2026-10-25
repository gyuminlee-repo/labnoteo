/**
 * `moveSampleInteractive` must move a sample between the folders the Samples
 * sidebar is *currently showing*, not folders it re-derives from the active
 * file. The regression this pins: a Global -> Local move used to resolve its
 * Local target from `plugin.localSampleFolder()`, which follows the active note
 * / last-opened experiment. If focus had moved since the tree was drawn, the
 * sample landed in a different experiment than the one the user right-clicked.
 *
 * The fix threads the rendered folders in as `fromFolder`/`toFolder`, so these
 * tests deliberately point `plugin.localSampleFolder()` at a WRONG experiment
 * and assert the move ignores it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type LabnotePlugin from '../../src/main';
import { moveSampleInteractive } from '../../src/sampleActions';
import { confirmModal } from '../../src/modals';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import {
  putSampleRecord,
  loadSamplesByType,
  type SampleRecord,
} from '../../packages/labnoteo-core/src/lib/sampleStorage';

const GLOBAL = 'resources/labsamples';
const RENDERED_LOCAL = 'labnote/111_Shown/resources/labsamples';
const WRONG_LOCAL = 'labnote/999_Stale/resources/labsamples';
const TYPE = 'Reagent';

function record(alias: string): SampleRecord {
  return { type: TYPE, alias, descriptions: [], sources: [], location: null };
}

/**
 * Minimal plugin double. `localSampleFolder` is pointed at the WRONG experiment
 * on purpose: the fixed move must never consult it.
 */
function makePlugin(fs: MemFileSystem) {
  let refreshed = 0;
  const plugin = {
    fs,
    t: (key: string, ...args: string[]) =>
      args.reduce<string>((s, a, i) => s.replace(`{${i}}`, a), key),
    settings: { customSampleTypes: [], globalSampleFolder: GLOBAL },
    localSampleFolder: () => WRONG_LOCAL,
    refreshSampleViews: () => {
      refreshed += 1;
    },
  };
  return { plugin: plugin as unknown as LabnotePlugin, getRefreshed: () => refreshed };
}

vi.mock('../../src/modals', () => ({
  promptModal: vi.fn(),
  confirmModal: vi.fn(),
  pickModal: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(confirmModal).mockReset();
});

/** A vault whose markdown notes are `notes` (path -> text), none of them open. */
function makeApp(notes: Record<string, string> = {}): App {
  return {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      getMarkdownFiles: () => Object.keys(notes).map(p => new TFile(p)),
      cachedRead: async (file: TFile) => notes[file.path],
    },
  } as unknown as App;
}

const APP = makeApp();

describe('moveSampleInteractive — targets the rendered folder', () => {
  it('moves Global -> Local into the shown experiment, not the active-file one', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-1', record('water'));
    const { plugin, getRefreshed } = makePlugin(fs);

    const moved = await moveSampleInteractive(APP, plugin, {
      fromScope: 'global',
      fromFolder: GLOBAL,
      toFolder: RENDERED_LOCAL,
      type: TYPE,
      id: 'Reagent-1',
    });

    expect(moved).toBe(true);
    // Landed in the folder the tree rendered…
    const local = await loadSamplesByType(fs, RENDERED_LOCAL, TYPE);
    expect(local['Reagent-1']).toEqual(record('water'));
    // …never in the (stale) folder localSampleFolder() points at…
    expect(await loadSamplesByType(fs, WRONG_LOCAL, TYPE)).toEqual({});
    // …and the source no longer holds it.
    expect(await loadSamplesByType(fs, GLOBAL, TYPE)).toEqual({});
    expect(getRefreshed()).toBe(1);
  });

  it('moves Local -> Global into the rendered global folder', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, RENDERED_LOCAL, TYPE, 'Reagent-2', record('buffer'));
    const { plugin } = makePlugin(fs);

    const moved = await moveSampleInteractive(APP, plugin, {
      fromScope: 'local',
      fromFolder: RENDERED_LOCAL,
      toFolder: GLOBAL,
      type: TYPE,
      id: 'Reagent-2',
    });

    expect(moved).toBe(true);
    expect((await loadSamplesByType(fs, GLOBAL, TYPE))['Reagent-2']).toEqual(record('buffer'));
    expect(await loadSamplesByType(fs, RENDERED_LOCAL, TYPE)).toEqual({});
  });

  it('refuses to move when a scope folder is unresolved (empty), writing nothing', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-3', record('x'));
    const { plugin, getRefreshed } = makePlugin(fs);
    const before = fs.snapshot();

    const moved = await moveSampleInteractive(APP, plugin, {
      fromScope: 'global',
      fromFolder: GLOBAL,
      toFolder: '', // Local scope not resolvable (no experiment rendered yet)
      type: TYPE,
      id: 'Reagent-3',
    });

    expect(moved).toBe(false);
    // Nothing written, nothing deleted — the sample stays put in Global.
    expect(fs.snapshot()).toEqual(before);
    expect(getRefreshed()).toBe(0);
  });
});

// #78: other experiments resolve a Global sample until it becomes Local to one.
describe('moveSampleInteractive — Global -> Local warns about other experiments', () => {
  const move = (app: App, plugin: LabnotePlugin, id: string) =>
    moveSampleInteractive(app, plugin, {
      fromScope: 'global',
      fromFolder: GLOBAL,
      toFolder: RENDERED_LOCAL,
      type: TYPE,
      id,
    });

  it('asks first and keeps the sample Global when the user declines', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-4', record('salt'));
    const { plugin } = makePlugin(fs);
    const app = makeApp({
      'labnote/111_Shown/001_WD010_A.labnote.md': 'Reagent-4;salt',
      'labnote/222_Other/001_WD010_B.labnote.md': 'Reagent-4;salt',
    });
    vi.mocked(confirmModal).mockResolvedValue(false);

    expect(await move(app, plugin, 'Reagent-4')).toBe(false);

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain('labnote/222_Other/001_WD010_B.labnote.md');
    expect(vi.mocked(confirmModal).mock.calls[0][1]).not.toContain('111_Shown');
    expect((await loadSamplesByType(fs, GLOBAL, TYPE))['Reagent-4']).toEqual(record('salt'));
    expect(await loadSamplesByType(fs, RENDERED_LOCAL, TYPE)).toEqual({});
  });

  it('moves after the user agrees', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-4', record('salt'));
    const { plugin } = makePlugin(fs);
    const app = makeApp({ 'Welcome.md': 'Reagent-4' });
    vi.mocked(confirmModal).mockResolvedValue(true);

    expect(await move(app, plugin, 'Reagent-4')).toBe(true);
    expect((await loadSamplesByType(fs, RENDERED_LOCAL, TYPE))['Reagent-4']).toEqual(record('salt'));
  });

  it('does not ask when only the target experiment uses it', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-4', record('salt'));
    const { plugin } = makePlugin(fs);
    const app = makeApp({ 'labnote/111_Shown/001_WD010_A.labnote.md': 'Reagent-4;salt' });

    expect(await move(app, plugin, 'Reagent-4')).toBe(true);
    expect(confirmModal).not.toHaveBeenCalled();
  });

  it('does not check references for a Local -> Global move', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, RENDERED_LOCAL, TYPE, 'Reagent-5', record('x'));
    const { plugin } = makePlugin(fs);
    const app = makeApp({ 'labnote/222_Other/001_WD010_B.labnote.md': 'Reagent-5' });

    const moved = await moveSampleInteractive(app, plugin, {
      fromScope: 'local',
      fromFolder: RENDERED_LOCAL,
      toFolder: GLOBAL,
      type: TYPE,
      id: 'Reagent-5',
    });

    expect(moved).toBe(true);
    expect(confirmModal).not.toHaveBeenCalled();
  });
});

// #336: the README's sample list kept the old scope.
describe('moveSampleInteractive — sample list tables', () => {
  it("rewrites the sample's row in the experiment's notes", async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, RENDERED_LOCAL, TYPE, 'Reagent-2', record('buffer'));
    const readme = 'labnote/111_Shown/README.labnote.md';
    await fs.write(
      readme,
      '| ID | Alias | Description | Location | Scope | Discarded |\n| --- | --- | --- | --- | --- | --- |\n| Reagent-2 | buffer |  |  | Local |  |\n'
    );
    const { plugin } = makePlugin(fs);
    (plugin as unknown as { host: object }).host = { fs };
    const app = {
      workspace: { getLeavesOfType: () => [] },
      vault: {
        getMarkdownFiles: () => [new TFile(readme)],
        cachedRead: () => fs.read(readme),
        getFileByPath: () => null,
      },
    } as unknown as App;

    expect(
      await moveSampleInteractive(app, plugin, {
        fromScope: 'local',
        fromFolder: RENDERED_LOCAL,
        toFolder: GLOBAL,
        type: TYPE,
        id: 'Reagent-2',
      })
    ).toBe(true);
    expect(await fs.read(readme)).toContain('| Reagent-2 | buffer |  |  | Global |  |');
  });
});

// #299: a move could put two samples with one alias side by side without a word.
describe('moveSampleInteractive — same alias in the destination', () => {
  const move = (plugin: LabnotePlugin) =>
    moveSampleInteractive(APP, plugin, {
      fromScope: 'local',
      fromFolder: RENDERED_LOCAL,
      toFolder: GLOBAL,
      type: TYPE,
      id: 'Reagent-2',
    });

  async function setup() {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, RENDERED_LOCAL, TYPE, 'Reagent-2', record('Buffer'));
    await putSampleRecord(fs, GLOBAL, TYPE, 'Reagent-9', record(' buffer '));
    const { plugin } = makePlugin(fs);
    (plugin as unknown as { settings: object }).settings = { customSampleTypes: [], globalSampleFolder: GLOBAL };
    return { fs, plugin };
  }

  it('asks first, naming the sample that has the alias, and stays put when declined', async () => {
    const { fs, plugin } = await setup();
    vi.mocked(confirmModal).mockResolvedValue(false);

    expect(await move(plugin)).toBe(false);

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toBe(
      'Global samples already have the alias Buffer (Reagent-9). Move Reagent-2 there anyway?'
    );
    expect(vi.mocked(confirmModal).mock.calls[0][2]).toBe('Move anyway');
    expect((await loadSamplesByType(fs, RENDERED_LOCAL, TYPE))['Reagent-2']).toBeDefined();
    expect((await loadSamplesByType(fs, GLOBAL, TYPE))['Reagent-2']).toBeUndefined();
  });

  it('moves when confirmed', async () => {
    const { fs, plugin } = await setup();
    vi.mocked(confirmModal).mockResolvedValue(true);

    expect(await move(plugin)).toBe(true);
    expect(Object.keys(await loadSamplesByType(fs, GLOBAL, TYPE)).sort()).toEqual(['Reagent-2', 'Reagent-9']);
  });
});
