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
  deleteSampleInteractive,
  editSampleInteractive,
  insertSampleReference,
  listSampleDefinitions,
  sampleUsages,
  sampleUsageSpots,
  usageSpotLabel,
  unregisteredReferences,
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
  vi.mocked(pickModal).mockReset();
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

  it('asks about a same-alias Global sample when adding to Global', async () => {
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } })
    );
    answer('siKIF', '', '');
    vi.mocked(pickModal).mockResolvedValueOnce(null);

    await createSampleInteractive(new App(), plugin, { type: 'RNA', folder: GLOBAL, mode: 'generate' });

    expect(vi.mocked(pickModal).mock.calls[0][2]).toMatchObject({
      title: 'Global samples already have the alias siKIF (RNA-7).',
    });
  });

  // #125, #248: two Local samples with one alias show as identical
  // autocomplete lines, so the choice comes before the sample is written.
  it('asks before creating when the same experiment has the alias, and creates on "anyway"', async () => {
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
    vi.mocked(pickModal).mockResolvedValueOnce(null);

    const created = await add();

    expect(vi.mocked(pickModal).mock.calls[0][2]).toMatchObject({
      title: 'This experiment already has the alias 배지성분-1 (RNA-3).',
    });
    expect(Notice.shown.some(m => m.includes('marked Local and Global'))).toBe(false);
    expect(created?.reused).toBeUndefined();
    expect(Object.keys(JSON.parse(await fs.read(REGISTRY)))).toContain(created!.id);
  });

  it('inserts the existing sample, asking nothing else and writing nothing, on "use the existing one"', async () => {
    await fs.write(
      REGISTRY,
      JSON.stringify({
        'RNA-3': { type: 'RNA', alias: '배지성분-1', descriptions: ['first run'], sources: [] },
      })
    );
    Notice.reset();
    answer('배지성분-1');
    vi.mocked(pickModal).mockResolvedValueOnce('RNA-3');

    const created = await add();

    expect(created).toMatchObject({
      id: 'RNA-3',
      alias: '배지성분-1',
      description: 'first run',
      referenceText: 'RNA-3;배지성분-1',
      reused: true,
    });
    expect(vi.mocked(promptModal)).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(await fs.read(REGISTRY)))).toEqual(['RNA-3']);
    expect(Notice.shown).toContain('Using the existing sample RNA-3 instead of creating one.');
    expect(Notice.shown.some(m => m.includes('Sample added'))).toBe(false);
  });

  // #274: with two samples already sharing the alias, both are offered.
  it('lists every sample that has the alias, with its description and location', async () => {
    await fs.write(
      REGISTRY,
      JSON.stringify({
        'RNA-3': { type: 'RNA', alias: 'R1', descriptions: ['first run'], sources: [], location: 'Freezer-1' },
        'RNA-4': { type: 'RNA', alias: 'r1', descriptions: [], sources: [] },
        'RNA-5': { type: 'RNA', alias: 'R2', descriptions: [], sources: [] },
      })
    );
    Notice.reset();
    answer('R1');
    vi.mocked(pickModal).mockResolvedValueOnce('RNA-4');

    const created = await add();

    const [, items, opts] = vi.mocked(pickModal).mock.calls[0];
    expect(opts).toMatchObject({ title: '2 samples in this experiment already have the alias R1 (RNA-3, RNA-4).' });
    expect(items).toEqual([
      { label: 'Use the existing sample RNA-3', value: 'RNA-3', description: 'first run · Freezer-1' },
      {
        label: 'Use the existing sample RNA-4',
        value: 'RNA-4',
        description: 'Nothing is registered; its ID goes where this one would have.',
      },
      expect.objectContaining({ label: 'Create a new sample anyway', value: null }),
    ]);
    expect(created).toMatchObject({ id: 'RNA-4', referenceText: 'RNA-4;r1', reused: true });
    expect(Object.keys(JSON.parse(await fs.read(REGISTRY)))).toEqual(['RNA-3', 'RNA-4', 'RNA-5']);
  });

  it('names every Global sample with the alias when adding to Local', async () => {
    await fs.write(
      `${GLOBAL}/RNA.json`,
      JSON.stringify({
        'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] },
        'RNA-8': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] },
      })
    );
    Notice.reset();
    answer('siKIF', '', '');

    await add();

    expect(Notice.shown[0]).toBe(
      'Global samples already have the alias siKIF (RNA-7, RNA-8). Autocomplete will show both, marked Local and Global.'
    );
  });

  it('registers nothing when the same-alias question is closed', async () => {
    await fs.write(
      REGISTRY,
      JSON.stringify({ 'RNA-3': { type: 'RNA', alias: 'R1', descriptions: [], sources: [] } })
    );
    answer('R1');
    vi.mocked(pickModal).mockResolvedValueOnce(undefined);

    expect(await add()).toBeUndefined();
    expect(Object.keys(JSON.parse(await fs.read(REGISTRY)))).toEqual(['RNA-3']);
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
    // #225: `_` next to Korean turns italic.
    expect(check('대장균_형질전환')).toContain('Markdown');
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

  // #403
  it('asks before taking the alias of another sample of the experiment, and saves nothing when declined', async () => {
    await fs.write(`${FOLDER}/RNA.json`, JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'siKIF' } }));
    vi.mocked(confirmModal).mockResolvedValueOnce(false);

    expect(await edit(FOLDER, 'SIKIF ')).toBe(false);

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toBe(
      'This experiment already has the alias SIKIF (RNA-2). Save RNA-1 anyway?'
    );
    expect(JSON.parse(await fs.read(`${FOLDER}/RNA.json`))['RNA-1'].alias).toBe('si KIF');
  });

  it('saves the shared alias on "Save anyway", and does not ask when only the case changed', async () => {
    await fs.write(`${FOLDER}/RNA.json`, JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'siKIF' } }));
    vi.mocked(confirmModal).mockResolvedValueOnce(true);

    expect(await edit(FOLDER, 'siKIF')).toBe(true);
    expect(JSON.parse(await fs.read(`${FOLDER}/RNA.json`))['RNA-1'].alias).toBe('siKIF');

    vi.mocked(confirmModal).mockReset();
    await fs.write(`${FOLDER}/RNA.json`, JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD } }));
    expect(await edit(FOLDER, 'SI KIF')).toBe(true);
    expect(confirmModal).not.toHaveBeenCalled();
  });

  // #385
  it('deletes a sample only a sample list table names, with its rows', async () => {
    const table = [
      '| ID | Alias | Description | Location | Scope | Discarded |',
      '| --- | --- | --- | --- | --- | --- |',
      '| RNA-1 | si KIF | kd |  | Local |  |',
      '| RNA-2 | other |  |  | Local |  |',
      '',
    ].join('\n');
    await fs.write(`${FOLDER}/RNA.json`, JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'other' } }));
    await fs.write(`${A}/README.labnote.md`, table);
    vi.mocked(confirmModal).mockResolvedValueOnce(true);
    const { app, p } = editPlugin();

    expect(await deleteSampleInteractive(app, p, { folder: FOLDER, type: 'RNA', id: 'RNA-1' })).toBe(true);

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain('RNA-1 is only listed in the sample list tables');
    // #391: what is deleted, beyond its ID.
    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain('Alias: si KIF\nDescription: kd\nScope: Local');
    expect(Notice.shown.at(-1)).toBe('Sample deleted: RNA-1;si KIF');
    expect(JSON.parse(await fs.read(`${FOLDER}/RNA.json`))).not.toHaveProperty('RNA-1');
    expect(await fs.read(`${A}/README.labnote.md`)).not.toContain('RNA-1');
    expect(await fs.read(`${A}/README.labnote.md`)).toContain('| RNA-2 | other |');
  });

  it('still refuses to delete a sample a note uses outside the table', async () => {
    await fs.write(`${FOLDER}/RNA.json`, JSON.stringify({ 'RNA-1': RECORD }));
    await fs.write(`${A}/001_WD010_A.labnote.md`, 'RNA-1;si KIF\n');
    const { app, p } = editPlugin();

    expect(await deleteSampleInteractive(app, p, { folder: FOLDER, type: 'RNA', id: 'RNA-1' })).toBe(false);
    expect(JSON.parse(await fs.read(`${FOLDER}/RNA.json`))).toHaveProperty('RNA-1');
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

  // #291: the list gave only paths and opened each note at its top.
  it('lists where in each note the sample is used, under the same filter', async () => {
    await fs.write(`${A}/001_WD010_A.labnote.md`, '## [UHW1 PCR] 첫\n#### Input\n- RNA-1;si KIF\n#### Output\n- x RNA-1\n');
    await fs.write(`${B}/resources/labsamples/RNA.json`, JSON.stringify({ 'RNA-1': RECORD }));
    await fs.write(`${B}/001_WD010_C.labnote.md`, 'RNA-1;si KIF\n');
    const { app, p } = editPlugin();

    const spots = await sampleUsageSpots(app, p, GLOBAL, 'RNA', 'RNA-1');
    expect(spots).toEqual([
      { path: `${A}/001_WD010_A.labnote.md`, line: 2, ch: 2, heading: '[UHW1 PCR] 첫 › Input' },
      { path: `${A}/001_WD010_A.labnote.md`, line: 4, ch: 4, heading: '[UHW1 PCR] 첫 › Output' },
    ]);
    expect(usageSpotLabel(p.t, spots[0])).toBe('[UHW1 PCR] 첫 › Input · line 3');
    expect(usageSpotLabel(p.t, { path: 'x', line: 0, ch: 0, heading: '' })).toBe('Line 1');
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
      JSON.stringify({ 'RNA-1': { type: 'RNA', alias: 'siKIF', descriptions: ['kd'], sources: [], location: 'Freezer-2' } })
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
    // #386: the location is searched ahead of the description.
    expect(items[0].description).toBe('Freezer-2');
    expect(items[1].description).toBeUndefined();
    expect(items[0].value).toMatchObject({ type: 'RNA', id: 'RNA-1', resolved: { scope: 'local', folder: FOLDER } });
  });

  it('shows only the Global samples without an open note', async () => {
    expect((await list(undefined)).map(i => i.value.id)).toEqual(['DNA-2']);
  });
});

describe('insertSampleReference', () => {
  /** A minimal EditTarget backed by a mutable string + cursor. */
  function makeTarget(text: string, cursor: number, selectionEnd?: number) {
    const state = { text, revealed: -1 };
    const target: EditTarget = {
      path: 'labnote/001_Test/001_WD010_Design.labnote.md',
      getText: async () => state.text,
      getCursorOffset: async () => cursor,
      getSelectionRange: async () => (selectionEnd === undefined ? undefined : { start: cursor, end: selectionEnd }),
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

  // #302: the selected template hint stayed, with the reference fused to it.
  it('replaces the selected text', async () => {
    const doc = '#### Input\n- (samples from the previous step)\n';
    const start = doc.indexOf('(');
    const { target, state } = makeTarget(doc, start, doc.indexOf(')') + 1);

    await insertSampleReference(refPlugin(), target, 'Plasmid-1;pET-28a(+)');

    expect(state.text).toBe('#### Input\n- Plasmid-1;pET-28a(+)\n');
    expect(state.revealed).toBe(start + 'Plasmid-1;pET-28a(+)'.length);
  });
});

// #238: the sample list left out references the registry does not have without a word.
describe('unregisteredReferences', () => {
  const ref = (id: string, alias: string | null = null) =>
    ({ id, type: 'RNA', alias, description: null, definition: false }) as Parameters<typeof unregisteredReferences>[0][number];

  it('lists each reference the registries do not have once, with its alias', () => {
    const refs = [ref('RNA-1', 'siKIF'), ref('RNA-9', '집락B'), ref('rna-9'), ref('Reagent-1001'), ref('RNA-7')];
    expect(unregisteredReferences(refs, new Set(['rna-1', 'reagent-1001']))).toEqual(['RNA-9;집락B', 'RNA-7']);
  });
});
