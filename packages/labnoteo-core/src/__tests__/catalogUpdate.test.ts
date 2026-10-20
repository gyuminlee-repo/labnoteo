import { describe, it, expect } from 'vitest';
import {
  CATALOG_FILE_SPECS,
  applyCatalogUpdate,
  isCatalogPlanEmpty,
  parseCatalogFile,
  planCatalogUpdate,
  type BundledCatalogItem,
  type CatalogFileSpec,
  type CatalogHistory,
} from '../catalog/catalogUpdate';
import { ADDED_BUNDLED_IDS, EARLIER_BUNDLED } from '../catalog/earlierBundled';

const spec: CatalogFileSpec = {
  file: 'test.json',
  listKey: 'workflows',
  fields: ['name', 'description', 'category'],
  version: '2.0',
  lastUpdated: '2026-01-01',
  items: [
    { id: 'A1', name: 'Alpha', description: 'Alpha new.', category: 'Build' },
    { id: 'A2', name: 'Beta', description: 'Beta.', category: 'Build' },
    { id: 'A3', name: 'Gamma', description: 'Gamma.', category: 'Build' },
    { id: 'A4', name: 'Delta', description: 'Delta.', category: 'Test' },
  ],
};
const history: CatalogHistory = {
  earlier: { A1: { name: ['Alfa'], description: ['Alpha old.'] } },
  added: ['A2', 'A4'],
};
const vaultJson = (items: unknown[]): Record<string, unknown> => ({
  version: '1.0',
  language: 'English',
  lastUpdated: '2025-01-01',
  workflows: items,
});
const plan = (items: unknown[]) => planCatalogUpdate(items, spec.items, spec.fields, history);

describe('parseCatalogFile', () => {
  it('reads the item list', () => {
    const parsed = parseCatalogFile(JSON.stringify(vaultJson([{ id: 'A1' }])), 'workflows');
    expect(parsed.ok && parsed.items).toEqual([{ id: 'A1' }]);
  });

  it('rejects broken JSON and a missing or non-array list', () => {
    expect(parseCatalogFile('{ "workflows": [', 'workflows').ok).toBe(false);
    expect(parseCatalogFile('[]', 'workflows').ok).toBe(false);
    expect(parseCatalogFile('{"unitOperations": []}', 'workflows').ok).toBe(false);
    expect(parseCatalogFile('{"workflows": {}}', 'workflows').ok).toBe(false);
  });
});

describe('planCatalogUpdate', () => {
  it('adds only ids added since the first release', () => {
    // A3 is not in `added`: the lab deleted it, so it stays deleted.
    const p = plan([{ id: 'A1', name: 'Alpha', description: 'Alpha new.', category: 'Build' }]);
    expect(p.added.map(i => i.id)).toEqual(['A2', 'A4']);
  });

  it('replaces a field still holding an earlier bundled value', () => {
    const p = plan([{ id: 'A1', name: 'Alfa', description: ' Alpha old. ', category: 'Build' }]);
    expect(p.updated).toEqual([
      { id: 'A1', field: 'name', from: 'Alfa', to: 'Alpha' },
      { id: 'A1', field: 'description', from: ' Alpha old. ', to: 'Alpha new.' },
    ]);
    expect(p.keptEdited).toEqual([]);
  });

  it('keeps a field the lab edited, or removed, and reports it', () => {
    const p = plan([{ id: 'A1', name: 'Our Alpha', category: 'Build' }]);
    expect(p.updated).toEqual([]);
    expect(p.keptEdited).toEqual([
      { id: 'A1', field: 'name' },
      { id: 'A1', field: 'description' },
    ]);
  });

  it('says nothing about an edit to a field the bundled catalog never changed', () => {
    const p = planCatalogUpdate(
      [{ id: 'A2', name: 'Our Beta', description: 'Beta.', category: 'Build' }],
      spec.items.slice(0, 2),
      spec.fields,
      { earlier: {}, added: [] }
    );
    expect(p).toEqual({ added: [], updated: [], keptEdited: [] });
  });

  it('compares only the first of duplicate ids and ignores items without a string id', () => {
    const p = plan([{ id: 'A1', name: 'Alpha', description: 'Alpha new.', category: 'Build' }, { id: 'A1', name: 'Alfa' }, 'x', { id: 7 }]);
    expect(p.updated).toEqual([]);
  });
});

describe('applyCatalogUpdate', () => {
  it('inserts an added item after the nearest bundled item before it that the copy has', () => {
    // A4 follows A3, which the lab deleted, so it goes after A2 (added just before).
    const items = [{ id: 'A1', name: 'Alpha', description: 'Alpha new.', category: 'Build' }, { id: 'LAB1', name: 'Ours' }];
    const out = applyCatalogUpdate(vaultJson(items), spec, plan(items));
    expect((out.workflows as { id: string }[]).map(i => i.id)).toEqual(['A1', 'A2', 'A4', 'LAB1']);
  });

  it('puts an added item at the end when the copy has no bundled item before it', () => {
    const items = [{ id: 'LAB1', name: 'Ours' }];
    const p = planCatalogUpdate(items, spec.items, spec.fields, { earlier: {}, added: ['A1'] });
    const out = applyCatalogUpdate(vaultJson(items), spec, p);
    expect((out.workflows as { id: string }[]).map(i => i.id)).toEqual(['LAB1', 'A1']);
  });

  it('changes only the planned fields, keeps other keys, and leaves the input as it was', () => {
    const items = [{ id: 'A1', name: 'Alfa', description: 'Our text', category: 'Build', note: 'lab' }, { id: 'A1', name: 'Alfa' }];
    const json = { ...vaultJson(items), labField: 1 };
    const before = JSON.stringify(json);
    const out = applyCatalogUpdate(json, spec, plan(items));
    expect(JSON.stringify(json)).toBe(before);
    const list = out.workflows as Record<string, unknown>[];
    expect(list[0]).toEqual({ id: 'A1', name: 'Alpha', description: 'Our text', category: 'Build', note: 'lab' });
    expect(list.map(i => i.id)).toEqual(['A1', 'A2', 'A4', 'A1']);
    expect(list[3]).toEqual({ id: 'A1', name: 'Alfa' });
    expect(out.labField).toBe(1);
    expect(out.version).toBe('2.0');
    expect(out.lastUpdated).toBe('2026-01-01');
    expect(out.language).toBe('English');
  });

  it('returns the file as it was when nothing changes', () => {
    const items = spec.items.map(i => ({ ...i }));
    const json = vaultJson(items);
    const p = plan(items);
    expect(isCatalogPlanEmpty(p)).toBe(true);
    expect(applyCatalogUpdate(json, spec, p)).toBe(json);
  });
});

/** A vault copy seeded by 0.106.0 or earlier: earlier values back in, added ids out. */
function seededBeforeUpdate(items: readonly BundledCatalogItem[]): BundledCatalogItem[] {
  return items
    .filter(item => !ADDED_BUNDLED_IDS.includes(item.id))
    .map(item => {
      const old: BundledCatalogItem = { ...item };
      for (const [field, values] of Object.entries(EARLIER_BUNDLED[item.id] ?? {})) {
        (old as Record<string, string>)[field] = values![0];
      }
      return old;
    });
}

describe('bundled catalogs', () => {
  it.each(CATALOG_FILE_SPECS.map(s => [s.file, s] as const))(
    'brings a %s copy seeded by an earlier release up to date',
    (_file, s) => {
      const old = seededBeforeUpdate(s.items);
      const json = { version: 'old', language: 'English', lastUpdated: 'old', [s.listKey]: old };
      const p = planCatalogUpdate(old, s.items, s.fields);
      expect(p.keptEdited).toEqual([]);
      const out = applyCatalogUpdate(json, s, p);
      expect(out[s.listKey]).toEqual(s.items);
      expect(isCatalogPlanEmpty(planCatalogUpdate(out[s.listKey] as unknown[], s.items, s.fields))).toBe(true);
    }
  );

  it('renames WB125 and adds WB155 and WB160 after WB150 in the workflows', () => {
    const s = CATALOG_FILE_SPECS[0];
    const old = seededBeforeUpdate(s.items);
    const p = planCatalogUpdate(old, s.items, s.fields);
    expect(p.added.map(i => i.id)).toEqual(['WB155', 'WB160']);
    expect(p.updated).toContainEqual({ id: 'WB125', field: 'name', from: 'Colony Picking', to: 'Colony Selection' });
    expect(p.updated.filter(u => u.field === 'description').map(u => u.id)).toContain('WT015');
    const ids = (applyCatalogUpdate({ workflows: old }, s, p).workflows as { id: string }[]).map(i => i.id);
    expect(ids.slice(ids.indexOf('WB150'), ids.indexOf('WB150') + 3)).toEqual(['WB150', 'WB155', 'WB160']);
  });

  it('keeps the history consistent with the bundled catalogs', () => {
    const bundled = new Map(CATALOG_FILE_SPECS.flatMap(s => s.items.map(i => [i.id, i] as const)));
    for (const id of ADDED_BUNDLED_IDS) expect(bundled.has(id)).toBe(true);
    for (const [id, fields] of Object.entries(EARLIER_BUNDLED)) {
      const item = bundled.get(id);
      expect(item, id).toBeDefined();
      for (const [field, values] of Object.entries(fields)) {
        for (const value of values!) expect(value, `${id}.${field}`).not.toBe(item![field as keyof BundledCatalogItem]);
      }
    }
  });
});
