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
  noteLabsamplesFolder,
  inventorySampleFolder,
  moveSampleFolder,
  planAliasRewrite,
  applyAliasRewrite,
  planSampleIdRewrite,
  sampleIdForType,
  planLocalSampleAdoption,
  legacyDefinitionSpan,
  hasReferenceCatalog,
  removeSampleSource,
  sampleTypesInText,
  renameSampleSources,
  renameSampleSourcesInFolder,
  setSampleDiscarded,
  listExperimentSampleFolders,
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

  it('gives a vault-root note a changed Global folder too (#101)', () => {
    expect(resolveLocalSampleFolder('Welcome.md', EXP, 'Samples').folder).toBe('Samples');
  });
});

// #101: a vault-root note's registry is the Global folder, whatever it is set to.
describe('noteLabsamplesFolder (#101)', () => {
  it('maps experiment, vault-root and other notes', () => {
    expect(noteLabsamplesFolder('labnote/001_GFP/001_WB030_X.labnote.md', 'Samples')).toBe(
      'labnote/001_GFP/resources/labsamples'
    );
    expect(noteLabsamplesFolder('labnote/001_GFP/sub/x.labnote.md', 'Samples')).toBe(
      'labnote/001_GFP/resources/labsamples'
    );
    expect(noteLabsamplesFolder('Welcome.md', 'Samples')).toBe('Samples');
    expect(noteLabsamplesFolder('notes/memo.md', 'Samples')).toBe('notes/resources/labsamples');
    expect(noteLabsamplesFolder('Welcome.md')).toBe('resources/labsamples');
  });

  it('saves a vault-root note to the new Global folder', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, 'Welcome.md', '@DNA;DNA-1;pUC19', 'Samples');
    expect(Object.keys(await loadSamplesByType(fs, 'Samples', 'DNA'))).toEqual(['DNA-1']);
    expect(await fs.exists('resources/labsamples/DNA.json')).toBe(false);
  });
});

describe('moving the Global sample folder (#101)', () => {
  const TYPES = ['DNA', 'Reagent'];
  const record = (alias: string): SampleRecord => ({ type: 'DNA', alias, descriptions: [], sources: [] });

  async function seeded() {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, 'old', 'DNA', 'DNA-1', record('a'));
    await putSampleRecord(fs, 'old', 'DNA', 'DNA-2', record('b'));
    await fs.write('old/Reagent_sigma.json', '{}');
    await fs.write('old/notes.txt', 'keep');
    return fs;
  }

  it('counts the records and catalog files left behind', async () => {
    const fs = await seeded();
    expect(await inventorySampleFolder(fs, 'old', TYPES)).toEqual({ records: 2, catalogs: ['Reagent_sigma.json'] });
    expect(await inventorySampleFolder(fs, 'missing', TYPES)).toEqual({ records: 0, catalogs: [] });
  });

  it('moves records and catalogs, skipping IDs and file names the new folder has', async () => {
    const fs = await seeded();
    await putSampleRecord(fs, 'new', 'DNA', 'dna-2', record('kept'));
    await fs.write('new/Reagent_sigma.json', '{"x":1}');

    const result = await moveSampleFolder(fs, 'old', 'new', TYPES);

    expect(result).toEqual({ moved: 1, skipped: ['DNA DNA-2'], catalogsMoved: 0, catalogsSkipped: ['Reagent_sigma.json'] });
    expect(Object.keys(await loadSamplesByType(fs, 'new', 'DNA')).sort()).toEqual(['DNA-1', 'dna-2']);
    expect((await loadSamplesByType(fs, 'new', 'DNA'))['dna-2'].alias).toBe('kept');
    expect(Object.keys(await loadSamplesByType(fs, 'old', 'DNA'))).toEqual(['DNA-2']);
    expect(await fs.read('new/Reagent_sigma.json')).toBe('{"x":1}');
  });

  it('empties and removes the old folder when everything moved', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, 'old', 'DNA', 'DNA-1', record('a'));
    await fs.write('old/Reagent_sigma.json', '{}');

    const result = await moveSampleFolder(fs, 'old', 'new', TYPES);

    expect(result).toMatchObject({ moved: 1, catalogsMoved: 1 });
    expect(await fs.read('new/Reagent_sigma.json')).toBe('{}');
    expect(await fs.exists('old')).toBe(false);
  });

  it('still reports the move when the emptied folder cannot be removed', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, 'old', 'DNA', 'DNA-1', record('a'));
    fs.rmdir = async () => {
      throw new Error('Path is a directory: rm returned EISDIR (is a directory) old');
    };

    const result = await moveSampleFolder(fs, 'old', 'new', TYPES);

    expect(result).toMatchObject({ moved: 1, skipped: [] });
    expect(Object.keys(await loadSamplesByType(fs, 'new', 'DNA'))).toEqual(['DNA-1']);
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

// #116: a sample registered under the wrong type moves to the right one.
describe('sampleIdForType', () => {
  it('swaps the type prefix and keeps the numbers', () => {
    expect(sampleIdForType('RNA', 'RNA-1792298689414-3', 'DNA')).toBe('DNA-1792298689414-3');
    expect(sampleIdForType('RNA', 'rna-12', 'Cell_Line')).toBe('Cell_Line-12');
    expect(sampleIdForType('RNA', 'DNA-12', 'Primer')).toBeUndefined();
  });
});

describe('planSampleIdRewrite', () => {
  const rewrite = (text: string) =>
    applyAliasRewrite(text, planSampleIdRewrite(text, 'RNA', 'RNA-1', 'DNA', 'DNA-1'));

  it('rewrites references and definitions, keeping alias, description and keyword case', () => {
    expect(rewrite('@rna;RNA-1;pUC19;플라스미드\n사용: RNA-1;pUC19, rna-1')).toBe(
      '@dna;DNA-1;pUC19;플라스미드\n사용: DNA-1;pUC19, DNA-1'
    );
    expect(rewrite('@RNA:RNA-1;x')).toBe('@DNA:DNA-1;x');
  });

  it('leaves other ids alone', () => {
    expect(rewrite('RNA-12 RNA-1-3 XRNA-1 RNA-1')).toBe('RNA-12 RNA-1-3 XRNA-1 DNA-1');
  });

  it('tells definitions from references', () => {
    const edits = planSampleIdRewrite('@rna;RNA-1;a RNA-1', 'RNA', 'RNA-1', 'DNA', 'DNA-1');
    expect(edits.map(e => e.kind)).toEqual(['definition', 'reference']);
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

  // #170
  it('adds a new alias to bare-id references when there was none', () => {
    const text = 'DNA-1 을 썼다. DNA-12, DNA-1-3, DNA-1;\n@dna;DNA-1\n| DNA-1 |\n';
    expect(rewrite(text, 'DNA-1', '', 'pUC19')).toBe(
      'DNA-1;pUC19 을 썼다. DNA-12, DNA-1-3, DNA-1;pUC19\n@dna;DNA-1\n| DNA-1;pUC19 |\n'
    );
    expect(planAliasRewrite(text, 'DNA', 'DNA-1', '', '')).toEqual([]);
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

  // #98: an old alias with ";" or ":" was read back cut at that character.
  it('rewrites references and definitions of an old alias holding ";" or ":"', () => {
    const text = 'DNA-1;EXT-01;여름 을 썼다\n@dna;DNA-1;EXT-01;여름;여름 추출\n@dna;DNA-1;EXT-01;여름\n';
    expect(rewrite(text, 'DNA-1', 'EXT-01;여름', 'EXT-01 여름')).toBe(
      'DNA-1;EXT-01 여름 을 썼다\n@dna;DNA-1;EXT-01 여름;여름 추출\n@dna;DNA-1;EXT-01 여름\n'
    );
    expect(rewrite('희석 DNA-2;1:10 사용\n@dna;DNA-2;1:10;설명\n', 'DNA-2', '1:10', '1-10')).toBe(
      '희석 DNA-2;1-10 사용\n@dna;DNA-2;1-10;설명\n'
    );
  });

  it('leaves an old alias with ";" alone where the text does not match it', () => {
    const text = 'DNA-1;EXT-01;가을 사용\n@dna;DNA-1;EXT-01;여름X\n';
    expect(planAliasRewrite(text, 'DNA', 'DNA-1', 'EXT-01;여름', 'new')).toEqual([]);
  });

  it('drops an old alias with ";" from a reference when the new alias is empty', () => {
    expect(rewrite('DNA-1;EXT-01;여름 사용\n', 'DNA-1', 'EXT-01;여름', '')).toBe('DNA-1 사용\n');
  });
});

describe('legacyDefinitionSpan (#98)', () => {
  const text = '@dna;DNA-1;EXT-01;여름;여름 추출  \n다음 줄';
  const aliasStart = text.indexOf('EXT');

  it('covers the old alias and the description after it', () => {
    expect(legacyDefinitionSpan(text, aliasStart, 'EXT-01;여름')).toEqual({
      end: text.indexOf('  \n'),
      description: '여름 추출',
    });
  });

  it('ends at the alias when no description follows', () => {
    const bare = '@dna;DNA-1;EXT-01;여름\n';
    expect(legacyDefinitionSpan(bare, aliasStart, 'EXT-01;여름')).toEqual({
      end: bare.indexOf('\n'),
      description: null,
    });
  });

  it('is undefined when the text is not the old alias', () => {
    expect(legacyDefinitionSpan(text, aliasStart, 'EXT-01;가을')).toBeUndefined();
    expect(legacyDefinitionSpan('@dna;DNA-1;EXT-01;여름X\n', aliasStart, 'EXT-01;여름')).toBeUndefined();
  });

  it('lets findSampleDefinitionMatch replace the whole definition', () => {
    const def = '@dna;DNA-1;EXT-01;여름;여름 추출';
    const doc = `본문\n${def}\n`;
    expect(findSampleDefinitionMatch(doc, 'DNA', 'DNA-1', 'EXT-01;여름')).toEqual({
      start: doc.indexOf(def),
      length: def.length,
    });
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
      descriptionSources: { 'note.labnote.md': 'my plasmid' },
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

  // #188
  it('keeps discarded, descriptionSources and the descriptions other notes added', async () => {
    const fs = new MemFileSystem();
    const stored = {
      type: 'DNA',
      alias: 'a',
      descriptions: ['first', 'from B'],
      sources: ['A.md', 'B.md'],
      location: 'Box-1',
      discarded: '2026-10-19',
      descriptionSources: { 'B.md': 'from B' },
    };
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', stored);

    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'a', description: 'first', location: 'Box-1' });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toEqual(stored);

    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'b', description: 'edited', location: 'Trash' });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toEqual({
      ...stored,
      alias: 'b',
      descriptions: ['edited', 'from B'],
      location: 'Trash',
    });
  });

  it('drops only the first description when it is cleared', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      type: 'DNA',
      alias: 'a',
      descriptions: ['first', 'second'],
      sources: [],
      location: null,
    });
    await upsertSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { alias: 'a', description: null });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].descriptions).toEqual(['second']);
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

  // #188
  it('keeps a discarded date and descriptionSources, and reports the date', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', {
      type: 'DNA',
      alias: 'a',
      descriptions: ['d'],
      sources: ['a.md'],
      location: null,
      discarded: '2026-10-19',
      descriptionSources: { 'a.md': 'd' },
    });
    const result = await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-1', { description: 'e', sources: ['b.md'] });
    expect(result).toEqual({ discarded: '2026-10-19' });
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).toMatchObject({
      discarded: '2026-10-19',
      descriptionSources: { 'a.md': 'd' },
      descriptions: ['e', 'd'],
    });
    expect(await mergeSampleRecord(fs, FOLDER, 'DNA', 'DNA-2', { description: 'x' })).toEqual({ discarded: null });
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

describe('planLocalSampleAdoption (#97)', () => {
  const rec = (alias: string, sources: string[]): SampleRecord => ({
    type: 'RNA',
    alias,
    descriptions: ['총 RNA'],
    sources,
    location: 'Freezer-1',
  });
  const NOTE = '추출 산물: RNA-1;총RNA-A1, RNA-2;총RNA-A2, RNA-3;전역';
  const base = {
    noteText: NOTE,
    newName: '002_WB050_RNA_Extraction.labnote.md',
    from: {
      RNA: {
        'RNA-1': rec('총RNA-A1', ['001_WB050_RNA_Extraction.labnote.md']),
        'RNA-2': rec('총RNA-A2', ['001_WB050_RNA_Extraction.labnote.md']),
        'RNA-9': rec('안 씀', ['001_WB050_RNA_Extraction.labnote.md']),
      },
    } as SampleDatabase,
    to: {} as SampleDatabase,
    global: { RNA: { 'RNA-3': rec('전역', []) } } as SampleDatabase,
    usedElsewhere: new Set<string>(),
  };

  it('moves the Local samples the note uses, with the note as their only source', () => {
    const plan = planLocalSampleAdoption(base);
    expect(plan.map(a => [a.id, a.action])).toEqual([
      ['RNA-1', 'move'],
      ['RNA-2', 'move'],
    ]);
    expect(plan[0].record).toEqual({ ...rec('총RNA-A1', []), sources: [base.newName] });
  });

  it('copies a sample a note left in the old experiment still uses, even when sources miss it', () => {
    const plan = planLocalSampleAdoption({
      ...base,
      usedElsewhere: new Set([sampleReferenceKey('RNA', 'rna-2')]),
    });
    expect(plan.map(a => [a.id, a.action])).toEqual([
      ['RNA-1', 'move'],
      ['RNA-2', 'copy'],
    ]);
  });

  it('skips ids the new experiment or the Global registry already resolves', () => {
    const plan = planLocalSampleAdoption({ ...base, to: { RNA: { 'rna-1': rec('있음', []) } } });
    expect(plan.map(a => a.id)).toEqual(['RNA-2']);
  });

  it('matches registry ids ignoring case and keeps the registry spelling', () => {
    const plan = planLocalSampleAdoption({ ...base, noteText: 'rna-1 사용' });
    expect(plan.map(a => a.id)).toEqual(['RNA-1']);
  });

  it('plans nothing for a note without samples from the old registry', () => {
    expect(planLocalSampleAdoption({ ...base, noteText: 'DNA-5;플라스미드' })).toEqual([]);
  });

  it('lists the registry types a note uses', () => {
    expect(sampleTypesInText('RNA-1;a, DNA-2;b, RNA-3').sort()).toEqual(['DNA', 'RNA']);
  });
});

describe('hasReferenceCatalog (#99)', () => {
  const FOLDER = 'resources/labsamples';

  it('sees a {Type}_*.json file without reading it, empty or not', async () => {
    const fs = new MemFileSystem();
    expect(await hasReferenceCatalog(fs, FOLDER, 'Reagent')).toBe(false);
    await fs.write(`${FOLDER}/Reagent.json`, '{}');
    await fs.write(`${FOLDER}/Labware_Corning.json`, '{}');
    expect(await hasReferenceCatalog(fs, FOLDER, 'Reagent')).toBe(false);
    await fs.write(`${FOLDER}/Reagent_Sigma.json`, '');
    expect(await hasReferenceCatalog(fs, FOLDER, 'Reagent')).toBe(true);
    expect(await hasReferenceCatalog(fs, FOLDER, 'Labware')).toBe(true);
  });

  it('is false for an empty folder setting', async () => {
    expect(await hasReferenceCatalog(new MemFileSystem(), '', 'Reagent')).toBe(false);
  });
});

describe('removeSampleSource (#97)', () => {
  const FOLDER = 'labnote/001_A/resources/labsamples';
  const record = (sources: string[]): SampleRecord => ({
    type: 'RNA',
    alias: 'a',
    descriptions: ['d1', 'd2'],
    sources,
    location: null,
  });

  it('drops one source and leaves other fields and ids as they are', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'RNA', 'RNA-1', record(['x.labnote.md', 'y.labnote.md']));
    await putSampleRecord(fs, FOLDER, 'RNA', 'RNA-2', record(['x.labnote.md']));

    expect(await removeSampleSource(fs, FOLDER, 'RNA', 'RNA-1', 'x.labnote.md')).toBe(true);
    const records = await loadSamplesByType(fs, FOLDER, 'RNA');
    expect(records['RNA-1']).toEqual(record(['y.labnote.md']));
    expect(records['RNA-2']).toEqual(record(['x.labnote.md']));
  });

  it('reports false and leaves the file untouched when the source is not listed', async () => {
    const fs = new MemFileSystem();
    await putSampleRecord(fs, FOLDER, 'RNA', 'RNA-1', record(['y.labnote.md']));
    const before = fs.snapshot();
    expect(await removeSampleSource(fs, FOLDER, 'RNA', 'RNA-1', 'x.labnote.md')).toBe(false);
    expect(await removeSampleSource(fs, FOLDER, 'RNA', 'RNA-9', 'y.labnote.md')).toBe(false);
    expect(fs.snapshot()).toEqual(before);
  });
});

describe('descriptionSources (#172)', () => {
  const DOC = 'labnote/001_Exp/note.labnote.md';
  const OTHER = 'labnote/001_Exp/other.labnote.md';
  const FOLDER = 'labnote/001_Exp/resources/labsamples';

  it('replaces the description a note put in when its definition changes', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;old text');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;new text');
    const rec = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.descriptions).toEqual(['new text']);
    expect(rec.descriptionSources).toEqual({ 'note.labnote.md': 'new text' });
  });

  it('keeps descriptions from other notes and from before tracking', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      `${FOLDER}/DNA.json`,
      JSON.stringify({ 'DNA-1': { type: 'DNA', alias: null, descriptions: ['edited'], sources: [], location: null } })
    );
    await saveSamplesFromDocument(fs, OTHER, '@DNA;DNA-1;pUC19;from other');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;first');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;second');
    const rec = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.descriptions).toEqual(['second', 'from other', 'edited']);
  });

  it('keeps a description another note still writes', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, OTHER, '@DNA;DNA-1;pUC19;shared');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;shared');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;changed');
    const rec = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.descriptions).toEqual(['changed', 'shared']);
  });

  it('a blank description keeps the stored one', async () => {
    const fs = new MemFileSystem();
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;kept');
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19');
    const rec = (await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'];
    expect(rec.descriptions).toEqual(['kept']);
  });
});

describe('renameSampleSources (#149)', () => {
  const rec = (sources: string[], descriptionSources?: Record<string, string>): SampleRecord => ({
    type: 'DNA',
    alias: null,
    descriptions: [],
    sources,
    location: null,
    ...(descriptionSources ? { descriptionSources } : {}),
  });

  it('renames sources and descriptionSources keys without touching the input', () => {
    const input = { 'DNA-1': rec(['a.md', 'b.md'], { 'a.md': 'x' }), 'DNA-2': rec(['c.md']) };
    const { records, changed } = renameSampleSources(input, new Map([['a.md', 'z.md']]));
    expect(changed).toBe(true);
    expect(records['DNA-1'].sources).toEqual(['z.md', 'b.md']);
    expect(records['DNA-1'].descriptionSources).toEqual({ 'z.md': 'x' });
    expect(records['DNA-2'].sources).toEqual(['c.md']);
    expect(input['DNA-1'].sources).toEqual(['a.md', 'b.md']);
  });

  it('applies swaps at once and merges a rename onto a listed name', () => {
    const swap = renameSampleSources(
      { 'DNA-1': rec(['a.md', 'b.md']) },
      new Map([['a.md', 'b.md'], ['b.md', 'a.md']])
    );
    expect(swap.records['DNA-1'].sources).toEqual(['b.md', 'a.md']);
    const onto = renameSampleSources({ 'DNA-1': rec(['a.md', 'b.md']) }, new Map([['a.md', 'b.md']]));
    expect(onto.records['DNA-1'].sources).toEqual(['b.md']);
  });

  it('reports no change and leaves a file alone when no record mentions the names', async () => {
    const fs = new MemFileSystem();
    const raw = JSON.stringify({ 'DNA-1': rec(['a.md']) });
    await fs.write('f/DNA.json', raw);
    expect(await renameSampleSourcesInFolder(fs, 'f', new Map([['x.md', 'y.md']]), ['DNA', 'RNA'])).toBe(0);
    expect(await fs.read('f/DNA.json')).toBe(raw);
    expect(await renameSampleSourcesInFolder(fs, 'f', new Map([['a.md', 'y.md']]), ['DNA', 'RNA'])).toBe(1);
    expect((await loadSamplesByType(fs, 'f', 'DNA'))['DNA-1'].sources).toEqual(['y.md']);
  });
});

describe('setSampleDiscarded (#158)', () => {
  it('marks and clears the discard date, and keeps it through a note save', async () => {
    const fs = new MemFileSystem();
    const DOC = 'labnote/001_Exp/note.labnote.md';
    const FOLDER = 'labnote/001_Exp/resources/labsamples';
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19');
    expect(await setSampleDiscarded(fs, FOLDER, 'DNA', 'DNA-1', '2026-10-19')).toBe(true);
    await saveSamplesFromDocument(fs, DOC, '@DNA;DNA-1;pUC19;more');
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1'].discarded).toBe('2026-10-19');
    expect(await setSampleDiscarded(fs, FOLDER, 'DNA', 'DNA-1', null)).toBe(true);
    expect((await loadSamplesByType(fs, FOLDER, 'DNA'))['DNA-1']).not.toHaveProperty('discarded');
    expect(await setSampleDiscarded(fs, FOLDER, 'DNA', 'DNA-9', '2026-10-19')).toBe(false);
  });
});

describe('listExperimentSampleFolders (#169)', () => {
  it('lists the experiments that have a labsamples folder, in order', async () => {
    const fs = new MemFileSystem();
    await fs.write('labnote/002_B/resources/labsamples/DNA.json', '{}');
    await fs.write('labnote/001_A/resources/labsamples/RNA.json', '{}');
    await fs.write('labnote/003_C/README.labnote.md', '');
    await fs.write('labnote/misc/resources/labsamples/DNA.json', '{}');
    expect(await listExperimentSampleFolders(fs, '')).toEqual([
      'labnote/001_A/resources/labsamples',
      'labnote/002_B/resources/labsamples',
    ]);
    expect(await listExperimentSampleFolders(new MemFileSystem(), '')).toEqual([]);
  });
});
