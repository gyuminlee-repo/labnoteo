/**
 * Sample autocomplete for the Obsidian editor.
 *
 * A thin `EditorSuggest` adapter over the pure core helpers
 * ({@link parseSampleTrigger}, {@link buildSampleCompletionEntries}). All
 * matching/formatting is tested in `@labnoteo/core`; this file only bridges
 * Obsidian's suggest lifecycle and loads records from the vault.
 */
import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
} from 'obsidian';
import {
  parseSampleTrigger,
  buildSampleCompletionEntries,
  type SampleCandidate,
  type SampleCompletionEntry,
  type LabnoteFs,
} from '@labnoteo/core';
import {
  getSampleDisplayMeta,
  isCatalogSampleType,
  sampleSuggestActions,
} from '@labnoteo/core/lib/sampleUtils';
import {
  loadSamplesByType,
  getLabsamplesFolder,
  hasReferenceCatalog,
  isSameSampleFolder,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentLabsamplesFolder } from '@labnoteo/core/lib/labnoteStructure';
import type LabnotePlugin from './main';
import { createSampleInteractive, pickCatalogReference } from './sampleActions';

/**
 * A rendered suggestion: either an existing sample reference, or a synthetic
 * "create"/"search" action. Registry-first: create/catalog insert a *reference*
 * (`id;alias`) into the document while the definition lives in JSON.
 */
type SuggestEntry =
  | { kind: 'existing'; entry: SampleCompletionEntry }
  | { kind: 'generate' | 'manual' | 'catalog'; type: string };

export interface SampleSuggestDeps {
  fs: LabnoteFs;
  /** Live getter for user-defined extra sample types. */
  customTypes: () => string[];
  /** Live getter for the vault-global labsamples folder (vault-relative). */
  globalFolder: () => string;
  /** Owning plugin (for translator, app, and interactive sample creation). */
  plugin: LabnotePlugin;
}

export class SampleEditorSuggest extends EditorSuggest<SuggestEntry> {
  /** Short-lived per-(folder,type) record cache. Autocomplete fires on every
   *  keystroke; without this each one re-read every `{Type}.json` from disk. */
  private readonly recordCache = new Map<
    string,
    { records: Record<string, SampleRecord>; expiry: number }
  >();
  private readonly catalogCache = new Map<string, { exists: boolean; expiry: number }>();
  private static readonly CACHE_TTL_MS = 1500;

  constructor(app: App, private readonly deps: SampleSuggestDeps) {
    super(app);
  }

  private get types(): string[] {
    return getSampleDisplayMeta(this.deps.customTypes()).types;
  }

  /** Load `{type}.json` from `folder`, memoised for a short TTL. */
  private async loadCached(
    folder: string,
    type: string
  ): Promise<Record<string, SampleRecord>> {
    const key = `${folder}\u0000${type}`;
    const now = Date.now();
    const hit = this.recordCache.get(key);
    if (hit && hit.expiry > now) return hit.records;
    const records = await loadSamplesByType(this.deps.fs, folder, type);
    this.recordCache.set(key, {
      records,
      expiry: now + SampleEditorSuggest.CACHE_TTL_MS,
    });
    return records;
  }

  /**
   * Whether a `{type}_*.json` catalog exists for the note, in the same folders
   * "Search catalog" reads ({@link pickCatalogReference}), memoised like the
   * records. Without one the action is left out (#99).
   */
  private async catalogExists(docPath: string, type: string): Promise<boolean> {
    const localFolder = getExperimentLabsamplesFolder(docPath) ?? getLabsamplesFolder(docPath);
    const globalFolder = this.deps.globalFolder();
    const key = `${localFolder}\u0000${globalFolder}\u0000${type}`;
    const now = Date.now();
    const hit = this.catalogCache.get(key);
    if (hit && hit.expiry > now) return hit.exists;
    const exists =
      (await hasReferenceCatalog(this.deps.fs, localFolder, type)) ||
      (Boolean(globalFolder) && (await hasReferenceCatalog(this.deps.fs, globalFolder, type)));
    this.catalogCache.set(key, { exists, expiry: now + SampleEditorSuggest.CACHE_TTL_MS });
    return exists;
  }

  /** Drop cached records so the next trigger re-reads from disk. Called after a
   *  sample-sync write so freshly-defined samples appear immediately. */
  clearCache(): void {
    this.recordCache.clear();
    this.catalogCache.clear();
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor
  ): EditorSuggestTriggerInfo | null {
    const linePrefix = editor.getLine(cursor.line).slice(0, cursor.ch);
    const trigger = parseSampleTrigger(linePrefix, this.types);
    if (!trigger) return null;
    return {
      start: { line: cursor.line, ch: trigger.startCol },
      end: cursor,
      query: linePrefix.slice(trigger.startCol),
    };
  }

  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestEntry[]> {
    const trigger = parseSampleTrigger(context.query, this.types);
    if (!trigger) return [];

    const localFolder = this.deps.plugin.localSampleFolder();
    const globalFolder = this.deps.globalFolder();

    const recordsByType: Record<string, SampleCandidate[]> = {};
    // A vault-root note's local folder is the global one: read it once.
    const readGlobal = Boolean(globalFolder) && !isSameSampleFolder(localFolder, globalFolder);
    for (const type of trigger.typesToSearch) {
      const local = await this.loadCached(localFolder, type);
      const global = readGlobal ? await this.loadCached(globalFolder, type) : {};
      // Local definitions win over global on id collision.
      const merged = { ...global, ...local };
      recordsByType[type] = Object.entries(merged).map(([id, rec]) => ({
        id,
        alias: rec.alias,
        description: rec.descriptions?.[0],
      }));
    }

    const existing: SuggestEntry[] = buildSampleCompletionEntries(
      trigger,
      recordsByType
    ).map(entry => ({ kind: 'existing', entry }));

    // Append synthetic create actions for a concrete type (never for @sample);
    // this also guarantees a non-empty list so the popup shows even with no
    // existing samples — the root cause of "autocomplete does nothing".
    const actions: SuggestEntry[] = [];
    if (trigger.typesToSearch.length === 1) {
      const type = trigger.typesToSearch[0];
      const catalogAvailable = isCatalogSampleType(type)
        ? await this.catalogExists(context.file.path, type)
        : false;
      const flags = sampleSuggestActions(trigger, { catalogAvailable });
      // A curated product is the preferred pick for catalog types, so it leads.
      if (flags.catalog) actions.push({ kind: 'catalog', type });
      if (flags.generate) actions.push({ kind: 'generate', type });
      if (flags.manual) actions.push({ kind: 'manual', type });
    }

    return [...existing, ...actions];
  }

  renderSuggestion(item: SuggestEntry, el: HTMLElement): void {
    const t = this.deps.plugin.t;
    if (item.kind === 'existing') {
      el.createEl('div', { text: item.entry.label });
      el.createEl('small', {
        text: `${item.entry.type} Sample`,
        cls: 'labnote-suggest-detail',
      });
      return;
    }
    if (item.kind === 'generate') {
      el.createEl('div', { text: t('Generate new {0} ID', item.type) });
      el.createEl('small', {
        text: t('Automatically generate a new sample ID'),
        cls: 'labnote-suggest-detail',
      });
      return;
    }
    if (item.kind === 'catalog') {
      el.createEl('div', { text: t('Search {0} catalog', item.type) });
      el.createEl('small', {
        text: t('Insert a reference from the product catalog'),
        cls: 'labnote-suggest-detail',
      });
      return;
    }
    el.createEl('div', { text: t('Enter info') });
    el.createEl('small', {
      text: t('Manually enter sample ID, alias, and description'),
      cls: 'labnote-suggest-detail',
    });
  }

  selectSuggestion(item: SuggestEntry): void {
    const ctx = this.context;
    if (!ctx) return;
    // Capture positions/editor/file BEFORE close() invalidates this.context.
    const editor = ctx.editor;
    const start = ctx.start;
    const end = ctx.end;
    const filePath = ctx.file.path;
    // Snapshot the trigger text so the async flow below can detect if the
    // document changed under it before inserting.
    const originalRange = editor.getRange(start, end);

    if (item.kind === 'existing') {
      editor.replaceRange(item.entry.insertText, start, end);
      editor.setCursor({
        line: start.line,
        ch: start.ch + item.entry.insertText.length,
      });
      this.close();
      return;
    }

    // Create/catalog flow: close first, then run the interactive modals, then
    // insert a *reference* (registry-first: the definition lives in JSON) at the
    // captured range.
    this.close();
    const { plugin } = this.deps;
    const type = item.type;
    const kind = item.kind;
    void (async () => {
      let referenceText: string | undefined;
      if (kind === 'catalog') {
        referenceText = await pickCatalogReference(plugin.app, plugin, {
          type,
          docPath: filePath,
        });
      } else {
        const created = await createSampleInteractive(plugin.app, plugin, {
          type,
          folder: plugin.localSampleFolder(),
          mode: kind,
          scope: 'local',
        });
        referenceText = created?.referenceText;
      }
      if (!referenceText) return;
      // The modal was async: the user may have switched notes or edited the
      // trigger text. Only insert if the same file is active AND the captured
      // range still holds the original trigger, otherwise we'd corrupt an
      // unrelated position.
      const activeFile = plugin.app.workspace.getActiveFile();
      if (!activeFile || activeFile.path !== filePath) return;
      if (editor.getRange(start, end) !== originalRange) return;
      editor.replaceRange(referenceText, start, end);
      editor.setCursor({
        line: start.line,
        ch: start.ch + referenceText.length,
      });
    })();
  }
}
