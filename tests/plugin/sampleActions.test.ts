/**
 * Adding a sample from the sidebar or the command generates its ID, so the
 * alias/description/location prompts are the only steps left — closing any of
 * them has to abandon the add, or a mistaken click leaves an empty sample
 * behind in the registry (#30).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { MarkdownView, Notice, TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import {
  createSampleInteractive,
  editSampleInteractive,
  insertSampleReference,
} from '../../src/sampleActions';
import { confirmModal, promptModal } from '../../src/modals';
import type { EditTarget } from '@labnoteo/core';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/modals', () => ({
  promptModal: vi.fn(),
  confirmModal: vi.fn(),
  pickModal: vi.fn(),
}));

const FOLDER = 'labnote/001_Test/resources/labsamples';
const REGISTRY = `${FOLDER}/RNA.json`;
const GLOBAL = 'resources/labsamples';

let fs: MemFileSystem;
let plugin: LabnotePlugin;

beforeEach(() => {
  vi.mocked(promptModal).mockReset();
  fs = new MemFileSystem();
  plugin = {
    fs,
    t: (key: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), key),
    refreshSampleViews: vi.fn(),
    settings: { globalSampleFolder: GLOBAL },
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

  // #109: a Local sample named like a Global one looks the same in autocomplete.
  it('warns, without refusing, when a Global sample has the same alias', async () => {
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } })
    );
    Notice.reset();
    answer(' sikif ', '', '');

    const created = await add();

    expect(Notice.shown[0]).toBe(
      'Global samples already have the alias sikif (RNA-7). Autocomplete will show both, marked Local and Global.'
    );
    expect(JSON.parse(await fs.read(REGISTRY))[created!.id].alias).toBe('sikif');
  });

  it('does not warn when adding to the Global folder itself', async () => {
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } })
    );
    Notice.reset();
    answer('siKIF', '', '');

    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: GLOBAL, mode: 'generate' });

    expect(Notice.shown.some(m => m.startsWith('Global samples already have'))).toBe(false);
  });
});

// #84: entering an id that is already registered must not wipe its record.
describe('createSampleInteractive with a manually entered existing id', () => {
  const GLOBAL = 'resources/labsamples';
  const STORED = {
    type: 'RNA',
    alias: 'siKIF',
    descriptions: ['knockdown'],
    sources: ['001_WD010_Design.labnote.md'],
    location: 'Freezer-1',
  };

  const manual = () =>
    createSampleInteractive(new App(), plugin, {
      type: 'RNA',
      folder: FOLDER,
      mode: 'manual',
      scope: 'local',
    });

  beforeEach(() => {
    (plugin as unknown as { settings: object }).settings = { globalSampleFolder: GLOBAL };
  });

  it('prefills the stored values and merges what was entered', async () => {
    await fs.write(REGISTRY, JSON.stringify({ 'RNA-7': STORED }));
    answer('rna-7', 'siKIF', 'second batch', '');

    const created = await manual();

    const prompts = vi.mocked(promptModal).mock.calls.map(c => c[1].value);
    expect(prompts).toEqual(['RNA-', 'siKIF', 'knockdown', 'Freezer-1']);
    expect(JSON.parse(await fs.read(REGISTRY))['RNA-7']).toEqual({
      ...STORED,
      descriptions: ['second batch', 'knockdown'],
    });
    expect(created).toMatchObject({ id: 'RNA-7', alias: 'siKIF', referenceText: 'RNA-7;siKIF' });
  });

  it('updates a Global-only sample in the Global folder without a Local copy', async () => {
    await fs.write(`${GLOBAL}/RNA.json`, JSON.stringify({ 'RNA-7': STORED }));
    answer('RNA-7', 'siKIF-2', 'knockdown', 'Freezer-1');

    await manual();

    expect(JSON.parse(await fs.read(`${GLOBAL}/RNA.json`))['RNA-7'].alias).toBe('siKIF-2');
    expect(await fs.exists(REGISTRY)).toBe(false);
  });

  it('registers a new id as before', async () => {
    answer('RNA-8', 'new', '', '');

    await manual();

    expect(JSON.parse(await fs.read(REGISTRY))['RNA-8']).toMatchObject({ alias: 'new', descriptions: [] });
  });
});

// #86: notes that still show the old alias are fixed together, after a confirm.
describe('editSampleInteractive alias rewrite', () => {
  const GLOBAL = 'resources/labsamples';
  const A = 'labnote/001_Test';
  const B = 'labnote/002_Other';
  const RECORD = { type: 'RNA', alias: 'si KIF', descriptions: ['kd'], sources: [], location: null };
  const format = (key: string, ...args: string[]) => key.replace(/\{(\d)\}/g, (_, i) => args[Number(i)]);

  let open: { path: string; text: string } | undefined;

  function editPlugin() {
    const view = new MarkdownView();
    if (open) {
      const state = open;
      view.file = new TFile(state.path);
      view.editor = {
        getValue: () => state.text,
        offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
        transaction: ({ changes }: { changes: { from: { ch: number }; to: { ch: number }; text: string }[] }): void => {
          for (const c of [...changes].sort((x, y) => y.from.ch - x.from.ch)) {
            state.text = state.text.slice(0, c.from.ch) + c.text + state.text.slice(c.to.ch);
          }
        },
      };
    }
    const app = {
      workspace: { getLeavesOfType: () => (open ? [{ view }] : []) },
      vault: {
        getMarkdownFiles: () =>
          Object.keys(fs.snapshot())
            .filter(p => p.endsWith('.md'))
            .map(p => new TFile(p)),
        cachedRead: (f: TFile) => fs.read(f.path),
        getFileByPath: () => null,
      },
    } as unknown as App;
    const p = {
      fs,
      t: format,
      settings: { globalSampleFolder: GLOBAL, customSampleTypes: [] },
      host: { fs, editTarget: () => undefined },
      refreshSampleViews: vi.fn(),
    } as unknown as LabnotePlugin;
    return { app, p };
  }

  const edit = (folder: string, alias: string) => {
    answer(alias, 'kd', '');
    const { app, p } = editPlugin();
    return editSampleInteractive(app, p, { folder, type: 'RNA', id: 'RNA-1', record: RECORD });
  };

  beforeEach(() => {
    open = undefined;
    Notice.reset();
    vi.mocked(confirmModal).mockReset();
  });

  it('rewrites definitions and references in the experiment of a Local sample', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, '@rna;RNA-1;si KIF;kd\n');
    await fs.write(`${A}/002_WD020_B.labnote.md`, 'RNA-1;si KIF 를 처리했다\n');
    await fs.write(`${B}/001_WD010_C.labnote.md`, 'RNA-1;si KIF\n');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await edit(FOLDER, 'siKIF');

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain(
      `- ${A}/001_WD010_A.labnote.md (1 definition(s), 0 reference(s))`
    );
    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe('@rna;RNA-1;siKIF;kd\n');
    expect(await fs.read(`${A}/002_WD020_B.labnote.md`)).toBe('RNA-1;siKIF 를 처리했다\n');
    expect(await fs.read(`${B}/001_WD010_C.labnote.md`)).toBe('RNA-1;si KIF\n');
    expect(Notice.shown.at(-1)).toBe('Sample updated: RNA-1 2 note(s) updated.');
  });

  it('changes nothing when declined, and warns that a definition can revert the alias', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, '@rna;RNA-1;si KIF\n');
    vi.mocked(confirmModal).mockResolvedValue(false);

    await edit(FOLDER, 'siKIF');

    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe('@rna;RNA-1;si KIF\n');
    expect(Notice.shown.at(-1)).toBe(
      'Sample updated: RNA-1 1 note(s) still show the old alias. Saving a note that defines it may bring the old alias back.'
    );
  });

  it('skips experiments where a Local record shadows a Global sample, and edits open notes in place', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, 'RNA-1;si KIF\n');
    await fs.write(`${B}/resources/labsamples/RNA.json`, JSON.stringify({ 'RNA-1': RECORD }));
    await fs.write(`${B}/001_WD010_C.labnote.md`, 'RNA-1;si KIF\n');
    open = { path: `${A}/002_WD020_Open.labnote.md`, text: 'RNA-1;si KIF (unsaved)\n' };
    await fs.write(open.path, '');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await edit(GLOBAL, 'siKIF');

    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe('RNA-1;siKIF\n');
    expect(await fs.read(`${B}/001_WD010_C.labnote.md`)).toBe('RNA-1;si KIF\n');
    expect(open.text).toBe('RNA-1;siKIF (unsaved)\n');
  });

  it('does not ask when no other note shows the old alias', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, 'RNA-1;other\n');

    await edit(FOLDER, 'siKIF');

    expect(confirmModal).not.toHaveBeenCalled();
    expect(Notice.shown.at(-1)).toBe('Sample updated: RNA-1');
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
