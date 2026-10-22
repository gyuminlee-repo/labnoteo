// Globals convention (no `import ... from 'vitest'`): the repo's local runner
// (Node 24 + vitest 4) fails to attach when a core test imports vitest directly,
// so we rely on `globals: true` + tsconfig `types: ["vitest/globals"]`.
import {
  buildSampleDefinitionText,
  buildSampleReferenceText,
  isCatalogSampleType,
  sampleSuggestActions,
  getSampleDisplayMeta,
  SAMPLE_TYPES,
  normalizeSampleId,
  canonicalSampleType,
  escapeSamplePipes,
  hasSampleAliasSeparator,
  hasSampleDescriptionSeparator,
  buildMarkdownTable,
} from '../lib/sampleUtils';
import { buildSampleInsertText, parseSampleTrigger } from '../sample/sampleSuggest';

const TYPES = ['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware'];

describe('buildSampleDefinitionText', () => {
  it('lowercases the type prefix and keeps the id verbatim', () => {
    expect(buildSampleDefinitionText('DNA', 'DNA-123')).toBe('@dna;DNA-123');
  });

  it('appends alias only when a description is absent', () => {
    expect(buildSampleDefinitionText('DNA', 'DNA-123', '별칭')).toBe('@dna;DNA-123;별칭');
  });

  it('emits an empty alias slot when only a description is given', () => {
    expect(buildSampleDefinitionText('RNA', 'RNA-9', '', '설명')).toBe('@rna;RNA-9;;설명');
  });

  it('emits alias and description together', () => {
    expect(buildSampleDefinitionText('Plasmid', 'Plasmid-1', 'pX', 'vector')).toBe(
      '@plasmid;Plasmid-1;pX;vector'
    );
  });
});

describe('normalizeSampleId', () => {
  it('accepts <type>-<number> ids and spells the prefix like the type', () => {
    expect(normalizeSampleId('Equip', 'Equip-3')).toBe('Equip-3');
    expect(normalizeSampleId('Equip', ' equip-3 ')).toBe('Equip-3');
    expect(normalizeSampleId('DNA', 'DNA-1737000000000-2')).toBe('DNA-1737000000000-2');
    expect(normalizeSampleId('배지', '배지-12')).toBe('배지-12');
  });

  // #61: AI extraction stored `ND-11` (a model number) as an Equip id.
  it('rejects anything else', () => {
    expect(normalizeSampleId('Equip', 'ND-11')).toBeUndefined();
    expect(normalizeSampleId('Equip', 'Equip-')).toBeUndefined();
    expect(normalizeSampleId('Equip', 'Equip-3a')).toBeUndefined();
    expect(normalizeSampleId('Equip', 'xEquip-3')).toBeUndefined();
    expect(normalizeSampleId('DNA', 'Plasmid-1')).toBeUndefined();
  });
});

describe('canonicalSampleType', () => {
  it('matches a known type ignoring case', () => {
    expect(canonicalSampleType('equip', TYPES)).toBe('Equip');
    expect(canonicalSampleType('Nope', TYPES)).toBeUndefined();
  });
});

describe('buildSampleReferenceText', () => {
  it('emits bare id when there is no alias', () => {
    expect(buildSampleReferenceText('DNA-123')).toBe('DNA-123');
    expect(buildSampleReferenceText('DNA-123', '')).toBe('DNA-123');
    expect(buildSampleReferenceText('DNA-123', null)).toBe('DNA-123');
  });

  it('emits id;alias when an alias is present', () => {
    expect(buildSampleReferenceText('DNA-123', '별칭')).toBe('DNA-123;별칭');
  });
});

// #98: `;`/`:` end an alias and `;` ends a description in a note.
describe('sample field separators', () => {
  it('flags ";" and ":" in an alias', () => {
    expect(hasSampleAliasSeparator('EXT-01;여름')).toBe(true);
    expect(hasSampleAliasSeparator('1:10')).toBe(true);
    expect(hasSampleAliasSeparator('EXT-01 여름, 1-10 / A|B')).toBe(false);
  });

  it('flags only ";" in a description', () => {
    expect(hasSampleDescriptionSeparator('여름; 추출')).toBe(true);
    expect(hasSampleDescriptionSeparator('희석 1:10, 4°C')).toBe(false);
  });
});

// #72: a bare `|` splits a table cell and ends a sample field.
describe('escaping `|` in sample text', () => {
  it('escapes every bare pipe and leaves escaped ones alone', () => {
    expect(escapeSamplePipes('a|b||c\\|d')).toBe('a\\|b\\|\\|c\\|d');
  });

  it('escapes the alias of a reference', () => {
    expect(buildSampleReferenceText('Equip-1', 'DNase I | 등급')).toBe('Equip-1;DNase I \\| 등급');
  });

  it('escapes the alias and description of a definition', () => {
    expect(buildSampleDefinitionText('Equip', 'Equip-1', 'a|b', 'c|d')).toBe('@equip;Equip-1;a\\|b;c\\|d');
  });

  it('escapes the autocomplete insert text', () => {
    expect(buildSampleInsertText({ id: 'Equip-1', alias: 'a|b' })).toBe('Equip-1;a\\|b');
    expect(buildSampleInsertText({ id: 'Equip-1', alias: 'a\\|b' })).toBe('Equip-1;a\\|b');
  });
});

describe('isCatalogSampleType', () => {
  // Used to be Reagent/Labware/Equip alone, the types with vendor catalogs. A
  // downloaded partbank catalog is a catalog of DNA, plasmids and primers, so
  // what decides is now whether a `{Type}_*.json` file exists, not the type.
  it('is true for every type, authored ones included', () => {
    for (const type of ['Reagent', 'Labware', 'Equip', 'DNA', 'RNA', 'Custom']) {
      expect(isCatalogSampleType(type)).toBe(true);
    }
  });
});

describe('the built-in Other type', () => {
  it('is offered in the tree with a colour of its own', () => {
    const meta = getSampleDisplayMeta();
    expect(meta.types).toContain('Other');
    expect(meta.colors.Other).toBeTruthy();
  });

  it('can have ids generated or typed, and no catalog action without a catalog file', () => {
    const t = parseSampleTrigger('@other:', [...SAMPLE_TYPES])!;
    expect(t.typesToSearch).toEqual(['Other']);
    expect(sampleSuggestActions(t, { catalogAvailable: false })).toEqual({
      generate: true,
      manual: true,
      catalog: false,
    });
  });
});

describe('sampleSuggestActions', () => {
  it('offers generate + manual for a concrete type with no catalog file', () => {
    const t = parseSampleTrigger('@dna:', TYPES)!;
    expect(sampleSuggestActions(t, { catalogAvailable: false })).toEqual({
      generate: true,
      manual: true,
      catalog: false,
    });
  });

  // A downloaded partbank catalog puts DNA parts and plasmids in one.
  it('offers the catalog for an authored type once it has a catalog file', () => {
    const t = parseSampleTrigger('@dna:', TYPES)!;
    expect(sampleSuggestActions(t, { catalogAvailable: true })).toEqual({
      generate: true,
      manual: true,
      catalog: true,
    });
  });

  // #40: without a catalog file, catalog-only left the user inventing an ID.
  it('offers catalog plus generate + manual for Equip (reference-DB type)', () => {
    const t = parseSampleTrigger('@equip:', TYPES)!;
    expect(sampleSuggestActions(t)).toEqual({ generate: true, manual: true, catalog: true });
  });

  it('offers catalog plus generate + manual for @item (Labware, reference-DB type)', () => {
    const t = parseSampleTrigger('@item:', TYPES)!;
    expect(sampleSuggestActions(t)).toEqual({ generate: true, manual: true, catalog: true });
  });

  it('offers catalog plus generate + manual for Reagent', () => {
    const t = parseSampleTrigger('@reagent;', TYPES)!;
    expect(sampleSuggestActions(t)).toEqual({ generate: true, manual: true, catalog: true });
  });

  it('offers no actions for @sample (multi-type)', () => {
    const t = parseSampleTrigger('@sample:', TYPES)!;
    expect(sampleSuggestActions(t)).toEqual({ generate: false, manual: false, catalog: false });
  });

  // #99: "Search catalog" led nowhere in a vault without a catalog file.
  it('leaves catalog out when no catalog file exists, keeping generate + manual', () => {
    const t = parseSampleTrigger('@reagent;', TYPES)!;
    expect(sampleSuggestActions(t, { catalogAvailable: false })).toEqual({
      generate: true,
      manual: true,
      catalog: false,
    });
    expect(sampleSuggestActions(t, { catalogAvailable: true }).catalog).toBe(true);
  });
});

describe('buildMarkdownTable (#152)', () => {
  it('escapes pipes and flattens line breaks in cells', () => {
    expect(buildMarkdownTable(['ID', 'Alias'], [['DNA-1', 'a|b'], ['DNA-2', 'two\nlines']])).toBe(
      ['| ID | Alias |', '| --- | --- |', '| DNA-1 | a\\|b |', '| DNA-2 | two lines |'].join('\n')
    );
  });
});
