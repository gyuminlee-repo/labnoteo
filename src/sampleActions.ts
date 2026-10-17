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
import { planReferenceInsert, type EditTarget, type PickItem } from '@labnoteo/core';
import {
  generateSampleId,
  normalizeSampleId,
  buildSampleDefinitionText,
  buildSampleReferenceText,
  isCatalogSampleType,
  getSampleDisplayMeta,
  hasSampleAliasSeparator,
  hasSampleDescriptionSeparator,
} from '@labnoteo/core/lib/sampleUtils';
import {
  loadSamplesByType,
  loadReferenceSamplesByType,
  upsertSampleRecord,
  mergeSampleRecord,
  deleteSampleRecord,
  putSampleRecord,
  getLabsamplesFolder,
  findSampleDefinitionMatch,
  findSampleUsages,
  isSameSampleFolder,
  planAliasRewrite,
  applyAliasRewrite,
  type AliasRewriteEdit,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import {
  getExperimentDir,
  getExperimentLabsamplesFolder,
} from '@labnoteo/core/lib/labnoteStructure';
import type LabnotePlugin from './main';
import { processNoteThroughVault } from './commands';
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

/** Block the characters that would split the alias in a note (#98). */
function validateAlias(plugin: LabnotePlugin): (value: string) => string | null {
  return v =>
    hasSampleAliasSeparator(v)
      ? plugin.t(
          'An alias cannot contain ";" or ":", which separate the ID, alias and description in a note. Use "-" or "/" instead (e.g. 1-10).'
        )
      : null;
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
  let existing: { folder: string; record: SampleRecord } | undefined;
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
    value: existing?.record.alias ?? '',
    placeholder: plugin.t('e.g. Sample-A'),
    validate: validateAlias(plugin),
  });
  if (aliasRaw === undefined) return undefined;
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
  const alias = clean(aliasRaw);
  const description = clean(descRaw);
  const location = clean(locationRaw);

  if (existing) {
    // A blank field keeps the stored value, as in the note sync (#73); clearing
    // or rewriting one is what "Edit sample" is for.
    await mergeSampleRecord(plugin.fs, existing.folder, type, id, {
      alias: alias ?? undefined,
      description: description ?? undefined,
      location: location ?? undefined,
    });
    plugin.refreshSampleViews();
    new Notice(plugin.t('Sample updated: {0}', id));
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
    validate: validateAlias(plugin),
  });
  if (aliasRaw === undefined) return false;
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

  const oldAlias = record.alias?.trim();
  const rewritten =
    oldAlias && oldAlias !== (alias ?? '')
      ? await rewriteStaleAliases(app, plugin, { folder, type, id, oldAlias, newAlias: alias ?? '' })
      : undefined;
  new Notice([plugin.t('Sample updated: {0}', id), rewritten].filter(Boolean).join(' '), rewritten ? 8000 : undefined);
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
  const docs = await notesInSampleScope(app, folder);
  return findSampleUsages(docs, type, id, plugin.settings.customSampleTypes);
}

/** A note's text, from its open editor when it has one. */
export interface ScopedNote {
  path: string;
  text: string;
  editor?: Editor;
}

/**
 * The notes a sample in `folder` can be used from: its experiment for a Local
 * folder, the whole vault for the Global one. An open note is read from its
 * editor so just-typed, unsaved text counts.
 */
export async function notesInSampleScope(app: App, folder: string): Promise<ScopedNote[]> {
  const editors = new Map<string, Editor>();
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file) {
      editors.set(view.file.path, view.editor);
    }
  }

  const expDir = getExperimentDir(folder);
  const scopePrefix = expDir ? `${expDir}/` : undefined;
  const files = app.vault
    .getMarkdownFiles()
    .filter(f => !scopePrefix || f.path.startsWith(scopePrefix));

  const docs: ScopedNote[] = [];
  for (const f of files) {
    const editor = editors.get(f.path);
    const text = editor ? editor.getValue() : await app.vault.cachedRead(f);
    docs.push({ path: f.path, text, editor });
  }
  return docs;
}

/**
 * After an alias edit, offer to replace `oldAlias` in the notes that still
 * show it (#86). A Global sample is skipped in experiments that have a Local
 * record with the same id, since their notes resolve to that one. Returns the
 * sentence to add to the "Sample updated" notice, if any.
 */
async function rewriteStaleAliases(
  app: App,
  plugin: LabnotePlugin,
  opts: { folder: string; type: string; id: string; oldAlias: string; newAlias: string }
): Promise<string | undefined> {
  const { folder, type, id, oldAlias, newAlias } = opts;
  const isGlobal = !getExperimentDir(folder);
  const shadowed = new Map<string, boolean>();
  const planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }> = [];
  for (const note of await notesInSampleScope(app, folder)) {
    const edits = planAliasRewrite(note.text, type, id, oldAlias, newAlias);
    if (edits.length === 0) continue;
    if (isGlobal) {
      const local = getExperimentLabsamplesFolder(note.path) ?? getLabsamplesFolder(note.path);
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(plugin.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    planned.push({ ...note, edits });
  }
  if (planned.length === 0) return undefined;

  const shownMax = 8;
  const lines = planned.slice(0, shownMax).map(n => {
    const defs = n.edits.filter(e => e.kind === 'definition').length;
    return `- ${n.path} (${plugin.t('{0} definition(s), {1} reference(s)', String(defs), String(n.edits.length - defs))})`;
  });
  if (planned.length > shownMax) lines.push(`(+${planned.length - shownMax})`);
  const count = String(planned.length);
  const ok = await confirmModal(
    app,
    newAlias
      ? plugin.t("Replace the old alias '{1}' with '{2}' in {0} note(s)?\n\n{3}", count, oldAlias, newAlias, lines.join('\n'))
      : plugin.t("Remove the old alias '{1}' from {0} note(s)?\n\n{2}", count, oldAlias, lines.join('\n')),
    plugin.t('Replace')
  );
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
      const edits = planAliasRewrite(editor.getValue(), type, id, oldAlias, newAlias);
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
        applyAliasRewrite(content, planAliasRewrite(content, type, id, oldAlias, newAlias))
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
    new Notice(plugin.t('Local and Global folders are the same.'));
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
    const outside = (await notesReferencingSample(app, plugin, src, type, id)).filter(
      p => !isSameSampleFolder(getExperimentLabsamplesFolder(p) ?? getLabsamplesFolder(p), tgt)
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
        plugin.t('Move anyway')
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
