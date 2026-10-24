/**
 * Turning partbank items into labnoteo sample records, and back.
 *
 * Pure on purpose (see `sampleLocationProvider`): the HTTP transport lives in
 * the host layer, so everything here takes an already-parsed response.
 */
import { toSampleAlias } from '../lib/sampleUtils';
import type { SampleRecord } from '../lib/sampleStorage';
import {
  PARTBANK_TYPES,
  isSameSampleSource,
  type PartbankConnection,
  type PartbankType,
  type SampleSource,
} from './types';

/** The sample type partbank's strains map to; added on demand (it is not built in). */
export const STRAIN_SAMPLE_TYPE = 'Strain';

/**
 * The type names partbank's global search takes. `device` excludes plasmids
 * and `vector` *is* the plasmid (an as-built circular Device), so the two are
 * separate search entities even though both are devices in the database.
 */
export type PartbankSearchEntity = 'part' | 'device' | 'vector' | 'strain' | 'molecule' | 'primer';

/**
 * The plural segment each type is filed under. The same word serves the detail
 * endpoint (`/api/v1/parts/{id}`) and the list endpoint (`/workspace/parts`).
 */
const RESOURCE_SEGMENT: Record<PartbankType, string> = {
  part: 'parts',
  device: 'devices',
  plasmid: 'plasmids',
  primer: 'primers',
  molecule: 'molecules',
  strain: 'strains',
};

/**
 * Where the partbank web app shows each type. Plasmids live under `/devices`
 * on screen even though the API calls them `/plasmids`.
 */
const WEB_SEGMENT: Record<PartbankType, string> = { ...RESOURCE_SEGMENT, plasmid: 'devices' };

/** The API segment for a type: `parts` in `/api/v1/parts/{id}`. */
export function resourceSegment(type: PartbankType): string {
  return RESOURCE_SEGMENT[type];
}

/** The web app path that shows an item, without a leading origin. */
export function webAppPath(source: Pick<SampleSource, 'type' | 'id'>): string {
  return `/${WEB_SEGMENT[source.type]}/${source.id}`;
}

/**
 * The `partbank://` link that shows an item in the desktop app. The app maps
 * the type to a screen itself and refuses anything else, so no path travels.
 */
export function desktopAppLink(source: Pick<SampleSource, 'type' | 'id'>): string {
  return `partbank://open?type=${source.type}&id=${encodeURIComponent(source.id)}`;
}

/** A search entity read back as the type a link stores. */
export function typeFromSearchEntity(entity: string): PartbankType | undefined {
  if (entity === 'vector') return 'plasmid';
  return (PARTBANK_TYPES as readonly string[]).includes(entity)
    ? (entity as PartbankType)
    : undefined;
}

/** The search entity to ask for when looking up a type. */
export function searchEntityForType(type: PartbankType): PartbankSearchEntity {
  return type === 'plasmid' ? 'vector' : (type as PartbankSearchEntity);
}

/**
 * Which partbank entities to search for a labnoteo sample type. Empty when the
 * type has no partbank counterpart, which is what hides the search action.
 *
 * `strainType` is the vault's strain type name when it has one; partbank's
 * strains are offered only under that type, since labnoteo has no built-in one.
 */
export function searchEntitiesForSampleType(
  sampleType: string | null,
  opts: { strainType?: string | null } = {}
): PartbankSearchEntity[] {
  // `@sample` searches every type, so it searches every partbank entity too.
  if (sampleType === null) {
    return ['part', 'device', 'vector', 'primer', 'molecule', 'strain'];
  }
  const strainType = opts.strainType;
  if (strainType && sampleType.toLowerCase() === strainType.toLowerCase()) return ['strain'];
  switch (sampleType) {
    case 'DNA':
      return ['part', 'device', 'molecule'];
    case 'Plasmid':
      return ['vector'];
    case 'Primer':
      return ['primer'];
    case 'RNA':
    case 'Protein':
    case 'Reagent':
      return ['molecule'];
    default:
      return [];
  }
}

type Translate = (key: string, ...args: string[]) => string;

/** One search entity in the plural, as a scope label lists it. */
function entityPlural(entity: PartbankSearchEntity, t: Translate): string {
  switch (entity) {
    case 'part':
      return t('parts');
    case 'device':
      return t('devices');
    case 'vector':
      return t('plasmids');
    case 'primer':
      return t('primers');
    case 'molecule':
      return t('molecules');
    case 'strain':
      return t('strains');
  }
}

/**
 * What a search over `entities` looks through, in words: "parts, devices and
 * molecules" for `@dna;`, "molecules" for `@protein;`. Shown on the "Search
 * partbank" row and in the empty result, so a typed type that does not reach
 * an item says why rather than suggesting the item does not exist (#276).
 */
export function searchScopeLabel(entities: readonly PartbankSearchEntity[], t: Translate): string {
  const names = entities.map(e => entityPlural(e, t));
  if (names.length <= 1) return names[0] ?? '';
  return t('{0} and {1}', names.slice(0, -1).join(t(', ')), names[names.length - 1]);
}

/**
 * Where to look for what `entities` leaves out, or `''` when nothing worth
 * naming is left out. Parts are what users miss most (#276), then plasmids,
 * which `@dna;` does not search.
 */
export function searchScopeHint(entities: readonly PartbankSearchEntity[], t: Translate): string {
  if (entities.length === 0) return '';
  if (!entities.includes('part')) return t('Search parts with @dna; or @sample;.');
  if (!entities.includes('vector')) return t('Search plasmids with @plasmid; or @sample;.');
  return '';
}

/**
 * The labnoteo type for a partbank item when the user did not name one (an
 * `@sample` pick, a URI import, a catalog download). Built-in types are
 * preferred; only strains need a custom type, and `strainType` is undefined
 * until the vault has one — the caller then offers to add it.
 */
export function sampleTypeForItem(
  item: { type: PartbankType; moleculeType?: string | null },
  opts: { strainType?: string | null } = {}
): string | undefined {
  switch (item.type) {
    case 'part':
    case 'device':
      return 'DNA';
    case 'plasmid':
      return 'Plasmid';
    case 'primer':
      return 'Primer';
    case 'strain':
      return opts.strainType ?? undefined;
    case 'molecule':
      switch ((item.moleculeType ?? '').toLowerCase()) {
        case 'protein':
        case 'enzyme':
          return 'Protein';
        case 'rna':
          return 'RNA';
        case 'dna':
          return 'DNA';
        default:
          return 'Reagent';
      }
  }
}

/** A partbank item as the conversion needs it, whatever endpoint it came from. */
export interface PartbankItem {
  type: PartbankType;
  id: string;
  kid?: string | null;
  name?: string | null;
  description?: string | null;
  moleculeType?: string | null;
}

/** Characters a description may run to before it is cut (#300). */
const DESCRIPTION_BUDGET = 1000;

/**
 * `text` within `budget` characters, ending in `…` when cut: at the last space
 * in the second half of the budget, else mid-word. Counts code points, so an
 * emoji or other surrogate pair is never split.
 */
function cutText(text: string, budget: number): string {
  const chars = Array.from(text);
  if (chars.length <= budget) return text;
  const head = chars.slice(0, budget - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space > 0 && Array.from(head.slice(0, space)).length >= budget / 2 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * The alias to register a partbank item under. partbank names routinely hold
 * `_` (`pTrc99A_GFP`), which Markdown reads as emphasis, so they cannot be used
 * verbatim ({@link toSampleAlias}). `disambiguate` appends the KID, for a
 * catalog where two items share a name.
 */
export function aliasForItem(
  item: PartbankItem,
  opts: { disambiguate?: boolean } = {}
): string | null {
  const base = toSampleAlias(item.name?.trim() ?? '') ?? null;
  if (!base) return item.kid ? toSampleAlias(item.kid) ?? null : null;
  if (!opts.disambiguate || !item.kid) return base;
  return `${base} (${toSampleAlias(item.kid) ?? item.kid})`;
}

/**
 * The description to register, which leads with the KID so the partbank id is
 * visible in the note and in sample search. The original name is kept when the
 * alias had to be rewritten, otherwise it would be lost.
 */
export function descriptionForItem(item: PartbankItem): string | null {
  const name = item.name?.trim() ?? '';
  const alias = aliasForItem(item);
  const parts: string[] = [];
  if (item.kid?.trim()) parts.push(item.kid.trim());
  if (name && name !== alias) parts.push(name);
  const text = item.description?.trim();
  if (text) parts.push(text);
  if (parts.length === 0) return null;
  // `;` ends a description in a note (#98) and a line break would split it.
  const joined = parts.join(' · ').replace(/;/g, ',').replace(/\s+/g, ' ').trim();
  return cutText(joined, DESCRIPTION_BUDGET);
}

/** The link to store for an item fetched over `connection` at `origin`. */
export function sourceForItem(
  item: PartbankItem,
  connection: PartbankConnection,
  origin: string
): SampleSource {
  return {
    system: 'partbank',
    connection,
    origin: origin.trim().replace(/\/+$/, ''),
    type: item.type,
    id: item.id,
    kid: item.kid?.trim() ? item.kid.trim() : null,
  };
}

/** One stock entry of `GET /stock-box/by-resource/{type}/{id}`. */
export interface PartbankStock {
  stock_box?: { name?: string | null } | null;
  storage?: { name?: string | null } | null;
  hole_position?: string | null;
  is_owner?: boolean;
}

/**
 * The `location` text for an item's stocks, in the shape the registry already
 * uses ("Freezer-2 / Box-3 / A1"). partbank only returns stocks the caller can
 * see, and a shared box can hold several, so the caller's own come first.
 * Returns `''` when the item has no visible stock.
 */
export function formatStockLocation(stocks: readonly PartbankStock[]): string {
  const mine = stocks.filter(s => s.is_owner);
  const others = stocks.filter(s => !s.is_owner);
  const lines: string[] = [];
  for (const stock of [...mine, ...others]) {
    const parts = [stock.storage?.name, stock.stock_box?.name, stock.hole_position]
      .map(p => p?.trim())
      .filter((p): p is string => Boolean(p));
    const text = parts.join(' / ');
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines.join('; ');
}

/** A sample already in the vault, with where it is kept. */
export interface LinkedSample {
  type: string;
  id: string;
  record: SampleRecord;
  /** Where it was found: the note's own registry, the global one, or a catalog. */
  scope: 'local' | 'global' | 'catalog';
  /** The sample folder it was read from (a catalog's is the folder holding the catalog file). */
  folder?: string;
}

/**
 * The sample already standing for `source`, if any. Searched local first, then
 * global, then the catalogs: registering a second id for one partbank item
 * would split its references in two.
 */
export function findLinkedSample(
  source: SampleSource,
  candidates: readonly LinkedSample[]
): LinkedSample | undefined {
  const order: LinkedSample['scope'][] = ['local', 'global', 'catalog'];
  for (const scope of order) {
    const hit = candidates.find(
      c => c.scope === scope && c.record.source && isSameSampleSource(c.record.source, source)
    );
    if (hit) return hit;
  }
  return undefined;
}
