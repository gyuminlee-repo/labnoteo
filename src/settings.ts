/**
 * Plugin settings shape + defaults.
 *
 * Mirrors the companion VS Code extension's configuration where it makes sense
 * (`sampleTracking`, `customSampleTypes`) and adds the LLM provider settings
 * that the Obsidian build introduces (VS Code delegates LLM to Copilot Chat,
 * Obsidian talks to Ollama/OpenAI directly).
 */
import type { ExperimentGrouping } from '@labnoteo/core';
import { isValidSampleTypeName, SAMPLE_TYPES, suggestSampleTypeName } from '@labnoteo/core/lib/sampleUtils';

export type LlmProviderKind = 'none' | 'ollama' | 'openai';

/**
 * Bumped whenever the persisted shape changes so {@link migrateSettings} can
 * upgrade older `data.json` files instead of silently `Object.assign`-ing an
 * incompatible blob onto the defaults.
 */
export const CURRENT_SCHEMA_VERSION = 1;

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
}

const MCP_TOKEN_RE = /^[0-9a-f]{48}$/;

export const DEFAULT_SETTINGS: LabnoteSettings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  sampleTracking: true,
  autoSyncUnitOpToc: true,
  autoUpdateLastUpdated: true,
  customSampleTypes: [],
  globalSampleFolder: 'resources/labsamples',
  workflowViewGroupBy: 'status',
  llmProvider: 'none',
  llmEndpointOllama: 'http://localhost:11434',
  llmEndpointOpenai: 'https://api.openai.com',
  llmModel: 'llama3.1',
  llmApiKey: '',
  mcpEnabled: false,
  mcpToken: '',
};

/** {@link partitionCustomSampleTypes} result. */
export interface CustomSampleTypesInput {
  /** What to store: valid names, plus invalid ones that were already stored. */
  save: string[];
  /** Newly typed names autocompletion cannot read, with a name that works. */
  rejected: { name: string; suggestion: string }[];
  /** Invalid names kept from before, so their `{Type}.json` and ids stay linked. */
  legacyInvalid: string[];
}

/**
 * Split the comma-separated "Custom sample types" field (#81). A name that
 * autocompletion cannot read is not stored when newly typed; one stored by an
 * older release is kept, because renaming it would orphan its `{Type}.json`
 * and every id written with it.
 */
export function partitionCustomSampleTypes(
  input: string,
  previouslySaved: readonly string[]
): CustomSampleTypesInput {
  const out: CustomSampleTypesInput = { save: [], rejected: [], legacyInvalid: [] };
  const names = input
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  for (const name of names) {
    if (isValidSampleTypeName(name)) {
      out.save.push(name);
    } else if (previouslySaved.includes(name)) {
      out.save.push(name);
      out.legacyInvalid.push(name);
    } else {
      out.rejected.push({ name, suggestion: suggestSampleTypeName(name) });
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
  if (data.workflowViewGroupBy === 'status' || data.workflowViewGroupBy === 'project') {
    out.workflowViewGroupBy = data.workflowViewGroupBy;
  }
  if (data.llmProvider === 'none' || data.llmProvider === 'ollama' || data.llmProvider === 'openai') {
    out.llmProvider = data.llmProvider;
  }
  if (typeof data.llmModel === 'string') out.llmModel = data.llmModel;
  if (typeof data.llmApiKey === 'string') out.llmApiKey = data.llmApiKey;
  if (typeof data.mcpEnabled === 'boolean') out.mcpEnabled = data.mcpEnabled;
  if (typeof data.mcpToken === 'string' && MCP_TOKEN_RE.test(data.mcpToken)) {
    out.mcpToken = data.mcpToken;
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
