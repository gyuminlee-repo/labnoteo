/**
 * One partbank item gets one labnoteo ID. #270: "Send to labnoteo" with Global
 * picked used to look only in Global, so an item this experiment already had
 * was registered a second time under a new ID.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemFileSystem, type SampleSource } from '@labnoteo/core';
import { loadSamplesByType, setSampleDiscarded, upsertSampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { Notice } from '../stubs/obsidian';
import { catalogSeedNote, noticeForRegistration, registerPartbankItem } from '../../src/partbank/partbankRegister';
import type { PartbankClient } from '../../src/partbank/client';
import type LabnotePlugin from '../../src/main';

const WEB = 'https://partbank.kbiofoundry.kr';
const LOCAL = 'labnote/001_Exp/resources/labsamples';
const GLOBAL = 'resources/labsamples';
const ITEM = { type: 'part' as const, id: '507f1f77bcf86cd799439011', kid: 'KBp_aa0249', name: 'sfGFP' };

const source: SampleSource = {
  system: 'partbank',
  connection: 'web',
  origin: WEB,
  type: 'part',
  id: ITEM.id,
  kid: ITEM.kid,
};

let fs: MemFileSystem;
let plugin: LabnotePlugin;

const client = { kind: 'web', origin: WEB, getStocks: async () => [] } as unknown as PartbankClient;

beforeEach(() => {
  fs = new MemFileSystem();
  plugin = {
    fs,
    t: (key: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), key),
    settings: { customSampleTypes: [], globalSampleFolder: GLOBAL },
    samplesChanged: () => undefined,
    sampleTrackingFor: () => true,
  } as unknown as LabnotePlugin;
  Notice.reset();
});

describe('registerPartbankItem (#270)', () => {
  it('reuses the sample this experiment already has when Global is the target', async () => {
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-1', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(plugin, client, ITEM, { folder: GLOBAL, type: 'DNA', lookIn: LOCAL });

    expect(result).toMatchObject({ id: 'DNA-1', reused: true, folder: LOCAL });
    expect(await loadSamplesByType(fs, GLOBAL, 'DNA')).toEqual({});
  });

  // #387: a sample marked used up was reused without a word.
  it('carries the discard date of a reused sample', async () => {
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-1', { alias: 'sfGFP', description: null, source });
    await setSampleDiscarded(fs, LOCAL, 'DNA', 'DNA-1', '2026-10-01');
    const result = await registerPartbankItem(plugin, client, ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result).toMatchObject({ id: 'DNA-1', reused: true, discarded: '2026-10-01' });
  });

  it('writes to the chosen folder when nothing stands for the item yet', async () => {
    const result = await registerPartbankItem(plugin, client, ITEM, { folder: GLOBAL, type: 'DNA', lookIn: LOCAL });

    expect(result?.reused).toBe(false);
    expect(result?.folder).toBe(GLOBAL);
    expect(Object.keys(await loadSamplesByType(fs, GLOBAL, 'DNA'))).toEqual([result!.id]);
    expect(await loadSamplesByType(fs, LOCAL, 'DNA')).toEqual({});
  });

  it('still finds a Global sample when the target is Local', async () => {
    await upsertSampleRecord(fs, GLOBAL, 'DNA', 'DNA-9', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(plugin, client, ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-9', reused: true, folder: GLOBAL });
  });

  // #301
  it('finds the sample after its type was changed, and says which type was asked for', async () => {
    await upsertSampleRecord(fs, LOCAL, 'Other', 'Other-3', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(plugin, client, ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ type: 'Other', id: 'Other-3', reused: true, folder: LOCAL, foundIn: 'local', requestedType: 'DNA' });
    expect(await loadSamplesByType(fs, LOCAL, 'DNA')).toEqual({});
  });

  it('prefers the type asked for when two types stand for the item', async () => {
    await upsertSampleRecord(fs, LOCAL, 'Other', 'Other-3', { alias: 'sfGFP', description: null, source });
    await upsertSampleRecord(fs, LOCAL, 'DNA', 'DNA-4', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(plugin, client, ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-4' });
    expect(result?.requestedType).toBeUndefined();
  });

  // #295
  it('reports the folder of the catalog it was found in', async () => {
    const record = { type: 'DNA', alias: 'sfGFP', descriptions: [], sources: [], location: null, source };
    await fs.write(`${GLOBAL}/DNA_partbank-web.json`, JSON.stringify({ 'DNA-7': record }));

    const result = await registerPartbankItem(plugin, client, ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-7', reused: true, folder: GLOBAL, foundIn: 'catalog' });
  });
});

describe('noticeForRegistration (#270)', () => {
  const result = (folder: string, reused: boolean) => ({
    type: 'DNA',
    id: 'DNA-1',
    alias: 'sfGFP',
    referenceText: 'DNA-1;sfGFP',
    folder,
    reused,
  });

  it('says where a reused sample is when another folder was chosen', () => {
    noticeForRegistration(plugin, result(LOCAL, true), GLOBAL);
    expect(Notice.shown).toEqual([
      `DNA-1 in ${LOCAL} already stands for this partbank item, so it was used instead of registering a second one.`,
    ]);
  });

  // #295: a catalog sample read as if nothing had happened.
  it('names the catalog a reused sample came from, and a Global one without a choice', () => {
    noticeForRegistration(plugin, { ...result(GLOBAL, true), foundIn: 'catalog' }, undefined, 'SEED');
    noticeForRegistration(plugin, { ...result(GLOBAL, true), foundIn: 'global' });
    noticeForRegistration(plugin, { ...result(LOCAL, true), foundIn: 'local' });
    expect(Notice.shown).toEqual([
      `Used DNA-1 from the partbank catalog (${GLOBAL}). SEED`,
      `DNA-1 in ${GLOBAL} already stands for this partbank item, so it was used instead of registering a second one.`,
      'DNA-1 already stands for this partbank item.',
    ]);
  });

  // #301
  it('says when the reused sample has another type than the one asked for', () => {
    noticeForRegistration(plugin, { ...result(LOCAL, true), foundIn: 'local', type: 'Other', id: 'Other-1', requestedType: 'DNA' });
    expect(Notice.shown).toEqual(['Other-1 already stands for this partbank item. It is registered as Other, not DNA.']);
  });

  it('says a reused sample was marked discarded', () => {
    noticeForRegistration(plugin, { ...result(LOCAL, true), foundIn: 'local', discarded: '2026-10-01' });
    expect(Notice.shown).toEqual(['DNA-1 already stands for this partbank item. DNA-1 was marked discarded on 2026-10-01.']);
  });

  it('tells a chosen Global apart from Global by default', () => {
    noticeForRegistration(plugin, result(GLOBAL, false), GLOBAL);
    noticeForRegistration(plugin, result(GLOBAL, false));
    expect(Notice.shown).toEqual([
      'Sample added to Global samples: DNA-1',
      'DNA-1 was added to Global samples because this note is outside an experiment folder.',
    ]);
  });
});

describe('catalogSeedNote (#295)', () => {
  const fromCatalog = {
    type: 'DNA',
    id: 'DNA-7',
    alias: 'sfGFP',
    referenceText: 'DNA-7;sfGFP',
    folder: GLOBAL,
    reused: true,
    foundIn: 'catalog' as const,
  };
  const NOTE = 'labnote/001_Exp/001_WD010_A.labnote.md';

  it('says saving copies a catalog sample into the experiment, once its reference is in a note there', () => {
    expect(catalogSeedNote(plugin, fromCatalog, NOTE)).toBe("Saving the note adds it to this experiment's samples as well.");
  });

  it('says nothing without a note, outside an experiment, untracked, or not from a catalog', () => {
    expect(catalogSeedNote(plugin, fromCatalog, undefined)).toBe('');
    expect(catalogSeedNote(plugin, fromCatalog, 'notes/loose.md')).toBe('');
    expect(catalogSeedNote(plugin, { ...fromCatalog, foundIn: 'local' }, NOTE)).toBe('');
    const untracked = { ...plugin, sampleTrackingFor: () => false } as unknown as LabnotePlugin;
    expect(catalogSeedNote(untracked, fromCatalog, NOTE)).toBe('');
  });
});
