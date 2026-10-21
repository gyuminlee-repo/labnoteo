/**
 * #210: a reference to a sample the registry does not have looks like any
 * other. The index tells each lab note which IDs it can resolve.
 */
import { describe, it, expect, vi } from 'vitest';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { SampleIdIndex } from '../../src/sampleIdIndex';

const GLOBAL = 'resources/labsamples';
const EXP = 'labnote/001_Test';
const LOCAL = `${EXP}/resources/labsamples`;
const NOTE = `${EXP}/001_WD010_A.labnote.md`;
const json = (ids: string[]) => JSON.stringify(Object.fromEntries(ids.map(id => [id, { alias: null }])));

function setup(files: Record<string, string>) {
  const fs = new MemFileSystem(files);
  const onChange = vi.fn();
  const index = new SampleIdIndex(fs, {
    globalFolder: () => GLOBAL,
    types: () => ['DNA', 'Reagent'],
    onChange,
    delayMs: 0,
  });
  return { fs, index, onChange };
}

async function known(index: SampleIdIndex, path = NOTE) {
  await vi.waitFor(() => expect(index.knownFor(path)).toBeDefined());
  return index.knownFor(path)!;
}

describe('SampleIdIndex', () => {
  it('joins the Local and Global registries and the catalogs, lower-cased', async () => {
    const { index } = setup({
      [`${LOCAL}/DNA.json`]: json(['DNA-1']),
      [`${GLOBAL}/DNA.json`]: json(['dna-2']),
      [`${GLOBAL}/Reagent_sigma.json`]: json(['Reagent-1001']),
    });

    expect(index.knownFor(NOTE)).toBeUndefined();
    expect([...(await known(index)).ids].sort()).toEqual(['dna-1', 'dna-2', 'reagent-1001']);
  });

  it('keeps the registry aliases, the Local one first, without the catalogs (#239)', async () => {
    const { index } = setup({
      [`${LOCAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'local' } }),
      [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'global' }, 'DNA-2': { alias: null } }),
      [`${GLOBAL}/Reagent_sigma.json`]: json(['Reagent-1001']),
    });

    expect((await known(index)).aliases).toEqual(
      new Map([
        ['dna-1', 'local'],
        ['dna-2', ''],
      ])
    );
  });

  it('covers lab notes only', async () => {
    const { index, onChange } = setup({ [`${GLOBAL}/DNA.json`]: json(['DNA-1']) });

    expect(index.knownFor('QUICKSTART.md')).toBeUndefined();
    expect(index.knownFor(`${EXP}/notes.md`)).toBeUndefined();
    expect(index.knownFor(undefined)).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('answers nothing for a note whose registry cannot be read, and keeps that answer', async () => {
    const { fs, index, onChange } = setup({ [`${LOCAL}/DNA.json`]: '<<<<<<< HEAD\n{}\n' });
    const read = vi.spyOn(fs, 'read');

    index.knownFor(NOTE);
    // One read each for the Local and the Global folder.
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const reads = read.mock.calls.length;

    expect(index.knownFor(NOTE)).toBeUndefined();
    expect(index.knownFor(NOTE)).toBeUndefined();
    expect(read.mock.calls.length).toBe(reads);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads a folder once however often it is asked, and caches an empty one', async () => {
    const { fs, index, onChange } = setup({});
    const list = vi.spyOn(fs, 'exists');

    index.knownFor(NOTE);
    index.knownFor(NOTE);
    const first = await known(index);
    const calls = list.mock.calls.length;

    expect(first.ids.size).toBe(0);
    expect(index.knownFor(NOTE)).toBe(first);
    expect(list.mock.calls.length).toBe(calls);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads the registries again once after an invalidation, with a new version', async () => {
    const { fs, index, onChange } = setup({ [`${LOCAL}/DNA.json`]: json(['DNA-1']) });
    const before = await known(index);
    const calls = onChange.mock.calls.length;

    await fs.write(`${LOCAL}/DNA.json`, json(['DNA-1', 'DNA-2']));
    index.invalidate();
    index.fileChanged(`${LOCAL}/DNA.json`);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(calls + 1));

    const after = index.knownFor(NOTE)!;
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.ids.has('dna-2')).toBe(true);
  });

  it('ignores files outside the registries it has read', async () => {
    const { index, onChange } = setup({});
    await known(index);
    const calls = onChange.mock.calls.length;

    index.fileChanged(`${EXP}/001_WD010_A.labnote.md`);
    index.fileChanged('other/resources/labsamples/DNA.json');
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(onChange).toHaveBeenCalledTimes(calls);
  });
});
