// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// The registry normalizer keeps only the fields it knows, so a partbank link
// that is not declared there is wiped by the first note sync. These tests pin
// the link to every path a record travels: note sync, a case-collision merge,
// a Local <-> Global move and a catalog seed.
import {
  saveSamplesFromDocument,
  loadSamplesByType,
  loadReferenceSamplesByType,
  upsertSampleRecord,
  putSampleRecord,
  mergeSampleRecord,
  type SampleRecord,
} from '../lib/sampleStorage';
import {
  normalizeSampleSource,
  isSameSampleSource,
  isDesktopOrigin,
  normalizeOrigin,
  type SampleSource,
} from '../partbank/types';
import { MemFileSystem } from '../fs/memFileSystem';

const web = (id: string, kid: string | null = 'KBp_aa0001'): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin: 'https://partbank.kbiofoundry.kr',
  type: 'part',
  id,
  kid,
});

const desktop = (port: number, id = '507f1f77bcf86cd799439011'): SampleSource => ({
  system: 'partbank',
  connection: 'desktop',
  origin: `http://127.0.0.1:${port}`,
  type: 'part',
  id,
  kid: 'KBp_aa0001',
});

describe('normalizeSampleSource', () => {
  it('keeps a well-formed link and trims it', () => {
    expect(
      normalizeSampleSource({
        system: 'partbank',
        connection: 'web',
        origin: ' https://partbank.kbiofoundry.kr ',
        type: 'plasmid',
        id: ' 507f1f77bcf86cd799439011 ',
        kid: ' KBvt_aa0001 ',
      })
    ).toEqual({
      system: 'partbank',
      connection: 'web',
      origin: 'https://partbank.kbiofoundry.kr',
      type: 'plasmid',
      id: '507f1f77bcf86cd799439011',
      kid: 'KBvt_aa0001',
    });
  });

  it('reads a missing kid as null', () => {
    expect(normalizeSampleSource({ ...web('x'), kid: '  ' })?.kid).toBeNull();
  });

  // A half-built link would send a lookup to the wrong item, so it is dropped.
  it('drops anything malformed', () => {
    expect(normalizeSampleSource(undefined)).toBeNull();
    expect(normalizeSampleSource('partbank')).toBeNull();
    expect(normalizeSampleSource({ ...web('x'), system: 'other' })).toBeNull();
    expect(normalizeSampleSource({ ...web('x'), connection: 'lan' })).toBeNull();
    expect(normalizeSampleSource({ ...web('x'), type: 'reagent' })).toBeNull();
    expect(normalizeSampleSource({ ...web('x'), id: '' })).toBeNull();
    expect(normalizeSampleSource({ ...web('x'), origin: '' })).toBeNull();
  });
});

describe('isSameSampleSource', () => {
  // The desktop port moves when 47830 is taken; matching on it would break
  // every link the moment the user changes it.
  it('ignores the port of a desktop link', () => {
    expect(isSameSampleSource(desktop(47830), desktop(47831))).toBe(true);
  });

  it('tells two web servers apart', () => {
    expect(
      isSameSampleSource(web('a'), { ...web('a'), origin: 'https://other.example.com' })
    ).toBe(false);
  });

  it('ignores a trailing slash and letter case in a web origin', () => {
    expect(
      isSameSampleSource(web('a'), { ...web('a'), origin: 'https://PARTBANK.kbiofoundry.kr/' })
    ).toBe(true);
  });

  it('is false across connections, types and ids', () => {
    expect(isSameSampleSource(web('a'), { ...web('a'), connection: 'desktop' })).toBe(false);
    expect(isSameSampleSource(web('a'), { ...web('a'), type: 'device' })).toBe(false);
    expect(isSameSampleSource(web('a'), web('b'))).toBe(false);
  });
});

describe('isDesktopOrigin / normalizeOrigin', () => {
  it('reads any port on this machine as the desktop app', () => {
    expect(isDesktopOrigin('http://127.0.0.1:47830')).toBe(true);
    expect(isDesktopOrigin('http://localhost:9999/')).toBe(true);
    expect(isDesktopOrigin('https://partbank.kbiofoundry.kr')).toBe(false);
    expect(isDesktopOrigin('not a url')).toBe(false);
  });

  it('strips a trailing slash and lowercases', () => {
    expect(normalizeOrigin(' https://Partbank.KR/// ')).toBe('https://partbank.kr');
  });
});

describe('a partbank link survives the registry round-trip', () => {
  const DOC = 'labnote/001_Exp/001_Exp.labnote.md';
  const FOLDER = 'labnote/001_Exp/resources/labsamples';
  const GLOBAL = 'resources/labsamples';

  it('is kept when the note is synced', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: null,
      source: web('507f1f77bcf86cd799439011'),
    });
    await saveSamplesFromDocument(fs, DOC, 'DNA-1;gfp 를 증폭했다');

    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].source).toEqual(
      web('507f1f77bcf86cd799439011')
    );
  });

  it('is kept when a definition rewrites the alias and description', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: null,
      source: web('507f1f77bcf86cd799439011'),
    });
    await saveSamplesFromDocument(fs, DOC, '@dna;DNA-1;eGFP;두 번째 설명');

    const rec = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.alias).toBe('eGFP');
    expect(rec.source).toEqual(web('507f1f77bcf86cd799439011'));
  });

  // Windows folds `{Type}.json` keys that differ only in case into one record.
  it('is carried over when case-colliding ids are merged', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/DNA.json`,
      JSON.stringify({
        'dna-1': { type: 'DNA', alias: null, descriptions: [], sources: [] },
        'DNA-1': {
          type: 'DNA',
          alias: 'gfp',
          descriptions: [],
          sources: [],
          source: web('507f1f77bcf86cd799439011'),
        },
      })
    );

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(Object.keys(records)).toEqual(['dna-1']);
    expect(records['dna-1'].source).toEqual(web('507f1f77bcf86cd799439011'));
  });

  it('moves with the record from Local to Global', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: null,
      source: web('507f1f77bcf86cd799439011'),
    });
    const record = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    await putSampleRecord(fs, GLOBAL, 'DNA', 'DNA-1', record);

    expect((await loadSamplesByType(fs, GLOBAL, 'DNA'))['DNA-1'].source).toEqual(
      web('507f1f77bcf86cd799439011')
    );
  });

  it('is kept by an MCP-style merge that only adds a description', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: null,
      source: web('507f1f77bcf86cd799439011'),
    });
    await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { description: 'from the agent' });

    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].source).toEqual(
      web('507f1f77bcf86cd799439011')
    );
  });

  // A reference to a catalog id seeds a local record; without the link it could
  // never refresh its location or open in partbank.
  it('is copied onto a record seeded from a catalog', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/Reagent_partbank-web.json`,
      JSON.stringify({
        'Reagent-7': {
          type: 'Reagent',
          alias: 'LB broth',
          descriptions: [],
          sources: [],
          source: web('507f1f77bcf86cd799439011'),
        },
      })
    );
    await saveSamplesFromDocument(fs, DOC, 'Reagent-7;LB broth 를 썼다');

    const seeded = (await loadSamplesByType(fs, FOLDER, 'Reagent'))['Reagent-7'];
    expect(seeded.alias).toBe('LB broth');
    expect(seeded.source).toEqual(web('507f1f77bcf86cd799439011'));
  });

  it('is read back from a catalog file', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/DNA_partbank-web.json`,
      JSON.stringify({ 'DNA-7': { alias: 'gfp', source: web('507f1f77bcf86cd799439011') } })
    );

    expect((await loadReferenceSamplesByType(fs, FOLDER, 'DNA'))['DNA-7'].source).toEqual(
      web('507f1f77bcf86cd799439011')
    );
  });
});

describe('upsertSampleRecord source field', () => {
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('keeps the stored link when omitted and clears it on null', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'gfp',
      description: null,
      source: web('507f1f77bcf86cd799439011'),
    });
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'eGFP', description: null });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].source).toEqual(
      web('507f1f77bcf86cd799439011')
    );

    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'eGFP',
      description: null,
      source: null,
    });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].source).toBeUndefined();
  });

  // Every vault's `{Type}.json` would otherwise gain a `"source": null` line.
  it('writes no source key for a hand-authored sample', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'gfp', description: null });
    expect(await fs.read(`${FOLDER}/DNA.json`)).not.toContain('"source"');
  });

  it('drops a malformed link rather than storing it', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/DNA.json`,
      JSON.stringify({
        'DNA-1': {
          type: 'DNA',
          alias: 'gfp',
          descriptions: [],
          sources: [],
          source: { system: 'partbank', connection: 'web' },
        },
      })
    );
    const rec: SampleRecord = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.source).toBeUndefined();
  });
});
