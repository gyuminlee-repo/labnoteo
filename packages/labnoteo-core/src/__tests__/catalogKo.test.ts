import { describe, it, expect } from 'vitest';
import { CATALOG_KO, CATALOG_KO_RETIRED, catalogDescriptionFor, catalogKoEntry } from '../catalog/catalogKo';
import { CATALOG_KO_DESCRIPTIONS } from '../catalog/catalogKoDescriptions';
import { RETIRED_BUNDLED } from '../catalog/earlierBundled';
import { UNIT_OPERATIONS_HW_CATALOG, UNIT_OPERATIONS_SW_CATALOG, WORKFLOWS_CATALOG } from '../catalog';

// #163
describe('CATALOG_KO', () => {
  const ids = [
    ...WORKFLOWS_CATALOG.workflows,
    ...UNIT_OPERATIONS_HW_CATALOG.unitOperations,
    ...UNIT_OPERATIONS_SW_CATALOG.unitOperations,
  ].map(item => item.id);

  it('names every bundled catalog item, and nothing else', () => {
    expect(Object.keys(CATALOG_KO).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(CATALOG_KO[id].name.trim()).not.toBe('');
  });

  // #213
  it('describes every bundled catalog item in Korean, and nothing else', () => {
    expect(Object.keys(CATALOG_KO_DESCRIPTIONS).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(CATALOG_KO_DESCRIPTIONS[id].trim()).not.toBe('');
  });

  // #235
  it('keeps retired items apart from the bundled ones, with their earlier English text', () => {
    for (const id of Object.keys(CATALOG_KO_RETIRED)) {
      expect(ids).not.toContain(id);
      expect(RETIRED_BUNDLED[id]?.name?.length).toBeGreaterThan(0);
      expect(RETIRED_BUNDLED[id]?.description?.length).toBeGreaterThan(0);
    }
  });
});

// #235: vaults seeded before 0.109.0 still list WG010.
describe('retired catalog items', () => {
  const earlier = RETIRED_BUNDLED.WG010.description![0];

  it('names and describes WG010 in Korean, pointing to the general workflows', () => {
    expect(catalogKoEntry('WG010')?.name).toBe('빈 워크플로');
    expect(catalogKoEntry('WD010')).toBe(CATALOG_KO.WD010);
    const ko = catalogDescriptionFor('WG010', earlier, 'ko');
    expect(ko).toBe(CATALOG_KO_RETIRED.WG010.description);
    expect(ko).toContain('WB001');
  });

  it("keeps a lab's edited WG010 description as written", () => {
    expect(catalogDescriptionFor('WG010', 'Our blank template.', 'ko')).toBe('Our blank template.');
    expect(catalogDescriptionFor('WG010', earlier, 'en')).toBe(earlier);
  });
});

// #213
describe('catalogDescriptionFor', () => {
  const bundled = WORKFLOWS_CATALOG.workflows.find(w => w.id === 'WD010')!.description;

  it('translates a bundled description in the Korean UI', () => {
    expect(catalogDescriptionFor('WD010', bundled, 'ko')).toBe(CATALOG_KO_DESCRIPTIONS.WD010);
    expect(catalogDescriptionFor('WD010', `${bundled}\n`, 'ko-KR')).toBe(CATALOG_KO_DESCRIPTIONS.WD010);
  });

  it('keeps English in another UI language', () => {
    expect(catalogDescriptionFor('WD010', bundled, 'en')).toBe(bundled);
    expect(catalogDescriptionFor('WD010', bundled, undefined)).toBe(bundled);
  });

  it('translates the text an earlier release seeded for a since-updated item', () => {
    const earlier =
      'This workflow verifies the size and assesses the integrity of nucleic acid fragments (DNA or RNA) using electrophoretic separation techniques. Methods such as traditional agarose gel electrophoresis or capillary electrophoresis are employed to separate fragments based on size.';
    expect(catalogDescriptionFor('WT015', earlier, 'ko')).toBe(CATALOG_KO_DESCRIPTIONS.WT015);
    expect(catalogDescriptionFor('WT010', earlier, 'ko')).toBe(earlier);
  });

  it("shows a lab's edited description as written", () => {
    expect(catalogDescriptionFor('WD010', 'Our own DoE notes.', 'ko')).toBe('Our own DoE notes.');
  });

  it("shows a lab's own item as written", () => {
    expect(catalogDescriptionFor('WX900', 'Lab item.', 'ko')).toBe('Lab item.');
  });
});
