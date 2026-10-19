import { describe, it, expect } from 'vitest';
import { CATALOG_KO } from '../catalog/catalogKo';
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
