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
  noteLabsamplesFolder,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
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
  /** For a reused sample: which registry or catalog it came from. */
  foundIn?: LinkedSample['scope'];
  /** For a reused sample of another type than the one asked for (#301): the type asked for. */
  requestedType?: string;
  /** For a reused sample marked used up (#387): the date it was marked. */
  discarded?: string;
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
 * registry, the global one, and the catalogs both of those hold. Every type
 * is read, `type` first: a sample whose type was changed keeps its partbank
 * link and still stands for the item (#301).
 */
export async function collectLinkedCandidates(
  plugin: LabnotePlugin,
  type: string,
  localFolder: string
): Promise<LinkedSample[]> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const readGlobal = Boolean(globalFolder) && !isSameSampleFolder(localFolder, globalFolder);
  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const out: LinkedSample[] = [];
  for (const t of [type, ...types.filter(other => other !== type)]) {
    const add = (records: Record<string, SampleRecord>, scope: LinkedSample['scope'], folder: string): void => {
      for (const [id, record] of Object.entries(records)) out.push({ type: t, id, record, scope, folder });
    };
    add(await loadSamplesByType(plugin.fs, localFolder, t), 'local', localFolder);
    add(await loadCatalogSamples(plugin, localFolder, t), 'catalog', localFolder);
    if (readGlobal) {
      add(await loadSamplesByType(plugin.fs, globalFolder, t), 'global', globalFolder);
      add(await loadCatalogSamples(plugin, globalFolder, t), 'catalog', globalFolder);
    }
  }
  return out;
}

/**
 * Register `item` as a sample in `folder`, or reuse the sample that already
 * stands for it. The storage location is read in the same pass, so a freshly
 * registered sample shows where it is kept without a second command.
 *
 * `lookIn` is the experiment's own sample folder, searched (with Global and
 * the catalogs) for the item even when `folder` is Global: writing to Global
 * must not register a second ID for an item this experiment already has
 * (#270). It defaults to `folder`. A reused sample reports where it was found.
 */
export async function registerPartbankItem(
  plugin: LabnotePlugin,
  client: PartbankClient,
  item: PartbankItem,
  opts: { folder: string; type?: string; lookIn?: string } = { folder: '' }
): Promise<RegisteredPartbankSample | undefined> {
  const type = opts.type ?? (await resolveSampleType(plugin, item));
  if (!type) return undefined;
  const folder = opts.folder;
  const lookIn = opts.lookIn ?? folder;
  const source = sourceForItem(item, client.kind, client.origin);

  const existing = findLinkedSample(source, await collectLinkedCandidates(plugin, type, lookIn));
  if (existing) {
    return {
      type: existing.type,
      id: existing.id,
      alias: existing.record.alias,
      referenceText: buildSampleReferenceText(existing.id, existing.record.alias),
      folder: existing.folder ?? folder,
      reused: true,
      foundIn: existing.scope,
      ...(existing.type !== type ? { requestedType: type } : {}),
      ...(existing.record.discarded ? { discarded: existing.record.discarded } : {}),
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
  const notFound = `${plugin.t('Nothing found among partbank {0}.', searchScopeLabel(entities, plugin.t))} ${plugin.t(
    'Only your own items and items shared with your groups are searched, not public ones.'
  )}`;
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
  const result = await registerPartbankItem(plugin, client, item, { folder, type });
  if (!result) return undefined;
  // Only a new sample can clash; a reused one is the very sample (#387).
  if (!result.reused && result.alias) await warnOnAliasClash(plugin, type, folder, result.alias, result.id);
  // The autocomplete puts the returned reference into the note being edited.
  noticeForRegistration(plugin, result, undefined, catalogSeedNote(plugin, result, plugin.host.editTarget()?.path));
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
  alias: string,
  self: string
): Promise<void> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const folders = [folder];
  if (globalFolder && !isSameSampleFolder(folder, globalFolder)) folders.push(globalFolder);
  const wanted = alias.trim().toLowerCase();
  for (const f of folders) {
    const records = await loadSamplesByType(plugin.fs, f, type);
    const clash = Object.keys(records).find(
      id => id !== self && records[id].alias?.trim().toLowerCase() === wanted
    );
    if (clash) {
      new Notice(plugin.t('"{0}" is already the alias of {1}.', alias, clash));
      return;
    }
  }
}

/**
 * The sentence for a sample reused from a catalog once its reference went into
 * `notePath`: saving that note copies it into the experiment's registry (the
 * sample sync seeds catalog references). Empty when no copy follows: not from
 * a catalog, a note whose samples are not tracked, or one outside an
 * experiment, whose registry is the global one.
 */
export function catalogSeedNote(
  plugin: LabnotePlugin,
  result: RegisteredPartbankSample,
  notePath: string | undefined
): string {
  if (result.foundIn !== 'catalog' || !notePath || !plugin.sampleTrackingFor(notePath)) return '';
  const globalFolder = plugin.settings.globalSampleFolder;
  if (!getExperimentDir(notePath) || isSameSampleFolder(noteLabsamplesFolder(notePath, globalFolder), globalFolder)) {
    return '';
  }
  return plugin.t("Saving the note adds it to this experiment's samples as well.");
}

/**
 * Say what happened, including when the sample landed in Global (#64).
 * `chosenFolder` is the folder the user picked, when they picked one: Global
 * chosen is then told apart from Global by default, and a sample reused from
 * elsewhere says where it is (#270): a catalog (#295), another folder, or
 * under another type than the one asked for (#301). `extra` is appended.
 */
export function noticeForRegistration(
  plugin: LabnotePlugin,
  result: RegisteredPartbankSample,
  chosenFolder?: string,
  extra = ''
): void {
  const show = (text: string): void => {
    new Notice(extra ? `${text} ${extra}` : text);
  };
  if (result.reused) {
    const elsewhere =
      result.foundIn === 'global' || (chosenFolder !== undefined && !isSameSampleFolder(result.folder, chosenFolder));
    const main =
      result.foundIn === 'catalog'
        ? plugin.t('Used {0} from the partbank catalog ({1}).', result.id, result.folder)
        : elsewhere
          ? plugin.t(
              '{0} in {1} already stands for this partbank item, so it was used instead of registering a second one.',
              result.id,
              result.folder
            )
          : plugin.t('{0} already stands for this partbank item.', result.id);
    show(
      [
        main,
        result.requestedType ? plugin.t('It is registered as {0}, not {1}.', result.type, result.requestedType) : '',
        result.discarded ? plugin.t('{0} was marked discarded on {1}.', result.id, result.discarded) : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
    return;
  }
  const landedInGlobal = isSameSampleFolder(result.folder, plugin.settings.globalSampleFolder);
  show(
    !landedInGlobal
      ? plugin.t('Sample added: {0}', result.id)
      : chosenFolder !== undefined
        ? plugin.t('Sample added to Global samples: {0}', result.id)
        : plugin.t(
            '{0} was added to Global samples because this note is outside an experiment folder.',
            result.id
          )
  );
}
