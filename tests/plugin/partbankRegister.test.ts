/**
 * One partbank item gets one labnoteo ID. #270: "Send to labnoteo" with Global
 * picked used to look only in Global, so an item this experiment already had
 * was registered a second time under a new ID.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemFileSystem, type SampleSource } from '@labnoteo/core';
import { loadSamplesByType, upsertSampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { Notice } from '../stubs/obsidian';
import { noticeForRegistration, registerPartbankItem } from '../../src/partbank/partbankRegister';
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

  it('tells a chosen Global apart from Global by default', () => {
    noticeForRegistration(plugin, result(GLOBAL, false), GLOBAL);
    noticeForRegistration(plugin, result(GLOBAL, false));
    expect(Notice.shown).toEqual([
      'Sample added to Global samples: DNA-1',
      'DNA-1 was added to Global samples because this note is outside an experiment folder.',
    ]);
  });
});
