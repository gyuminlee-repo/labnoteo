/**
 * Bring a vault's editable catalog copy up to the bundled catalog without
 * undoing the lab's edits: a field is replaced only while it still holds a
 * value an earlier release bundled, and only ids added since the first
 * release are added (an older id missing from the copy was deleted on purpose).
 */
import { CATALOG_FILE_NAMES, UNIT_OPERATIONS_HW_CATALOG, UNIT_OPERATIONS_SW_CATALOG, WORKFLOWS_CATALOG } from './index';
import { ADDED_BUNDLED_IDS, EARLIER_BUNDLED, type CatalogField } from './earlierBundled';

export type { CatalogField } from './earlierBundled';

export type CatalogListKey = 'workflows' | 'unitOperations';

export type BundledCatalogItem = { id: string } & Partial<Record<CatalogField, string>>;

/** One bundled catalog and the vault file it seeds. */
export interface CatalogFileSpec {
  /** File name under `resources/workflows/`. */
  file: string;
  listKey: CatalogListKey;
  /** Fields compared with the vault copy. */
  fields: readonly CatalogField[];
  version: string;
  lastUpdated: string;
  items: readonly BundledCatalogItem[];
}

export const CATALOG_FILE_SPECS: readonly CatalogFileSpec[] = [
  {
    file: CATALOG_FILE_NAMES.workflows,
    listKey: 'workflows',
    fields: ['name', 'description', 'category'],
    version: WORKFLOWS_CATALOG.version,
    lastUpdated: WORKFLOWS_CATALOG.lastUpdated,
    items: WORKFLOWS_CATALOG.workflows,
  },
  {
    file: CATALOG_FILE_NAMES.unitOperationsHw,
    listKey: 'unitOperations',
    fields: ['name', 'description', 'equipment'],
    version: UNIT_OPERATIONS_HW_CATALOG.version,
    lastUpdated: UNIT_OPERATIONS_HW_CATALOG.lastUpdated,
    items: UNIT_OPERATIONS_HW_CATALOG.unitOperations,
  },
  {
    file: CATALOG_FILE_NAMES.unitOperationsSw,
    listKey: 'unitOperations',
    fields: ['name', 'description', 'software'],
    version: UNIT_OPERATIONS_SW_CATALOG.version,
    lastUpdated: UNIT_OPERATIONS_SW_CATALOG.lastUpdated,
    items: UNIT_OPERATIONS_SW_CATALOG.unitOperations,
  },
];

/** Earlier bundled values and the ids added since, as in `./earlierBundled`. */
export interface CatalogHistory {
  earlier: Readonly<Record<string, Partial<Record<CatalogField, readonly string[]>>>>;
  added: readonly string[];
}

export const BUNDLED_CATALOG_HISTORY: CatalogHistory = { earlier: EARLIER_BUNDLED, added: ADDED_BUNDLED_IDS };

export interface CatalogUpdatePlan {
  /** Bundled items to add, in bundled order. */
  added: BundledCatalogItem[];
  /** Fields still holding an earlier bundled value. */
  updated: { id: string; field: CatalogField; from: string; to: string }[];
  /** Fields whose bundled value changed but which the lab edited, so they stay. */
  keptEdited: { id: string; field: CatalogField }[];
}

export type ParsedCatalogFile = { ok: true; json: Record<string, unknown>; items: unknown[] } | { ok: false };

/**
 * Parse a vault catalog file. A file that is not JSON or has no item list is
 * not ok: reading it as empty would make every bundled item look missing.
 */
export function parseCatalogFile(text: string, listKey: CatalogListKey): ParsedCatalogFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false };
  const items = (json as Record<string, unknown>)[listKey];
  if (!Array.isArray(items)) return { ok: false };
  return { ok: true, json: json as Record<string, unknown>, items };
}

function itemId(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const id = (item as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** Index of the first item with `id`; later duplicates are the lab's and stay as they are. */
function firstIndexOf(items: readonly unknown[], id: string): number {
  return items.findIndex(item => itemId(item) === id);
}

export function planCatalogUpdate(
  vaultItems: readonly unknown[],
  bundledItems: readonly BundledCatalogItem[],
  fields: readonly CatalogField[],
  history: CatalogHistory = BUNDLED_CATALOG_HISTORY
): CatalogUpdatePlan {
  const plan: CatalogUpdatePlan = { added: [], updated: [], keptEdited: [] };
  for (const bundled of bundledItems) {
    const index = firstIndexOf(vaultItems, bundled.id);
    if (index === -1) {
      if (history.added.includes(bundled.id)) plan.added.push(bundled);
      continue;
    }
    const vault = vaultItems[index] as Record<string, unknown>;
    const earlier = Object.prototype.hasOwnProperty.call(history.earlier, bundled.id)
      ? history.earlier[bundled.id]
      : undefined;
    for (const field of fields) {
      const to = bundled[field];
      if (to === undefined) continue;
      const from = vault[field];
      const current = typeof from === 'string' ? from.trim() : undefined;
      if (current === to.trim()) continue;
      const before = earlier?.[field];
      if (!before?.length) continue;
      if (current !== undefined && before.some(value => value.trim() === current)) {
        plan.updated.push({ id: bundled.id, field, from: from as string, to });
      } else {
        plan.keptEdited.push({ id: bundled.id, field });
      }
    }
  }
  return plan;
}

/** Whether applying `plan` would change nothing (fields the lab edited are never changed). */
export function isCatalogPlanEmpty(plan: CatalogUpdatePlan): boolean {
  return plan.added.length === 0 && plan.updated.length === 0;
}

/**
 * `json` with `plan` applied, as a new object. Only the planned fields change;
 * other fields and keys are kept. An added item goes after the nearest bundled
 * item before it that the copy has, or at the end. The file's `version` and
 * `lastUpdated` follow the bundled catalog once anything changed.
 */
export function applyCatalogUpdate(
  json: Record<string, unknown>,
  spec: Pick<CatalogFileSpec, 'listKey' | 'version' | 'lastUpdated' | 'items'>,
  plan: CatalogUpdatePlan
): Record<string, unknown> {
  if (isCatalogPlanEmpty(plan)) return json;
  const source = json[spec.listKey];
  const items: unknown[] = Array.isArray(source) ? [...source] : [];

  for (const { id, field, to } of plan.updated) {
    const index = firstIndexOf(items, id);
    if (index === -1) continue;
    items[index] = { ...(items[index] as Record<string, unknown>), [field]: to };
  }

  for (const item of plan.added) {
    const order = spec.items.findIndex(b => b.id === item.id);
    let at = items.length;
    for (let i = order - 1; i >= 0; i--) {
      const index = firstIndexOf(items, spec.items[i].id);
      if (index !== -1) {
        at = index + 1;
        break;
      }
    }
    items.splice(at, 0, { ...item });
  }

  return { ...json, version: spec.version, lastUpdated: spec.lastUpdated, [spec.listKey]: items };
}
