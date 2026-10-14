// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// Phase 0 regression safety net for `lib/sampleStorage.ts` (643 lines, 0 direct
// tests before this file). Correct behaviour is locked in with plain `it(...)`.
// Reproduced bugs are pinned with `it.fails(...)`, which passes now *because*
// the assertion throws against current behaviour; Phase 1-1/1-3 will fix them
// and flip these to normal `it(...)`.
import {
  extractSampleInfoFromText,
  findSampleDefinitionMatch,
  mergeSampleDatabases,
  sampleReferenceKey,
  buildSampleDatabase,
  saveSamplesFromDocument,
  loadSamplesByType,
  saveSamplesByType,
  upsertSampleRecord,
  mergeSampleRecord,
  deleteSampleRecord,
  putSampleRecord,
  removeSourcesForDocument,
  findSampleUsages,
  resolveLocalSampleFolder,
  planAliasRewrite,
  applyAliasRewrite,
  type SampleDatabase,
  type SampleRecord,
} from '../lib/sampleStorage';
import { MemFileSystem } from '../fs/memFileSystem';

describe('resolveLocalSampleFolder (#70)', () => {
  const GLOBAL = 'resources/labsamples';
  const EXP = 'labnote/001_GFP';
  const EXP_FOLDER = `${EXP}/resources/labsamples`;

  it('uses and remembers the experiment of a file inside one', () => {
    expect(resolveLocalSampleFolder(`${EXP}/001_WB030_X.labnote.md`, undefined, GLOBAL)).toEqual({
      folder: EXP_FOLDER,
      lastExperimentDir: EXP,
    });
    expect(resolveLocalSampleFolder(`${EXP}/images/gel.png`, 'labnote/002_Other', GLOBAL)).toEqual({
      folder: EXP_FOLDER,
      lastExperimentDir: EXP,
    });
  });

  it('gives a vault-root note the global folder even after an experiment was opened', () => {
    expect(resolveLocalSampleFolder('Welcome.md', EXP, GLOBAL)).toEqual({
      folder: GLOBAL,
      lastExperimentDir: EXP,
    });
  });

  it('gives any other note outside an experiment its own folder', () => {
    expect(resolveLocalSampleFolder('notes/memo.md', EXP, GLOBAL).folder).toBe('notes/resources/labsamples');
    expect(resolveLocalSampleFolder('labnote/GFP/001_WB030_X.labnote.md', EXP, GLOBAL).folder).toBe(
      'labnote/GFP/resources/labsamples'
    );
  });

  it('keeps the remembered experiment for a non-note file outside any experiment', () => {
    expect(resolveLocalSampleFolder('attachments/scan.pdf', EXP, GLOBAL)).toEqual({
      folder: EXP_FOLDER,
      lastExperimentDir: EXP,
    });
  });

  it('falls back to the file folder, then the global folder, with nothing remembered', () => {
    expect(resolveLocalSampleFolder('attachments/scan.pdf', undefined, GLOBAL).folder).toBe(
      'attachments/resources/labsamples'
    );
    expect(resolveLocalSampleFolder(undefined, undefined, GLOBAL).folder).toBe(GLOBAL);
    expect(resolveLocalSampleFolder(undefined, EXP, GLOBAL).folder).toBe(EXP_FOLDER);
  });
});

describe('extractSampleInfoFromText', () => {
  it('extracts a full @type;id;alias;description definition', () => {
    const out = extractSampleInfoFromText('@DNA;DNA-1;pUC19;my plasmid');
    expect(out).toEqual([
      { id: 'DNA-1', type: 'DNA', alias: 'pUC19', description: 'my plasmid', definition: true },
    ]);
  });

  it('extracts a bare id reference with no alias/description', () => {
    const out = extractSampleInfoFromText('see DNA-2 in the fridge');
    expect(out).toEqual([
      { id: 'DNA-2', type: 'DNA', alias: null, description: null, definition: false },
    ]);
  });

  it('marks an `id;alias` reference as a non-definition (#37)', () => {
    const out = extractSampleInfoFromText('같게Plasmid-1;pBFC-Lower 유지하며 올린다');
    expect(out).toHaveLength(1);
    expect(out[0].definition).toBe(false);
  });

  it('prefers a later @ definition over an earlier aliased reference (#37)', () => {
    const out = extractSampleInfoFromText(
      'Plasmid-1;pX 를 썼다\n@plasmid;Plasmid-1;pBFC-Lower;vector\n'
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ alias: 'pBFC-Lower', description: 'vector', definition: true });
  });

  it('extracts multiple types from one document', () => {
    const out = extractSampleInfoFromText('@DNA;DNA-1;a\n@RNA;RNA-9;b');
    const ids = out.map(s => s.id).sort();
    expect(ids).toEqual(['DNA-1', 'RNA-9']);
  });

  // Fixed in Phase 1-3: a definition (with alias/desc) now upgrades an earlier
  // bare reference to the same id instead of being dropped by "first match
  // wins".
  it('prefers the definition over an earlier bare reference', () => {
    const out = extractSampleInfoFromText('See DNA-100 later.\n\n@DNA;DNA-100;pUC19;my plasmid\n');
    expect(out).toHaveLength(1);
    expect(out[0].alias).toBe('pUC19');
    expect(out[0].description).toBe('my plasmid');
  });

  // Fixed in Phase 1-3: the dedup key is now case-normalized, so `DNA-55` and
  // `dna-55` collapse to a single logical sample.
  it('treats ids that differ only in case as one sample', () => {
    const out = extractSampleInfoFromText('@DNA;DNA-55;a\n@DNA;dna-55;b');
    expect(out).toHaveLength(1);
  });

  // #72: `\|` is a literal pipe inside the alias/description.
  it('reads an escaped pipe in the alias and description and unescapes it', () => {
    const out = extractSampleInfoFromText('| @equip;Equip-1;DNase I \\| 등급;a\\|b | ok |');
    expect(out).toEqual([
      { id: 'Equip-1', type: 'Equip', alias: 'DNase I | 등급', description: 'a|b', definition: true },
    ]);
  });

  it('still reads the legacy `ID|alias` form', () => {
    const out = extractSampleInfoFromText('DNA-1|pUC19');
    expect(out[0]).toMatchObject({ id: 'DNA-1', alias: 'pUC19' });
  });
});

describe('extractSampleInfoFromText — same-type id after an alias (#57)', () => {
  const pick = (text: string) =>
    extractSampleInfoFromText(text).map(({ id, alias, description, definition }) => ({
      id,
      alias,
      description,
      definition,
    }));

  it('reads a later same-type reference on the line as its own reference', () => {
    expect(pick('Reagent-1;두번째시약 Reagent-2;세번째')).toEqual([
      { id: 'Reagent-1', alias: '두번째시약', description: null, definition: false },
      { id: 'Reagent-2', alias: '세번째', description: null, definition: false },
    ]);
    expect(pick('Reagent-1 Reagent-2;세번째').map(s => s.id)).toEqual(['Reagent-1', 'Reagent-2']);
    expect(pick('Reagent-1;두번째시약 DNA-2;x').map(s => s.id)).toEqual(['Reagent-1', 'DNA-2']);
    expect(pick('Reagent-1;a Reagent-2;b Reagent-3;c').map(s => s.id)).toEqual([
      'Reagent-1',
      'Reagent-2',
      'Reagent-3',
    ]);
  });

  it('splits an empty alias, the legacy `: description` form and a following definition', () => {
    expect(pick('Reagent-1; Reagent-2')).toEqual([
      { id: 'Reagent-1', alias: null, description: null, definition: false },
      { id: 'Reagent-2', alias: null, description: null, definition: false },
    ]);
    expect(pick('Reagent-1: 설명 Reagent-2')).toEqual([
      { id: 'Reagent-1', alias: null, description: '설명', definition: false },
      { id: 'Reagent-2', alias: null, description: null, definition: false },
    ]);
    expect(pick('Reagent-1;별칭 @Reagent;Reagent-2;x')).toEqual([
      { id: 'Reagent-1', alias: '별칭', description: null, definition: false },
      { id: 'Reagent-2', alias: 'x', description: null, definition: true },
    ]);
  });

  it('keeps a definition description whole and needs whitespace before the id', () => {
    expect(pick('@Reagent;Reagent-3;희석액;원액 Reagent-1을 10배 희석')).toEqual([
      { id: 'Reagent-3', alias: '희석액', description: '원액 Reagent-1을 10배 희석', definition: true },
    ]);
    expect(pick('DNA-1;cDNA-2 클론')).toEqual([
      { id: 'DNA-1', alias: 'cDNA-2 클론', description: null, definition: false },
    ]);
  });
});

describe('buildSampleDatabase', () => {
  it('groups extracted samples by type and records the source file', () => {
    const samples = extractSampleInfoFromText('@DNA;DNA-1;a;desc');
    const db = buildSampleDatabase(samples, 'note.labnote.md');
    expect(db).toEqual({
      DNA: {
        'DNA-1': {
          type: 'DNA',
          alias: 'a',
          descriptions: ['desc'],
          sources: ['note.labnote.md'],
        },
      },
    });
  });
});

describe('mergeSampleDatabases', () => {
  it('overwrites alias, unions sources, and puts new descriptions first', () => {
    const existing: SampleDatabase = {
      DNA: { 'DNA-1': { type: 'DNA', alias: 'old', descriptions: ['d1'], sources: ['fileA'] } },
    };
    const incoming: SampleDatabase = {
      DNA: { 'DNA-1': { type: 'DNA', alias: 'new', descriptions: ['d2'], sources: ['fileB'] } },
    };
    const merged = mergeSampleDatabases(existing, incoming);
    expect(merged.DNA['DNA-1'].alias).toBe('new');
    expect(merged.DNA['DNA-1'].descriptions).toEqual(['d2', 'd1']);
    expect(merged.DNA['DNA-1'].sources).toEqual(['fileA', 'fileB']);
  });

  it('does not mutate the existing database', () => {
    const existing: SampleDatabase = {
      DNA: { 'DNA-1': { type: 'DNA', alias: 'old', descriptions: ['d1'], sources: ['fileA'] } },
    };
    mergeSampleDatabases(existing, {
      DNA: { 'DNA-1': { type: 'DNA', alias: 'new', descriptions: [], sources: ['fileB'] } },
    });
    expect(existing.DNA['DNA-1'].alias).toBe('old');
    expect(existing.DNA['DNA-1'].sources).toEqual(['fileA']);
  });

  it('only adds sources for reference-only ids, matching the existing key ignoring case', () => {
    const existing: SampleDatabase = {
      DNA: { 'DNA-1': { type: 'DNA', alias: 'keep', descriptions: ['d1'], sources: ['fileA'] } },
    };
    const merged = mergeSampleDatabases(
      existing,
      { DNA: { 'dna-1': { type: 'DNA', alias: 'prose', descriptions: ['junk'], sources: ['fileB'] } } },
      { referenceOnly: new Set([sampleReferenceKey('DNA', 'dna-1')]) }
    );
    expect(Object.keys(merged.DNA)).toEqual(['DNA-1']);
    expect(merged.DNA['DNA-1']).toEqual({
      type: 'DNA',
      alias: 'keep',
      descriptions: ['d1'],
      sources: ['fileA', 'fileB'],
    });
  });
});

describe('document references never overwrite the registry (#37)', () => {
  const DOC = 'labnote/001_Exp/001_WF.labnote.md';
  const FOLDER = 'labnote/001_Exp/resources/labsamples';
  const MID_LINE =
    '3차 계대 기록: 나머지 조건은 앞 계대와 같게Plasmid-1;pBFC-Lower 유지하며 용매 농도만 한 단계 올린다';

  it('keeps the modal-entered alias/description when a mid-line reference is scanned', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', {
      alias: 'pBFC-Lower',
      description: '하류 경로 발현 벡터',
      location: '냉장고-1 / 박스-2 / B5',
    });
    await saveSamplesFromDocument(fs, DOC, MID_LINE);

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(records['Plasmid-1']).toEqual({
      type: 'Plasmid',
      alias: 'pBFC-Lower',
      descriptions: ['하류 경로 발현 벡터'],
      sources: ['001_WF.labnote.md'],
      location: '냉장고-1 / 박스-2 / B5',
    });
  });

  it('does not revert an edited alias from a stale `id;old alias` reference', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', { alias: 'old', description: null });
    await saveSamplesFromDocument(fs, DOC, 'Plasmid-1;old');
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', { alias: 'new', description: null });
    await saveSamplesFromDocument(fs, DOC, 'Plasmid-1;old');

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(records['Plasmid-1'].alias).toBe('new');
  });

  it('still lets an @ definition overwrite the alias', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', { alias: 'old', description: null });
    await saveSamplesFromDocument(fs, DOC, '@plasmid;Plasmid-1;new');

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(records['Plasmid-1'].alias).toBe('new');
  });

  it('does NOT seed a record from a bare reference to an unknown id (#54, #55)', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, DOC, 'Plasmid-9;pUC19');

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(records['Plasmid-9']).toBeUndefined();
  });

  it('does not re-create a deleted sample while a reference remains (#54)', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', {
      alias: 'pBFC',
      description: 'desc',
      location: '냉장고-1',
    });
    // The note references it, then the user deletes it from the registry…
    await saveSamplesFromDocument(fs, DOC, 'used Plasmid-1;pBFC here');
    await deleteSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1');
    // …and edits the note again (reference still present).
    await saveSamplesFromDocument(fs, DOC, 'used Plasmid-1;pBFC here, edited');

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(records['Plasmid-1']).toBeUndefined();
  });

  it('does not register a mangled id fragment (#55)', async () => {
    const fs = new MemFileSystem();
    // A corrupted line with a split reference fragment.
    await saveSamplesFromDocument(fs, DOC, 'Other-1791Other-1791838231413;INA-05838238153;INA-06');

    const records = await loadSamplesByType(fs, FOLDER, 'Other');
    expect(records['Other-1791']).toBeUndefined();
  });

  it('seeds a catalog-type record from the catalog, not the trailing prose', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/Reagent_vendor.json`,
      JSON.stringify({ 'Reagent-7': { type: 'Reagent', alias: 'LB broth', descriptions: ['Sigma'] } })
    );
    await saveSamplesFromDocument(fs, DOC, '배지는 Reagent-7;LB broth 를 썼고; 37도에서 배양');

    const records = await loadSamplesByType(fs, FOLDER, 'Reagent');
    expect(records['Reagent-7'].alias).toBe('LB broth');
    expect(records['Reagent-7'].descriptions).toEqual([]);
  });

  it('adds only a source when the reference differs from the stored id in case', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'Plasmid', 'Plasmid-1', { alias: 'pBFC-Lower', description: 'd' });
    await saveSamplesFromDocument(fs, DOC, 'plasmid-1;pBFC-Lower 유지하며; 올린다');

    const records = await loadSamplesByType(fs, FOLDER, 'Plasmid');
    expect(Object.keys(records)).toEqual(['Plasmid-1']);
    expect(records['Plasmid-1']).toMatchObject({
      alias: 'pBFC-Lower',
      descriptions: ['d'],
      sources: ['001_WF.labnote.md'],
    });
  });
});

describe('findSampleDefinitionMatch (#37)', () => {
  it('skips a plain reference so the prose after it is never replaced', () => {
    const text = '같게Plasmid-1;pBFC-Lower 유지하며 용매 농도만 한 단계 올린다';
    expect(findSampleDefinitionMatch(text, 'Plasmid', 'Plasmid-1', 'pBFC-Lower')).toBeNull();
  });

  it('returns the range of an @ definition after a reference', () => {
    const def = '@plasmid;Plasmid-1;pBFC-Lower;vector';
    const text = `Plasmid-1;pBFC-Lower 를 썼다\n${def}\n`;
    expect(findSampleDefinitionMatch(text, 'Plasmid', 'Plasmid-1')).toEqual({
      start: text.indexOf(def),
      length: def.length,
    });
  });

  // #57: the reference used to swallow the definition into its alias.
  it('finds a definition that follows a reference on the same line', () => {
    const def = '@Reagent;Reagent-2;x';
    const text = `Reagent-1;별칭 ${def}`;
    expect(findSampleDefinitionMatch(text, 'Reagent', 'Reagent-2')).toEqual({
      start: text.indexOf(def),
      length: def.length,
    });
  });

  // #72: the replaced range covers the whole escaped alias.
  it('covers an alias with an escaped pipe', () => {
    const def = '@equip;Equip-1;DNase \\| 등급;설명';
    const text = `| ${def} | ok |`;
    const match = findSampleDefinitionMatch(text, 'Equip', 'Equip-1');
    expect(match?.start).toBe(text.indexOf(def));
    expect(text.slice(match!.start, match!.start + match!.length).trimEnd()).toBe(def);
  });

  it('finds a legacy id-less Equip definition by its escaped alias', () => {
    const def = '@equip;;DNase | 등급'.replace('|', '\\|');
    const text = `기기 ${def}\n`;
    expect(findSampleDefinitionMatch(text, 'Equip', 'Equip-9', 'DNase | 등급')).toEqual({
      start: text.indexOf(def),
      length: def.length,
    });
  });
});

// #86: renaming an alias also fixes the notes that still show the old one.
describe('planAliasRewrite', () => {
  const rewrite = (text: string, id: string, from: string, to: string, type = 'DNA') =>
    applyAliasRewrite(text, planAliasRewrite(text, type, id, from, to));

  it('rewrites a definition and keeps its description', () => {
    const text = '@dna;DNA-1;old name;원본 플라스미드\n';
    expect(planAliasRewrite(text, 'DNA', 'DNA-1', 'old name', 'new')[0].kind).toBe('definition');
    expect(rewrite(text, 'DNA-1', 'old name', 'new')).toBe('@dna;DNA-1;new;원본 플라스미드\n');
  });

  it('rewrites every definition of the id in the note', () => {
    expect(rewrite('@dna;DNA-1;old\n본문\n@DNA;DNA-1;old\n', 'DNA-1', 'old', 'new')).toBe(
      '@dna;DNA-1;new\n본문\n@dna;DNA-1;new\n'
    );
  });

  it('replaces only the leading alias of a reference followed by prose', () => {
    expect(rewrite('DNA-1;pUC 19 를 형질전환했다\n', 'DNA-1', 'pUC 19', 'pUC19-v2')).toBe(
      'DNA-1;pUC19-v2 를 형질전환했다\n'
    );
  });

  it('extends a prefix alias but leaves a reference that only shares the prefix', () => {
    expect(rewrite('DNA-1;ANC 사용\n', 'DNA-1', 'ANC', 'ANC 튜브')).toBe('DNA-1;ANC 튜브 사용\n');
    expect(rewrite('DNA-1;ANC 사용\n', 'DNA-1', 'ANC 튜브', 'ANC')).toBe('DNA-1;ANC 사용\n');
    expect(rewrite('DNA-1;ANCX 사용\n', 'DNA-1', 'ANC', 'B')).toBe('DNA-1;ANCX 사용\n');
  });

  it('does not double a reference already written with the new alias', () => {
    expect(rewrite('DNA-1;ANC 튜브 사용\n', 'DNA-1', 'ANC', 'ANC 튜브')).toBe('DNA-1;ANC 튜브 사용\n');
  });

  it('keeps table cells intact with escaped pipes', () => {
    const text = '| Equip-1;DNase \\| 등급 | ok |\n| @equip;Equip-1;DNase \\| 등급 | x |\n';
    expect(rewrite(text, 'Equip-1', 'DNase | 등급', 'DNase | A', 'Equip')).toBe(
      '| Equip-1;DNase \\| A | ok |\n| @equip;Equip-1;DNase \\| A | x |\n'
    );
  });

  it('tells DNA-12 from DNA-12-3 and leaves other aliases alone', () => {
    const text = 'DNA-12-3;old, DNA-12;old 와 DNA-12;other\n';
    expect(rewrite(text, 'DNA-12', 'old', 'new')).toBe('DNA-12-3;old, DNA-12;new 와 DNA-12;other\n');
  });

  it('drops the alias and its ; when the new alias is empty', () => {
    expect(rewrite('DNA-1;old 를 썼다\n@dna;DNA-1;old;설명\n', 'DNA-1', 'old', '')).toBe(
      'DNA-1 를 썼다\n@dna;DNA-1;;설명\n'
    );
  });

  it('plans nothing when the alias did not change', () => {
    expect(planAliasRewrite('DNA-1;same\n', 'DNA', 'DNA-1', 'same', 'same')).toEqual([]);
  });
});

describe('saveSamplesFromDocument + loadSamplesByType (MemFileSystem round-trip)', () => {
  const DOC = 'labnote/001_Exp/note.labnote.md';
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('persists extracted samples to {Type}.json and loads them back', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;my plasmid');

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1']).toEqual({
      type: 'DNA',
      alias: 'pUC19',
      descriptions: ['my plasmid'],
      sources: ['note.labnote.md'],
      location: null,
    });
  });

  it('merges a second document into the same {Type}.json', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;a');
    await saveSamplesFromDocument(fs, 'labnote/001_Exp/other.labnote.md', '@DNA;DNA-2;b');

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(Object.keys(records).sort()).toEqual(['DNA-1', 'DNA-2']);
  });

  it('returns an empty object when the type file does not exist', async () => {
    const fs = new MemFileSystem();
    expect(await loadSamplesByType(fs, FOLDER, 'DNA')).toEqual({});
  });

  // #82: an experiment that only references Global samples has no local registry.
  it('creates no local {Type}.json for a reference to a Global sample', async () => {
    const GLOBAL = 'resources/labsamples';
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, GLOBAL, 'Reagent', 'Reagent-1', { alias: 'PBS', description: null });

    await saveSamplesFromDocument(fs, DOC, 'Reagent-1;PBS 로 세척', GLOBAL);
    await saveSamplesFromDocument(fs, DOC, '@reagent;Reagent-1;PBS', GLOBAL);
    await saveSamplesFromDocument(fs, DOC, 'Reagent-404;모르는 시약', GLOBAL);

    expect(await fs.exists(`${FOLDER}/Reagent.json`)).toBe(false);
  });

  it('still updates an existing local {Type}.json that ends up empty', async () => {
    const fs = new MemFileSystem();
    await fs.write(`${FOLDER}/DNA.json`, '{"DNA-1":{"type":"DNA","alias":"a","descriptions":[],"sources":[]}}');
    await saveSamplesFromDocument(fs, DOC, 'DNA-1;a');

    expect(Object.keys(await loadSamplesByType(fs, FOLDER, 'DNA'))).toEqual(['DNA-1']);
  });

  it('normalizes legacy records missing sources/descriptions without throwing', async () => {
    // A pre-normalization record with no `sources`/`descriptions` used to cause
    // `record.sources.length` TypeErrors downstream. Phase 7 normalizes on load.
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/DNA.json`,
      JSON.stringify({ 'DNA-9': { type: 'DNA', alias: 'legacy' } })
    );
    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-9']).toEqual({
      type: 'DNA',
      alias: 'legacy',
      descriptions: [],
      sources: [],
      location: null,
    });
  });
});

describe('saveSamplesByType type validation', () => {
  // Fixed in Phase 1-1: `type` is validated before use, so a traversal payload
  // (path separators / `..`) is rejected before any write.
  it('rejects a traversal payload in the sample type', async () => {
    const fs = new MemFileSystem();
    await expect(
      saveSamplesByType(fs, 'labnote/001_Exp/resources/labsamples', '../../../../evil', {})
    ).rejects.toThrow();
  });
});

describe('upsertSampleRecord (Phase 3 atomic merge)', () => {
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('creates a record when the file is absent', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'pUC19',
      description: 'my plasmid',
      sources: ['note.labnote.md'],
    });
    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1']).toEqual({
      type: 'DNA',
      alias: 'pUC19',
      descriptions: ['my plasmid'],
      sources: ['note.labnote.md'],
      location: null,
    });
  });

  it('preserves existing sources when `sources` is omitted (sidebar edit)', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'a',
      description: null,
      sources: ['note.labnote.md'],
    });
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'b', description: 'new desc' });

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1'].alias).toBe('b');
    expect(records['DNA-1'].descriptions).toEqual(['new desc']);
    expect(records['DNA-1'].sources).toEqual(['note.labnote.md']);
  });

  it('does not drop concurrent upserts of different ids into one file', async () => {
    const fs = new MemFileSystem();
    await Promise.all([
      upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'a', description: null }),
      upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-2', { alias: 'b', description: null }),
      upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-3', { alias: 'c', description: null }),
    ]);
    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(Object.keys(records).sort()).toEqual(['DNA-1', 'DNA-2', 'DNA-3']);
  });
});

describe('mergeSampleRecord (#73)', () => {
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('creates a record when the file is absent', async () => {
    const fs = new MemFileSystem();
    await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { description: 'd', sources: ['a.md'] });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toEqual({
      type: 'DNA',
      alias: null,
      descriptions: ['d'],
      sources: ['a.md'],
      location: null,
    });
  });

  it('keeps omitted fields, puts the new description first, and unions sources', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      type: 'DNA',
      alias: 'pUC19',
      descriptions: ['old', 'older'],
      sources: ['a.md'],
      location: 'Box-1',
    });

    await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { description: 'older', sources: ['b.md', 'a.md'] });

    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toEqual({
      type: 'DNA',
      alias: 'pUC19',
      descriptions: ['older', 'old'],
      sources: ['a.md', 'b.md'],
      location: 'Box-1',
    });
  });

  it('replaces alias and location when given', async () => {
    const fs = new MemFileSystem();
    await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'a', location: 'L1' });
    await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'b', location: 'L2' });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toMatchObject({ alias: 'b', location: 'L2' });
  });
});

describe('deleteSampleRecord', () => {
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  const seed = async (fs: MemFileSystem, ids: string[]): Promise<void> => {
    for (const id of ids) {
      await upsertSampleRecord(fs, FOLDER, 'DNA', id, { alias: id, description: null });
    }
  };

  it('removes only the requested id', async () => {
    const fs = new MemFileSystem();
    await seed(fs, ['DNA-1', 'DNA-2']);

    expect(await deleteSampleRecord(fs, FOLDER, 'DNA', 'DNA-1')).toBe(true);
    expect(Object.keys(await loadSamplesByType(fs, FOLDER, 'DNA'))).toEqual(['DNA-2']);
  });

  it('reports false for an unknown id and leaves the file untouched', async () => {
    const fs = new MemFileSystem();
    await seed(fs, ['DNA-1']);
    const before = fs.snapshot();

    expect(await deleteSampleRecord(fs, FOLDER, 'DNA', 'DNA-9')).toBe(false);
    expect(fs.snapshot()).toEqual(before);
  });

  it('reports false when the file does not exist', async () => {
    const fs = new MemFileSystem();
    expect(await deleteSampleRecord(fs, FOLDER, 'DNA', 'DNA-1')).toBe(false);
    // Must not create an empty `{Type}.json` just to find nothing in it.
    expect(fs.snapshot()).toEqual({});
  });

  it('does not clobber a concurrent upsert of a different id', async () => {
    const fs = new MemFileSystem();
    await seed(fs, ['DNA-1', 'DNA-2']);

    await Promise.all([
      deleteSampleRecord(fs, FOLDER, 'DNA', 'DNA-1'),
      upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-3', { alias: 'c', description: null }),
    ]);

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(Object.keys(records).sort()).toEqual(['DNA-2', 'DNA-3']);
  });

  it('rejects a traversal payload in the sample type', async () => {
    const fs = new MemFileSystem();
    await expect(deleteSampleRecord(fs, FOLDER, '../../evil', 'x')).rejects.toThrow();
  });
});

describe('putSampleRecord (verbatim atomic write)', () => {
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  const rec = (over: Partial<SampleRecord> = {}): SampleRecord => ({
    type: 'DNA',
    alias: 'pUC19',
    descriptions: ['first', 'second'],
    sources: ['a.labnote.md', 'b.labnote.md'],
    location: null,
    ...over,
  });

  it('creates the file and stores the record verbatim', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', rec());

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1']).toEqual(rec());
  });

  it('preserves multiple descriptions and sources (unlike upsertSampleRecord)', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', rec());

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1'].descriptions).toEqual(['first', 'second']);
    expect(records['DNA-1'].sources).toEqual(['a.labnote.md', 'b.labnote.md']);
  });

  it('overwrites an existing record with the given one', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'old', description: 'old' });
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', rec({ alias: 'new' }));

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1'].alias).toBe('new');
    expect(records['DNA-1'].descriptions).toEqual(['first', 'second']);
  });

  it('does not disturb sibling records in the same file', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-2', { alias: 'keep', description: null });
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', rec());

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(Object.keys(records).sort()).toEqual(['DNA-1', 'DNA-2']);
    expect(records['DNA-2'].alias).toBe('keep');
  });

  it('rejects a traversal payload in the sample type', async () => {
    const fs = new MemFileSystem();
    await expect(putSampleRecord(fs, FOLDER, '../../evil', 'x', rec())).rejects.toThrow();
  });
});

describe('removeSourcesForDocument keeps the sample', () => {
  const DOC = 'labnote/001_Exp/001_WF.labnote.md';
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('drops the source but keeps a menu-created record (empty document text)', async () => {
    const fs = new MemFileSystem();
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      alias: 'pUC19',
      description: 'desc',
      location: '냉장고-1',
    });
    // Record a usage from the note, then "delete" the note (empty text).
    await saveSamplesFromDocument(fs, DOC, '@dna;DNA-1;pUC19;desc');
    await removeSourcesForDocument(fs, DOC, '');

    const records = await loadSamplesByType(fs, FOLDER, 'DNA');
    expect(records['DNA-1']).toBeDefined();
    expect(records['DNA-1'].sources).toEqual([]);
    expect(records['DNA-1'].location).toBe('냉장고-1');
  });

  it('keeps a record that was only ever defined in the deleted note', async () => {
    const fs = new MemFileSystem();
    // No prior registry entry: the note's `@` definition seeds it…
    await saveSamplesFromDocument(fs, DOC, '@rna;RNA-5;siKIF;knockdown');
    expect((await loadSamplesByType(fs, FOLDER, 'RNA'))['RNA-5']).toBeDefined();

    // …and deleting the note no longer erases the sample.
    await removeSourcesForDocument(fs, DOC, '');
    const records = await loadSamplesByType(fs, FOLDER, 'RNA');
    expect(records['RNA-5']).toBeDefined();
    expect(records['RNA-5'].sources).toEqual([]);
  });
});

describe('findSampleUsages', () => {
  const docs = [
    { path: 'labnote/001_Exp/a.labnote.md', text: 'uses DNA-1;pUC19 here' },
    { path: 'labnote/001_Exp/b.labnote.md', text: '@dna;dna-1;alias;def' },
    { path: 'labnote/001_Exp/c.labnote.md', text: 'no samples here' },
  ];

  it('finds both plain references and definitions, ignoring id case', () => {
    expect(findSampleUsages(docs, 'DNA', 'DNA-1').sort()).toEqual([
      'labnote/001_Exp/a.labnote.md',
      'labnote/001_Exp/b.labnote.md',
    ]);
  });

  it('returns empty when no note references the sample', () => {
    expect(findSampleUsages(docs, 'DNA', 'DNA-9')).toEqual([]);
  });

  it('matches a custom type passed via additionalTypes', () => {
    const custom = [{ path: 'x.md', text: 'see Strain-3 in the freezer' }];
    expect(findSampleUsages(custom, 'Strain', 'Strain-3', ['Strain'])).toEqual(['x.md']);
    expect(findSampleUsages(custom, 'Strain', 'Strain-3')).toEqual([]);
  });
});
