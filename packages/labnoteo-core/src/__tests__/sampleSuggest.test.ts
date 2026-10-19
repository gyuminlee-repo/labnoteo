// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  parseSampleTrigger,
  buildSampleCompletionEntries,
  findSampleIdRanges,
} from '../sample/sampleSuggest';

const TYPES = ['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware'];

describe('parseSampleTrigger', () => {
  it('detects a specific type prefix at end of line', () => {
    const t = parseSampleTrigger('@dna:', TYPES);
    expect(t).toBeDefined();
    expect(t!.typesToSearch).toEqual(['DNA']);
    expect(t!.searchTerm).toBe('');
    expect(t!.startCol).toBe(0);
  });

  it('captures the search term and is case-insensitive', () => {
    const t = parseSampleTrigger('@DNA:abc', TYPES);
    expect(t!.typesToSearch).toEqual(['DNA']);
    expect(t!.searchTerm).toBe('abc');
  });

  it('allows spaces in the search term (alias search)', () => {
    const t = parseSampleTrigger('@DNA;my plasmid', TYPES);
    expect(t!.typesToSearch).toEqual(['DNA']);
    expect(t!.searchTerm).toBe('my plasmid');
  });

  // #171
  it('closes once a definition is being typed', () => {
    expect(parseSampleTrigger('@DNA;DNA-001;', TYPES)).toBeUndefined();
    expect(parseSampleTrigger('@DNA;DNA-001;my plasmid', TYPES)).toBeUndefined();
    expect(parseSampleTrigger('@DNA;DNA-001', TYPES)).toBeDefined();
  });

  it('treats @sample as all types', () => {
    const t = parseSampleTrigger('@sample:', TYPES);
    expect(t!.typesToSearch).toEqual(TYPES);
  });

  it('maps @item to Labware', () => {
    const t = parseSampleTrigger('@item:', TYPES);
    expect(t!.typesToSearch).toEqual(['Labware']);
  });

  it('matches without a delimiter (trigger before ; or :)', () => {
    const t = parseSampleTrigger('@rna', TYPES);
    expect(t!.typesToSearch).toEqual(['RNA']);
  });

  it('reports the start column when text precedes the trigger', () => {
    const t = parseSampleTrigger('note @rna;', TYPES);
    expect(t!.startCol).toBe(5);
  });

  it('returns undefined without an @', () => {
    expect(parseSampleTrigger('no trigger', TYPES)).toBeUndefined();
  });

  it('returns undefined for an unknown prefix', () => {
    expect(parseSampleTrigger('@unknown:', TYPES)).toBeUndefined();
  });

  it('honours custom types passed in', () => {
    const t = parseSampleTrigger('@cellline:', [...TYPES, 'CellLine']);
    expect(t!.typesToSearch).toEqual(['CellLine']);
  });

  // #62: `\w` is ASCII-only, so a Korean custom type never triggered.
  it('triggers on a non-ASCII custom type', () => {
    const t = parseSampleTrigger('배양에 @배지;', [...TYPES, '배지']);
    expect(t).toEqual({ fullPrefix: '@배지;', searchTerm: '', typesToSearch: ['배지'], startCol: 4 });
    expect(parseSampleTrigger('@배지', [...TYPES, '배지'])!.typesToSearch).toEqual(['배지']);
  });
});

describe('buildSampleCompletionEntries', () => {
  it('formats label and insert text with alias + description', () => {
    const trigger = parseSampleTrigger('@dna:', TYPES)!;
    const entries = buildSampleCompletionEntries(trigger, {
      DNA: [{ id: 'DNA-1', alias: 'plasmidA', description: 'first' }],
    });
    expect(entries).toEqual([
      { type: 'DNA', id: 'DNA-1', label: 'DNA-1 (plasmidA) - first', insertText: 'DNA-1;plasmidA' },
    ]);
  });

  // #109: Local and Global records are told apart in the list.
  it('carries the registry scope through', () => {
    const trigger = parseSampleTrigger('@dna:', TYPES)!;
    const entries = buildSampleCompletionEntries(trigger, {
      DNA: [
        { id: 'DNA-1', alias: 'p', scope: 'local' },
        { id: 'DNA-2', alias: 'p', scope: 'global' },
      ],
    });
    expect(entries.map(e => `${e.id}:${e.scope}`)).toEqual(['DNA-1:local', 'DNA-2:global']);
  });

  it('omits alias/description when absent', () => {
    const trigger = parseSampleTrigger('@dna:', TYPES)!;
    const entries = buildSampleCompletionEntries(trigger, {
      DNA: [{ id: 'DNA-9', alias: null }],
    });
    expect(entries[0]).toEqual({
      type: 'DNA',
      id: 'DNA-9',
      label: 'DNA-9',
      insertText: 'DNA-9',
    });
  });

  it('filters by the (case-insensitive) search term against the label', () => {
    const trigger = parseSampleTrigger('@dna:plasmid', TYPES)!;
    const entries = buildSampleCompletionEntries(trigger, {
      DNA: [
        { id: 'DNA-1', alias: 'plasmidA' },
        { id: 'DNA-2', alias: 'primerX' },
      ],
    });
    expect(entries.map(e => e.id)).toEqual(['DNA-1']);
  });
});

describe('findSampleIdRanges', () => {
  it('locates sample IDs for the given types with correct offsets', () => {
    const text = 'see DNA-12 and RNA-3 here';
    const ranges = findSampleIdRanges(text, ['DNA', 'RNA']);
    expect(ranges).toEqual([
      { start: 4, end: 10, type: 'DNA' },
      { start: 15, end: 20, type: 'RNA' },
    ]);
  });

  it('matches collision-resolved IDs (DNA-1-2)', () => {
    const ranges = findSampleIdRanges('x DNA-1-2 y', ['DNA']);
    expect(ranges).toEqual([{ start: 2, end: 9, type: 'DNA' }]);
  });

  it('returns empty when no IDs present', () => {
    expect(findSampleIdRanges('nothing here', ['DNA'])).toEqual([]);
  });

  // #62: a leading `\b` needs an ASCII word char, which a Korean type is not.
  it('finds ids of a non-ASCII type at line start and after a space', () => {
    expect(findSampleIdRanges('배지-1 그리고 배지-22', ['배지'])).toEqual([
      { start: 0, end: 4, type: '배지' },
      { start: 9, end: 14, type: '배지' },
    ]);
  });

  it('still finds an ASCII-type id glued to Korean text', () => {
    expect(findSampleIdRanges('같게Plasmid-1', ['Plasmid'])).toEqual([{ start: 2, end: 11, type: 'Plasmid' }]);
    expect(findSampleIdRanges('xDNA-1', ['DNA'])).toEqual([]);
  });
});

describe('discarded samples in completion (#158)', () => {
  it('lists discarded samples after every sample in use, keeping their order', () => {
    const trigger = parseSampleTrigger('@dna;', TYPES)!;
    const entries = buildSampleCompletionEntries(trigger, {
      DNA: [
        { id: 'DNA-1', alias: null, discarded: '2026-10-01' },
        { id: 'DNA-2', alias: null },
        { id: 'DNA-3', alias: null, discarded: '2026-10-02' },
        { id: 'DNA-4', alias: null, discarded: null },
      ],
    });
    expect(entries.map(e => [e.id, e.discarded ?? false])).toEqual([
      ['DNA-2', false],
      ['DNA-4', false],
      ['DNA-1', true],
      ['DNA-3', true],
    ]);
  });
});
