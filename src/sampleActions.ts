/**
 * Shared, interactive sample create/edit/delete actions for the Obsidian
 * plugin. Used by both the editor autocomplete "create" flow
 * ([sampleSuggest.ts](./sampleSuggest.ts)) and the Samples sidebar context menu
 * ([views/sampleView.ts](./views/sampleView.ts)).
 *
 * Pure formatting/ID logic lives in `@labnoteo/core`; this module only wires
 * the modals, persists JSON via the vault fs, and surfaces notices.
 */
import { App, MarkdownView, Notice } from 'obsidian';
import { planReferenceInsert, type EditTarget, type PickItem } from '@labnoteo/core';
import {
  generateSampleId,
  normalizeSampleId,
  buildSampleDefinitionText,
  buildSampleReferenceText,
  isCatalogSampleType,
  getSampleDisplayMeta,
} from '@labnoteo/core/lib/sampleUtils';
import {
  loadSamplesByType,
  loadReferenceSamplesByType,
  upsertSampleRecord,
  deleteSampleRecord,
  putSampleRecord,
  getLabsamplesFolder,
  findSampleDefinitionMatch,
  findSampleUsages,
  isSameSampleFolder,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import {
  getExperimentDir,
  getExperimentLabsamplesFolder,
} from '@labnoteo/core/lib/labnoteStructure';
import type LabnotePlugin from './main';
import { promptModal, confirmModal, pickModal } from './modals';

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
 * Insert a sample reference (`id;alias` / bare `id`) into `target` at the place
 * {@link planReferenceInsert} chooses: appended below the last section when the
 * cursor sits in the front matter or above the title, at the end of the line
 * when the cursor is on an existing reference or heading, otherwise at the
 * cursor (padded so it never fuses with a neighbour). Reveals the spot and marks
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
  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const plan = planReferenceInsert(text, cursor, ref, types);
  await target.replaceRange(plan.offset, plan.offset, plan.text);
  await target.revealOffset?.(plan.offset + plan.text.length);
  plugin.markUserEdit(target.path);
}

export interface CreatedSample {
  id: string;
  alias: string | null;
  description: string | null;
  /** `@type;id;alias;desc` — optional, for the "insert definition" action. */
  definitionText: string;
  /** `id;alias` (or bare `id`) — the registry-first document insert form. */
  referenceText: string;
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
  opts: { type: string; folder: string; mode: 'generate' | 'manual'; scope?: SampleScope }
): Promise<CreatedSample | undefined> {
  const { type, folder, mode } = opts;

  let id: string;
  if (mode === 'generate') {
    id = generateSampleId(type);
  } else {
    const entered = await promptModal(app, {
      title: plugin.t('Enter the {0} sample ID', type),
      value: `${type}-`,
      placeholder: plugin.t('e.g. {0}-12345', type),
      validate: v =>
        normalizeSampleId(type, v) ? null : plugin.t('Invalid ID. Expected {0}-<number>.', type),
    });
    if (entered === undefined) return undefined;
    id = normalizeSampleId(type, entered) ?? entered.trim();
  }

  const aliasRaw = await promptModal(app, {
    title: plugin.t('Enter an alias for the new {0} sample (optional)', type),
    placeholder: plugin.t('e.g. Sample-A'),
  });
  if (aliasRaw === undefined) return undefined;
  const descRaw = await promptModal(app, {
    title: plugin.t('Enter a description (optional)'),
    placeholder: plugin.t('e.g. Sample used in experiment 1'),
  });
  if (descRaw === undefined) return undefined;
  const locationRaw = await promptModal(app, {
    title: plugin.t('Enter a storage location (optional)'),
    placeholder: plugin.t('e.g. Freezer-2 / Box-3 / A1'),
  });
  if (locationRaw === undefined) return undefined;
  const alias = clean(aliasRaw);
  const description = clean(descRaw);
  const location = clean(locationRaw);

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
 * Search the read-only product catalog (`{Type}_*.json`) for a catalog type
 * (Reagent/Labware/Equip) and return the chosen entry's reference text
 * (`id;alias`). Merges the document's local catalog with the vault-global one
 * (local wins). When no catalog exists, guides the user and falls back to
 * registering a sample with a generated id, as the sample view does (returning
 * its reference).
 */
export async function pickCatalogReference(
  app: App,
  plugin: LabnotePlugin,
  opts: { type: string; docPath: string }
): Promise<string | undefined> {
  const { type, docPath } = opts;
  const localFolder = getExperimentLabsamplesFolder(docPath) ?? getLabsamplesFolder(docPath);
  const globalFolder = plugin.settings.globalSampleFolder;

  const local = await loadReferenceSamplesByType(plugin.fs, localFolder, type);
  const global = globalFolder
    ? await loadReferenceSamplesByType(plugin.fs, globalFolder, type)
    : {};
  const merged: Record<string, SampleRecord> = { ...global, ...local };

  const items: PickItem<string>[] = Object.entries(merged).map(([id, rec]) => ({
    label: rec.alias ? `${id} — ${rec.alias}` : id,
    value: id,
    description: rec.descriptions?.[0],
  }));

  if (items.length === 0) {
    new Notice(
      plugin.t('No {0} catalog found. Add resources/labsamples/{0}_*.json.', type)
    );
    // Fallback: register a custom sample with a generated id, then reference it.
    const created = await createSampleInteractive(app, plugin, {
      type,
      folder: localFolder,
      mode: 'generate',
      scope: 'local',
    });
    return created?.referenceText;
  }

  const chosen = await pickModal(app, items, {
    title: plugin.t('Search {0} catalog', type),
    placeholder: plugin.t('Search catalog'),
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
  });
  if (aliasRaw === undefined) return false;
  const descRaw = await promptModal(app, {
    title: plugin.t('Enter a new description'),
    value: record.descriptions?.[0] ?? '',
    placeholder: plugin.t('e.g. Sample used in experiment 1'),
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
  if (target) {
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

  new Notice(plugin.t('Sample updated: {0}', id));
  return true;
}

/** A sample definition located in a JSON registry (or read-only catalog). */
export interface ResolvedSampleDefinition {
  scope: 'local' | 'global' | 'catalog';
  folder: string;
  record: SampleRecord;
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
  const localFolder = getExperimentLabsamplesFolder(docPath) ?? getLabsamplesFolder(docPath);
  const globalFolder = plugin.settings.globalSampleFolder;

  const localDb = await loadSamplesByType(plugin.fs, localFolder, type);
  if (localDb[id]) return { scope: 'local', folder: localFolder, record: localDb[id] };

  if (globalFolder) {
    const globalDb = await loadSamplesByType(plugin.fs, globalFolder, type);
    if (globalDb[id]) return { scope: 'global', folder: globalFolder, record: globalDb[id] };
  }

  if (isCatalogSampleType(type)) {
    const localCat = await loadReferenceSamplesByType(plugin.fs, localFolder, type);
    if (localCat[id]) return { scope: 'catalog', folder: localFolder, record: localCat[id] };
    if (globalFolder) {
      const globalCat = await loadReferenceSamplesByType(plugin.fs, globalFolder, type);
      if (globalCat[id]) return { scope: 'catalog', folder: globalFolder, record: globalCat[id] };
    }
  }

  return undefined;
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
  id: string
): Promise<string[]> {
  const openText = new Map<string, string>();
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file) {
      openText.set(view.file.path, view.editor.getValue());
    }
  }

  const expDir = getExperimentDir(folder);
  const scopePrefix = expDir ? `${expDir}/` : undefined;
  const files = app.vault
    .getMarkdownFiles()
    .filter(f => !scopePrefix || f.path.startsWith(scopePrefix));

  const docs: Array<{ path: string; text: string }> = [];
  for (const f of files) {
    const text = openText.get(f.path) ?? (await app.vault.cachedRead(f));
    docs.push({ path: f.path, text });
  }
  return findSampleUsages(docs, type, id, plugin.settings.customSampleTypes);
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

  const usages = await notesReferencingSample(app, plugin, folder, type, id);
  if (usages.length > 0) {
    // Full vault paths: notes in different experiments often share a name (#66).
    const shown = usages.slice(0, 3).join(', ');
    const list =
      usages.length > 3 ? plugin.t('{0} (+{1} more)', shown, String(usages.length - 3)) : shown;
    new Notice(
      plugin.t(
        '{0} is still used in notes ({1}). Remove it from the note(s) first, then delete.',
        id,
        list
      ),
      8000
    );
    return false;
  }

  const ok = await confirmModal(
    app,
    plugin.t('Are you sure you want to delete {0}?', id),
    plugin.t('Delete')
  );
  if (!ok) return false;

  await deleteSampleRecord(plugin.fs, folder, type, id);
  plugin.refreshSampleViews();
  new Notice(plugin.t('Sample deleted: {0}', id));
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
  const { fromFolder: src, toFolder: tgt, type, id } = opts;

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
    new Notice(plugin.t('Local and Global folders are the same.'));
    return false;
  }

  const srcDb = await loadSamplesByType(plugin.fs, src, type);
  const record = srcDb[id];
  if (!record) {
    new Notice(plugin.t('Sample not found: {0}', id));
    return false;
  }

  // Confirm before clobbering a record that already exists in the destination.
  const tgtDb = await loadSamplesByType(plugin.fs, tgt, type);
  if (tgtDb[id]) {
    const ok = await confirmModal(
      app,
      plugin.t('{0} already exists in the destination. Overwrite it?', id),
      plugin.t('Overwrite')
    );
    if (!ok) return false;
  }

  await putSampleRecord(plugin.fs, tgt, type, id, record);
  await deleteSampleRecord(plugin.fs, src, type, id);
  plugin.refreshSampleViews();
  new Notice(plugin.t('Sample moved: {0}', id));
  return true;
}
