/**
 * Registering a partbank item as a sample: deciding its type, finding the
 * sample that already stands for it, and writing the record.
 *
 * The rule that shapes this file: one partbank item gets one labnoteo id. A
 * second id would split a note's references between two records that nothing
 * ties together, so an item already in the registry (or in a downloaded
 * catalog) is reused rather than registered again.
 */
import { Notice } from 'obsidian';
import {
  aliasForItem,
  descriptionForItem,
  findLinkedSample,
  formatStockLocation,
  sampleTypeForItem,
  searchEntitiesForSampleType,
  searchScopeHint,
  searchScopeLabel,
  sourceForItem,
  STRAIN_SAMPLE_TYPE,
  type LinkedSample,
  type PartbankItem,
} from '@labnoteo/core';
import {
  canonicalSampleType,
  generateSampleId,
  getSampleDisplayMeta,
  buildSampleReferenceText,
} from '@labnoteo/core/lib/sampleUtils';
import {
  isSameSampleFolder,
  loadSamplesByType,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import type LabnotePlugin from '../main';
import { loadCatalogSamples } from '../sampleActions';
import { confirmModal } from '../modals';
import type { PartbankClient } from './client';
import { searchPartbankModal } from './partbankSearch';

/** What a registration produced, for the caller to insert or copy. */
export interface RegisteredPartbankSample {
  type: string;
  id: string;
  alias: string | null;
  /** `id;alias`, the registry-first form a note carries. */
  referenceText: string;
  folder: string;
  /** The sample already stood for this item, so nothing new was written. */
  reused: boolean;
}

/** The vault's strain type, when it has one: partbank strains need it. */
export function strainTypeOf(plugin: LabnotePlugin): string | undefined {
  return canonicalSampleType(
    STRAIN_SAMPLE_TYPE,
    getSampleDisplayMeta(plugin.settings.customSampleTypes).types
  );
}

/**
 * The labnoteo type for an item, asking to add a strain type when partbank
 * hands over a strain and the vault has none. Undefined means the user said no
 * and the item is left alone.
 */
export async function resolveSampleType(
  plugin: LabnotePlugin,
  item: PartbankItem,
  opts: { silent?: boolean } = {}
): Promise<string | undefined> {
  const strainType = strainTypeOf(plugin);
  const type = sampleTypeForItem(item, { strainType });
  if (type) return type;
  if (item.type !== 'strain') return undefined;
  if (opts.silent) return undefined;
  const ok = await confirmModal(
    plugin.app,
    plugin.t(
      'partbank keeps strains, but this vault has no sample type for them. Add the custom sample type "{0}"?',
      STRAIN_SAMPLE_TYPE
    ),
    plugin.t('Add {0}', STRAIN_SAMPLE_TYPE)
  );
  if (!ok) return undefined;
  await addStrainType(plugin);
  return STRAIN_SAMPLE_TYPE;
}

/** Add the strain type the way the settings screen does, and refresh the views. */
export async function addStrainType(plugin: LabnotePlugin): Promise<void> {
  const now = plugin.settings.customSampleTypes;
  if (!now.some(t => t.toLowerCase() === STRAIN_SAMPLE_TYPE.toLowerCase())) {
    plugin.settings.customSampleTypes = [...now, STRAIN_SAMPLE_TYPE];
    await plugin.saveSettings();
  }
  plugin.refreshSampleViews();
}

/**
 * Every sample that could already stand for a partbank item: this note's
 * registry, the global one, and the catalogs both of those hold.
 */
export async function collectLinkedCandidates(
  plugin: LabnotePlugin,
  type: string,
  localFolder: string
): Promise<LinkedSample[]> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const readGlobal = Boolean(globalFolder) && !isSameSampleFolder(localFolder, globalFolder);
  const out: LinkedSample[] = [];
  const add = (
    records: Record<string, SampleRecord>,
    scope: LinkedSample['scope']
  ): void => {
    for (const [id, record] of Object.entries(records)) out.push({ type, id, record, scope });
  };
  add(await loadSamplesByType(plugin.fs, localFolder, type), 'local');
  add(await loadCatalogSamples(plugin, localFolder, type), 'catalog');
  if (readGlobal) {
    add(await loadSamplesByType(plugin.fs, globalFolder, type), 'global');
    add(await loadCatalogSamples(plugin, globalFolder, type), 'catalog');
  }
  return out;
}

/**
 * Register `item` as a sample in `folder`, or reuse the sample that already
 * stands for it. The storage location is read in the same pass, so a freshly
 * registered sample shows where it is kept without a second command.
 */
export async function registerPartbankItem(
  plugin: LabnotePlugin,
  client: PartbankClient,
  item: PartbankItem,
  opts: { folder: string; type?: string } = { folder: '' }
): Promise<RegisteredPartbankSample | undefined> {
  const type = opts.type ?? (await resolveSampleType(plugin, item));
  if (!type) return undefined;
  const folder = opts.folder;
  const source = sourceForItem(item, client.kind, client.origin);

  const existing = findLinkedSample(source, await collectLinkedCandidates(plugin, type, folder));
  if (existing) {
    return {
      type,
      id: existing.id,
      alias: existing.record.alias,
      referenceText: buildSampleReferenceText(existing.id, existing.record.alias),
      folder,
      reused: true,
    };
  }

  const id = generateSampleId(type);
  const alias = aliasForItem(item);
  // Best-effort: an item with no visible stock, or a lookup that fails, simply
  // leaves the location empty rather than failing the registration.
  let location: string | null = null;
  try {
    location = formatStockLocation(await client.getStocks(item.type, item.id)) || null;
  } catch {
    location = null;
  }
  await upsertSampleRecord(plugin.fs, folder, type, id, {
    alias,
    description: descriptionForItem(item),
    location,
    source,
  });
  plugin.samplesChanged();
  return {
    type,
    id,
    alias,
    referenceText: buildSampleReferenceText(id, alias),
    folder,
    reused: false,
  };
}

/**
 * The "Search partbank" autocomplete action end to end: search, register (or
 * reuse), and hand back the `id;alias` to insert. `type` is the type the user
 * typed, or null for `@sample`, where the item decides.
 */
export async function pickPartbankReference(
  plugin: LabnotePlugin,
  opts: { type: string | null; initialQuery: string }
): Promise<string | undefined> {
  const client = plugin.partbank.defaultClient();
  if (!client) {
    plugin.partbank.notifyNotConfigured();
    return undefined;
  }
  const entities = searchEntitiesForSampleType(opts.type, { strainType: strainTypeOf(plugin) });
  if (entities.length === 0) return undefined;

  const hint = searchScopeHint(entities, plugin.t);
  const notFound = plugin.t('Nothing found among partbank {0}.', searchScopeLabel(entities, plugin.t));
  const hit = await searchPartbankModal(plugin.app, client, entities, {
    initialQuery: opts.initialQuery,
    placeholder: plugin.t('Search partbank'),
    emptyText: hint ? `${notFound} ${hint}` : notFound,
    t: plugin.t,
    onError: err => plugin.partbank.notifyError(err, client.kind),
  });
  if (!hit) return undefined;

  // The search rows carry no `molecule_type`, which is what decides whether a
  // molecule is a protein, an RNA or a reagent, so the detail is fetched.
  let item: PartbankItem = hit;
  try {
    item = await client.getItem(hit.type, hit.id);
  } catch (err) {
    if (hit.type === 'molecule' && opts.type === null) {
      plugin.partbank.notifyError(err, client.kind);
      return undefined;
    }
  }

  const type = opts.type ?? (await resolveSampleType(plugin, item));
  if (!type) return undefined;
  const folder = plugin.localSampleFolder();
  const alias = aliasForItem(item);
  if (alias) await warnOnAliasClash(plugin, type, folder, alias);

  const result = await registerPartbankItem(plugin, client, item, { folder, type });
  if (!result) return undefined;
  noticeForRegistration(plugin, result);
  return result.referenceText;
}

/**
 * Tell the user when the alias is already taken. Not a refusal: partbank is
 * the authority on the name, and two samples may legitimately share one.
 */
async function warnOnAliasClash(
  plugin: LabnotePlugin,
  type: string,
  folder: string,
  alias: string
): Promise<void> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const folders = [folder];
  if (globalFolder && !isSameSampleFolder(folder, globalFolder)) folders.push(globalFolder);
  const wanted = alias.trim().toLowerCase();
  for (const f of folders) {
    const records = await loadSamplesByType(plugin.fs, f, type);
    const clash = Object.keys(records).find(
      id => records[id].alias?.trim().toLowerCase() === wanted
    );
    if (clash) {
      new Notice(plugin.t('"{0}" is already the alias of {1}.', alias, clash));
      return;
    }
  }
}

/** Say what happened, including when the sample landed in Global (#64). */
export function noticeForRegistration(
  plugin: LabnotePlugin,
  result: RegisteredPartbankSample
): void {
  if (result.reused) {
    new Notice(plugin.t('{0} already stands for this partbank item.', result.id));
    return;
  }
  const landedInGlobal = isSameSampleFolder(result.folder, plugin.settings.globalSampleFolder);
  new Notice(
    landedInGlobal
      ? plugin.t(
          '{0} was added to Global samples because this note is outside an experiment folder.',
          result.id
        )
      : plugin.t('Sample added: {0}', result.id)
  );
}
