// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  resourceSegment,
  webAppPath,
  desktopAppLink,
  typeFromSearchEntity,
  searchEntityForType,
  searchEntitiesForSampleType,
  searchScopeLabel,
  searchScopeHint,
  sampleTypeForItem,
  aliasForItem,
  descriptionForItem,
  sourceForItem,
  formatStockLocation,
  findLinkedSample,
  type LinkedSample,
} from '../partbank/mapping';
import { sampleAliasProblem } from '../lib/sampleUtils';
import type { SampleSource } from '../partbank/types';
import type { SampleRecord } from '../lib/sampleStorage';

const source = (id: string, overrides: Partial<SampleSource> = {}): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin: 'https://partbank.kbiofoundry.kr',
  type: 'part',
  id,
  kid: 'KBp_aa0001',
  ...overrides,
});

describe('paths', () => {
  it('files each type under its plural segment', () => {
    expect(resourceSegment('part')).toBe('parts');
    expect(resourceSegment('plasmid')).toBe('plasmids');
    expect(resourceSegment('strain')).toBe('strains');
  });

  // The API calls it /plasmids, the screen shows it under /devices.
  it('sends a plasmid to the device screen', () => {
    expect(webAppPath({ type: 'plasmid', id: 'abc' })).toBe('/devices/abc');
    expect(webAppPath({ type: 'part', id: 'abc' })).toBe('/parts/abc');
  });

  // The desktop app answers this scheme; it picks the screen itself, so the
  // link names the type rather than a path.
  it('asks the desktop app for an item by type and id', () => {
    expect(desktopAppLink({ type: 'plasmid', id: '507f1f77bcf86cd799439011' })).toBe(
      'partbank://open?type=plasmid&id=507f1f77bcf86cd799439011'
    );
    expect(desktopAppLink({ type: 'strain', id: '507f1f77bcf86cd799439011' })).toBe(
      'partbank://open?type=strain&id=507f1f77bcf86cd799439011'
    );
  });
});

describe('search entities', () => {
  // `vector` is the as-built plasmid Device; `device` excludes plasmids.
  it('maps the vector entity to the plasmid type and back', () => {
    expect(typeFromSearchEntity('vector')).toBe('plasmid');
    expect(searchEntityForType('plasmid')).toBe('vector');
    expect(typeFromSearchEntity('part')).toBe('part');
    expect(typeFromSearchEntity('storage')).toBeUndefined();
  });

  it('searches every entity for @sample', () => {
    expect(searchEntitiesForSampleType(null)).toEqual([
      'part',
      'device',
      'vector',
      'primer',
      'molecule',
      'strain',
    ]);
  });

  it('narrows the search to what a type can be', () => {
    expect(searchEntitiesForSampleType('DNA')).toEqual(['part', 'device', 'molecule']);
    expect(searchEntitiesForSampleType('Plasmid')).toEqual(['vector']);
    expect(searchEntitiesForSampleType('Primer')).toEqual(['primer']);
    expect(searchEntitiesForSampleType('Reagent')).toEqual(['molecule']);
  });

  // No partbank counterpart, which is what hides the search action.
  it('is empty for a type partbank does not carry', () => {
    expect(searchEntitiesForSampleType('Labware')).toEqual([]);
    expect(searchEntitiesForSampleType('Equip')).toEqual([]);
    expect(searchEntitiesForSampleType('Other')).toEqual([]);
  });

  it('offers strains only under the vault\u2019s strain type', () => {
    expect(searchEntitiesForSampleType('Strain')).toEqual([]);
    expect(searchEntitiesForSampleType('Strain', { strainType: 'Strain' })).toEqual(['strain']);
    expect(searchEntitiesForSampleType('strain', { strainType: 'Strain' })).toEqual(['strain']);
    expect(searchEntitiesForSampleType('CellLine', { strainType: 'CellLine' })).toEqual(['strain']);
  });
});

// #276: `@protein;` only reaches molecules, so a part like sfGFP is not found
// there; the row and the empty result have to say what was searched.
describe('searchScopeLabel / searchScopeHint', () => {
  const t = (key: string, ...args: string[]): string =>
    args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), key);
  const label = (type: string | null): string => searchScopeLabel(searchEntitiesForSampleType(type), t);
  const hint = (type: string | null): string => searchScopeHint(searchEntitiesForSampleType(type), t);

  it('names what each typed type searches', () => {
    expect(label('DNA')).toBe('parts, devices and molecules');
    expect(label('Plasmid')).toBe('plasmids');
    expect(label('Primer')).toBe('primers');
    expect(label('Protein')).toBe('molecules');
    expect(label('Reagent')).toBe('molecules');
    expect(label('RNA')).toBe('molecules');
    expect(label(null)).toBe('parts, devices, plasmids, primers, molecules and strains');
    expect(searchScopeLabel(searchEntitiesForSampleType('Strain', { strainType: 'Strain' }), t)).toBe('strains');
  });

  it('points to where the left-out kinds are searched', () => {
    expect(hint('Protein')).toBe('Search parts with @dna; or @sample;.');
    expect(hint('Reagent')).toBe('Search parts with @dna; or @sample;.');
    expect(hint('DNA')).toBe('Search plasmids with @plasmid; or @sample;.');
    expect(hint(null)).toBe('');
    expect(hint('Labware')).toBe('');
  });
});

describe('sampleTypeForItem', () => {
  it('prefers built-in types', () => {
    expect(sampleTypeForItem({ type: 'part' })).toBe('DNA');
    expect(sampleTypeForItem({ type: 'device' })).toBe('DNA');
    expect(sampleTypeForItem({ type: 'plasmid' })).toBe('Plasmid');
    expect(sampleTypeForItem({ type: 'primer' })).toBe('Primer');
  });

  it('reads a molecule by its molecule_type', () => {
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'protein' })).toBe('Protein');
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'enzyme' })).toBe('Protein');
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'rna' })).toBe('RNA');
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'dna' })).toBe('DNA');
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'small molecule' })).toBe('Reagent');
    expect(sampleTypeForItem({ type: 'molecule', moleculeType: 'buffer' })).toBe('Reagent');
    expect(sampleTypeForItem({ type: 'molecule' })).toBe('Reagent');
  });

  // labnoteo has no built-in strain type, so the caller must add one first.
  it('has no type for a strain until the vault defines one', () => {
    expect(sampleTypeForItem({ type: 'strain' })).toBeUndefined();
    expect(sampleTypeForItem({ type: 'strain' }, { strainType: 'Strain' })).toBe('Strain');
  });
});

describe('aliasForItem', () => {
  // `_` next to text turns the reference italic in Markdown (#225), and
  // plasmid names are full of it.
  it('rewrites characters a sample alias cannot hold', () => {
    const alias = aliasForItem({ type: 'plasmid', id: 'x', kid: 'KBvt_aa0001', name: 'pTrc99A_GFP' });
    expect(alias).toBe('pTrc99A-GFP');
    expect(sampleAliasProblem(alias!)).toBeUndefined();
  });

  it('falls back to the KID when the name is empty or all punctuation', () => {
    expect(aliasForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: '  ' })).toBe('KBp-aa0001');
    expect(aliasForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: '***' })).toBe('KBp-aa0001');
    expect(aliasForItem({ type: 'part', id: 'x', kid: null, name: '' })).toBeNull();
  });

  // Two partbank items can share a name; autocomplete would show one label twice.
  it('appends the KID when asked to disambiguate', () => {
    expect(
      aliasForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: 'GFP' }, { disambiguate: true })
    ).toBe('GFP (KBp-aa0001)');
  });
});

describe('descriptionForItem', () => {
  it('leads with the KID so the partbank id is visible in the note', () => {
    expect(
      descriptionForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: 'GFP', description: 'green' })
    ).toBe('KBp_aa0001 · green');
  });

  // The alias was rewritten, so the real name only survives here.
  it('keeps the original name when the alias differs', () => {
    expect(descriptionForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: 'pA_B' })).toBe(
      'KBp_aa0001 · pA_B'
    );
  });

  it('leaves the name out when the alias already is it', () => {
    expect(descriptionForItem({ type: 'part', id: 'x', kid: 'KBp_aa0001', name: 'GFP' })).toBe(
      'KBp_aa0001'
    );
  });

  // `;` would end the description where it is read back (#98).
  it('replaces separators, flattens line breaks and cuts long text', () => {
    expect(
      descriptionForItem({ type: 'part', id: 'x', kid: null, name: '', description: 'a;b\n c' })
    ).toBe('a,b c');
    const long = descriptionForItem({ type: 'part', id: 'x', kid: null, name: '', description: 'x'.repeat(400) });
    expect(long).toHaveLength(200);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('is null when the item carries nothing to say', () => {
    expect(descriptionForItem({ type: 'part', id: 'x', kid: null, name: '' })).toBeNull();
  });
});

describe('sourceForItem', () => {
  it('records the connection, trimmed origin, type, id and KID', () => {
    expect(
      sourceForItem({ type: 'plasmid', id: 'abc', kid: ' KBvt_aa0001 ' }, 'web', 'https://p.kr/')
    ).toEqual({
      system: 'partbank',
      connection: 'web',
      origin: 'https://p.kr',
      type: 'plasmid',
      id: 'abc',
      kid: 'KBvt_aa0001',
    });
  });

  it('reads a missing KID as null', () => {
    expect(sourceForItem({ type: 'part', id: 'abc' }, 'desktop', 'http://127.0.0.1:47830').kid).toBeNull();
  });
});

describe('formatStockLocation', () => {
  it('writes storage / box / hole in the shape the registry already uses', () => {
    expect(
      formatStockLocation([
        { storage: { name: 'Freezer-2' }, stock_box: { name: 'Box-3' }, hole_position: 'A1', is_owner: true },
      ])
    ).toBe('Freezer-2 / Box-3 / A1');
  });

  it('leaves out the parts a stock does not have', () => {
    expect(formatStockLocation([{ storage: { name: 'Freezer-2' }, is_owner: true }])).toBe('Freezer-2');
    expect(formatStockLocation([{ stock_box: { name: 'Box-3' }, hole_position: 'B2' }])).toBe('Box-3 / B2');
  });

  // A shared box can hold several stocks; the caller's own are the useful ones.
  it('puts the caller\u2019s own stocks first and joins the rest', () => {
    expect(
      formatStockLocation([
        { storage: { name: 'S' }, stock_box: { name: 'Shared' }, hole_position: 'C3', is_owner: false },
        { storage: { name: 'S' }, stock_box: { name: 'Mine' }, hole_position: 'A1', is_owner: true },
      ])
    ).toBe('S / Mine / A1; S / Shared / C3');
  });

  it('drops duplicates and is empty with no visible stock', () => {
    const same = { storage: { name: 'S' }, stock_box: { name: 'B' }, hole_position: 'A1' };
    expect(formatStockLocation([same, { ...same }])).toBe('S / B / A1');
    expect(formatStockLocation([])).toBe('');
    expect(formatStockLocation([{ hole_position: '  ' }])).toBe('');
  });
});

describe('findLinkedSample', () => {
  const sample = (scope: LinkedSample['scope'], id: string, src?: SampleSource): LinkedSample => ({
    type: 'DNA',
    id,
    scope,
    record: { type: 'DNA', alias: null, descriptions: [], sources: [], ...(src ? { source: src } : {}) } as SampleRecord,
  });

  // Registering a second id for one partbank item would split its references.
  it('prefers local, then global, then a catalog', () => {
    const candidates = [
      sample('catalog', 'DNA-3', source('abc')),
      sample('global', 'DNA-2', source('abc')),
      sample('local', 'DNA-1', source('abc')),
    ];
    expect(findLinkedSample(source('abc'), candidates)?.id).toBe('DNA-1');
    expect(findLinkedSample(source('abc'), candidates.slice(0, 2))?.id).toBe('DNA-2');
    expect(findLinkedSample(source('abc'), candidates.slice(0, 1))?.id).toBe('DNA-3');
  });

  it('is undefined for an item nothing stands for yet', () => {
    expect(findLinkedSample(source('abc'), [sample('local', 'DNA-1', source('other'))])).toBeUndefined();
    expect(findLinkedSample(source('abc'), [sample('local', 'DNA-1')])).toBeUndefined();
  });

  // The desktop port drifts, so a link made on 47830 still matches on 47831.
  it('matches a desktop link across ports', () => {
    const stored = source('abc', { connection: 'desktop', origin: 'http://127.0.0.1:47830' });
    const asked = source('abc', { connection: 'desktop', origin: 'http://127.0.0.1:47831' });
    expect(findLinkedSample(asked, [sample('local', 'DNA-1', stored)])?.id).toBe('DNA-1');
  });
});
