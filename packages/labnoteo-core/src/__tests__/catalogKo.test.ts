import { describe, it, expect } from 'vitest';
import { CATALOG_KO, catalogDescriptionFor } from '../catalog/catalogKo';
import { CATALOG_KO_DESCRIPTIONS } from '../catalog/catalogKoDescriptions';
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

  it("shows a lab's edited description as written", () => {
    expect(catalogDescriptionFor('WD010', 'Our own DoE notes.', 'ko')).toBe('Our own DoE notes.');
  });

  it("shows a lab's own item as written", () => {
    expect(catalogDescriptionFor('WX900', 'Lab item.', 'ko')).toBe('Lab item.');
  });
});
