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
  changeSampleTypeInteractive,
  createSampleInteractive,
  editSampleInteractive,
  insertSampleReference,
  listSampleDefinitions,
  sampleUsages,
  validateAlias,
} from '../../src/sampleActions';
import { confirmModal, pickModal, promptModal } from '../../src/modals';
import { createObsidianHost } from '../../src/obsidianHost';
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

  it('warns about a same-alias Global sample as one that cannot be told apart when adding to Global', async () => {
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } })
    );
    Notice.reset();
    answer('siKIF', '', '');

    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: GLOBAL, mode: 'generate' });

    expect(Notice.shown[0]).toBe(
      'Global samples already have the alias siKIF (RNA-7). Autocomplete cannot tell the two apart, so picking the existing sample is usually better.'
    );
  });

  // #125: two Local samples with one alias show as identical autocomplete lines.
  it('warns, without refusing, when the same experiment has the alias', async () => {
    await fs.write(
      REGISTRY,
      JSON.stringify({ 'RNA-3': { type: 'RNA', alias: '배지성분-1', descriptions: [], sources: [] } })
    );
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({ 'RNA-7': { type: 'RNA', alias: '배지성분-1', descriptions: [], sources: [] } })
    );
    Notice.reset();
    answer('배지성분-1', '', '');

    const created = await add();

    expect(Notice.shown[0]).toBe(
      'This experiment already has the alias 배지성분-1 (RNA-3). Autocomplete cannot tell the two apart, so picking the existing sample is usually better.'
    );
    expect(Notice.shown.some(m => m.includes('marked Local and Global'))).toBe(false);
    expect(Object.keys(JSON.parse(await fs.read(REGISTRY)))).toContain(created!.id);
  });

  it('does not warn about a same alias of another type', async () => {
    await fs.write(
      `${FOLDER}/DNA.json`,
      JSON.stringify({ 'DNA-3': { type: 'DNA', alias: 'R1', descriptions: [], sources: [] } })
    );
    Notice.reset();
    answer('R1', '', '');

    await add();

    expect(Notice.shown.some(m => m.includes('already has the alias'))).toBe(false);
  });
});

// #84: entering an id that is already registered must not wipe its record.
// #142: what was typed after `@type;` is not lost.
describe('createSampleInteractive with a typed search term', () => {
  it('fills the alias prompt with a name, and the ID prompt with an ID', async () => {
    answer(undefined);
    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: FOLDER, mode: 'generate', initial: ' siKIF ' });
    expect(vi.mocked(promptModal).mock.calls[0][1]).toMatchObject({ value: 'siKIF' });

    vi.mocked(promptModal).mockReset();
    answer(undefined);
    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: FOLDER, mode: 'manual', initial: 'RNA-12' });
    expect(vi.mocked(promptModal).mock.calls[0][1]).toMatchObject({ value: 'RNA-12' });

    vi.mocked(promptModal).mockReset();
    answer('RNA-13', undefined);
    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: FOLDER, mode: 'manual', initial: 'siKIF' });
    expect(vi.mocked(promptModal).mock.calls[0][1]).toMatchObject({ value: 'RNA-' });
    expect(vi.mocked(promptModal).mock.calls[1][1]).toMatchObject({ value: 'siKIF' });
  });

  // #168
  it('refuses Markdown characters in a new alias', () => {
    const check = validateAlias(plugin);
    expect(check('#1')).toContain('Markdown');
    expect(check('[[x]]')).toContain('Markdown');
    expect(check('a;b')).toContain('";" or ":"');
    expect(check('pUC19 v2')).toBeNull();
  });
});

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

  let open: { path: string; text: string; mode?: 'source' | 'preview' } | undefined;
  let editTarget: () => EditTarget | undefined;

  function editPlugin() {
    const view = new MarkdownView();
    if (open) {
      const state = open;
      view.file = new TFile(state.path);
      view.mode = state.mode ?? 'source';
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
      host: { fs, editTarget: () => editTarget() },
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
    editTarget = () => undefined;
    Notice.reset();
    vi.mocked(confirmModal).mockReset();
  });

  // #216: a note shown only in reading view has a hidden editor that is never saved.
  it('rewrites a note open in reading view through the vault, not its hidden editor', async () => {
    open = { path: `${A}/002_WD020_Open.labnote.md`, text: 'hidden buffer RNA-1;si KIF\n', mode: 'preview' };
    await fs.write(open.path, 'RNA-1;si KIF saved\n');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await edit(FOLDER, 'siKIF');

    expect(await fs.read(open.path)).toBe('RNA-1;siKIF saved\n');
    expect(open.text).toBe('hidden buffer RNA-1;si KIF\n');
  });

  it('syncs the definition of a reading-view note through the vault without switching its view', async () => {
    const path = `${A}/001_WD010_A.labnote.md`;
    await fs.write(path, '@rna;RNA-1;si KIF;kd\n');
    const view = new MarkdownView();
    view.file = new TFile(path);
    view.mode = 'preview';
    view.data = '@rna;RNA-1;si KIF;kd\n';
    view.editor = { getValue: () => 'hidden buffer' };
    const setState = vi.spyOn(view, 'setState');
    const host = createObsidianHost(
      { workspace: { getActiveViewOfType: () => view, getMostRecentLeaf: () => null } } as unknown as App,
      fs,
      key => key
    );
    editTarget = () => host.editTarget();
    vi.mocked(confirmModal).mockResolvedValue(false);

    await edit(FOLDER, 'siKIF');

    expect(await fs.read(path)).toBe('@rna;RNA-1;siKIF;kd\n');
    expect(setState).not.toHaveBeenCalled();
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

  // #130, #131
  it('lists the usages of a Global sample without the experiments a Local record shadows', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, 'RNA-1;si KIF\n');
    await fs.write(`${A}/002_WD020_B.labnote.md`, 'no reference\n');
    await fs.write(`${B}/resources/labsamples/RNA.json`, JSON.stringify({ 'RNA-1': RECORD }));
    await fs.write(`${B}/001_WD010_C.labnote.md`, 'RNA-1;si KIF\n');
    const { app, p } = editPlugin();

    expect(await sampleUsages(app, p, GLOBAL, 'RNA', 'RNA-1')).toEqual([`${A}/001_WD010_A.labnote.md`]);
    expect(await sampleUsages(app, p, `${B}/resources/labsamples`, 'RNA', 'RNA-1')).toEqual([
      `${B}/001_WD010_C.labnote.md`,
    ]);
  });
});

// #116: a sample registered under the wrong type moves with the notes that use it.
describe('changeSampleTypeInteractive', () => {
  const A = 'labnote/001_Test';
  const B = 'labnote/002_Other';
  const RECORD = { type: 'RNA', alias: 'pUC19', descriptions: ['vector'], sources: [], location: null };
  const format = (key: string, ...args: string[]) => key.replace(/\{(\d)\}/g, (_, i) => args[Number(i)]);

  const change = () => {
    const app = {
      workspace: { getLeavesOfType: () => [] },
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
    return changeSampleTypeInteractive(app, p, { folder: FOLDER, type: 'RNA', id: 'RNA-1' });
  };

  beforeEach(async () => {
    Notice.reset();
    vi.mocked(confirmModal).mockReset();
    vi.mocked(pickModal).mockReset();
    await fs.write(REGISTRY, JSON.stringify({ 'RNA-1': RECORD }));
    await fs.write(`${A}/001_WD010_A.labnote.md`, '@rna;RNA-1;pUC19;vector\n');
    await fs.write(`${A}/002_WD020_B.labnote.md`, 'used RNA-1;pUC19 and RNA-12\n');
    await fs.write(`${B}/001_WD010_C.labnote.md`, 'RNA-1;other\n');
  });

  it('moves the record under the new type and rewrites the notes of its experiment', async () => {
    vi.mocked(pickModal).mockResolvedValue('Plasmid');
    vi.mocked(confirmModal).mockResolvedValue(true);

    expect(await change()).toBe(true);

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain(
      'Change RNA-1 to Plasmid-1? Its record moves from RNA.json to Plasmid.json.'
    );
    expect(JSON.parse(await fs.read(REGISTRY))).toEqual({});
    expect(JSON.parse(await fs.read(`${FOLDER}/Plasmid.json`))['Plasmid-1']).toMatchObject({
      type: 'Plasmid',
      alias: 'pUC19',
      descriptions: ['vector'],
    });
    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe('@plasmid;Plasmid-1;pUC19;vector\n');
    expect(await fs.read(`${A}/002_WD020_B.labnote.md`)).toBe('used Plasmid-1;pUC19 and RNA-12\n');
    expect(await fs.read(`${B}/001_WD010_C.labnote.md`)).toBe('RNA-1;other\n');
    expect(Notice.shown.at(-1)).toBe(
      'Changed RNA-1 to Plasmid-1. 2 note(s) updated. Ctrl+Z only reverts the note, not the sample record. To undo, change the type again.'
    );
  });

  it('gives a new id when the new type already has those numbers', async () => {
    await fs.write(`${GLOBAL}/Plasmid.json`, JSON.stringify({ 'Plasmid-1': { ...RECORD, type: 'Plasmid' } }));
    vi.mocked(pickModal).mockResolvedValue('Plasmid');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await change();

    const ids = Object.keys(JSON.parse(await fs.read(`${FOLDER}/Plasmid.json`)));
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('Plasmid-1');
    expect(ids[0]).toMatch(/^Plasmid-/);
    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe(`@plasmid;${ids[0]};pUC19;vector\n`);
  });

  it('changes nothing when declined', async () => {
    vi.mocked(pickModal).mockResolvedValue('Plasmid');
    vi.mocked(confirmModal).mockResolvedValue(false);

    expect(await change()).toBe(false);

    expect(JSON.parse(await fs.read(REGISTRY))).toHaveProperty('RNA-1');
    expect(await fs.exists(`${FOLDER}/Plasmid.json`)).toBe(false);
    expect(await fs.read(`${A}/001_WD010_A.labnote.md`)).toBe('@rna;RNA-1;pUC19;vector\n');
  });

  it('does not offer the current type', async () => {
    vi.mocked(pickModal).mockResolvedValue(undefined);

    expect(await change()).toBe(false);

    const offered = vi.mocked(pickModal).mock.calls[0][1].map(i => i.value);
    expect(offered).not.toContain('RNA');
    expect(offered).toContain('Plasmid');
  });
});

// #121: the definition window is reachable from the command palette.
describe('listSampleDefinitions', () => {
  const list = (docPath: string | undefined) =>
    listSampleDefinitions(
      {
        ...plugin,
        t: (key: string, ...args: string[]) => key.replace(/\{(\d)\}/g, (_, i) => args[Number(i)]),
        settings: { globalSampleFolder: GLOBAL, customSampleTypes: [] },
      } as unknown as LabnotePlugin,
      docPath
    );

  beforeEach(async () => {
    await fs.write(
      REGISTRY,
      JSON.stringify({ 'RNA-1': { type: 'RNA', alias: 'siKIF', descriptions: ['kd'], sources: [] } })
    );
    await fs.write(
      `${GLOBAL}/DNA.json`,
      JSON.stringify({ 'DNA-2': { type: 'DNA', alias: null, descriptions: [], sources: [] } })
    );
  });

  it('shows the Local samples of the note and then the Global ones as ID | alias | scope', async () => {
    const items = await list('labnote/001_Test/001_WD010_A.labnote.md');

    expect(items.map(i => i.label)).toEqual(['RNA-1 | siKIF | Local RNA sample', 'DNA-2 | - | Global DNA sample']);
    expect(items[0].detail).toBe('kd');
    expect(items[0].value).toMatchObject({ type: 'RNA', id: 'RNA-1', resolved: { scope: 'local', folder: FOLDER } });
  });

  it('shows only the Global samples without an open note', async () => {
    expect((await list(undefined)).map(i => i.value.id)).toEqual(['DNA-2']);
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
