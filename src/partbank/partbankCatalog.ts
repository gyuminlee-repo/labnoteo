/**
 * Downloading a partbank workspace into read-only `{Type}_partbank-*.json`
 * catalogs beside the sample registry.
 *
 * A catalog is not the registry: nothing is written to it from a note, and
 * references to its ids seed local records on sync. That makes it safe to
 * rewrite the whole file on each download — as long as an item keeps the id it
 * had, which is what {@link planCatalogFile} is for. An id that changed would
 * orphan every reference already written in a note.
 *
 * (Unrelated to the `Update catalogs` command, which updates the bundled
 * *workflow* catalogs.)
 */
import { Notice } from 'obsidian';
import {
  aliasForItem,
  descriptionForItem,
  sampleTypeForItem,
  sourceForItem,
  PARTBANK_TYPES,
  type PartbankItem,
  type PartbankType,
  type SampleSource,
} from '@labnoteo/core';
import { generateSampleId } from '@labnoteo/core/lib/sampleUtils';
import { loadSamplesByType, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from '../main';
import { loadCatalogSamples } from '../sampleActions';
import { resolveSampleType, strainTypeOf } from './partbankRegister';
import type { PartbankClient } from './client';

/** `{Type}_partbank-web.json`: one file per sample type and connection. */
export function catalogFileName(type: string, connection: 'desktop' | 'web'): string {
  return `${type}_partbank-${connection}.json`;
}

/** An item with the labnoteo type it was sorted into. */
export interface TypedPartbankItem {
  item: PartbankItem;
  sampleType: string;
}

/**
 * The contents of one `{Type}_partbank-*.json`.
 *
 * Sorted by KID so a re-download produces a small git diff, and keyed by the
 * id the item already had wherever one is known — a reference written in a
 * note months ago must keep resolving.
 */
export function planCatalogFile(
  sampleType: string,
  items: readonly PartbankItem[],
  connection: 'desktop' | 'web',
  origin: string,
  knownIds: ReadonlyMap<string, string>,
  newId: (type: string) => string = generateSampleId
): Record<string, SampleRecord> {
  const sorted = [...items].sort((a, b) =>
    (a.kid ?? a.id).localeCompare(b.kid ?? b.id, 'en')
  );
  // Two items may share a name; an unqualified alias would show the same label
  // twice in autocomplete, with no way to tell which is which.
  const nameCounts = new Map<string, number>();
  for (const item of sorted) {
    const alias = aliasForItem(item);
    if (alias) nameCounts.set(alias, (nameCounts.get(alias) ?? 0) + 1);
  }

  const out: Record<string, SampleRecord> = {};
  for (const item of sorted) {
    const source = sourceForItem(item, connection, origin);
    const id = knownIds.get(sourceKey(source)) ?? newId(sampleType);
    const plain = aliasForItem(item);
    out[id] = {
      type: sampleType,
      alias: aliasForItem(item, { disambiguate: Boolean(plain && nameCounts.get(plain)! > 1) }),
      descriptions: [descriptionForItem(item)].filter((d): d is string => Boolean(d)),
      sources: [],
      location: null,
      source,
    };
  }
  return out;
}

/** A link reduced to the fields that identify it, for a Map key. */
function sourceKey(source: SampleSource): string {
  const origin = source.connection === 'desktop' ? 'desktop' : source.origin.toLowerCase();
  return `${origin}\u0000${source.type}\u0000${source.id}`;
}

/**
 * The ids already standing for partbank items of `sampleType`: from the
 * catalog being replaced, and from the global registry, where an item
 * registered through the `@` search lives. Without the second one, an item
 * would get a different id in the catalog than the one a note already uses.
 */
export async function knownCatalogIds(
  plugin: LabnotePlugin,
  folder: string,
  sampleType: string,
  records: readonly Record<string, SampleRecord>[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const all = [await loadCatalogSamples(plugin, folder, sampleType), ...records];
  for (const set of all) {
    for (const [id, record] of Object.entries(set)) {
      if (record.source) out.set(sourceKey(record.source), id);
    }
  }
  return out;
}

/** What one download produced, per sample type. */
export type CatalogCounts = Map<string, number>;

/**
 * Download every item in the key owner's own workspace and write it out as
 * catalogs. Items other people share with their groups are not included.
 */
export async function downloadPartbankCatalog(plugin: LabnotePlugin): Promise<void> {
  const client = plugin.partbank.defaultClient();
  if (!client) {
    plugin.partbank.notifyNotConfigured();
    return;
  }
  const folder = plugin.settings.globalSampleFolder;
  if (!folder) {
    new Notice(
      plugin.t('Set the Global sample folder in the plugin settings before downloading a catalog.'),
      8000
    );
    return;
  }

  const progress = new Notice(plugin.t('Downloading the partbank catalog…'), 0);
  const byType = new Map<string, PartbankItem[]>();
  let skippedStrains = 0;
  try {
    for (const partbankType of PARTBANK_TYPES) {
      const items = await client.listAll(partbankType);
      for (const item of items) {
        const sampleType = await sampleTypeFor(plugin, item, partbankType);
        if (!sampleType) {
          if (partbankType === 'strain') skippedStrains++;
          continue;
        }
        const list = byType.get(sampleType) ?? [];
        list.push(item);
        byType.set(sampleType, list);
      }
    }
  } catch (err) {
    progress.hide();
    plugin.partbank.notifyError(err, client.kind);
    return;
  } finally {
    progress.hide();
  }

  const globalRecords = await loadGlobalRecords(plugin, folder, [...byType.keys()]);
  const counts: CatalogCounts = new Map();
  for (const [sampleType, items] of byType) {
    const knownIds = await knownCatalogIds(plugin, folder, sampleType, [
      globalRecords.get(sampleType) ?? {},
    ]);
    const records = planCatalogFile(sampleType, items, client.kind, client.origin, knownIds);
    const path = posix.join(folder, catalogFileName(sampleType, client.kind));
    await plugin.fs.write(path, `${JSON.stringify(records, null, 2)}\n`);
    counts.set(sampleType, Object.keys(records).length);
  }

  plugin.samplesChanged();
  new Notice(summarize(plugin, counts, skippedStrains), 10000);
}

/**
 * The sample type for a catalog item. Asking about a strain type here would
 * interrupt a long download, so the question is asked once, for the first
 * strain; afterwards the answer stands.
 */
async function sampleTypeFor(
  plugin: LabnotePlugin,
  item: PartbankItem,
  partbankType: PartbankType
): Promise<string | undefined> {
  if (partbankType !== 'strain') return sampleTypeForItem(item);
  const existing = strainTypeOf(plugin);
  if (existing) return existing;
  // `resolveSampleType` asks, and adds the type when the answer is yes.
  return resolveSampleType(plugin, item);
}

/** The global registry per type, read once for the id-stability lookup. */
async function loadGlobalRecords(
  plugin: LabnotePlugin,
  folder: string,
  types: readonly string[]
): Promise<Map<string, Record<string, SampleRecord>>> {
  const out = new Map<string, Record<string, SampleRecord>>();
  for (const type of types) out.set(type, await loadSamplesByType(plugin.fs, folder, type));
  return out;
}

function summarize(plugin: LabnotePlugin, counts: CatalogCounts, skippedStrains: number): string {
  if (counts.size === 0) return plugin.t('partbank returned nothing to put in a catalog.');
  const parts = [...counts]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([type, n]) => `${type} ${n}`)
    .join(', ');
  const main = plugin.t('Downloaded the partbank catalog: {0}.', parts);
  return skippedStrains > 0
    ? `${main} ${plugin.t('{0} strain(s) were left out.', String(skippedStrains))}`
    : main;
}
