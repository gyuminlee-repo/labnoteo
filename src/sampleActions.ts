/**
 * Shared, interactive sample create/edit/delete actions for the Obsidian
 * plugin. Used by both the editor autocomplete "create" flow
 * ([sampleSuggest.ts](./sampleSuggest.ts)) and the Samples sidebar context menu
 * ([views/sampleView.ts](./views/sampleView.ts)).
 *
 * Pure formatting/ID logic lives in `@labnoteo/core`; this module only wires
 * the modals, persists JSON via the vault fs, and surfaces notices.
 */
import { App, MarkdownView, Notice, type Editor } from 'obsidian';
import { isOffsetBeforeBody, maskAiCallouts, planReferenceInsert, type EditTarget, type PickItem } from '@labnoteo/core';
import {
  generateSampleId,
  normalizeSampleId,
  buildSampleDefinitionText,
  buildSampleReferenceText,
  isCatalogSampleType,
  getSampleDisplayMeta,
  hasSampleDescriptionSeparator,
  sampleAliasProblem,
  buildMarkdownTable,
  planSampleListRowUpdate,
  planSampleListRowRemoval,
  maskSampleListTables,
  compareSamples,
} from '@labnoteo/core/lib/sampleUtils';
import {
  loadSamplesByType,
  loadReferenceSamplesByType,
  upsertSampleRecord,
  mergeSampleRecord,
  deleteSampleRecord,
  putSampleRecord,
  noteLabsamplesFolder,
  noteLocalSampleFolder,
  findSampleDefinitionMatch,
  findSampleUsages,
  isSameSampleFolder,
  planAliasRewrite,
  applyAliasRewrite,
  planSampleIdRewrite,
  sampleIdForType,
  setSampleDiscarded,
  listExperimentSampleFolders,
  extractSampleInfoFromText,
  samplesWithAliasIn,
  findSampleUsageSpots,
  type SampleUsageSpot,
  type AliasRewriteEdit,
  type SampleInfo,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { invalidVaultFolderReason } from '@labnoteo/core/lib/regexUtils';
import type LabnotePlugin from './main';
import { invalidFolderText } from './settings';
import { processNoteThroughVault } from './commands';
import { promptModal, confirmModal, pickModal } from './modals';
import { isReadingViewTarget } from './obsidianHost';
import obsidianKo from './l10n.ko';

export type SampleScope = 'local' | 'global';

/**
 * Resolve the vault-relative labsamples folder for a scope. Local is the active
 * note's experiment `resources/labsamples` (via {@link LabnotePlugin.localSampleFolder},
 * which pins to the last opened experiment); Global is the settings folder.
 */
export function resolveScopeFolder(plugin: LabnotePlugin, scope: SampleScope): string {
  if (scope === 'global') return plugin.settings.globalSampleFolder;
  return plugin.localSampleFolder();
}

/** Trim to a non-empty string or null. */
function clean(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/**
 * Read a type's product catalogs from `folder`.
 *
 * Always goes through the vault's type list: a custom type name may hold `_`,
 * so `DNA_Lib.json` — the registry of the `DNA_Lib` type — would otherwise be
 * read as a `DNA` catalog.
 */
export function loadCatalogSamples(
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  fileOf?: Record<string, string>
): Promise<Record<string, SampleRecord>> {
  return loadReferenceSamplesByType(
    plugin.fs,
    folder,
    type,
    getSampleDisplayMeta(plugin.settings.customSampleTypes).types,
    fileOf
  );
}

/**
 * Block the characters that would split the alias in a note (#98) or that
 * Markdown reads as a tag, link, emphasis or code (#168).
 */
export function validateAlias(plugin: Pick<LabnotePlugin, 't'>): (value: string) => string | null {
  return v => {
    switch (sampleAliasProblem(v)) {
      case 'separator':
        return plugin.t(
          'An alias cannot contain ";" or ":", which separate the ID, alias and description in a note. Use "-" or "/" instead (e.g. 1-10).'
        );
      case 'markdown':
        return plugin.t(
          'An alias cannot contain #, [[, ]], ](, *, _ or `, which Markdown reads as a tag, link, emphasis or code. Use "-" or "/" instead.'
        );
      default:
        return null;
    }
  };
}

/** Block the character that would end the description in a note (#98). */
function validateDescription(plugin: LabnotePlugin): (value: string) => string | null {
  return v =>
    hasSampleDescriptionSeparator(v)
      ? plugin.t('A description cannot contain ";", which ends the description in a note. Use "," instead.')
      : null;
}

/**
 * Insert a sample reference (`id;alias` / bare `id`) into `target` at the place
 * {@link planReferenceInsert} chooses: appended below the last section when the
 * cursor sits in the front matter or above the title, at the end of the line
 * when the cursor is on an existing reference or heading, over the selected
 * text on one line (#302), otherwise at the cursor (padded so it never fuses
 * with a neighbour). Reveals the spot and marks
 * the note edited so `last_updated_date` refreshes.
 */
export async function insertSampleReference(
  plugin: LabnotePlugin,
  target: EditTarget,
  ref: string
): Promise<void> {
  // Hosts without cursor tracking (none today) fall back to a plain insert.
  if (!target.getCursorOffset) {
    await target.insertAtCursor(ref);
    plugin.markUserEdit(target.path);
    return;
  }
  const text = await target.getText();
  const cursor = await target.getCursorOffset();
  const selection = await target.getSelectionRange?.();
  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const plan = planReferenceInsert(text, cursor, ref, types, selection?.end);
  await target.replaceRange(plan.offset, plan.end ?? plan.offset, plan.text);
  await target.revealOffset?.(plan.offset + plan.text.length);
  plugin.markUserEdit(target.path);
}

/**
 * "Insert sample list of this experiment" (#152): a Markdown table of every
 * Local sample of the open note's experiment and the Global ones its notes use,
 * inserted at the cursor. Returns false when there is nothing to insert.
 */
export async function insertExperimentSamplesTable(app: App, plugin: LabnotePlugin): Promise<boolean> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note to insert into.'));
    return false;
  }
  const globalFolder = plugin.settings.globalSampleFolder;
  const local = noteLabsamplesFolder(target.path, globalFolder);
  if (!getExperimentDir(target.path) || isSameSampleFolder(local, globalFolder)) {
    new Notice(plugin.t('Open a note of an experiment to list its samples.'));
    return false;
  }

  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const used = new Set<string>();
  const references: SampleInfo[] = [];
  const headers = sampleListHeaders(plugin);
  for (const note of await notesInSampleScope(app, local)) {
    // An earlier table and an AI answer list samples without using them (#385, #318).
    const text = maskSampleListTables(maskAiCallouts(note.text), headers);
    for (const s of extractSampleInfoFromText(text, plugin.settings.customSampleTypes)) {
      used.add(`${s.type}\u0000${s.id}`);
      references.push(s);
    }
  }
  // The same sources as the editor's "not in the registry" mark (#238).
  const known = new Set<string>();
  const remember = (db: Record<string, unknown>): void => {
    for (const id of Object.keys(db)) known.add(id.toLowerCase());
  };
  const rows: string[][] = [];
  for (const type of types) {
    const localDb = await loadSamplesByType(plugin.fs, local, type);
    remember(localDb);
    if (isCatalogSampleType(type)) remember(await loadCatalogSamples(plugin, local, type));
    const listed: Array<{ id: string; rec: SampleRecord; scope: SampleScope }> = Object.entries(localDb).map(
      ([id, rec]) => ({ id, rec, scope: 'local' })
    );
    if (globalFolder) {
      const globalDb = await loadSamplesByType(plugin.fs, globalFolder, type);
      remember(globalDb);
      if (isCatalogSampleType(type)) remember(await loadCatalogSamples(plugin, globalFolder, type));
      for (const [id, rec] of Object.entries(globalDb)) {
        if (!localDb[id] && used.has(`${type}\u0000${id}`)) listed.push({ id, rec, scope: 'global' });
      }
    }
    // By alias within each type, as the sample view lists them (#410).
    listed.sort(
      (a, b) =>
        compareSamples({ id: a.id, alias: a.rec.alias }, { id: b.id, alias: b.rec.alias }) ||
        (a.scope === b.scope ? 0 : a.scope === 'local' ? -1 : 1)
    );
    for (const { id, rec, scope } of listed) rows.push(sampleListRow(plugin, id, rec, scope));
  }
  const unregistered = unregisteredReferences(references, known);
  const leftOut =
    unregistered.length === 0
      ? ''
      : ` ${plugin.t(
          "{0} sample reference(s) in this experiment's notes are not in the sample registry, so they are not in the table: {1}",
          String(unregistered.length),
          listSome(unregistered)
        )}`;
  if (rows.length === 0) {
    new Notice(`${plugin.t('This experiment has no samples yet.')}${leftOut}`);
    return false;
  }

  const table = buildMarkdownTable(sampleListHeaders(plugin)[0], rows, new Set([0]));
  const text = await target.getText();
  const cursor = target.getCursorOffset ? await target.getCursorOffset() : text.length;
  // In the front matter or above the title the table would break the
  // properties, so it goes at the end like a sample reference does (#360).
  const atEnd = cursor !== text.length && isOffsetBeforeBody(text, cursor);
  const at = atEnd ? text.length : cursor;
  const before = at === 0 || text[at - 1] === '\n' ? (at > 1 && text[at - 2] !== '\n' ? '\n' : '') : '\n\n';
  const after = at >= text.length || text[at] === '\n' ? '\n' : '\n\n';
  await target.replaceRange(at, at, `${before}${table}${after}`);
  // Below the table, not in its last cell, so running the command again does
  // not land inside this table (#196).
  await target.revealOffset?.(at + before.length + table.length + after.length);
  plugin.markUserEdit(target.path);
  const where = atEnd ? ` ${plugin.t('The cursor was in the properties or above the title, so the table is at the end of the note.')}` : '';
  new Notice(`${plugin.t('Inserted {0} sample(s).', String(rows.length))}${where}${leftOut}`);
  return true;
}

const SAMPLE_LIST_HEADERS = ['ID', 'Alias', 'Description', 'Location', 'Scope', 'Discarded'];

/**
 * The header of a sample list table in the UI language, then in Korean and
 * English, so a table inserted before the UI language changed is still known.
 */
export function sampleListHeaders(plugin: Pick<LabnotePlugin, 't'>): string[][] {
  const sets = [
    SAMPLE_LIST_HEADERS.map(h => plugin.t(h)),
    SAMPLE_LIST_HEADERS.map(h => (obsidianKo as Record<string, string>)[h] ?? h),
    SAMPLE_LIST_HEADERS,
  ];
  return sets.filter((set, i) => sets.findIndex(other => other.join('\u0000') === set.join('\u0000')) === i);
}

/** A sample's row in a sample list table, in {@link SAMPLE_LIST_HEADERS} order. */
function sampleListRow(plugin: Pick<LabnotePlugin, 't'>, id: string, rec: SampleRecord, scope: SampleScope): string[] {
  return [
    id,
    rec.alias ?? '',
    rec.descriptions?.[0] ?? '',
    rec.location ?? '',
    plugin.t(scope === 'local' ? 'Local' : 'Global'),
    rec.discarded ?? '',
  ];
}

/**
 * Bring the rows of sample `(type, id)` of `folder` in the sample list tables
 * of its notes up to the registry (#336): the table is written from it, so it
 * follows it like a definition does. A Global sample is skipped in experiments
 * with a Local record of the same id, which the table lists instead.
 * `notesOf` is the folder whose notes are read, `folder` by default. Returns
 * how many notes changed.
 */
async function updateSampleListTables(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; notesOf?: string }
): Promise<number> {
  const { folder, type, id } = opts;
  const record = (await loadSamplesByType(plugin.fs, folder, type))[id];
  if (!record) return 0;
  const isGlobal = isSameSampleFolder(folder, plugin.settings.globalSampleFolder);
  const cells = sampleListRow(plugin, id, record, isGlobal ? 'global' : 'local');
  const headers = sampleListHeaders(plugin);
  const shadowed = new Map<string, boolean>();
  let updated = 0;
  for (const note of await notesInSampleScope(app, opts.notesOf ?? folder)) {
    if (planSampleListRowUpdate(note.text, headers, id, cells).length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, plugin.settings.globalSampleFolder);
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    if (note.editor) {
      const editor = note.editor;
      const edits = planSampleListRowUpdate(editor.getValue(), headers, id, cells);
      if (edits.length === 0) continue;
      editor.transaction({
        changes: edits.map(e => ({ from: editor.offsetToPos(e.start), to: editor.offsetToPos(e.end), text: e.text })),
      });
      updated++;
    } else if (
      await processNoteThroughVault(app, plugin.host, note.path, content =>
        planSampleListRowUpdate(content, headers, id, cells).reduceRight(
          (out, e) => out.slice(0, e.start) + e.text + out.slice(e.end),
          content
        )
      )
    ) {
      updated++;
    }
  }
  return updated;
}

/**
 * The references of `references` whose ID is not in `known` (lower-cased),
 * once each, as `ID;alias` (#238).
 */
export function unregisteredReferences(references: readonly SampleInfo[], known: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of references) {
    const key = s.id.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(buildSampleReferenceText(s.id, s.alias));
  }
  return out;
}

function listSome(items: readonly string[], max = 5): string {
  return items.length > max ? `${items.slice(0, max).join(', ')}, …` : items.join(', ');
}

export interface CreatedSample {
  id: string;
  alias: string | null;
  description: string | null;
  /** `@type;id;alias;desc` — optional, for the "insert definition" action. */
  definitionText: string;
  /** `id;alias` (or bare `id`) — the registry-first document insert form. */
  referenceText: string;
  /** An existing same-alias sample picked instead of creating one (#248). */
  reused?: boolean;
}

/**
 * Interactively create a sample (generate a new id or enter one manually),
 * persist it, and return the created record + its `@type;id;...` definition
 * text. Returns undefined, registering nothing, when any step is cancelled
 * (Escape / closing the prompt); alias/description/location are optional, so
 * submitting a prompt empty leaves that field blank.
 */
export async function createSampleInteractive(
  app: App,
  plugin: LabnotePlugin,
  opts: {
    type: string;
    folder: string;
    mode: 'generate' | 'manual';
    scope?: SampleScope;
    /**
     * What was typed after `@type;` (#142): an ID of the type's form fills the
     * ID prompt of manual entry, anything else the alias prompt.
     */
    initial?: string;
  }
): Promise<CreatedSample | undefined> {
  const { type, folder, mode } = opts;
  // Checked before the prompts, so what would be typed into them is not lost (#328).
  const badFolder = invalidVaultFolderReason(folder);
  if (badFolder) {
    const why = plugin.t('Samples cannot be saved in "{0}": {1}', folder, invalidFolderText(plugin.t, badFolder));
    const fix = isSameSampleFolder(folder, plugin.settings.globalSampleFolder)
      ? plugin.t('Change the Global sample folder in Settings.')
      : '';
    new Notice([why, fix].filter(Boolean).join(' '), 10000);
    return undefined;
  }
  const initial = opts.initial?.trim() ?? '';
  const initialId = initial && normalizeSampleId(type, initial) ? initial : undefined;
  const initialAlias = initial && !initialId ? initial : '';

  let id: string;
  let existing: { folder: string; record: SampleRecord } | undefined;
  if (mode === 'generate') {
    id = generateSampleId(type);
  } else {
    const entered = await promptModal(app, {
      title: plugin.t('Enter the {0} sample ID', type),
      value: initialId ?? `${type}-`,
      placeholder: plugin.t('e.g. {0}-12345', type),
      validate: v =>
        normalizeSampleId(type, v) ? null : plugin.t('Invalid ID. Expected {0}-<number>.', type),
    });
    if (entered === undefined) return undefined;
    id = normalizeSampleId(type, entered) ?? entered.trim();
    // Re-entering a known id adds to its record instead of replacing it (#84).
    existing = await findRegisteredSample(plugin, type, id, folder);
    if (existing) {
      new Notice(
        plugin.t(
          '{0} already exists. Its current values are filled in, and a new description is added before the earlier ones.',
          id
        ),
        8000
      );
    }
  }

  const aliasRaw = await promptModal(app, {
    title: existing
      ? plugin.t('Enter a new alias')
      : plugin.t('Enter an alias for the new {0} sample (optional)', type),
    value: existing?.record.alias ?? initialAlias,
    placeholder: plugin.t('e.g. Sample-A'),
    validate: validateAlias(plugin),
  });
  if (aliasRaw === undefined) return undefined;
  const alias = clean(aliasRaw);
  // Re-entering a known id changes its alias as editing does (#403).
  if (existing && !(await confirmAliasClash(app, plugin, { folder: existing.folder, type, id, alias, before: existing.record.alias }))) {
    return undefined;
  }

  // A twin in the same folder is worse than a Global one (#125): autocomplete
  // shows the two with identical text and no Local/Global tag to tell them
  // apart. Ask before the remaining prompts rather than after the sample is
  // written (#248); re-entering a known id is the merge flow, which stays.
  // Every one is listed (#274): when two already share the alias, offering only
  // the first hides the one the user may have meant.
  const siblings = alias && !existing ? await samplesWithAliasIn(plugin.fs, folder, type, alias) : [];
  if (siblings.length > 0) {
    const records = await loadSamplesByType(plugin.fs, folder, type);
    const inGlobal = isSameSampleFolder(folder, plugin.settings.globalSampleFolder);
    const labels = siblings.map(s => aliasSiblingLabel(plugin, s, records[s]));
    // Discarded ones go below "Create a new sample anyway", so Enter on the
    // first item does not take a tube that is gone (#419), as in autocomplete.
    const reuseItem = (sibling: string) => {
      const discarded = records[sibling]?.discarded;
      return {
        label: `${plugin.t('Use the existing sample {0}', sibling)}${discarded ? ` ${plugin.t('(discarded)')}` : ''}`,
        value: sibling,
        description:
          [discarded && plugin.t('Marked discarded on {0}', discarded), records[sibling]?.descriptions?.[0], records[sibling]?.location]
            .filter(Boolean)
            .join(' · ') || plugin.t('Nothing is registered; its ID goes where this one would have.'),
      };
    };
    const live = siblings.filter(s => !records[s]?.discarded);
    const reuse = await pickModal<string | null>(
      app,
      [
        ...live.map(reuseItem),
        {
          label: plugin.t('Create a new sample anyway'),
          value: null,
          description: plugin.t('Both keep the alias, and only their descriptions tell them apart.'),
        },
        ...siblings.filter(s => records[s]?.discarded).map(reuseItem),
      ],
      {
        title:
          live.length === 0
            ? plugin.t('Only discarded samples have the alias {0} ({1}).', alias!, siblings.join(', '))
            : siblings.length === 1
              ? plugin.t(
                  inGlobal
                    ? 'Global samples already have the alias {0} ({1}).'
                    : 'This experiment already has the alias {0} ({1}).',
                  alias!,
                  labels[0]
                )
              : plugin.t(
                  inGlobal
                    ? '{0} Global samples already have the alias {1} ({2}).'
                    : '{0} samples in this experiment already have the alias {1} ({2}).',
                  String(siblings.length),
                  alias!,
                  labels.join(', ')
                ),
      }
    );
    if (reuse === undefined) return undefined;
    if (reuse !== null) {
      const record = records[reuse];
      const reusedAlias = record?.alias ?? null;
      const reusedDesc = record?.descriptions?.[0] ?? null;
      new Notice(plugin.t('Using the existing sample {0} instead of creating one.', reuse));
      if (record?.discarded) new Notice(plugin.t('{0} was marked discarded on {1}.', reuse, record.discarded));
      return {
        id: reuse,
        alias: reusedAlias,
        description: reusedDesc,
        definitionText: buildSampleDefinitionText(type, reuse, reusedAlias, reusedDesc),
        referenceText: buildSampleReferenceText(reuse, reusedAlias),
        reused: true,
      };
    }
  }

  const descRaw = await promptModal(app, {
    title: plugin.t('Enter a description (optional)'),
    value: existing?.record.descriptions?.[0] ?? '',
    placeholder: plugin.t('e.g. Sample used in experiment 1'),
    validate: validateDescription(plugin),
  });
  if (descRaw === undefined) return undefined;
  const locationRaw = await promptModal(app, {
    title: plugin.t('Enter a storage location (optional)'),
    value: existing?.record.location ?? '',
    placeholder: plugin.t('e.g. Freezer-2 / Box-3 / A1'),
  });
  if (locationRaw === undefined) return undefined;
  const description = clean(descRaw);
  const location = clean(locationRaw);

  if (existing) {
    // A blank field keeps the stored value, as in the note sync (#73); clearing
    // or rewriting one is what "Edit sample" is for.
    const { discarded } = await mergeSampleRecord(plugin.fs, existing.folder, type, id, {
      alias: alias ?? undefined,
      description: description ?? undefined,
      location: location ?? undefined,
    });
    plugin.refreshSampleViews();
    new Notice(plugin.t('Sample updated: {0}', id));
    if (discarded) new Notice(plugin.t('{0} was marked discarded on {1}.', id, discarded));
    const merged = (await loadSamplesByType(plugin.fs, existing.folder, type))[id];
    const mergedAlias = merged?.alias ?? null;
    const mergedDesc = merged?.descriptions?.[0] ?? null;
    return {
      id,
      alias: mergedAlias,
      description: mergedDesc,
      definitionText: buildSampleDefinitionText(type, id, mergedAlias, mergedDesc),
      referenceText: buildSampleReferenceText(id, mergedAlias),
    };
  }

  // Only Global holds the alias: the two are told apart by the Local/Global
  // tag in autocomplete, so a notice is enough (#109).
  const twins = alias && siblings.length === 0 ? await globalSamplesWithAlias(plugin, type, folder, alias) : [];
  if (twins.length > 0) {
    new Notice(
      plugin.t(
        'Global samples already have the alias {0} ({1}). Autocomplete will show both, marked Local and Global.',
        alias!,
        twins.join(', ')
      ),
      8000
    );
  }

  // `sources` is omitted so the record keeps whatever documents already
  // reference it; a tree-created sample legitimately starts with none.
  await upsertSampleRecord(plugin.fs, folder, type, id, { alias, description, location });
  plugin.refreshSampleViews();
  // A vault-root note's "local" folder is the global one (#64): say where it went.
  const landedInGlobal =
    opts.scope === 'local' && isSameSampleFolder(folder, plugin.settings.globalSampleFolder);
  new Notice(
    landedInGlobal
      ? plugin.t('{0} was added to Global samples because this note is outside an experiment folder.', id)
      : plugin.t('Sample added: {0}', id)
  );

  return {
    id,
    alias,
    description,
    definitionText: buildSampleDefinitionText(type, id, alias, description),
    referenceText: buildSampleReferenceText(id, alias),
  };
}

/**
 * Ask before sample `id` of `folder` takes an alias another sample already has
 * (#403), as creating one does: the two would look alike in autocomplete. Only
 * Global holding it is told in a notice. True when the alias may be saved:
 * also when it is empty or did not change (spaces and case aside).
 */
async function confirmAliasClash(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; alias: string | null; before?: string | null }
): Promise<boolean> {
  const { folder, type, id, alias } = opts;
  if (!alias || alias.trim().toLowerCase() === (opts.before ?? '').trim().toLowerCase()) return true;
  const siblings = (await samplesWithAliasIn(plugin.fs, folder, type, alias)).filter(s => s !== id);
  if (siblings.length === 0) {
    const twins = (await globalSamplesWithAlias(plugin, type, folder, alias)).filter(s => s !== id);
    if (twins.length > 0) {
      new Notice(
        plugin.t(
          'Global samples already have the alias {0} ({1}). Autocomplete will show both, marked Local and Global.',
          alias,
          twins.join(', ')
        ),
        8000
      );
    }
    return true;
  }
  const inGlobal = isSameSampleFolder(folder, plugin.settings.globalSampleFolder);
  const records = await loadSamplesByType(plugin.fs, folder, type);
  const labels = siblings.map(s => aliasSiblingLabel(plugin, s, records[s]));
  const taken =
    siblings.length === 1
      ? plugin.t(
          inGlobal ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
          alias,
          labels[0]
        )
      : plugin.t(
          inGlobal
            ? '{0} Global samples already have the alias {1} ({2}).'
            : '{0} samples in this experiment already have the alias {1} ({2}).',
          String(siblings.length),
          alias,
          labels.join(', ')
        );
  return confirmModal(app, `${taken} ${plugin.t('Save {0} anyway?', id)}`, plugin.t('Save anyway'));
}

/** A sample sharing an alias, as an alias question names it: its ID, marked when discarded (#419). */
function aliasSiblingLabel(plugin: LabnotePlugin, id: string, record: SampleRecord | undefined): string {
  return record?.discarded ? `${id} ${plugin.t('(discarded)')}` : id;
}

/**
 * The IDs of the Global `type` samples with `alias` (trimmed, case ignored)
 * when a sample is being added to the Local `folder`: they would look alike in
 * autocomplete (#109). Empty for a Global folder or no such sample.
 */
async function globalSamplesWithAlias(
  plugin: LabnotePlugin,
  type: string,
  folder: string,
  alias: string
): Promise<string[]> {
  const globalFolder = plugin.settings.globalSampleFolder;
  if (!globalFolder || isSameSampleFolder(folder, globalFolder)) return [];
  return samplesWithAliasIn(plugin.fs, globalFolder, type, alias);
}

/**
 * The registry record for `id` in `folder`, else in the Global folder, with the
 * folder it was found in so an update lands there (no Local shadow of a Global
 * sample).
 */
async function findRegisteredSample(
  plugin: LabnotePlugin,
  type: string,
  id: string,
  folder: string
): Promise<{ folder: string; record: SampleRecord } | undefined> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const folders = [folder];
  if (globalFolder && !isSameSampleFolder(folder, globalFolder)) folders.push(globalFolder);
  for (const f of folders) {
    const record = (await loadSamplesByType(plugin.fs, f, type))[id];
    if (record) return { folder: f, record };
  }
  return undefined;
}

/**
 * Search the read-only product catalog (`{Type}_*.json`) for a catalog type
 * (Reagent/Labware/Equip) and return the chosen entry's reference text
 * (`id;alias`). Merges the document's local catalog with the vault-global one
 * (local wins). When the catalog has no entries, offers to register a sample
 * with a generated id instead, as the sample view does (returning its
 * reference).
 */
export async function pickCatalogReference(
  app: App,
  plugin: LabnotePlugin,
  opts: { type: string; docPath: string; initialQuery?: string }
): Promise<string | undefined> {
  const { type, docPath, initialQuery } = opts;
  const localFolder = noteLabsamplesFolder(docPath, plugin.settings.globalSampleFolder);
  const globalFolder = plugin.settings.globalSampleFolder;

  const local = await loadCatalogSamples(plugin, localFolder, type);
  const global = globalFolder ? await loadCatalogSamples(plugin, globalFolder, type) : {};
  const merged: Record<string, SampleRecord> = { ...global, ...local };

  const items: PickItem<string>[] = Object.entries(merged).map(([id, rec]) => ({
    label: rec.alias ? `${id} — ${rec.alias}` : id,
    value: id,
    description: rec.descriptions?.[0],
  }));

  if (items.length === 0) {
    // The action is listed only when a catalog file exists (#99), so this is
    // an empty file or one removed since; ask before switching to creation.
    const ok = await confirmModal(
      app,
      plugin.t(
        'No {0} catalog entries found (resources/labsamples/{0}_*.json). Create a new {0} sample instead?',
        type
      ),
      plugin.t('Create sample')
    );
    if (!ok) return undefined;
    const created = await createSampleInteractive(app, plugin, {
      type,
      folder: localFolder,
      mode: 'generate',
      scope: 'local',
      initial: initialQuery,
    });
    return created?.referenceText;
  }

  const chosen = await pickModal(app, items, {
    title: plugin.t('Search {0} catalog', type),
    placeholder: plugin.t('Search catalog'),
    initialQuery,
  });
  if (chosen === undefined) return undefined;
  return buildSampleReferenceText(chosen, merged[chosen]?.alias);
}

/**
 * Interactively edit a sample's alias/description (prefilled), persist to JSON,
 * and best-effort update the `@type;` definition in the active note if present
 * so the document and JSON do not diverge. Returns false when cancelled.
 */
export async function editSampleInteractive(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; record: SampleRecord }
): Promise<boolean> {
  const { folder, type, id, record } = opts;

  const aliasRaw = await promptModal(app, {
    title: plugin.t('Enter a new alias'),
    value: record.alias ?? '',
    placeholder: plugin.t('e.g. Sample-A'),
    // An alias registered before #168 may keep its Markdown characters.
    validate: v =>
      v.trim() === (record.alias ?? '').trim() && sampleAliasProblem(v) === 'markdown'
        ? null
        : validateAlias(plugin)(v),
  });
  if (aliasRaw === undefined) return false;
  if (!(await confirmAliasClash(app, plugin, { folder, type, id, alias: clean(aliasRaw), before: record.alias }))) {
    return false;
  }
  const descRaw = await promptModal(app, {
    title: plugin.t('Enter a new description'),
    value: record.descriptions?.[0] ?? '',
    placeholder: plugin.t('e.g. Sample used in experiment 1'),
    validate: validateDescription(plugin),
  });
  if (descRaw === undefined) return false;
  const locationRaw = await promptModal(app, {
    title: plugin.t('Enter a storage location (optional)'),
    value: record.location ?? '',
    placeholder: plugin.t('e.g. Freezer-2 / Box-3 / A1'),
  });
  if (locationRaw === undefined) return false;

  const alias = clean(aliasRaw);
  const description = clean(descRaw);
  const location = clean(locationRaw);
  await upsertSampleRecord(plugin.fs, folder, type, id, { alias, description, location });
  plugin.refreshSampleViews();

  // Best-effort: keep the active note's `@type;` definition in sync (single
  // file only). Plain `id;alias` references are left as written.
  const target = plugin.host.editTarget();
  if (target && isReadingViewTarget(target)) {
    await processNoteThroughVault(app, plugin.host, target.path, content => {
      const match = findSampleDefinitionMatch(content, type, id, record.alias ?? null);
      return match
        ? content.slice(0, match.start) +
            buildSampleDefinitionText(type, id, alias, description) +
            content.slice(match.start + match.length)
        : content;
    });
  } else if (target) {
    const text = await target.getText();
    const match = findSampleDefinitionMatch(text, type, id, record.alias ?? null);
    if (match) {
      await target.replaceRange(
        match.start,
        match.start + match.length,
        buildSampleDefinitionText(type, id, alias, description)
      );
    }
  }

  const tables = await updateSampleListTables(app, plugin, { folder, type, id });
  const tablesNote = tables > 0 ? plugin.t('Updated the sample list table in {0} note(s).', String(tables)) : undefined;
  const oldAlias = record.alias?.trim() ?? '';
  // From no alias to one, bare-id references can show it too (#170).
  const rewritten =
    oldAlias !== (alias ?? '')
      ? await rewriteStaleAliases(app, plugin, { folder, type, id, oldAlias, newAlias: alias ?? '', tablesNote })
      : undefined;
  const copies = await otherExperimentsWithSample(plugin, folder, type, id);
  const elsewhere =
    copies.length > 0
      ? plugin.t('{0} is also registered in other experiments ({1}); only this one changed.', id, copies.join(', '))
      : undefined;
  new Notice(
    [plugin.t('Sample updated: {0}', id), tablesNote, rewritten, elsewhere].filter(Boolean).join(' '),
    tablesNote || rewritten || elsewhere ? 8000 : undefined
  );
  return true;
}

/**
 * The experiments other than `folder`'s whose Local registry also has `(type,
 * id)`: copies an import left behind, which an edit here does not reach (#173).
 */
export async function otherExperimentsWithSample(
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  id: string
): Promise<string[]> {
  const out: string[] = [];
  for (const other of await listExperimentSampleFolders(plugin.fs, '')) {
    if (isSameSampleFolder(other, folder) || isSameSampleFolder(other, plugin.settings.globalSampleFolder)) continue;
    if ((await loadSamplesByType(plugin.fs, other, type))[id]) out.push(getExperimentDir(other) ?? other);
  }
  return out;
}

/**
 * Mark a sample discarded today, or in use again with `discarded: false`
 * (#158). The record stays, so the notes that use it keep resolving it.
 */
export async function setSampleDiscardedInteractive(
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; discarded: boolean }
): Promise<boolean> {
  const { folder, type, id, discarded } = opts;
  const found = await setSampleDiscarded(plugin.fs, folder, type, id, discarded ? getSeoulDateString() : null);
  if (!found) {
    new Notice(plugin.t('Sample not found: {0}', id));
    return false;
  }
  plugin.refreshSampleViews();
  const tables = await updateSampleListTables(plugin.app, plugin, { folder, type, id });
  new Notice(
    [
      discarded ? plugin.t('Marked {0} as discarded.', id) : plugin.t('{0} is no longer marked discarded.', id),
      tables > 0 ? plugin.t('Updated the sample list table in {0} note(s).', String(tables)) : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
  return true;
}

/** A sample definition located in a JSON registry (or read-only catalog). */
export interface ResolvedSampleDefinition {
  scope: 'local' | 'global' | 'catalog';
  folder: string;
  record: SampleRecord;
  /** The catalog file a `catalog` record was read from (#431). */
  file?: string;
}

/**
 * Resolve a `(type, id)` reference to its definition record: local `{Type}.json`
 * first, then the vault-global one, then (for catalog types) the read-only
 * `{Type}_*.json` product catalog. Returns undefined when nothing matches.
 */
export async function resolveSampleDefinition(
  plugin: LabnotePlugin,
  opts: { type: string; id: string; docPath: string }
): Promise<ResolvedSampleDefinition | undefined> {
  const { type, id, docPath } = opts;
  const globalFolder = plugin.settings.globalSampleFolder;
  const localFolder = noteLocalSampleFolder(docPath, globalFolder);

  if (localFolder) {
    const localDb = await loadSamplesByType(plugin.fs, localFolder, type);
    if (localDb[id]) return { scope: 'local', folder: localFolder, record: localDb[id] };
  }

  if (globalFolder) {
    const globalDb = await loadSamplesByType(plugin.fs, globalFolder, type);
    if (globalDb[id]) return { scope: 'global', folder: globalFolder, record: globalDb[id] };
  }

  if (isCatalogSampleType(type)) {
    const fileOf: Record<string, string> = {};
    if (localFolder) {
      const localCat = await loadCatalogSamples(plugin, localFolder, type, fileOf);
      if (localCat[id]) return { scope: 'catalog', folder: localFolder, record: localCat[id], file: fileOf[id] };
    }
    if (globalFolder) {
      const globalCat = await loadCatalogSamples(plugin, globalFolder, type, fileOf);
      if (globalCat[id]) return { scope: 'catalog', folder: globalFolder, record: globalCat[id], file: fileOf[id] };
    }
  }

  return undefined;
}

/**
 * Every registered sample `docPath` can see, as `ID | alias | scope` picker
 * items for the `Open sample definition` command (#121): the note's Local
 * samples then the Global ones, or only the Global ones without a note.
 */
export async function listSampleDefinitions(
  plugin: LabnotePlugin,
  docPath: string | undefined
): Promise<PickItem<{ type: string; id: string; resolved: ResolvedSampleDefinition }>[]> {
  const globalFolder = plugin.settings.globalSampleFolder;
  const local = docPath ? noteLabsamplesFolder(docPath, globalFolder) : undefined;
  const scopes: Array<{ scope: 'local' | 'global'; folder: string }> = [];
  if (local && !isSameSampleFolder(local, globalFolder)) scopes.push({ scope: 'local', folder: local });
  if (globalFolder) scopes.push({ scope: 'global', folder: globalFolder });

  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const items: PickItem<{ type: string; id: string; resolved: ResolvedSampleDefinition }>[] = [];
  for (const { scope, folder } of scopes) {
    for (const type of types) {
      const records = await loadSamplesByType(plugin.fs, folder, type);
      const ids = Object.keys(records).sort((a, b) =>
        compareSamples({ id: a, alias: records[a].alias }, { id: b, alias: records[b].alias })
      );
      for (const [id, record] of ids.map(id => [id, records[id]] as const)) {
        const where = scope === 'local' ? plugin.t('Local {0} sample', type) : plugin.t('Global {0} sample', type);
        items.push({
          label: [id, record.alias ?? '-', where].join(' | '),
          // Searched ahead of the description (#386).
          description: record.location ?? undefined,
          detail: record.descriptions?.[0],
          value: { type, id, resolved: { scope, folder, record } },
        });
      }
    }
  }
  return items;
}

/**
 * Collect the notes that still reference `(type, id)`, scoped to the sample's
 * experiment for a Local sample and to the whole vault for a Global one (its
 * folder is outside any experiment). Prefers the live editor text of an open
 * note so just-typed, unsaved references still count.
 */
async function notesReferencingSample(
  app: App,
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  id: string,
  opts: { maskSampleLists?: boolean } = {}
): Promise<string[]> {
  const { notes: docs } = await notesForSample(app, plugin, { folder, type, id });
  return findSampleUsages(docs, type, id, plugin.settings.customSampleTypes, {
    includeAiCallouts: true,
    sampleListHeaders: opts.maskSampleLists ? sampleListHeaders(plugin) : undefined,
  });
}

/**
 * The notes that use the sample `(type, id)` of `folder`, for "View usages"
 * and the MCP `get_sample` (#130, #131). Like {@link notesReferencingSample},
 * but a Global sample leaves out experiments with a Local record of the same
 * id, since their notes use that one (as {@link rewriteStaleAliases} does).
 * Deleting keeps the stricter check.
 */
async function notesUsingSample(
  app: App,
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  id: string
): Promise<ScopedNote[]> {
  const { notes: docs } = await notesForSample(app, plugin, { folder, type, id });
  const paths = new Set(
    findSampleUsages(docs, type, id, plugin.settings.customSampleTypes, { sampleListHeaders: sampleListHeaders(plugin) })
  );
  const using = docs.filter(doc => paths.has(doc.path));
  if (getExperimentDir(folder)) return using;
  const shadowed = new Map<string, boolean>();
  const used: ScopedNote[] = [];
  for (const doc of using) {
    const local = noteLabsamplesFolder(doc.path, plugin.settings.globalSampleFolder);
    if (!isSameSampleFolder(local, folder)) {
      if (!shadowed.has(local)) {
        shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
      }
      if (shadowed.get(local)) continue;
    }
    used.push(doc);
  }
  return used;
}

/** {@link notesUsingSample} as vault paths. */
export async function sampleUsages(
  app: App,
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  id: string
): Promise<string[]> {
  return (await notesUsingSample(app, plugin, folder, type, id)).map(doc => doc.path);
}

/**
 * Each line of {@link notesUsingSample} that uses the sample, with its section
 * (#291). A note whose reference the line scan misses still gets one spot, at
 * its top, so the list never drops a note the path list has.
 */
export async function sampleUsageSpots(
  app: App,
  plugin: LabnotePlugin,
  folder: string,
  type: string,
  id: string
): Promise<SampleUsageSpot[]> {
  return (await notesUsingSample(app, plugin, folder, type, id)).flatMap(doc => {
    const spots = findSampleUsageSpots([doc], type, id, sampleListHeaders(plugin));
    return spots.length > 0 ? spots : [{ path: doc.path, line: 0, ch: 0, heading: '' }];
  });
}

/** Where in its note a usage is, for the usage list: the section and the 1-based line. */
export function usageSpotLabel(t: LabnotePlugin['t'], spot: SampleUsageSpot): string {
  const line = String(spot.line + 1);
  return spot.heading ? t('{0} · line {1}', spot.heading, line) : t('Line {0}', line);
}

/** A note's text, from its open editor when it has one. */
export interface ScopedNote {
  path: string;
  text: string;
  editor?: Editor;
}

/**
 * The notes a sample in `folder` can be used from: its experiment for a Local
 * folder, the whole vault for the Global one. A note open for editing is read
 * from its editor so just-typed, unsaved text counts. One shown only in
 * reading view is read from the vault: its hidden editor is never saved (#216).
 */
export async function notesInSampleScope(
  app: App,
  folder: string,
  opts: { outsideExperiments?: boolean } = {}
): Promise<ScopedNote[]> {
  const editors = new Map<string, Editor>();
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file && view.getMode() === 'source') {
      editors.set(view.file.path, view.editor);
    }
  }

  const expDir = getExperimentDir(folder);
  const scopePrefix = expDir ? `${expDir}/` : undefined;
  const files = app.vault
    .getMarkdownFiles()
    .filter(
      f => !scopePrefix || f.path.startsWith(scopePrefix) || (opts.outsideExperiments === true && !getExperimentDir(f.path))
    );

  const docs: ScopedNote[] = [];
  for (const f of files) {
    const editor = editors.get(f.path);
    const text = editor ? editor.getValue() : await app.vault.cachedRead(f);
    docs.push({ path: f.path, text, editor });
  }
  return docs;
}

/**
 * The notes that may use sample `(type, id)` of `folder` (see
 * {@link notesInSampleScope}). For a Local sample these include the notes
 * outside every experiment, such as a daily note, whose own registry and the
 * Global one lack the ID, so it can only mean this sample (#423). With
 * `write`, those are `held` instead when another experiment's registry has
 * the same ID (#173): which one they mean is not known, so they are counted
 * but not changed.
 */
async function notesForSample(
  app: App,
  plugin: LabnotePlugin,
  sample: { folder: string; type: string; id: string },
  opts: { write?: boolean } = {}
): Promise<{ notes: ScopedNote[]; held: ScopedNote[] }> {
  const { folder, type, id } = sample;
  if (!getExperimentDir(folder)) return { notes: await notesInSampleScope(app, folder), held: [] };
  const all = await notesInSampleScope(app, folder, { outsideExperiments: true });
  const globalFolder = plugin.settings.globalSampleFolder;
  const holds = new Map<string, boolean>();
  const has = async (registry: string): Promise<boolean> => {
    if (!holds.has(registry)) holds.set(registry, Boolean((await loadSamplesByType(plugin.fs, registry, type))[id]));
    return holds.get(registry)!;
  };
  const inside: ScopedNote[] = [];
  const outside: ScopedNote[] = [];
  for (const doc of all) {
    if (getExperimentDir(doc.path)) inside.push(doc);
    else if (!(await has(noteLabsamplesFolder(doc.path, globalFolder))) && !(globalFolder && (await has(globalFolder)))) {
      outside.push(doc);
    }
  }
  if (outside.length > 0 && opts.write && (await otherExperimentsWithSample(plugin, folder, type, id)).length > 0) {
    return { notes: inside, held: outside };
  }
  return { notes: [...inside, ...outside], held: [] };
}

/** The sentence for notes {@link notesForSample} held back from a change. */
function heldNotesSentence(plugin: LabnotePlugin, held: number): string {
  return plugin.t(
    'Another experiment has a sample with the same ID, so {0} note(s) outside experiments are left as they are.',
    String(held)
  );
}

/**
 * After an alias edit, offer to replace `oldAlias` in the notes that still
 * show it (#86), or — when there was none — to add the new alias to the
 * references that are the bare id (#170). A Global sample is skipped in experiments that have a Local
 * record with the same id, since their notes resolve to that one. Returns the
 * sentence to add to the "Sample updated" notice, if any.
 */
async function rewriteStaleAliases(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; oldAlias: string; newAlias: string; tablesNote?: string }
): Promise<string | undefined> {
  const { folder, type, id, oldAlias, newAlias } = opts;
  const isGlobal = !getExperimentDir(folder);
  const shadowed = new Map<string, boolean>();
  const planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }> = [];
  const { notes, held } = await notesForSample(app, plugin, { folder, type, id }, { write: true });
  const heldCount = held.filter(
    n => planAliasRewrite(n.text, type, id, oldAlias, newAlias, sampleListHeaders(plugin)).length > 0
  ).length;
  const heldNote = heldCount > 0 ? heldNotesSentence(plugin, heldCount) : '';
  for (const note of notes) {
    const edits = planAliasRewrite(note.text, type, id, oldAlias, newAlias, sampleListHeaders(plugin));
    if (edits.length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, plugin.settings.globalSampleFolder);
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    planned.push({ ...note, edits });
  }
  if (planned.length === 0) return heldNote || undefined;

  const shownMax = 8;
  const lines = planned.slice(0, shownMax).map(n => {
    const defs = n.edits.filter(e => e.kind === 'definition').length;
    return `- ${n.path} (${plugin.t('{0} definition(s), {1} reference(s)', String(defs), String(n.edits.length - defs))})`;
  });
  if (planned.length > shownMax) lines.push(`(+${planned.length - shownMax})`);
  if (opts.tablesNote) lines.push('', opts.tablesNote);
  if (heldNote) lines.push('', heldNote);
  const count = String(planned.length);
  const ok = await confirmModal(
    app,
    !oldAlias
      ? plugin.t("Add the alias '{1}' to the references that show only the ID {2} in {0} note(s)?\n\n{3}", count, newAlias, id, lines.join('\n'))
      : newAlias
        ? plugin.t("Replace the old alias '{1}' with '{2}' in {0} note(s)?\n\n{3}", count, oldAlias, newAlias, lines.join('\n'))
        : plugin.t("Remove the old alias '{1}' from {0} note(s)?\n\n{2}", count, oldAlias, lines.join('\n')),
    plugin.t('Replace'),
    { destructive: true }
  );
  if (!oldAlias && !ok) return undefined;
  if (!ok) {
    const stale = plugin.t('{0} note(s) still show the old alias.', count);
    return planned.some(n => n.edits.some(e => e.kind === 'definition'))
      ? `${stale} ${plugin.t('Saving a note that defines it may bring the old alias back.')}`
      : stale;
  }

  let updated = 0;
  for (const note of planned) {
    if (note.editor) {
      // Re-planned on the live text (the user may have typed meanwhile), as
      // one transaction so a single undo reverts the note.
      const editor = note.editor;
      const edits = planAliasRewrite(editor.getValue(), type, id, oldAlias, newAlias, sampleListHeaders(plugin));
      if (edits.length === 0) continue;
      editor.transaction({
        changes: edits.map(e => ({
          from: editor.offsetToPos(e.start),
          to: editor.offsetToPos(e.end),
          text: e.text,
        })),
      });
      updated++;
    } else if (
      await processNoteThroughVault(app, plugin.host, note.path, content =>
        applyAliasRewrite(content, planAliasRewrite(content, type, id, oldAlias, newAlias, sampleListHeaders(plugin)))
      )
    ) {
      updated++;
    }
  }
  return plugin.t('{0} note(s) updated.', String(updated));
}

/**
 * Confirm + delete a sample from its `{Type}.json`. Refuses when the body still
 * references the sample (the reference would resurrect a bare record on the next
 * edit); the user must remove it from the note first. Returns false when
 * cancelled or refused.
 */
export async function deleteSampleInteractive(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string }
): Promise<boolean> {
  const { folder, type, id } = opts;

  // A row of a sample list table is no use (#385): the sample can go, with its rows.
  const usages = await notesReferencingSample(app, plugin, folder, type, id, { maskSampleLists: true });
  const listedIn =
    usages.length > 0 ? [] : await notesReferencingSample(app, plugin, folder, type, id);
  if (usages.length > 0) {
    // Full vault paths: notes in different experiments often share a name (#66).
    const shown = usages.slice(0, 3).join(', ');
    const list =
      usages.length > 3 ? plugin.t('{0} (+{1} more)', shown, String(usages.length - 3)) : shown;
    const refused = plugin.t(
      '{0} is still used in notes ({1}). Remove it from the note(s) first, then delete.',
      id,
      list
    );
    const record = (await loadSamplesByType(plugin.fs, folder, type))[id];
    if (!record || record.discarded) {
      new Notice(refused, 8000);
      return false;
    }
    // A used-up sample those notes still name is better kept and marked (#158).
    const discard = await confirmModal(
      app,
      `${refused}

${plugin.t('To keep it for those notes but show it as used up, mark it discarded instead.')}`,
      plugin.t('Mark as discarded')
    );
    if (discard) await setSampleDiscardedInteractive(plugin, { folder, type, id, discarded: true });
    return false;
  }

  const listed =
    listedIn.length === 0
      ? ''
      : plugin.t(
          '{0} is only listed in the sample list tables of notes ({1}). Its rows are removed with it.',
          id,
          listedIn.length > 3
            ? plugin.t('{0} (+{1} more)', listedIn.slice(0, 3).join(', '), String(listedIn.length - 3))
            : listedIn.join(', ')
        );
  const heldListed =
    listedIn.length === 0
      ? 0
      : (await notesForSample(app, plugin, opts, { write: true })).held.filter(n => listedIn.includes(n.path)).length;
  // Similar samples differ by these, not by their long IDs (#391).
  const record = (await loadSamplesByType(plugin.fs, folder, type))[id];
  const scope = isSameSampleFolder(folder, plugin.settings.globalSampleFolder) ? plugin.t('Global') : plugin.t('Local');
  const facts = [
    [plugin.t('Alias'), record?.alias],
    [plugin.t('Description'), record?.descriptions?.[0]],
    [plugin.t('Location'), record?.location],
    [plugin.t('Scope'), scope],
    [plugin.t('Discarded'), record?.discarded],
  ]
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const ok = await confirmModal(
    app,
    [
      plugin.t('Are you sure you want to delete {0}?', id),
      facts,
      listed,
      heldListed > 0 ? heldNotesSentence(plugin, heldListed) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    plugin.t('Delete'),
    { destructive: true }
  );
  if (!ok) return false;

  // Rows go first: they are read against the record still in the registry.
  if (listedIn.length > 0) await removeSampleListRows(app, plugin, { folder, type, id });
  await deleteSampleRecord(plugin.fs, folder, type, id);
  plugin.refreshSampleViews();
  new Notice(plugin.t('Sample deleted: {0}', buildSampleReferenceText(id, record?.alias)));
  return true;
}

/**
 * Delete the rows of sample `(type, id)` of `folder` from the sample list
 * tables of its notes (#385), as {@link updateSampleListTables} goes through
 * them: a Global sample is skipped in experiments with a Local record of the
 * same id. Returns how many notes changed.
 */
async function removeSampleListRows(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string }
): Promise<number> {
  const { folder, type, id } = opts;
  const headers = sampleListHeaders(plugin);
  const isGlobal = isSameSampleFolder(folder, plugin.settings.globalSampleFolder);
  const shadowed = new Map<string, boolean>();
  const apply = (content: string): string =>
    planSampleListRowRemoval(content, headers, id).reduceRight(
      (out, e) => out.slice(0, e.start) + e.text + out.slice(e.end),
      content
    );
  let removed = 0;
  const { notes } = await notesForSample(app, plugin, opts, { write: true });
  for (const note of notes) {
    if (planSampleListRowRemoval(note.text, headers, id).length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, plugin.settings.globalSampleFolder);
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    if (note.editor) {
      const editor = note.editor;
      const edits = planSampleListRowRemoval(editor.getValue(), headers, id);
      if (edits.length === 0) continue;
      editor.transaction({
        changes: edits.map(e => ({ from: editor.offsetToPos(e.start), to: editor.offsetToPos(e.end), text: e.text })),
      });
      removed++;
    } else if (await processNoteThroughVault(app, plugin.host, note.path, apply)) {
      removed++;
    }
  }
  return removed;
}

/**
 * The notes in `folder`'s scope that `plan` would change. A Global sample is
 * skipped in experiments with a Local record of the same id, since their notes
 * resolve to that one.
 */
async function planNotesInScope(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string },
  plan: (text: string) => AliasRewriteEdit[]
): Promise<{ planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }>; held: number }> {
  const { folder, type, id } = opts;
  const isGlobal = !getExperimentDir(folder);
  const shadowed = new Map<string, boolean>();
  const planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }> = [];
  const { notes, held } = await notesForSample(app, plugin, opts, { write: true });
  for (const note of notes) {
    const edits = plan(note.text);
    if (edits.length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, plugin.settings.globalSampleFolder);
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    planned.push({ ...note, edits });
  }
  return { planned, held: held.filter(n => plan(n.text).length > 0).length };
}

/**
 * Change a sample's type (#116): pick the new type, give the record the same
 * numbers under the new prefix (a new id when that one is taken), and rewrite
 * the notes that use it. One confirmation covers both, and declining changes
 * nothing: a note left with the old id would bring the old record back the
 * next time it is saved. Returns false when cancelled.
 */
export async function changeSampleTypeInteractive(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string }
): Promise<boolean> {
  const { folder, type, id } = opts;
  const record = (await loadSamplesByType(plugin.fs, folder, type))[id];
  if (!record) {
    new Notice(plugin.t('Sample not found: {0}', id));
    return false;
  }
  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types.filter(t => t !== type);
  const newType = await pickModal(
    app,
    types.map(t => ({ label: t, value: t })),
    { title: plugin.t('Change the type of {0}', id), placeholder: plugin.t('Pick the new type') }
  );
  if (newType === undefined) return false;

  const globalFolder = plugin.settings.globalSampleFolder;
  const taken = async (candidate: string): Promise<boolean> => {
    for (const f of [folder, globalFolder]) {
      if (f && (await loadSamplesByType(plugin.fs, f, newType))[candidate]) return true;
    }
    return false;
  };
  let newId = sampleIdForType(type, id, newType) ?? generateSampleId(newType);
  while (await taken(newId)) newId = generateSampleId(newType);

  const plan = (text: string): AliasRewriteEdit[] => planSampleIdRewrite(text, type, id, newType, newId);
  const { planned, held } = await planNotesInScope(app, plugin, opts, plan);
  const shownMax = 8;
  const lines = planned.slice(0, shownMax).map(n => {
    const defs = n.edits.filter(e => e.kind === 'definition').length;
    return `- ${n.path} (${plugin.t('{0} definition(s), {1} reference(s)', String(defs), String(n.edits.length - defs))})`;
  });
  if (planned.length > shownMax) lines.push(`(+${planned.length - shownMax})`);
  let message = plugin.t('Change {0} to {1}? Its record moves from {2}.json to {3}.json.', id, newId, type, newType);
  // The new type may already have a sample of this alias (#403).
  const twins = record.alias ? await samplesWithAliasIn(plugin.fs, folder, newType, record.alias) : [];
  if (twins.length > 0) {
    message += `\n\n${plugin.t('{0} samples already have the alias {1} ({2}).', newType, record.alias!, twins.join(', '))}`;
  }
  if (planned.length > 0) {
    message += `\n\n${plugin.t('The notes that use it change too ({0}):', String(planned.length))}\n${lines.join('\n')}`;
  }
  if (held > 0) message += `\n\n${heldNotesSentence(plugin, held)}`;
  if (!(await confirmModal(app, message, plugin.t('Change type')))) return false;

  await putSampleRecord(plugin.fs, folder, newType, newId, { ...record, type: newType });
  await deleteSampleRecord(plugin.fs, folder, type, id);
  let updated = 0;
  for (const note of planned) {
    if (note.editor) {
      // Re-planned on the live text, as one transaction so one undo reverts the note.
      const editor = note.editor;
      const edits = plan(editor.getValue());
      if (edits.length === 0) continue;
      editor.transaction({
        changes: edits.map(e => ({ from: editor.offsetToPos(e.start), to: editor.offsetToPos(e.end), text: e.text })),
      });
      updated++;
    } else if (await processNoteThroughVault(app, plugin.host, note.path, content => applyAliasRewrite(content, plan(content)))) {
      updated++;
    }
  }
  plugin.refreshSampleViews();
  const done = plugin.t('Changed {0} to {1}.', id, newId);
  // Ctrl+Z reverts a note but not the record, leaving the old id unregistered (#151).
  const undo = plugin.t('Ctrl+Z only reverts the note, not the sample record. To undo, change the type again.');
  new Notice(
    planned.length > 0 ? `${done} ${plugin.t('{0} note(s) updated.', String(updated))} ${undo}` : done,
    planned.length > 0 ? 10000 : undefined
  );
  return true;
}

/**
 * Move a sample record between the Local and Global scopes, preserving it
 * verbatim (all descriptions/sources). Writes the destination first, then
 * deletes the source, so a mid-way failure leaves a recoverable duplicate
 * rather than losing data. Returns false when nothing was moved (cancelled,
 * missing record, or same folder). Returns undefined never — always resolves.
 *
 * The source/target folders are passed in by the caller (the Samples sidebar
 * hands over exactly the folders its tree is currently showing) rather than
 * re-derived here from the active file. Deriving them again would let a change
 * of the active note between render and click send the sample into a different
 * experiment than the one the user is looking at.
 */
export async function moveSampleInteractive(
  app: App,
  plugin: LabnotePlugin,
  opts: { fromScope: SampleScope; fromFolder: string; toFolder: string; type: string; id: string }
): Promise<boolean> {
  const { fromScope, fromFolder: src, toFolder: tgt, type, id } = opts;

  // Empty-folder guard: an unresolved scope (no experiment rendered yet) yields
  // '' which would normalize to the vault root. Refuse rather than read/write
  // sample JSON at the root.
  if (!src || !tgt) {
    new Notice(plugin.t('Open an experiment note first to move samples.'));
    return false;
  }

  // Same-folder guard (e.g. no experiment open so Local === Global): moving
  // would delete then re-create in place, or worse, silently no-op.
  if (isSameSampleFolder(src, tgt)) {
    new Notice(
      plugin.t('The open note is outside an experiment. Open a note of the experiment to move it to, then try again.')
    );
    return false;
  }

  const srcDb = await loadSamplesByType(plugin.fs, src, type);
  const record = srcDb[id];
  if (!record) {
    new Notice(plugin.t('Sample not found: {0}', id));
    return false;
  }

  // A Global sample may be used anywhere; notes that resolve their samples
  // from another folder lose it once it is Local to one experiment (#78).
  if (fromScope === 'global') {
    const outside = (await notesReferencingSample(app, plugin, src, type, id, { maskSampleLists: true })).filter(
      p => !isSameSampleFolder(noteLabsamplesFolder(p, plugin.settings.globalSampleFolder), tgt)
    );
    if (outside.length > 0) {
      const shown = outside.slice(0, 3).join(', ');
      const list =
        outside.length > 3 ? plugin.t('{0} (+{1} more)', shown, String(outside.length - 3)) : shown;
      const ok = await confirmModal(
        app,
        plugin.t(
          '{0} is used in notes outside this experiment ({1}). Those notes will no longer find it after the move. Move anyway?',
          id,
          list
        ),
        plugin.t('Move anyway'),
        { destructive: true }
      );
      if (!ok) return false;
    }
  }

  // Confirm before clobbering a record that already exists in the destination.
  const tgtDb = await loadSamplesByType(plugin.fs, tgt, type);
  if (tgtDb[id]) {
    const ok = await confirmModal(
      app,
      plugin.t('{0} already exists in the destination. Overwrite it?', id),
      plugin.t('Overwrite'),
      { destructive: true }
    );
    if (!ok) return false;
  }

  // Two samples with one alias show the same text in autocomplete (#299). Asked, not refused.
  const twins = record.alias ? (await samplesWithAliasIn(plugin.fs, tgt, type, record.alias)).filter(other => other !== id) : [];
  if (twins.length > 0) {
    const toGlobal = isSameSampleFolder(tgt, plugin.settings.globalSampleFolder);
    const ok = await confirmModal(
      app,
      `${plugin.t(
        toGlobal ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
        record.alias!,
        twins.join(', ')
      )} ${plugin.t('Move {0} there anyway?', id)}`,
      plugin.t('Move anyway')
    );
    if (!ok) return false;
  }

  await putSampleRecord(plugin.fs, tgt, type, id, record);
  await deleteSampleRecord(plugin.fs, src, type, id);
  plugin.refreshSampleViews();
  // The experiment's tables list it with the other scope now.
  const experiment = getExperimentDir(tgt) ? tgt : src;
  const tables = await updateSampleListTables(app, plugin, { folder: tgt, type, id, notesOf: experiment });
  new Notice(
    [
      plugin.t('Sample moved: {0}', id),
      tables > 0 ? plugin.t('Updated the sample list table in {0} note(s).', String(tables)) : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
  return true;
}
