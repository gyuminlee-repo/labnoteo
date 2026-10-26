/**
 * Plugin settings shape + defaults.
 *
 * Mirrors the companion VS Code extension's configuration where it makes sense
 * (`sampleTracking`, `customSampleTypes`) and adds the LLM provider settings
 * that the Obsidian build introduces (VS Code delegates LLM to Copilot Chat,
 * Obsidian talks to Ollama/OpenAI directly).
 */
import type { ExperimentGrouping, PartbankConnection, Translator } from '@labnoteo/core';
import type { InvalidFolderReason } from '@labnoteo/core/lib/regexUtils';
import {
  isValidSampleTypeName,
  SAMPLE_TYPES,
  suggestSampleTypeName,
  underscoreTurnsItalic,
} from '@labnoteo/core/lib/sampleUtils';
export type LlmProviderKind = 'none' | 'ollama' | 'openai';

/**
 * Bumped whenever the persisted shape changes so {@link migrateSettings} can
 * upgrade older `data.json` files instead of silently `Object.assign`-ing an
 * incompatible blob onto the defaults.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface LabnoteSettings {
  /** Persisted-shape version (see {@link CURRENT_SCHEMA_VERSION}). */
  schemaVersion: number;
  /** Show the Samples sidebar view. */
  sampleTracking: boolean;
  /** Auto-reorder a workflow note's unit-op TOC to match heading order on edit. */
  autoSyncUnitOpToc: boolean;
  /** Set a lab note's front matter `last_updated_date` to today when it is edited. */
  autoUpdateLastUpdated: boolean;
  /** Extra sample types beyond the built-ins (DNA, RNA, …). */
  customSampleTypes: string[];
  /** Folder (vault-relative) that holds vault-global sample storage. */
  globalSampleFolder: string;
  /** What the workflow view groups experiments by (#204). */
  workflowViewGroupBy: ExperimentGrouping;
  /** Bundled-catalog hash the "Update catalogs" startup notice last checked; '' until then. */
  catalogNoticeHash: string;

  // --- LLM ---
  llmProvider: LlmProviderKind;
  /**
   * Base URL per provider. Split from the old single `llmEndpoint` so switching
   * provider can never leak an `Authorization: Bearer <openai-key>` header to a
   * local Ollama address (they no longer share a field).
   */
  llmEndpointOllama: string;
  llmEndpointOpenai: string;
  /** Model id, e.g. `llama3.1` or `gpt-4o-mini`. */
  llmModel: string;
  /** API key for OpenAI-compatible providers (never sent to Ollama). */
  llmApiKey: string;
  /** Expose the in-process MCP server for external MCP clients. */
  mcpEnabled: boolean;
  /** MCP bearer token (48 hex chars), kept across restarts; '' until first needed. */
  mcpToken: string;

  // --- Barcode & scans ---
  /** Long edge, in pixels, that a scanned page is scaled down to before it is stored. */
  scanMaxImageEdge: number;
  /** JPEG quality (0.5–1) of stored scans. */
  scanJpegQuality: number;
  /** Width, in pixels, scans are shown at in notes; 0 shows them full size. */
  scanEmbedWidth: number;
  /** Paper the worksheets are laid out for. */
  worksheetPaperSize: WorksheetPaperSize;

  // --- partbank ---
  /**
   * Address of the partbank desktop app's API. Its port is not guaranteed:
   * the user moves it when 47830 is taken.
   */
  partbankDesktopUrl: string;
  /** Address of the partbank web server's API. */
  partbankWebUrl: string;
  /**
   * Which connection search and the catalog download use. Web by default: a
   * desktop link means nothing on anyone else's machine, so it would break a
   * vault shared through git.
   *
   * The API keys are deliberately NOT here — they live per-PC (see `pcStore`),
   * since `data.json` travels with the vault.
   */
  partbankDefaultConnection: PartbankConnection;
}

export type WorksheetPaperSize = 'a4' | 'letter';

const MCP_TOKEN_RE = /^[0-9a-f]{48}$/;

export const DEFAULT_SETTINGS: LabnoteSettings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  sampleTracking: true,
  autoSyncUnitOpToc: true,
  autoUpdateLastUpdated: true,
  customSampleTypes: [],
  globalSampleFolder: 'resources/labsamples',
  workflowViewGroupBy: 'status',
  catalogNoticeHash: '',
  llmProvider: 'none',
  llmEndpointOllama: 'http://localhost:11434',
  llmEndpointOpenai: 'https://api.openai.com',
  llmModel: 'llama3.1',
  llmApiKey: '',
  mcpEnabled: false,
  mcpToken: '',
  scanMaxImageEdge: 2400,
  scanJpegQuality: 0.85,
  scanEmbedWidth: 200,
  worksheetPaperSize: 'a4',
  partbankDesktopUrl: 'http://127.0.0.1:47830',
  partbankWebUrl: 'https://partbank.kbiofoundry.kr',
  partbankDefaultConnection: 'web',
};

/**
 * Whether `url` can be a partbank address: an http(s) origin. Anything else
 * (a `file:` path, a typo without a scheme) is refused rather than stored,
 * because the API key is sent to whatever is stored here.
 */
export function isValidPartbankUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const SCAN_IMAGE_EDGE_RANGE = { min: 800, max: 6000 } as const;
export const SCAN_JPEG_QUALITY_RANGE = { min: 0.5, max: 1 } as const;
/** Besides this range, 0 is allowed and means full size. */
export const SCAN_EMBED_WIDTH_RANGE = { min: 100, max: 1600 } as const;

/**
 * A whole number typed into a settings field, rounded, when it is inside
 * `range` or one of `also` (#321); undefined for anything else, empty included.
 */
export function parseRangedNumber(
  value: string,
  range: { min: number; max: number },
  also: readonly number[] = []
): number | undefined {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const n = Math.round(Number(text));
  return also.includes(n) || (n >= range.min && n <= range.max) ? n : undefined;
}

/** Why a folder path was refused (#328), as one sentence. */
export function invalidFolderText(t: Translator, reason: InvalidFolderReason): string {
  switch (reason.kind) {
    case 'empty':
      return t('The folder path is empty.');
    case 'chars':
      return t('Folder names cannot contain {0}.', reason.chars);
    case 'parent':
      return t('A folder path cannot have an empty part (//), or a . or .. part.');
    case 'trailing':
      return t('"{0}" ends in a dot or a space, which Windows does not allow.', reason.part);
    case 'reserved':
      return t('"{0}" is a name Windows keeps for devices.', reason.part);
  }
}

/** {@link partitionCustomSampleTypes} result. */
export interface CustomSampleTypesInput {
  /** What to store: valid names, plus invalid ones that were already stored. */
  save: string[];
  /** Newly typed names autocompletion cannot read, with a name that works. */
  rejected: { name: string; suggestion: string }[];
  /** Invalid names kept from before, so their `{Type}.json` and ids stay linked. */
  legacyInvalid: string[];
  /** Newly typed names whose `_` the reading view turns into italics (#252). */
  italic: { name: string; suggestion: string }[];
  /** Such names kept from before, so their samples stay linked. */
  legacyItalic: string[];
  /** Newly typed names that differ from a built-in or earlier type only in case. */
  caseDuplicates: { name: string; clashesWith: string }[];
  /** Such names kept from before, so their samples stay linked. */
  legacyCaseDuplicates: { name: string; clashesWith: string }[];
}

/**
 * Split the comma-separated "Custom sample types" field (#81). A name that
 * autocompletion cannot read is not stored when newly typed; one stored by an
 * older release is kept, because renaming it would orphan its `{Type}.json`
 * and every id written with it.
 *
 * Names that differ only in case (`dna` next to the built-in `DNA`) are
 * refused the same way (#222): on a case-insensitive file system both types
 * read and write the one `dna.json`, and their samples mix. So is a name
 * whose `_` the reading view turns into italics (#252).
 */
export function partitionCustomSampleTypes(
  input: string,
  previouslySaved: readonly string[]
): CustomSampleTypesInput {
  const out: CustomSampleTypesInput = {
    save: [],
    rejected: [],
    legacyInvalid: [],
    italic: [],
    legacyItalic: [],
    caseDuplicates: [],
    legacyCaseDuplicates: [],
  };
  const taken = new Map<string, string>(SAMPLE_TYPES.map(t => [t.toLowerCase(), t]));
  const names = input
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  for (const name of names) {
    const clashesWith = taken.get(name.toLowerCase());
    if (clashesWith !== undefined && clashesWith !== name) {
      const clash = { name, clashesWith };
      if (previouslySaved.includes(name)) {
        out.save.push(name);
        out.legacyCaseDuplicates.push(clash);
      } else {
        out.caseDuplicates.push(clash);
      }
      continue;
    }
    taken.set(name.toLowerCase(), name);
    const readable = isValidSampleTypeName(name);
    if (readable && !underscoreTurnsItalic(name)) {
      out.save.push(name);
    } else if (previouslySaved.includes(name)) {
      out.save.push(name);
      (readable ? out.legacyItalic : out.legacyInvalid).push(name);
    } else {
      (readable ? out.italic : out.rejected).push({ name, suggestion: suggestSampleTypeName(name) });
    }
  }
  return out;
}

/**
 * Custom sample types in `before` that `after` dropped (#137): the samples of
 * such a type stop showing. A change of case and a built-in name do not count,
 * since those types stay shown.
 */
export function removedCustomSampleTypes(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set([...after, ...SAMPLE_TYPES].map(t => t.toLowerCase()));
  return [...new Set(before)].filter(t => !kept.has(t.toLowerCase()));
}

/** Samples in the given `{Type}.json` texts (#137); an empty or broken file counts as none. */
export function countSampleRecords(jsonTexts: readonly string[]): number {
  let count = 0;
  for (const text of jsonTexts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) count += Object.keys(parsed).length;
    } catch {
      // Not counted.
    }
  }
  return count;
}

/**
 * Validate + upgrade a raw persisted blob into a well-typed {@link LabnoteSettings}.
 *
 * Replaces the previous shallow `Object.assign(defaults, loadData())`, which
 * copied through any garbage (wrong types, stale keys) unchecked. Each field is
 * type-checked before use, and the pre-schema single `llmEndpoint` is migrated
 * onto the provider-specific field so existing users keep their endpoint.
 */
export function migrateSettings(raw: unknown): LabnoteSettings {
  const data: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: LabnoteSettings = { ...DEFAULT_SETTINGS };

  if (typeof data.sampleTracking === 'boolean') out.sampleTracking = data.sampleTracking;
  if (typeof data.autoSyncUnitOpToc === 'boolean') out.autoSyncUnitOpToc = data.autoSyncUnitOpToc;
  if (typeof data.autoUpdateLastUpdated === 'boolean') {
    out.autoUpdateLastUpdated = data.autoUpdateLastUpdated;
  }
  if (Array.isArray(data.customSampleTypes)) {
    out.customSampleTypes = data.customSampleTypes.filter(
      (x): x is string => typeof x === 'string'
    );
  }
  if (typeof data.globalSampleFolder === 'string') out.globalSampleFolder = data.globalSampleFolder;
  if (
    data.workflowViewGroupBy === 'status' ||
    data.workflowViewGroupBy === 'project' ||
    data.workflowViewGroupBy === 'author' ||
    data.workflowViewGroupBy === 'discuss'
  ) {
    out.workflowViewGroupBy = data.workflowViewGroupBy;
  }
  if (typeof data.catalogNoticeHash === 'string') out.catalogNoticeHash = data.catalogNoticeHash;
  if (data.llmProvider === 'none' || data.llmProvider === 'ollama' || data.llmProvider === 'openai') {
    out.llmProvider = data.llmProvider;
  }
  if (typeof data.llmModel === 'string') out.llmModel = data.llmModel;
  if (typeof data.llmApiKey === 'string') out.llmApiKey = data.llmApiKey;
  if (typeof data.mcpEnabled === 'boolean') out.mcpEnabled = data.mcpEnabled;
  if (typeof data.mcpToken === 'string' && MCP_TOKEN_RE.test(data.mcpToken)) {
    out.mcpToken = data.mcpToken;
  }
  const edge = data.scanMaxImageEdge;
  if (typeof edge === 'number' && edge >= SCAN_IMAGE_EDGE_RANGE.min && edge <= SCAN_IMAGE_EDGE_RANGE.max) {
    out.scanMaxImageEdge = Math.round(edge);
  }
  const quality = data.scanJpegQuality;
  if (typeof quality === 'number' && quality >= SCAN_JPEG_QUALITY_RANGE.min && quality <= SCAN_JPEG_QUALITY_RANGE.max) {
    out.scanJpegQuality = quality;
  }
  const width = data.scanEmbedWidth;
  if (typeof width === 'number' && (width === 0 || (width >= SCAN_EMBED_WIDTH_RANGE.min && width <= SCAN_EMBED_WIDTH_RANGE.max))) {
    out.scanEmbedWidth = Math.round(width);
  }
  // 0.110.0 (schema 1) saved its 300 px default along with everything else.
  const storedVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  if (storedVersion < 2 && out.scanEmbedWidth === 300) out.scanEmbedWidth = DEFAULT_SETTINGS.scanEmbedWidth;
  if (data.worksheetPaperSize === 'a4' || data.worksheetPaperSize === 'letter') {
    out.worksheetPaperSize = data.worksheetPaperSize;
  }
  if (typeof data.partbankDesktopUrl === 'string' && isValidPartbankUrl(data.partbankDesktopUrl)) {
    out.partbankDesktopUrl = data.partbankDesktopUrl.trim();
  }
  if (typeof data.partbankWebUrl === 'string' && isValidPartbankUrl(data.partbankWebUrl)) {
    out.partbankWebUrl = data.partbankWebUrl.trim();
  }
  if (data.partbankDefaultConnection === 'desktop' || data.partbankDefaultConnection === 'web') {
    out.partbankDefaultConnection = data.partbankDefaultConnection;
  }

  // Provider-specific endpoints (new shape) win when present…
  if (typeof data.llmEndpointOllama === 'string') out.llmEndpointOllama = data.llmEndpointOllama;
  if (typeof data.llmEndpointOpenai === 'string') out.llmEndpointOpenai = data.llmEndpointOpenai;
  // …otherwise migrate the legacy single `llmEndpoint` onto whichever provider
  // was active (defaulting to Ollama, the old default).
  if (
    typeof data.llmEndpoint === 'string' &&
    data.llmEndpoint &&
    typeof data.llmEndpointOllama !== 'string' &&
    typeof data.llmEndpointOpenai !== 'string'
  ) {
    if (data.llmProvider === 'openai') out.llmEndpointOpenai = data.llmEndpoint;
    else out.llmEndpointOllama = data.llmEndpoint;
  }

  out.schemaVersion = CURRENT_SCHEMA_VERSION;
  return out;
}
