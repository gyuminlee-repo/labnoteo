/**
 * The download rewrites each `{Type}_partbank-*.json` whole, so the one thing
 * that must hold is that an item keeps the id it already had: a reference
 * written in a note months ago has to keep resolving.
 */
import { describe, it, expect } from 'vitest';
import type { PartbankItem, SampleSource } from '@labnoteo/core';
import { catalogFileName, planCatalogFile } from '../../src/partbank/partbankCatalog';

const WEB = 'https://partbank.kbiofoundry.kr';

const item = (kid: string, name: string, id = kid.toLowerCase()): PartbankItem => ({
  type: 'part',
  id,
  kid,
  name,
  description: null,
  moleculeType: null,
});

/** The key `planCatalogFile` looks ids up by, built the same way it does. */
const key = (source: SampleSource): string =>
  `${source.connection === 'desktop' ? 'desktop' : source.origin.toLowerCase()}\u0000${source.type}\u0000${source.id}`;

const webKey = (id: string, type = 'part'): string => `${WEB.toLowerCase()}\u0000${type}\u0000${id}`;

/** Deterministic ids, so a test can tell a reused id from a fresh one. */
function idFactory(): (type: string) => string {
  let n = 0;
  return type => `${type}-new${++n}`;
}

describe('catalogFileName', () => {
  it('names one file per type and connection', () => {
    expect(catalogFileName('DNA', 'web')).toBe('DNA_partbank-web.json');
    expect(catalogFileName('Plasmid', 'desktop')).toBe('Plasmid_partbank-desktop.json');
  });
});

describe('planCatalogFile', () => {
  // Rewriting the whole file every time only produces a readable git diff if
  // the order is stable.
  it('writes the items in KID order', () => {
    const records = planCatalogFile(
      'DNA',
      [item('KBp_cc0003', 'C'), item('KBp_aa0001', 'A'), item('KBp_bb0002', 'B')],
      'web',
      WEB,
      new Map(),
      idFactory()
    );
    expect(Object.values(records).map(r => r.source?.kid)).toEqual([
      'KBp_aa0001',
      'KBp_bb0002',
      'KBp_cc0003',
    ]);
  });

  // The id is what a note wrote down; changing it orphans the reference.
  it('keeps the id an item already had and generates one only for the rest', () => {
    const known = new Map([[webKey('kbp_aa0001'), 'DNA-1760000000000']]);
    const records = planCatalogFile(
      'DNA',
      [item('KBp_aa0001', 'A'), item('KBp_bb0002', 'B')],
      'web',
      WEB,
      known,
      idFactory()
    );
    expect(Object.keys(records)).toEqual(['DNA-1760000000000', 'DNA-new1']);
  });

  it('stores the link, so the next download finds the item again', () => {
    const records = planCatalogFile('DNA', [item('KBp_aa0001', 'A')], 'web', `${WEB}/`, new Map(), idFactory());
    const source = Object.values(records)[0].source!;
    expect(source).toEqual({
      system: 'partbank',
      connection: 'web',
      origin: WEB,
      type: 'part',
      id: 'kbp_aa0001',
      kid: 'KBp_aa0001',
    });
    expect(key(source)).toBe(webKey('kbp_aa0001'));
  });

  // partbank names routinely hold `_`, which Markdown reads as emphasis.
  it('rewrites the name into a usable alias and leads the description with the KID', () => {
    const records = planCatalogFile(
      'Plasmid',
      [{ type: 'plasmid', id: 'x', kid: 'KBvt_aa0001', name: 'pTrc99A_GFP', description: 'green' }],
      'web',
      WEB,
      new Map(),
      idFactory()
    );
    const record = Object.values(records)[0];
    expect(record.alias).toBe('pTrc99A-GFP');
    expect(record.descriptions).toEqual(['KBvt_aa0001 · pTrc99A_GFP · green']);
    expect(record.type).toBe('Plasmid');
    // A catalog entry is not kept anywhere and is not used by a note yet.
    expect(record.location).toBeNull();
    expect(record.sources).toEqual([]);
  });

  // Two items with one name would show the same autocomplete label twice.
  it('appends the KID to an alias two items share, and leaves unique ones alone', () => {
    const records = planCatalogFile(
      'DNA',
      [item('KBp_aa0001', 'GFP'), item('KBp_bb0002', 'GFP'), item('KBp_cc0003', 'RFP')],
      'web',
      WEB,
      new Map(),
      idFactory()
    );
    expect(Object.values(records).map(r => r.alias)).toEqual([
      'GFP (KBp-aa0001)',
      'GFP (KBp-bb0002)',
      'RFP',
    ]);
  });

  it('is empty for a type with no items', () => {
    expect(planCatalogFile('DNA', [], 'web', WEB, new Map(), idFactory())).toEqual({});
  });

  // The desktop port moves; matching on it would hand out a new id each time.
  it('matches a desktop item whatever port it was downloaded through', () => {
    const known = new Map([['desktop\u0000part\u0000kbp_aa0001', 'DNA-1']]);
    const records = planCatalogFile(
      'DNA',
      [item('KBp_aa0001', 'A')],
      'desktop',
      'http://127.0.0.1:47999',
      known,
      idFactory()
    );
    expect(Object.keys(records)).toEqual(['DNA-1']);
  });
});
