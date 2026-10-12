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
} from '../lib/sampleUtils';
import { parseSampleTrigger } from '../sample/sampleSuggest';

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

describe('isCatalogSampleType', () => {
  it('is true for reference-DB types', () => {
    expect(isCatalogSampleType('Reagent')).toBe(true);
    expect(isCatalogSampleType('Labware')).toBe(true);
    expect(isCatalogSampleType('Equip')).toBe(true);
  });

  it('is false for authored types', () => {
    expect(isCatalogSampleType('DNA')).toBe(false);
    expect(isCatalogSampleType('RNA')).toBe(false);
    expect(isCatalogSampleType('Custom')).toBe(false);
  });
});

describe('the built-in Other type', () => {
  it('is offered in the tree with a colour of its own', () => {
    const meta = getSampleDisplayMeta();
    expect(meta.types).toContain('Other');
    expect(meta.colors.Other).toBeTruthy();
  });

  it('is authored, not a catalog type, so ids can be generated or typed', () => {
    expect(isCatalogSampleType('Other')).toBe(false);
    const t = parseSampleTrigger('@other:', [...SAMPLE_TYPES])!;
    expect(t.typesToSearch).toEqual(['Other']);
    expect(sampleSuggestActions(t)).toEqual({ generate: true, manual: true, catalog: false });
  });
});

describe('sampleSuggestActions', () => {
  it('offers generate + manual for a concrete authored type', () => {
    const t = parseSampleTrigger('@dna:', TYPES)!;
    expect(sampleSuggestActions(t)).toEqual({ generate: true, manual: true, catalog: false });
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
});
