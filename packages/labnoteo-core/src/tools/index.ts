/**
 * Transport-agnostic Labnote tool set.
 *
 * A single source of domain "tools" (read a sample, create a workflow, update a
 * section, …) described by JSON Schema and implemented as pure async functions
 * over a {@link LabnoteFs}. The Obsidian build wraps these for its in-process
 * MCP server *and* its built-in AI commands; the same definitions could back a
 * VS Code language-model tool provider. Nothing here knows about MCP, HTTP or
 * any specific model.
 *
 * Where no single existing helper covered a tool, it is **composed** from core
 * primitives (e.g. `create_workflow` = catalog lookup + `createWorkflowContent`
 * + README checklist update) and section edits go through the non-lossy
 * {@link replaceSectionBody} rather than a full re-serialization.
 */
import type { LabnoteFs } from '../fs/labnoteFs';
import {
  loadSamplesByType,
  mergeSampleRecord,
  noteLabsamplesFolder,
  isSameSampleFolder,
  listExperimentSampleFolders,
  type SampleRecord,
} from '../lib/sampleStorage';
import {
  generateSampleId,
  normalizeSampleId,
  canonicalSampleType,
  getSampleDisplayMeta,
  sampleAliasProblem,
  hasSampleDescriptionSeparator,
} from '../lib/sampleUtils';
import { getExperimentDir } from '../lib/labnoteStructure';
import {
  ensureWorkflowResources,
  getWorkflowFilePath,
  loadWorkflows,
  loadUnitOperations,
  type UnitOperationItem,
} from '../lib/workflowDataLoader';
import { WORKFLOWS_CATALOG } from '../catalog';
import {
  getNextWorkflowNumber,
  createWorkflowFileName,
  sanitizeWorkflowName,
  createWorkflowContent,
  insertWorkflowChecklistEntries,
  hasWorkflowChecklistSection,
  parseExperimenterFromReadme,
} from '../lib/workflowStructure';
import {
  findSectionMatches,
  listHeadings,
  stripRepeatedHeading,
  replaceSectionBodyAt,
  sectionBodyAt,
  diffBodyLines,
  type SectionMatch,
} from '../sections/sectionEdit';
import * as posix from '../util/posixPath';

export interface ToolContext {
  fs: LabnoteFs;
  /** Vault/workspace root (`''` for an Obsidian vault). */
  workspaceRoot: string;
  /** Vault-global labsamples folder (for cross-scope sample reads). */
  globalSampleFolder?: string;
  /** Extra sample types beyond the built-ins. */
  customTypes?: string[];
  /** Host UI language, so scaffolded notes cite palette names the user sees. */
  locale?: string;
  /**
   * Optional override for writing *markdown notes* (not data files).
   *
   * On a host where a note may be open in an editor, writing through the raw
   * filesystem is a lost update waiting to happen: the editor holds its own
   * buffer and flushes it over whatever the tool just wrote. Obsidian's plugin
   * layer supplies a hook that routes through the vault instead, which the
   * editor observes. Hosts without that problem can leave it unset — handlers
   * fall back to {@link ToolContext.fs}.
   */
  writeNote?(path: string, content: string): Promise<void>;
  /**
   * Optional: vault paths of the notes that use the sample `(type, id)` stored
   * in `folder`. `get_sample` returns them as `usages` (#131); a host without
   * a note index leaves it unset and `usages` is left out.
   */
  findSampleUsages?(folder: string, type: string, id: string): Promise<string[]>;
}

/**
 * Write a markdown note through {@link ToolContext.writeNote} when the host
 * provides it, otherwise straight to the filesystem.
 */
async function writeNote(ctx: ToolContext, path: string, content: string): Promise<void> {
  if (ctx.writeNote) {
    await ctx.writeNote(path, content);
    return;
  }
  await ctx.fs.write(path, content);
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Non-fatal notes for the caller, e.g. arguments the tool ignored. */
  warnings?: string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  /**
   * Whether the tool changes user-visible content (notes, sample records).
   *
   * Hosts MUST confirm with the user before running a mutating tool — an AI
   * agent decides to call these on its own. Declared here, next to the handler,
   * so the policy cannot drift from the tool list the way a separate allowlist
   * in the host would. Required, not optional, so adding a tool forces the
   * author to make the call rather than defaulting to "safe".
   *
   * Lazily seeding built-in resource files (e.g. the workflow catalog) does not
   * count: it is invisible to the user and carries no data loss.
   */
  mutates: boolean;
  inputSchema: JsonSchema;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
  /**
   * What a mutating call would change, read before the host asks the user, so
   * the approval prompt can say it (#69). Returns an error when the call would
   * be rejected anyway; hosts then skip the prompt and report that error.
   * Structured, not prose: the host words and translates it.
   */
  describe?(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolPreview>;
}

/** {@link ToolDef.describe} result. */
export type ToolPreview = { error: string } | SectionEditPreview | SampleCreatePreview | WorkflowCreatePreview;

/** `update_section` preview: the section that will be replaced or cleared. */
export interface SectionEditPreview {
  kind: 'sectionEdit';
  documentPath: string;
  heading: string;
  /** Enclosing heading of the target section, `''` at the top level. */
  parentHeading: string;
  /** 1-based position among the `total` matching sections (#114). */
  occurrence: number;
  total: number;
  /** 1-based line of the target heading. */
  line: number;
  /** Non-blank lines the current body holds. */
  removedLines: number;
  /** Nested headings replaced along with the body. */
  removedSubheadings: number;
  /** True when the call empties the section (`clear: true`). */
  clearing: boolean;
  /** The first non-blank lines the edit erases, so the user sees what goes (#187). */
  removedText: string[];
  /** Erased lines beyond {@link removedText}. */
  removedMore: number;
  /** The first non-blank lines the edit brings in. */
  addedText: string[];
  /** New lines beyond {@link addedText}. */
  addedMore: number;
}

/** Lines of each side an `update_section` preview lists, and their length cap. */
const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 160;

function previewLines(lines: string[]): { text: string[]; more: number } {
  return {
    text: lines
      .slice(0, PREVIEW_LINES)
      .map(l => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS)}…` : l)),
    more: Math.max(0, lines.length - PREVIEW_LINES),
  };
}

/** `create_sample` preview: the sample that will be created or added to (#113). */
export interface SampleCreatePreview {
  kind: 'sampleCreate';
  type: string;
  /** Absent when the call leaves the id to be generated. */
  id?: string;
  /** True when `id` is already recorded, so the call adds to that record. */
  existing: boolean;
  alias?: string;
  location?: string;
  /** Samples folder the record goes to. */
  folder: string;
  scope: 'local' | 'global';
}

/** `create_workflow` preview: the file it creates and the README it registers it in (#124). */
export interface WorkflowCreatePreview {
  kind: 'workflowCreate';
  workflowId: string;
  workflowName: string;
  /** Expected at approval time; the handler numbers the file again when it runs. */
  fileName: string;
  readmePath: string;
}

// --- small arg helpers -----------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Resolve a document path argument to a normalized, vault-relative path, or
 * `undefined` when it is missing/empty OR escapes the workspace root (e.g. a
 * traversal payload like `../../.obsidian/plugins/evil/note.md`). MCP/LLM
 * callers can pass arbitrary strings, so every handler that touches a
 * `documentPath` must funnel it through this guard — previously only
 * `create_workflow` validated its path.
 */
function safePath(ctx: ToolContext, args: Record<string, unknown>, key: string): string | undefined {
  const raw = str(args, key);
  if (raw === undefined) return undefined;
  const normalized = posix.normalize(raw);
  const root = ctx.workspaceRoot && ctx.workspaceRoot !== '' ? ctx.workspaceRoot : '.';
  return posix.isInside(root, normalized) ? normalized : undefined;
}

/**
 * Error for a `documentPath` that {@link safePath} rejected although one was
 * given, so a client is not told a path it sent is "required".
 */
function outsideVaultError(args: Record<string, unknown>, key: string): ToolResult | undefined {
  const raw = str(args, key);
  return raw === undefined ? undefined : { ok: false, error: `${key} is outside the vault: ${raw}` };
}

/**
 * Whether a section's enclosing heading is the one `wanted` names: its full
 * text, or for a unit operation heading `[USW230 Sequence Embedding] alias`,
 * the bracketed text or the id alone. Case-insensitive.
 */
function matchesParentHeading(parent: string, wanted: string): boolean {
  const p = parent.trim().toLowerCase();
  const w = wanted.trim().toLowerCase();
  if (p === w) return true;
  const unitOp = p.match(/^\[([^\]]+)\]/);
  if (!unitOp) return false;
  const inner = unitOp[1].trim();
  return inner === w || inner.split(/\s+/)[0] === w;
}

/** Candidate list for an ambiguous `update_section`, readable by people and models. */
function describeSections(matches: SectionMatch[]): string {
  return matches
    .map(
      (m, i) =>
        `occurrence ${i + 1} under ${m.parentHeading ? `"${m.parentHeading}"` : 'the top level'} (line ${m.line + 1})`
    )
    .join('; ');
}

/** How much of a replaced section body `update_section` returns. */
const PREVIOUS_BODY_LIMIT = 500;

interface ResolvedSectionTarget {
  documentPath: string;
  heading: string;
  /** Body to write: `''` only when the caller set `clear: true`. */
  content: string;
  md: string;
  target: SectionMatch;
  /** 0-based index among `total` candidates. */
  index: number;
  total: number;
}

/**
 * Validate an `update_section` call and find its one target section, so the
 * handler and the approval preview cannot disagree about it. Empty content is
 * refused unless `clear: true` says it is meant (#69): models sent `""` to
 * mean "no change" and wiped recorded results.
 */
async function resolveSectionTarget(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ResolvedSectionTarget | { error: string }> {
  const documentPath = safePath(ctx, args, 'documentPath');
  const heading = str(args, 'heading');
  const rawContent = typeof args.content === 'string' ? args.content : undefined;
  if (!documentPath) {
    const outside = outsideVaultError(args, 'documentPath');
    if (outside) return { error: outside.error! };
  }
  if (!documentPath || !heading || rawContent === undefined) {
    return { error: 'documentPath, heading and content are required' };
  }
  const clear = args.clear === true;
  const blank = rawContent.trim() === '';
  if (blank && !clear) {
    return {
      error:
        'content is empty; nothing was written. To empty the section on purpose, call again with content "" and clear: true.',
    };
  }
  if (!blank && clear) {
    return { error: 'clear: true empties the section, so content must be "". Send one or the other.' };
  }
  const content = blank ? '' : rawContent;
  const parentHeading = str(args, 'parentHeading');
  const occurrence = args.occurrence;
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || (occurrence as number) < 1)) {
    return { error: 'occurrence must be a positive integer (1-based)' };
  }
  if (!(await ctx.fs.exists(documentPath))) {
    return { error: `File not found: ${documentPath}` };
  }
  const md = await ctx.fs.read(documentPath);
  const all = findSectionMatches(md, heading);
  if (all.length === 0) return { error: sectionNotFound(md, heading) };

  const candidates = parentHeading
    ? all.filter(m => matchesParentHeading(m.parentHeading, parentHeading))
    : all;
  if (candidates.length === 0) {
    return { error: `No "${heading}" section under "${parentHeading}". Candidates: ${describeSections(all)}.` };
  }
  let index = 0;
  if (occurrence !== undefined) {
    index = (occurrence as number) - 1;
    if (index >= candidates.length) {
      return {
        error: `occurrence ${occurrence} is out of range: only ${candidates.length} "${heading}" section(s) match. Candidates: ${describeSections(candidates)}.`,
      };
    }
  } else if (candidates.length > 1) {
    return {
      error:
        `"${heading}" matches ${candidates.length} sections; nothing was written. ` +
        `Call again with ${parentHeading ? 'occurrence' : 'parentHeading or occurrence'} to choose one. ` +
        `Candidates: ${describeSections(candidates)}.`,
    };
  }
  const target = candidates[index];
  if (content === '') return { documentPath, heading, content, md, target, index, total: candidates.length };
  // Content that starts with the section's own heading would repeat it (#162).
  const targetText = md.split(/\r?\n/)[target.line].replace(/^#{1,6}\s+/, '');
  const body = stripRepeatedHeading(content, targetText);
  if (body.trim() === '') {
    return { error: 'content only repeats the section heading; nothing was written. Send the body without the heading.' };
  }
  return { documentPath, heading, content: body, md, target, index, total: candidates.length };
}

/** Most headings {@link sectionNotFound} lists. */
const HEADING_LIST_LIMIT = 40;

/** "Section not found", with the note's headings so the caller can pick the right one (#145). */
function sectionNotFound(md: string, heading: string): string {
  const headings = listHeadings(md).map(h => `${'#'.repeat(h.level)} ${h.text}`);
  if (headings.length === 0) return `Section not found: ${heading}. The note has no headings.`;
  const shown = headings.slice(0, HEADING_LIST_LIMIT).join(' | ');
  const more = headings.length > HEADING_LIST_LIMIT ? ` (+${headings.length - HEADING_LIST_LIMIT} more)` : '';
  return `Section not found: ${heading}. Headings in this note: ${shown}${more}`;
}

interface ResolvedSampleCreate {
  documentPath: string;
  type: string;
  /** Normalized id, or undefined when one is to be generated. */
  id?: string;
  alias?: string;
  description?: string;
  location?: string;
  folder: string;
  scope: 'local' | 'global';
}

/**
 * Validate a `create_sample` call, so the handler and the approval preview
 * (#113) agree on what it writes and where.
 */
async function resolveSampleCreate(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ResolvedSampleCreate | { error: string }> {
  const rawType = str(args, 'type');
  const documentPath = safePath(ctx, args, 'documentPath');
  if (!documentPath) {
    const outside = outsideVaultError(args, 'documentPath');
    if (outside) return { error: outside.error! };
  }
  if (!rawType || !documentPath) return { error: 'type and documentPath are required' };
  // Unknown types are still accepted, as before; known ones take their
  // canonical spelling so `equip` and `Equip` share one file and id prefix.
  const type = canonicalSampleType(rawType, getSampleDisplayMeta(ctx.customTypes).types) ?? rawType;
  const rawId = str(args, 'id');
  const id = rawId === undefined ? undefined : normalizeSampleId(type, rawId);
  if (rawId !== undefined && !id) {
    return { error: `Invalid id "${rawId}": expected ${type}-<number>. Omit id to generate one.` };
  }
  const alias = str(args, 'alias');
  const aliasProblem = alias === undefined ? undefined : sampleAliasProblem(alias);
  if (aliasProblem === 'separator') {
    return {
      error: `Invalid alias "${alias}": ";" and ":" separate the id, alias and description in a note. Replace them (e.g. with "-" or "/") and retry.`,
    };
  }
  if (aliasProblem === 'markdown') {
    return {
      error: `Invalid alias "${alias}": #, [[, ]], *, _ and \` are read by Markdown as a tag, link, emphasis or code. Replace them (e.g. with "-" or "/") and retry.`,
    };
  }
  const description = str(args, 'description');
  if (description !== undefined && hasSampleDescriptionSeparator(description)) {
    return {
      error: `Invalid description "${description}": ";" ends the description in a note. Replace it (e.g. with ",") and retry.`,
    };
  }
  // The samples folder is derived from the note's directory and created on
  // write, so a mistyped path would leave a stray folder no experiment
  // owns. A folder path passes `exists` (it is true for folders too) but
  // would put the samples in its parent, hence the `.md` check.
  if (!/\.md$/i.test(documentPath) || !(await ctx.fs.exists(documentPath))) {
    return {
      error: `Note not found: ${documentPath} (documentPath must be an existing note; the sample is stored next to it)`,
    };
  }
  const folder = noteLabsamplesFolder(documentPath, ctx.globalSampleFolder);
  // A note outside any experiment (e.g. a vault-root note) resolves to the
  // same folder as the global samples; say so instead of calling it local.
  const scope = ctx.globalSampleFolder && isSameSampleFolder(folder, ctx.globalSampleFolder) ? 'global' : 'local';
  return { documentPath, type, id: id ?? undefined, alias, description, location: str(args, 'location'), folder, scope };
}

const README_NAME = 'README.labnote.md';

interface ResolvedWorkflowCreate {
  labnoteDir: string;
  readmePath: string;
  info: { id: string; name: string; description: string };
  /** Per-instance alias after the catalog name, as the app's "Workflow name" prompt adds it. */
  alias?: string;
  fileName: string;
}

/**
 * Validate a `create_workflow` call, so the handler and the approval preview
 * (#124) agree on what it creates. Reads only: the preview runs before the
 * user allows anything, so a vault without the catalog files yet is read from
 * the bundled catalog the handler would seed them with.
 */
async function resolveWorkflowCreate(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ResolvedWorkflowCreate | { error: string }> {
  const documentPath = safePath(ctx, args, 'documentPath');
  const workflowId = str(args, 'workflowId');
  if (!documentPath) {
    const outside = outsideVaultError(args, 'documentPath');
    if (outside) return { error: outside.error! };
  }
  if (!documentPath || !workflowId) return { error: 'documentPath and workflowId are required' };
  if (args.alias !== undefined && typeof args.alias !== 'string') return { error: 'alias must be a string' };
  const rawAlias = typeof args.alias === 'string' ? args.alias.trim() : '';
  if (/[\r\n]/.test(rawAlias)) return { error: 'alias must be a single line' };
  // As in the app, an alias of only symbols, which leaves no file name part, is dropped.
  const alias = rawAlias && sanitizeWorkflowName(rawAlias) ? rawAlias : undefined;
  const labnoteDir = getExperimentDir(documentPath);
  if (!labnoteDir) return { error: 'documentPath is not inside a labnote/### experiment folder' };
  // An experiment is its README; without one the write would create a stray
  // folder that no experiment view or automation sees.
  const readmePath = posix.join(labnoteDir, README_NAME);
  if (!(await ctx.fs.exists(readmePath))) {
    return { error: `Experiment not found: ${labnoteDir} (no ${README_NAME})` };
  }

  const seeded = ctx.workspaceRoot && !(await ctx.fs.exists(getWorkflowFilePath(ctx.workspaceRoot, 'workflows')));
  const workflows = seeded ? WORKFLOWS_CATALOG.workflows : (await loadWorkflows(ctx.fs, ctx.workspaceRoot)).workflows;
  const wf = workflows.find(w => w.id === workflowId);
  if (!wf) return { error: `Workflow not found: ${workflowId}` };

  const info = { id: wf.id, name: wf.name, description: wf.description };
  const sequence = getNextWorkflowNumber(await ctx.fs.list(labnoteDir));
  return { labnoteDir, readmePath, info, alias, fileName: createWorkflowFileName(sequence, info, alias) };
}

async function findUnitOp(
  ctx: ToolContext,
  opId: string
): Promise<{ op: UnitOperationItem; opType: 'hw' | 'sw' } | undefined> {
  await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
  const hw = await loadUnitOperations(ctx.fs, ctx.workspaceRoot, 'hw');
  const found = hw.unitOperations.find(o => o.id === opId);
  if (found) return { op: found, opType: 'hw' };
  const sw = await loadUnitOperations(ctx.fs, ctx.workspaceRoot, 'sw');
  const foundSw = sw.unitOperations.find(o => o.id === opId);
  if (foundSw) return { op: foundSw, opType: 'sw' };
  return undefined;
}

/** Most matches `search_samples` returns; the rest are reported as `truncated`. */
const SEARCH_SAMPLES_LIMIT = 50;

/**
 * `type` as the registry spells it (`dna` → `DNA`), or an error listing the
 * types there are, so a model can correct itself instead of being told an
 * existing sample was not found.
 */
function resolveSampleType(
  ctx: ToolContext,
  type: string
): { ok: true; type: string } | { ok: false; error: ToolResult } {
  const types = getSampleDisplayMeta(ctx.customTypes).types;
  const canonical = canonicalSampleType(type, types);
  if (canonical) return { ok: true, type: canonical };
  return { ok: false, error: { ok: false, error: `Unknown sample type "${type}". Known types: ${types.join(', ')}` } };
}

interface SampleScope {
  folder: string;
  scope: 'local' | 'global';
  /** The experiment folder of a local scope, else `null`. */
  experiment: string | null;
}

/** `local` (when given and not the global folder itself) then the global folder. */
function sampleScopes(ctx: ToolContext, local?: string): SampleScope[] {
  const out: SampleScope[] = [];
  const global = ctx.globalSampleFolder;
  if (local && !(global && isSameSampleFolder(local, global))) {
    out.push({ folder: local, scope: 'local', experiment: getExperimentDir(local) ?? null });
  }
  if (global) out.push({ folder: global, scope: 'global', experiment: null });
  return out;
}

/** Every experiment's local labsamples folder, see {@link listExperimentSampleFolders}. */
async function experimentSampleScopes(ctx: ToolContext): Promise<SampleScope[]> {
  const global = ctx.globalSampleFolder;
  return (await listExperimentSampleFolders(ctx.fs, ctx.workspaceRoot))
    .filter(folder => !(global && isSameSampleFolder(folder, global)))
    .map(folder => ({ folder, scope: 'local' as const, experiment: posix.dirname(posix.dirname(folder)) }));
}

// --- tool definitions ------------------------------------------------------

export function createLabnoteTools(): ToolDef[] {
  return [
    {
      name: 'get_sample',
      mutates: false,
      description:
        'Look up a stored sample definition by type and id, searching the document-local labsamples folder then the vault-global one; without documentPath, every experiment\'s local labsamples folder is searched after the global one. The result says where it was found (`scope` local/global, `experiment` folder for a local sample). When the host can search notes, `usages` lists the vault paths of the notes that use the sample found (`sources` is only where it was defined or recorded).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Sample type, e.g. DNA, RNA, Plasmid.' },
          id: { type: 'string', description: 'Sample id, e.g. DNA-12.' },
          documentPath: { type: 'string', description: 'Vault-relative path of the note for local scope.' },
        },
        required: ['type', 'id'],
      },
      async handler(ctx, args) {
        const rawType = str(args, 'type');
        const id = str(args, 'id');
        if (!rawType || !id) return { ok: false, error: 'type and id are required' };
        const type = resolveSampleType(ctx, rawType);
        if (!type.ok) return type.error;

        const documentPath = safePath(ctx, args, 'documentPath');
        const folders = documentPath
          ? sampleScopes(ctx, noteLabsamplesFolder(documentPath, ctx.globalSampleFolder))
          : [
              ...sampleScopes(ctx),
              ...(await experimentSampleScopes(ctx)),
            ];

        for (const { folder, scope, experiment } of folders) {
          const records = await loadSamplesByType(ctx.fs, folder, type.type);
          if (!records[id]) continue;
          const data = { ...records[id], id, scope, experiment };
          if (!ctx.findSampleUsages) return { ok: true, data };
          const usages = await ctx.findSampleUsages(folder, type.type, id);
          return { ok: true, data: { ...data, usages } };
        }
        return { ok: false, error: `Sample not found: ${type.type}/${id}` };
      },
    },

    {
      name: 'list_samples',
      mutates: false,
      description:
        'List all stored samples of a given type (local scope merged over global). Each entry says whether it is `local` (the note\'s experiment) or `global`.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          documentPath: { type: 'string' },
        },
        required: ['type'],
      },
      async handler(ctx, args) {
        const rawType = str(args, 'type');
        if (!rawType) return { ok: false, error: 'type is required' };
        const type = resolveSampleType(ctx, rawType);
        if (!type.ok) return type.error;
        const documentPath = safePath(ctx, args, 'documentPath');

        const merged: Record<string, { rec: SampleRecord; scope: 'local' | 'global' }> = {};
        const scopes = sampleScopes(
          ctx,
          documentPath ? noteLabsamplesFolder(documentPath, ctx.globalSampleFolder) : undefined
        ).reverse();
        for (const { folder, scope } of scopes) {
          for (const [id, rec] of Object.entries(await loadSamplesByType(ctx.fs, folder, type.type))) {
            merged[id] = { rec, scope };
          }
        }
        const data = Object.entries(merged).map(([id, { rec, scope }]) => ({
          id,
          alias: rec.alias,
          description: rec.descriptions?.[0] ?? null,
          location: rec.location ?? null,
          scope,
          ...(rec.discarded ? { discarded: rec.discarded } : {}),
        }));
        return { ok: true, data };
      },
    },

    {
      name: 'search_samples',
      mutates: false,
      description:
        'Search the samples of every type in the global labsamples folder and every experiment\'s local one for `query` in the id, alias, storage location or descriptions (case-insensitive). Each match gives its type, `scope` (local/global), `experiment` folder for a local sample and `discarded` date if it was marked discarded. Use it when you do not know the type or which experiment holds a sample.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find, e.g. part of an id, alias or location.' },
          type: { type: 'string', description: 'Only this sample type (optional).' },
        },
        required: ['query'],
      },
      async handler(ctx, args) {
        const query = str(args, 'query')?.trim().toLowerCase();
        if (!query) return { ok: false, error: 'query is required' };
        const rawType = str(args, 'type');
        let types = getSampleDisplayMeta(ctx.customTypes).types;
        if (rawType) {
          const type = resolveSampleType(ctx, rawType);
          if (!type.ok) return type.error;
          types = [type.type];
        }

        const matches: Array<Record<string, unknown>> = [];
        let truncated = false;
        for (const { folder, scope, experiment } of [...sampleScopes(ctx), ...(await experimentSampleScopes(ctx))]) {
          for (const type of types) {
            for (const [id, rec] of Object.entries(await loadSamplesByType(ctx.fs, folder, type))) {
              const haystack = [id, rec.alias ?? '', rec.location ?? '', ...(rec.descriptions ?? [])];
              if (!haystack.some(h => h.toLowerCase().includes(query))) continue;
              if (matches.length >= SEARCH_SAMPLES_LIMIT) {
                truncated = true;
                continue;
              }
              matches.push({
                type,
                id,
                alias: rec.alias,
                description: rec.descriptions?.[0] ?? null,
                location: rec.location ?? null,
                scope,
                experiment,
                discarded: rec.discarded ?? null,
              });
            }
          }
        }
        return { ok: true, data: { matches, truncated } };
      },
    },

    {
      name: 'create_sample',
      mutates: true,
      description:
        'Create a sample definition in the document-local labsamples folder, or add to an existing one, optionally with its storage location. Generates an id when none is given. For an existing id the description is added in front of the earlier ones and the note is added to its sources; alias and location change only when given.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: {
            type: 'string',
            description:
              'Optional; auto-generated when omitted. Must be "<type>-<number>" (e.g. "Equip-3"); anything else is rejected, so omit it rather than inventing one.',
          },
          alias: {
            type: 'string',
            description:
              'Must not contain ";" or ":" (they separate the id, alias and description in a note); use "-" or "/" instead, e.g. "1-10".',
          },
          description: {
            type: 'string',
            description: 'Must not contain ";" (it ends the description in a note); use "," instead.',
          },
          location: {
            type: 'string',
            description:
              'Storage location, e.g. "Freezer-2 / Box-3 / A1". Omit (or leave empty) to keep the existing one.',
          },
          documentPath: {
            type: 'string',
            description:
              'Existing note the sample belongs to (defines the folder + source). Nothing is written for a missing note.',
          },
        },
        required: ['type', 'documentPath'],
      },
      async handler(ctx, args) {
        const resolved = await resolveSampleCreate(ctx, args);
        if ('error' in resolved) return { ok: false, error: resolved.error };
        const { documentPath, type, alias, description, location, folder, scope } = resolved;
        const id = resolved.id ?? generateSampleId(type);

        // Atomic merge into an existing record (#73): calling again for a known
        // id adds this note as a source and the description in front, and an
        // omitted alias or location keeps what was recorded in Obsidian.
        const { discarded } = await mergeSampleRecord(ctx.fs, folder, type, id, {
          alias,
          description,
          sources: [posix.basename(documentPath)],
          location,
        });
        const result: ToolResult = { ok: true, data: { id, type, folder, scope } };
        const warnings: string[] = [];
        if (scope === 'global') {
          warnings.push(
            `${documentPath} is outside an experiment folder, so the sample was written to the global samples folder (${folder}).`
          );
        }
        if (discarded) {
          warnings.push(
            `${id} was marked discarded on ${discarded} and stays discarded; tell the user, who can clear it with "Unmark discarded" in the samples view.`
          );
        }
        if (warnings.length) result.warnings = warnings;
        return result;
      },
      async describe(ctx, args) {
        const resolved = await resolveSampleCreate(ctx, args);
        if ('error' in resolved) return { error: resolved.error };
        const { type, id, alias, location, folder, scope } = resolved;
        const existing = id !== undefined && (await loadSamplesByType(ctx.fs, folder, type))[id] !== undefined;
        return { kind: 'sampleCreate', type, id, existing, alias, location, folder, scope };
      },
    },

    {
      name: 'get_unit_operation',
      // Seeds the workflow catalog on first use, which is invisible to the user.
      mutates: false,
      description: 'Return catalog metadata (name, description, equipment/software) for a unit-operation id.',
      inputSchema: {
        type: 'object',
        properties: { opId: { type: 'string', description: 'e.g. UHW010 or USW020.' } },
        required: ['opId'],
      },
      async handler(ctx, args) {
        const opId = str(args, 'opId');
        if (!opId) return { ok: false, error: 'opId is required' };
        const found = await findUnitOp(ctx, opId);
        if (!found) return { ok: false, error: `Unit operation not found: ${opId}` };
        return { ok: true, data: { ...found.op, opType: found.opType } };
      },
    },

    {
      name: 'update_section',
      mutates: true,
      description:
        'Replace the body of a section (matched by heading text at any level) in a note, without re-serializing the rest of the document. ' +
        'README headings may carry emoji (e.g. "## 🧪 Related Workflows"); when no heading matches exactly, emoji, square brackets, case and extra spaces are ignored. ' +
        'Send only the body: a first line repeating the section heading is dropped. ' +
        'Workflow notes repeat headings such as "Method" under every unit operation: when the heading occurs more than once, pass parentHeading and/or occurrence, ' +
        'otherwise nothing is written and the error lists the candidates. ' +
        'The whole body is replaced, nested headings included; the result reports what was removed (removedLines, removedSubheadings, previousBody).',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string' },
          heading: { type: 'string', description: 'Heading text without the leading #s, e.g. "Method".' },
          content: {
            type: 'string',
            description:
              'New Markdown body for the section. Empty or whitespace-only content is rejected unless clear is true.',
          },
          clear: {
            type: 'boolean',
            description: 'Set to true, with content "", to empty the section on purpose.',
          },
          parentHeading: {
            type: 'string',
            description:
              'Enclosing heading of the target section: its full text, the unit operation without brackets ("USW230 Sequence Embedding"), or just the unit operation id ("USW230").',
          },
          occurrence: {
            type: 'integer',
            minimum: 1,
            description:
              '1-based position among the matching sections, counted after the parentHeading filter. Needed when the same unit operation appears twice.',
          },
        },
        required: ['documentPath', 'heading', 'content'],
      },
      async handler(ctx, args) {
        const resolved = await resolveSectionTarget(ctx, args);
        if ('error' in resolved) return { ok: false, error: resolved.error };
        const { documentPath, heading, content, md, target, index, total } = resolved;

        const { ok, md: next, removed } = replaceSectionBodyAt(md, target.line, content);
        if (!ok) return { ok: false, error: `Section not found: ${heading}` };
        await writeNote(ctx, documentPath, next);
        return {
          ok: true,
          data: {
            documentPath,
            heading,
            parentHeading: target.parentHeading,
            occurrence: index + 1,
            total,
            removedLines: removed?.lines ?? 0,
            removedSubheadings: removed?.subheadings ?? 0,
            previousBody: (removed?.text ?? '').slice(0, PREVIOUS_BODY_LIMIT),
          },
        };
      },
      async describe(ctx, args) {
        const resolved = await resolveSectionTarget(ctx, args);
        if ('error' in resolved) return { error: resolved.error };
        const body = sectionBodyAt(resolved.md, resolved.target.line);
        const diff = diffBodyLines(body?.text ?? '', resolved.content);
        const removed = previewLines(diff.removed);
        const added = previewLines(diff.added);
        return {
          kind: 'sectionEdit',
          documentPath: resolved.documentPath,
          heading: resolved.heading,
          parentHeading: resolved.target.parentHeading,
          occurrence: resolved.index + 1,
          total: resolved.total,
          line: resolved.target.line + 1,
          removedLines: body?.lines ?? 0,
          removedSubheadings: body?.subheadings ?? 0,
          clearing: resolved.content === '',
          removedText: removed.text,
          removedMore: removed.more,
          addedText: added.text,
          addedMore: added.more,
        };
      },
    },

    {
      name: 'create_workflow',
      mutates: true,
      description:
        'Create a new workflow file in an experiment folder from the catalog and register it in the README checklist. ' +
        'An optional alias names this instance (e.g. "pUC19 cloning"): it follows the catalog name in the file name, title and checklist entry.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: 'Any path inside the target labnote/### experiment folder.' },
          workflowId: { type: 'string', description: 'Catalog workflow id, e.g. WD010.' },
          alias: {
            type: 'string',
            description: 'Optional name for this workflow instance, added after the catalog name.',
          },
        },
        required: ['documentPath', 'workflowId'],
      },
      async handler(ctx, args) {
        const resolved = await resolveWorkflowCreate(ctx, args);
        if ('error' in resolved) return { ok: false, error: resolved.error };
        const { labnoteDir, readmePath, info, alias, fileName } = resolved;

        await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
        const experimenter = parseExperimenterFromReadme(await ctx.fs.read(readmePath));
        const workflowPath = posix.join(labnoteDir, fileName);
        // The new workflow file cannot be open yet, but the README very well
        // may be — both go through the hook so the host owns note writes.
        await writeNote(
          ctx,
          workflowPath,
          createWorkflowContent(info, experimenter, alias, { locale: ctx.locale })
        );

        const readme = await ctx.fs.read(readmePath);
        // A README whose section was renamed beyond recognition lists nothing (#298).
        if (!hasWorkflowChecklistSection(readme)) {
          return {
            ok: true,
            data: {
              path: workflowPath,
              fileName,
              registered: false,
              warning:
                'The README has no "Related Workflows" section, so the workflow was not added to its checklist. Tell the user.',
            },
          };
        }
        const title = [info.id, info.name, alias].filter(Boolean).join(' ');
        await writeNote(ctx, readmePath, insertWorkflowChecklistEntries(readme, [{ done: false, title, fileName }]));

        return { ok: true, data: { path: workflowPath, fileName, registered: true } };
      },
      async describe(ctx, args) {
        const resolved = await resolveWorkflowCreate(ctx, args);
        if ('error' in resolved) return { error: resolved.error };
        return {
          kind: 'workflowCreate',
          workflowId: resolved.info.id,
          workflowName: resolved.info.name,
          fileName: resolved.fileName,
          readmePath: resolved.readmePath,
        };
      },
    },
  ];
}

/**
 * Arguments the tool's schema does not declare. Handlers read only declared
 * keys, so these are silently dropped; the caller should hear about it rather
 * than believe e.g. a field was saved. Only a plain-object `args` is checked —
 * MCP passes `arguments` through unvalidated, and an array's indices are not
 * argument names.
 */
function unsupportedArgsWarning(tool: ToolDef, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const supported = Object.keys(tool.inputSchema.properties);
  const unsupported = Object.keys(args).filter(k => !supported.includes(k));
  if (unsupported.length === 0) return undefined;
  return (
    `Ignored unsupported argument(s): ${unsupported.join(', ')}. ` +
    `Supported: ${supported.join(', ') || '(none)'}.`
  );
}

/**
 * Invoke a tool by name; returns a structured {@link ToolResult}. Unsupported
 * arguments never fail the call — they are reported in `warnings`.
 */
export async function runTool(
  tools: ToolDef[],
  name: string,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  let result: ToolResult;
  try {
    result = await tool.handler(ctx, args);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const warning = unsupportedArgsWarning(tool, args);
  return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
}
