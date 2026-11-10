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
  samplesWithAliasIn,
  noteLabsamplesFolder,
  isSameSampleFolder,
  listExperimentSampleFolders,
  findRecordIgnoringCase,
  type SampleRecord,
} from '../lib/sampleStorage';
import {
  generateSampleId,
  normalizeSampleId,
  canonicalSampleType,
  getSampleDisplayMeta,
  sampleAliasProblem,
  hasSampleDescriptionSeparator,
  normalizeSampleSearch,
} from '../lib/sampleUtils';
import { getExperimentDir } from '../lib/labnoteStructure';
import {
  ensureWorkflowResources,
  getWorkflowFilePath,
  loadWorkflows,
  loadUnitOperations,
  type UnitOperationItem,
} from '../lib/workflowDataLoader';
import { UNIT_OPERATIONS_HW_CATALOG, UNIT_OPERATIONS_SW_CATALOG, WORKFLOWS_CATALOG } from '../catalog';
import {
  getNextWorkflowNumber,
  createWorkflowFileName,
  sanitizeWorkflowName,
  createWorkflowContent,
  insertWorkflowChecklistEntries,
  hasWorkflowChecklistSection,
  parseExperimenterFromReadme,
  parseExperimenterFromNote,
  diagnoseWorkflowPath,
  workflowAliasProblem,
  findSameAliasWorkflow,
  workflowChecklistLabels,
} from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown, buildSwUnitOpMarkdown } from '../lib/unitOpTemplate';
import { getSeoulDateTimeString } from '../lib/dateUtils';
import { findSameAliasUnitOp, listUnitOpBlocks } from '../sections/scanInsert';
import {
  findUnitOpInsertPointAt,
  syncUnitOpTocAfterInsert,
  unitOpSectionLine,
  ensureUnitOpSection,
  type UnitOpInsertPoint,
} from '../sections/workflowSectionParser';
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
   *
   * `change` makes the new note of the note as it is when written (in an open
   * editor, with what was typed and not saved yet), and may be called more
   * than once: the last call is the one written. A note that does not exist is
   * made of `''`. Resolves false when nothing was written though the note
   * would change (a save of the open note did not end in time). `lone`: what the
   * host changes in other notes along with this one (the date of the experiment
   * README, say) is left out, the caller writing those notes itself next.
   */
  processNote?(path: string, change: (text: string) => string, lone?: boolean): Promise<boolean>;
  /**
   * Whether inserting a unit operation sorts the note's unit operation list
   * into note order, as the "Auto-sync unit operation TOC" setting does in the
   * app (#457, #491). Unset sorts.
   */
  sortUnitOpToc?: boolean;
  /**
   * Optional: vault paths of the notes that use the sample `(type, id)` stored
   * in `folder`. `get_sample` returns them as `usages` (#131); a host without
   * a note index leaves it unset and `usages` is left out.
   */
  findSampleUsages?(folder: string, type: string, id: string): Promise<string[]>;
}

/**
 * Rewrite a markdown note through {@link ToolContext.processNote} when the host
 * provides it, otherwise on the filesystem.
 */
async function processNote(
  ctx: ToolContext,
  path: string,
  change: (text: string) => string,
  lone = false
): Promise<boolean> {
  if (ctx.processNote) return ctx.processNote(path, change, lone);
  const text = (await ctx.fs.exists(path)) ? await ctx.fs.read(path) : '';
  await ctx.fs.write(path, change(text));
  return true;
}

/** Thrown by a change that refuses the note as it is when written: nothing is written. */
class NoteChangeRefused extends Error {
  constructor(readonly refusal: ToolError) {
    super(refusal.error);
  }
}

/** Thrown by a change that leaves the note as it is, with what it found. */
class NoteLeft<T> extends Error {
  constructor(readonly data: T) {
    super('note left as it is');
  }
}

/**
 * The note was not written: Obsidian was still saving it when the wait ran out, or another
 * writer changed it while the change went in.
 */
function noteNotWritten(path: string): ToolError {
  return {
    error: `${path} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.`,
    code: 'note_not_written',
    params: [path],
  };
}

/**
 * Change a note as it is when written ({@link processNote}): `make` gives the
 * new text and what the tool reports of it, from the last call, the one
 * written. A refusal it throws comes back as the error, and nothing is written.
 */
async function changeNote<T>(
  ctx: ToolContext,
  path: string,
  make: (text: string) => { text: string; data: T }
): Promise<{ data: T } | ToolError> {
  let last: { input: string; text: string; data: T } | undefined;
  let written: boolean;
  try {
    written = await processNote(ctx, path, text => {
      last = { input: text, ...make(text) };
      return last.text;
    });
  } catch (err) {
    if (err instanceof NoteChangeRefused) return err.refusal;
    if (err instanceof NoteLeft) return { data: err.data as T };
    throw err;
  }
  // Not written, though the note would change: the save of the open note did not end in time.
  if (!last || (!written && last.text !== last.input)) return noteNotWritten(path);
  return { data: last.data };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * Names the rule a refusal broke, with the values its wording needs (#529).
   * `error` stays English, for the model; a host words the code in the
   * language the person watching reads.
   */
  code?: string;
  params?: string[];
  /** Non-fatal notes for the caller, e.g. arguments the tool ignored. */
  warnings?: string[];
}

/** A refused call: the English sentence for the model, and the code a host translates (#529). */
export interface ToolError {
  error: string;
  code?: string;
  params?: string[];
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
export type ToolPreview =
  | ToolError
  | SectionEditPreview
  | SampleCreatePreview
  | WorkflowCreatePreview
  | UnitOpInsertPreview;

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
  /** True for `mode: "append"`: the body stays and the new text goes after it (#554). */
  appending?: boolean;
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
  /** Other samples of the type in `folder` that already have `alias` (#310). */
  aliasTwins?: string[];
}

/** `create_workflow` preview: the file it creates and the README it registers it in (#124). */
export interface WorkflowCreatePreview {
  kind: 'workflowCreate';
  workflowId: string;
  workflowName: string;
  /** Expected at approval time; the handler numbers the file again when it runs. */
  fileName: string;
  readmePath: string;
  /** The workflow file of the experiment with the same ID and alias (#484). */
  sameAliasAs?: string;
}

/** `insert_unit_operation` preview: the block it adds to a workflow note, and where (#491). */
export interface UnitOpInsertPreview {
  kind: 'unitOpInsert';
  documentPath: string;
  opId: string;
  opName: string;
  alias?: string;
  opType: 'hw' | 'sw';
  /** Where the block goes, as {@link findUnitOpInsertPointAt} says. */
  place: UnitOpInsertPoint['place'];
  /** Heading of the block it follows, for `place: 'after'`. */
  after?: string;
  beforeConclusions?: boolean;
  /** Heading of the block in the note with the same ID and alias. */
  sameAliasAs?: string;
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
 * the bracketed text, the id alone, the whole heading without brackets
 * (`USW230 Sequence Embedding alias`, or `… | alias` as the note's unit
 * operation list shows it), or the alias alone (#311). Case-insensitive.
 */
function matchesParentHeading(parent: string, wanted: string): boolean {
  const p = parent.trim().toLowerCase();
  const w = wanted.trim().toLowerCase();
  if (p === w) return true;
  const unitOp = p.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!unitOp) return false;
  const inner = unitOp[1].trim();
  const alias = unitOp[2].trim();
  if (inner === w || inner.split(/\s+/)[0] === w) return true;
  const loose = (text: string) => text.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  return loose(p) === loose(w) || (alias !== '' && alias === w);
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

/** How much of a note or section `read_section` returns; the rest is reported as `truncated`. */
const READ_SECTION_LIMIT = 20000;

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
  /** `mode: "append"`: {@link content} is the current body with the new text after it (#554). */
  append: boolean;
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
): Promise<ResolvedSectionTarget | ToolError> {
  const call = await resolveSectionCall(ctx, args);
  if ('error' in call) return call;
  return sectionTargetIn(call, await ctx.fs.read(call.documentPath), args);
}

/** An `update_section` call checked for itself, before the note is read. */
interface SectionCall {
  documentPath: string;
  heading: string;
  content: string;
  append: boolean;
}

async function resolveSectionCall(ctx: ToolContext, args: Record<string, unknown>): Promise<SectionCall | ToolError> {
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
  const mode = args.mode;
  if (mode !== undefined && mode !== 'replace' && mode !== 'append') {
    return { error: 'mode must be "replace" or "append"; nothing was written.' };
  }
  const append = mode === 'append';
  const clear = args.clear === true;
  if (append && clear) {
    return { error: 'clear: true empties the section, which mode "append" never does. Send one or the other.' };
  }
  const blank = rawContent.trim() === '';
  if (blank && append) return { error: 'content is empty, so there is nothing to append; nothing was written.' };
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
  if (!(await ctx.fs.exists(documentPath))) {
    return { error: `File not found: ${documentPath}` };
  }
  return { documentPath, heading, content, append };
}

/** The one target section of `call` in the note `md`, and the body to write there. */
function sectionTargetIn(call: SectionCall, md: string, args: Record<string, unknown>): ResolvedSectionTarget | ToolError {
  const { documentPath, heading, content, append } = call;
  const found = pickSection(md, heading, args);
  if ('error' in found) return found;
  const { target, index, total } = found;
  if (content === '') return { documentPath, heading, content, md, target, index, total, append };
  // Content that starts with the section's own heading would repeat it (#162).
  const targetText = md.split(/\r?\n/)[target.line].replace(/^#{1,6}\s+/, '');
  const body = stripRepeatedHeading(content, targetText);
  if (body.trim() === '') {
    return { error: 'content only repeats the section heading; nothing was written. Send the body without the heading.' };
  }
  // A heading as high as the target's would end the section there and start a new one (#334).
  const sibling = listHeadings(body).find(h => h.level <= target.level);
  if (sibling) {
    return {
      error:
        `content has the heading "${'#'.repeat(sibling.level)} ${sibling.text}", which would start a new section after "${heading}"; nothing was written. ` +
        `Send only the body, or use deeper headings (${'#'.repeat(Math.min(target.level + 1, 6))} or more) inside it.`,
    };
  }
  if (!append) return { documentPath, heading, content: body, md, target, index, total, append };
  const existing = sectionBodyAt(md, target.line)?.text ?? '';
  const added = body.replace(/^\s*\n/, '').trimEnd();
  return {
    documentPath,
    heading,
    content: existing ? `${existing}\n\n${added}` : added,
    md,
    target,
    index,
    total,
    append,
  };
}

/**
 * The one section of `md` named `heading` that `args.parentHeading` and
 * `args.occurrence` pick, or an error listing the candidates. Shared by
 * `update_section` and `read_section` so both resolve a heading the same way.
 */
function pickSection(
  md: string,
  heading: string,
  args: Record<string, unknown>
): { target: SectionMatch; index: number; total: number } | ToolError {
  const parentHeading = str(args, 'parentHeading');
  const occurrence = args.occurrence;
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || (occurrence as number) < 1)) {
    return { error: 'occurrence must be a positive integer (1-based)' };
  }
  const all = findSectionMatches(md, heading);
  if (all.length === 0) return { error: sectionNotFound(md, heading), code: 'section_not_found', params: [heading] };

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
  return { target: candidates[index], index, total: candidates.length };
}

/** Levenshtein distance of `a` and `b`, giving up past `max` (returns `max + 1`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The item whose `id` is `raw` (#335): trimmed, exactly when one matches,
 * else ignoring case. Models write `uhw010` for `UHW010`.
 */
function findIdIgnoringCase<T extends { id: string }>(items: readonly T[], raw: string): T | undefined {
  const id = raw.trim();
  const lower = id.toLowerCase();
  return items.find(i => i.id === id) ?? items.find(i => i.id.toLowerCase() === lower);
}

/** Most IDs {@link similarIds} suggests. */
const SIMILAR_ID_LIMIT = 5;

/**
 * IDs among `ids` close to `raw`, for a "not found" error (#335): within two
 * edits, case aside, or with `byPrefix`, sharing its letters and first digit
 * (`UHW25` → `UHW250`). Sample IDs all share their type, so they skip that.
 */
function similarIds(ids: readonly string[], raw: string, byPrefix: boolean): string[] {
  const wanted = raw.trim().toLowerCase();
  const prefix = byPrefix ? /^[a-z]+\d/.exec(wanted)?.[0] : undefined;
  return ids
    .map(id => {
      const lower = id.toLowerCase();
      const distance = editDistance(lower, wanted, 2);
      // Prefix matches first, the closest of them first; then the near misses.
      const rank = prefix !== undefined && lower.startsWith(prefix) ? distance - 10 : distance;
      return { id, rank, near: rank < 0 || distance <= 2 };
    })
    .filter(c => c.near)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SIMILAR_ID_LIMIT)
    .map(c => c.id);
}

/** `message`, with the IDs close to `raw` when there are any. */
function notFoundWithSuggestions(message: string, ids: readonly string[], raw: string, byPrefix = true): string {
  const similar = similarIds(ids, raw, byPrefix);
  return similar.length > 0 ? `${message}. Did you mean: ${similar.join(', ')}?` : message;
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
): Promise<ResolvedSampleCreate | ToolError> {
  const rawType = str(args, 'type');
  const documentPath = safePath(ctx, args, 'documentPath');
  if (!documentPath) {
    const outside = outsideVaultError(args, 'documentPath');
    if (outside) return { error: outside.error! };
  }
  if (!rawType || !documentPath) return { error: 'type and documentPath are required' };
  // A type missing from the settings would be saved where no view or lookup
  // reads it (#447), so it is refused as `get_sample` refuses it. Known ones
  // take their canonical spelling so `equip` and `Equip` share one file and id prefix.
  const knownTypes = getSampleDisplayMeta(ctx.customTypes).types;
  const type = canonicalSampleType(rawType, knownTypes);
  if (!type) {
    return {
      error: `Unknown sample type "${rawType}". Known types: ${knownTypes.join(', ')}. A new type must first be added to the sample types in the Labnote settings.`,
      code: 'sample_type_unknown',
      params: [rawType, knownTypes.join(', ')],
    };
  }
  const rawId = str(args, 'id');
  const id = rawId === undefined ? undefined : normalizeSampleId(type, rawId);
  if (rawId !== undefined && !id) {
    return {
      error: `Invalid id "${rawId}": expected ${type}-<number>. Omit id to generate one.`,
      code: 'sample_id_invalid',
      params: [rawId, type],
    };
  }
  const alias = str(args, 'alias');
  const aliasProblem = alias === undefined ? undefined : sampleAliasProblem(alias);
  if (aliasProblem === 'separator') {
    return {
      error: `Invalid alias "${alias}": ";" and ":" separate the id, alias and description in a note. Replace them (e.g. with "-" or "/") and retry.`,
      code: 'sample_alias_separator',
      params: [alias!],
    };
  }
  if (aliasProblem === 'markdown') {
    return {
      error: `Invalid alias "${alias}": #, [[, ]], ](, *, _ and \` are read by Markdown as a tag, link, emphasis or code. Replace them (e.g. with "-" or "/") and retry.`,
      code: 'sample_alias_markdown',
      params: [alias!],
    };
  }
  const description = str(args, 'description');
  if (description !== undefined && hasSampleDescriptionSeparator(description)) {
    return {
      error: `Invalid description "${description}": ";" ends the description in a note. Replace it (e.g. with ",") and retry.`,
      code: 'sample_desc_separator',
      params: [description],
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

/**
 * Other samples a `create_sample` call would share its alias with, in the
 * folder it writes to (#310), as the app's "Add sample" asks about. A call
 * that adds to an existing id keeps that record's own alias out.
 */
async function aliasTwins(ctx: ToolContext, resolved: ResolvedSampleCreate, id: string | undefined): Promise<string[]> {
  if (!resolved.alias) return [];
  const twins = await samplesWithAliasIn(ctx.fs, resolved.folder, resolved.type, resolved.alias);
  return twins.filter(other => other.toLowerCase() !== id?.toLowerCase());
}

const README_NAME = 'README.labnote.md';

interface ResolvedWorkflowCreate {
  labnoteDir: string;
  readmePath: string;
  info: { id: string; name: string; description: string };
  /** Per-instance alias after the catalog name, as the app's "Workflow name" prompt adds it. */
  alias?: string;
  fileName: string;
  /** As in the app's alias prompt: a workflow file with this ID and alias already (#484). */
  sameAliasAs?: string;
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
): Promise<ResolvedWorkflowCreate | ToolError> {
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
  const aliasProblem = workflowAliasProblem(rawAlias);
  if (aliasProblem === 'hash') {
    return {
      error: 'alias must not contain "#": links to its heading would break',
      code: 'workflow_alias_hash',
    };
  }
  if (aliasProblem === 'markdown') {
    return {
      error:
        'alias must not contain "*", or "_" next to anything but ASCII letters and digits: the reading view shows part of it in italics. Use a space instead',
      code: 'workflow_alias_markdown',
    };
  }
  // As in the app, an alias of only symbols, which leaves no file name part, is dropped.
  const alias = rawAlias && sanitizeWorkflowName(rawAlias) ? rawAlias : undefined;
  const labnoteDir = getExperimentDir(documentPath);
  if (!labnoteDir) {
    return {
      error: 'documentPath is not inside a labnote/### experiment folder',
      code: 'not_experiment_folder',
      params: [documentPath],
    };
  }
  // An experiment is its README; without one the write would create a stray
  // folder that no experiment view or automation sees.
  const readmePath = posix.join(labnoteDir, README_NAME);
  if (!(await ctx.fs.exists(readmePath))) {
    return { error: `Experiment not found: ${labnoteDir} (no ${README_NAME})` };
  }

  const seeded = ctx.workspaceRoot && !(await ctx.fs.exists(getWorkflowFilePath(ctx.workspaceRoot, 'workflows')));
  const workflows = seeded ? WORKFLOWS_CATALOG.workflows : (await loadWorkflows(ctx.fs, ctx.workspaceRoot)).workflows;
  const wf = findIdIgnoringCase(workflows, workflowId);
  if (!wf) {
    return {
      error: notFoundWithSuggestions(
        `Workflow not found: ${workflowId}`,
        workflows.map(w => w.id),
        workflowId
      ),
    };
  }

  const info = { id: wf.id, name: wf.name, description: wf.description };
  const names = await ctx.fs.list(labnoteDir);
  const sequence = getNextWorkflowNumber(names);
  const labels = workflowChecklistLabels(await ctx.fs.read(readmePath));
  const sameAliasAs = findSameAliasWorkflow(names, info.id, info.name, alias ?? '', labels);
  return {
    labnoteDir,
    readmePath,
    info,
    alias,
    fileName: createWorkflowFileName(sequence, info, alias),
    ...(sameAliasAs ? { sameAliasAs } : {}),
  };
}

/** A unit operation catalog, read only: the bundled one while the vault has no copy yet. */
async function unitOpCatalog(ctx: ToolContext, type: 'hw' | 'sw'): Promise<UnitOperationItem[]> {
  const file = getWorkflowFilePath(ctx.workspaceRoot, type === 'hw' ? 'unitoperations_hw' : 'unitoperations_sw');
  if (ctx.workspaceRoot && !(await ctx.fs.exists(file))) {
    return (type === 'hw' ? UNIT_OPERATIONS_HW_CATALOG : UNIT_OPERATIONS_SW_CATALOG).unitOperations;
  }
  return (await loadUnitOperations(ctx.fs, ctx.workspaceRoot, type)).unitOperations;
}

interface ResolvedUnitOpInsert {
  documentPath: string;
  md: string;
  op: UnitOperationItem;
  opType: 'hw' | 'sw';
  alias?: string;
  at: UnitOpInsertPoint;
  sameAliasAs?: string;
}

/**
 * Validate an `insert_unit_operation` call (#491), so the handler and the
 * approval preview agree on the block and its place. Reads only, like
 * {@link resolveWorkflowCreate}: the catalog files are seeded by the handler,
 * after the user allows the write.
 */
async function resolveUnitOpInsert(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ResolvedUnitOpInsert | ToolError> {
  const call = await resolveUnitOpCall(ctx, args);
  if ('error' in call) return call;
  return { ...call, ...unitOpInsertIn(call, await ctx.fs.read(call.documentPath)) };
}

/** An `insert_unit_operation` call checked for itself, before the note is read. */
type UnitOpCall = Pick<ResolvedUnitOpInsert, 'documentPath' | 'op' | 'opType' | 'alias'>;

async function resolveUnitOpCall(ctx: ToolContext, args: Record<string, unknown>): Promise<UnitOpCall | ToolError> {
  const documentPath = safePath(ctx, args, 'documentPath');
  const opId = str(args, 'opId');
  if (!documentPath) {
    const outside = outsideVaultError(args, 'documentPath');
    if (outside) return { error: outside.error! };
  }
  if (!documentPath || !opId) return { error: 'documentPath and opId are required' };
  const where = diagnoseWorkflowPath(documentPath);
  if (where.kind === 'readme') {
    return {
      error:
        'documentPath is the experiment README, which holds no unit operations. Use one of its workflow notes (###_….labnote.md), or make one with create_workflow',
      code: 'unit_op_readme',
      params: [documentPath],
    };
  }
  if (where.kind === 'notWorkflow') {
    return {
      error:
        'documentPath is not a workflow note: unit operations go into a ###_….labnote.md note directly in an experiment folder',
      code: 'not_workflow_note',
      params: [documentPath],
    };
  }
  if (where.kind !== 'ok') {
    return {
      error: 'documentPath is not inside a labnote/### experiment folder',
      code: 'not_experiment_folder',
      params: [documentPath],
    };
  }
  if (!(await ctx.fs.exists(documentPath))) return { error: `Note not found: ${documentPath}` };
  if (args.alias !== undefined && typeof args.alias !== 'string') return { error: 'alias must be a string' };
  const alias = typeof args.alias === 'string' ? args.alias.trim() : '';
  if (/[\r\n]/.test(alias)) return { error: 'alias must be a single line' };
  const aliasProblem = workflowAliasProblem(alias);
  if (aliasProblem === 'hash') {
    return { error: 'alias must not contain "#": links to its heading would break', code: 'workflow_alias_hash' };
  }
  if (aliasProblem === 'markdown') {
    return {
      error:
        'alias must not contain "*", or "_" next to anything but ASCII letters and digits: the reading view shows part of it in italics. Use a space instead',
      code: 'workflow_alias_markdown',
    };
  }

  const hw = await unitOpCatalog(ctx, 'hw');
  const sw = await unitOpCatalog(ctx, 'sw');
  const foundHw = findIdIgnoringCase(hw, opId);
  const op = foundHw ?? findIdIgnoringCase(sw, opId);
  if (!op) {
    return {
      error: notFoundWithSuggestions(
        `Unit operation not found: ${opId}`,
        [...hw, ...sw].map(o => o.id),
        opId
      ),
    };
  }
  return { documentPath, op, opType: foundHw ? 'hw' : 'sw', ...(alias ? { alias } : {}) };
}

/** Where in the note `text` the block of `call` goes, and the block of the same ID and alias there. */
function unitOpInsertIn(call: UnitOpCall, text: string): Pick<ResolvedUnitOpInsert, 'md' | 'at' | 'sameAliasAs'> {
  const { op, alias } = call;
  // A deleted section heading is put back first, so the preview shows where the block really goes (#564).
  const md = ensureUnitOpSection(text);
  const twin = findSameAliasUnitOp(listUnitOpBlocks(md), op.id, op.name, alias ?? '');
  return {
    md,
    at: findUnitOpInsertPointAt(md, md.length),
    ...(twin ? { sameAliasAs: `[${twin.opId} ${twin.opName}]${twin.alias ? ` ${twin.alias}` : ''}` } : {}),
  };
}

async function findUnitOp(
  ctx: ToolContext,
  opId: string
): Promise<{ op: UnitOperationItem; opType: 'hw' | 'sw' } | { similar: string[] }> {
  await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
  const hw = await loadUnitOperations(ctx.fs, ctx.workspaceRoot, 'hw');
  const found = findIdIgnoringCase(hw.unitOperations, opId);
  if (found) return { op: found, opType: 'hw' };
  const sw = await loadUnitOperations(ctx.fs, ctx.workspaceRoot, 'sw');
  const foundSw = findIdIgnoringCase(sw.unitOperations, opId);
  if (foundSw) return { op: foundSw, opType: 'sw' };
  return { similar: [...hw.unitOperations, ...sw.unitOperations].map(o => o.id) };
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
        'Look up a stored sample definition by type and id, searching the document-local labsamples folder then the vault-global one; without documentPath, every experiment\'s local labsamples folder is searched after the global one. The result says where it was found (`scope` local/global, `experiment` folder for a local sample). A discarded sample whose location was emptied keeps the old one in `discardedLocation`. When the host can search notes, `usages` lists the vault paths of the notes that use the sample found (`sources` is only where it was defined or recorded).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Sample type, e.g. DNA, RNA, Plasmid.' },
          id: { type: 'string', description: 'Sample id, e.g. DNA-12 (case-insensitive).' },
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

        // `dna-1` and ` DNA-1` name DNA-1 too (#335); the stored key is what is reported.
        const key = normalizeSampleId(type.type, id) ?? id.trim();
        const seen: string[] = [];
        for (const { folder, scope, experiment } of folders) {
          const records = await loadSamplesByType(ctx.fs, folder, type.type);
          const hit = findRecordIgnoringCase(records, key);
          if (!hit) {
            seen.push(...Object.keys(records));
            continue;
          }
          const [storedId, record] = hit;
          const data = { ...record, id: storedId, scope, experiment };
          if (!ctx.findSampleUsages) return { ok: true, data };
          const usages = await ctx.findSampleUsages(folder, type.type, storedId);
          return { ok: true, data: { ...data, usages } };
        }
        return {
          ok: false,
          error: notFoundWithSuggestions(`Sample not found: ${type.type}/${id}`, [...new Set(seen)], key, false),
        };
      },
    },

    {
      name: 'list_samples',
      mutates: false,
      description:
        'List all stored samples of a given type. With documentPath, that note\'s experiment-local samples are merged over the global ones; without it, the global samples come first and then every experiment\'s local ones, each listed separately (the same id may appear in several experiments). Each entry gives its `scope` (local/global) and `experiment` folder for a local sample.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          documentPath: {
            type: 'string',
            description:
              'Vault-relative path of a note: lists its experiment\'s local samples merged over the global ones. Omit to list every experiment.',
          },
        },
        required: ['type'],
      },
      async handler(ctx, args) {
        const rawType = str(args, 'type');
        if (!rawType) return { ok: false, error: 'type is required' };
        const type = resolveSampleType(ctx, rawType);
        if (!type.ok) return type.error;
        const documentPath = safePath(ctx, args, 'documentPath');

        type Entry = { id: string; rec: SampleRecord; scope: 'local' | 'global'; experiment: string | null };
        const entries: Entry[] = [];
        if (documentPath) {
          const merged: Record<string, Entry> = {};
          const scopes = sampleScopes(ctx, noteLabsamplesFolder(documentPath, ctx.globalSampleFolder)).reverse();
          for (const { folder, scope, experiment } of scopes) {
            for (const [id, rec] of Object.entries(await loadSamplesByType(ctx.fs, folder, type.type))) {
              merged[id] = { id, rec, scope, experiment };
            }
          }
          entries.push(...Object.values(merged));
        } else {
          for (const { folder, scope, experiment } of [...sampleScopes(ctx), ...(await experimentSampleScopes(ctx))]) {
            for (const [id, rec] of Object.entries(await loadSamplesByType(ctx.fs, folder, type.type))) {
              entries.push({ id, rec, scope, experiment });
            }
          }
        }
        const data = entries.map(({ id, rec, scope, experiment }) => ({
          id,
          alias: rec.alias,
          description: rec.descriptions?.[0] ?? null,
          location: rec.location ?? null,
          scope,
          experiment,
          ...(rec.discarded ? { discarded: rec.discarded } : {}),
          ...(rec.discardedLocation ? { discardedLocation: rec.discardedLocation } : {}),
        }));
        return { ok: true, data };
      },
    },

    {
      name: 'search_samples',
      mutates: false,
      description:
        'Search the samples of every type in the global labsamples folder and every experiment\'s local one for `query` in the id, alias, storage location or descriptions (case-insensitive; `_`, `:` and `;` match `-`, and `#`, `*`, `[[`, `]]` are ignored, as in aliases, so a name written `lacZ_F1` in a note finds the alias `lacZ-F1`). Each match gives its type, `scope` (local/global), `experiment` folder for a local sample and `discarded` date if it was marked discarded (with `discardedLocation`, the location emptied then). Use it when you do not know the type or which experiment holds a sample.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find, e.g. part of an id, alias or location.' },
          type: { type: 'string', description: 'Only this sample type (optional).' },
        },
        required: ['query'],
      },
      async handler(ctx, args) {
        const raw = str(args, 'query')?.trim();
        if (!raw) return { ok: false, error: 'query is required' };
        const query = normalizeSampleSearch(raw);
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
              if (!haystack.some(h => normalizeSampleSearch(h).includes(query))) continue;
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
                ...(rec.discardedLocation ? { discardedLocation: rec.discardedLocation } : {}),
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
        if ('error' in resolved) return { ok: false, ...resolved };
        const { documentPath, type, alias, description, location, folder, scope } = resolved;
        const id = resolved.id ?? generateSampleId(type);
        const twins = await aliasTwins(ctx, resolved, id);

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
        if (twins.length > 0) {
          warnings.push(
            `The alias "${alias}" was already used by ${twins.join(', ')} in ${folder}; both now show the same text in autocomplete. If it is the same sample, reference ${twins[0]} instead of ${id}.`
          );
        }
        if (warnings.length) result.warnings = warnings;
        return result;
      },
      async describe(ctx, args) {
        const resolved = await resolveSampleCreate(ctx, args);
        if ('error' in resolved) return resolved;
        const { type, id, alias, location, folder, scope } = resolved;
        const existing = id !== undefined && (await loadSamplesByType(ctx.fs, folder, type))[id] !== undefined;
        const twins = await aliasTwins(ctx, resolved, id);
        return {
          kind: 'sampleCreate',
          type,
          id,
          existing,
          alias,
          location,
          folder,
          scope,
          ...(twins.length > 0 ? { aliasTwins: twins } : {}),
        };
      },
    },

    {
      name: 'get_unit_operation',
      // Seeds the workflow catalog on first use, which is invisible to the user.
      mutates: false,
      description: 'Return catalog metadata (name, description, equipment/software) for a unit-operation id.',
      inputSchema: {
        type: 'object',
        properties: { opId: { type: 'string', description: 'e.g. UHW010 or USW020 (case-insensitive).' } },
        required: ['opId'],
      },
      async handler(ctx, args) {
        const opId = str(args, 'opId');
        if (!opId) return { ok: false, error: 'opId is required' };
        const found = await findUnitOp(ctx, opId);
        if ('similar' in found) {
          return { ok: false, error: notFoundWithSuggestions(`Unit operation not found: ${opId}`, found.similar, opId) };
        }
        return { ok: true, data: { ...found.op, opType: found.opType } };
      },
    },

    {
      name: 'read_section',
      mutates: false,
      description:
        'Read a Markdown note in the vault: with heading, the body of that section (nested headings included), found as update_section finds it; without heading, the whole note and its headings. ' +
        'Use it before update_section to see what a section holds, e.g. to add a comment with mode "append" instead of replacing what others wrote.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: 'Vault-relative path of a .md note.' },
          heading: { type: 'string', description: 'Heading text without the leading #s, e.g. "Method". Omit to read the whole note.' },
          parentHeading: {
            type: 'string',
            description: 'Enclosing heading of the section, as for update_section, when the heading repeats.',
          },
          occurrence: {
            type: 'integer',
            minimum: 1,
            description: '1-based position among the matching sections, counted after the parentHeading filter.',
          },
        },
        required: ['documentPath'],
      },
      async handler(ctx, args) {
        const documentPath = safePath(ctx, args, 'documentPath');
        if (!documentPath) return outsideVaultError(args, 'documentPath') ?? { ok: false, error: 'documentPath is required' };
        // Plugin settings (with tokens and keys) live in dot folders; notes do not.
        if (!documentPath.toLowerCase().endsWith('.md') || documentPath.split('/').some(s => s.startsWith('.'))) {
          return { ok: false, error: `Only Markdown notes can be read, not ${documentPath}` };
        }
        if (!(await ctx.fs.exists(documentPath))) return { ok: false, error: `File not found: ${documentPath}` };
        const md = await ctx.fs.read(documentPath);
        const clip = (text: string) =>
          text.length > READ_SECTION_LIMIT ? { text: text.slice(0, READ_SECTION_LIMIT), truncated: true } : { text, truncated: false };
        const heading = str(args, 'heading');
        if (!heading) {
          const { text, truncated } = clip(md);
          return {
            ok: true,
            data: {
              documentPath,
              headings: listHeadings(md).map(h => `${'#'.repeat(h.level)} ${h.text}`),
              content: text,
              truncated,
            },
          };
        }
        const found = pickSection(md, heading, args);
        if ('error' in found) return { ok: false, ...found };
        const body = sectionBodyAt(md, found.target.line);
        const { text, truncated } = clip(body?.text ?? '');
        return {
          ok: true,
          data: {
            documentPath,
            heading,
            parentHeading: found.target.parentHeading,
            occurrence: found.index + 1,
            total: found.total,
            line: found.target.line + 1,
            lines: body?.lines ?? 0,
            subheadings: body?.subheadings ?? 0,
            content: text,
            truncated,
          },
        };
      },
    },

    {
      name: 'update_section',
      mutates: true,
      description:
        'Replace the body of a section (matched by heading text at any level) in a note, without re-serializing the rest of the document. ' +
        'README headings may carry emoji (e.g. "## 🧪 Related Workflows"); when no heading matches exactly, emoji, square brackets, case and extra spaces are ignored. ' +
        'Send only the body: a first or last line repeating the section heading is dropped, and a heading as high as the section\'s own is refused, since it would start a new section (use deeper headings inside the body). ' +
        'Workflow notes repeat headings such as "Method" under every unit operation: when the heading occurs more than once, pass parentHeading and/or occurrence, ' +
        'otherwise nothing is written and the error lists the candidates. ' +
        'By default the whole body is replaced, nested headings included; the result reports what was removed (removedLines, removedSubheadings, previousBody). ' +
        'With mode "append", content is added after the current body (after any nested headings) and nothing is removed. Read the section first with read_section.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string' },
          heading: { type: 'string', description: 'Heading text without the leading #s, e.g. "Method".' },
          content: {
            type: 'string',
            description:
              'New Markdown body for the section, or with mode "append" the text to add at its end. Empty or whitespace-only content is rejected unless clear is true.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: '"replace" (default) swaps the whole body; "append" keeps it and adds content after it.',
          },
          clear: {
            type: 'boolean',
            description: 'Set to true, with content "", to empty the section on purpose.',
          },
          parentHeading: {
            type: 'string',
            description:
              'Enclosing heading of the target section: its full text, the unit operation without brackets ("USW230 Sequence Embedding"), or just the unit operation id ("USW230"). ' +
              'A unit operation added twice is told apart by its alias: "USW230 Sequence Embedding rerun", "USW230 Sequence Embedding | rerun" (as the note\'s unit operation list shows it) or the alias alone ("rerun").',
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
        const call = await resolveSectionCall(ctx, args);
        if ('error' in call) return { ok: false, ...call };
        // Found and replaced in the note as it is when written: typing not saved yet included.
        const done = await changeNote(ctx, call.documentPath, md => {
          const resolved = sectionTargetIn(call, md, args);
          if ('error' in resolved) throw new NoteChangeRefused(resolved);
          const { ok, md: next, removed } = replaceSectionBodyAt(md, resolved.target.line, resolved.content);
          if (!ok) throw new NoteChangeRefused({ error: `Section not found: ${call.heading}` });
          return { text: next, data: { ...resolved, removed } };
        });
        if ('error' in done) return { ok: false, ...done };
        const { documentPath, heading, target, index, total, append, removed } = done.data;
        return {
          ok: true,
          data: {
            documentPath,
            heading,
            parentHeading: target.parentHeading,
            occurrence: index + 1,
            total,
            mode: append ? 'append' : 'replace',
            removedLines: append ? 0 : (removed?.lines ?? 0),
            removedSubheadings: append ? 0 : (removed?.subheadings ?? 0),
            previousBody: append ? '' : (removed?.text ?? '').slice(0, PREVIOUS_BODY_LIMIT),
          },
        };
      },
      async describe(ctx, args) {
        const resolved = await resolveSectionTarget(ctx, args);
        if ('error' in resolved) return resolved;
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
          removedSubheadings: resolved.append ? 0 : (body?.subheadings ?? 0),
          ...(resolved.append ? { appending: true } : {}),
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
          workflowId: { type: 'string', description: 'Catalog workflow id, e.g. WD010 (case-insensitive).' },
          alias: {
            type: 'string',
            description:
              'Optional name for this workflow instance, added after the catalog name. Must not contain "#" or "*", nor "_" except between ASCII letters and digits; use spaces between words.',
          },
        },
        required: ['documentPath', 'workflowId'],
      },
      async handler(ctx, args) {
        const resolved = await resolveWorkflowCreate(ctx, args);
        if ('error' in resolved) return { ok: false, ...resolved };
        const { labnoteDir, readmePath, info, alias, fileName, sameAliasAs } = resolved;
        const withWarnings = (result: ToolResult): ToolResult =>
          sameAliasAs
            ? {
                ...result,
                warnings: [
                  `${sameAliasAs} already has the ID ${info.id} and ${alias ? `the alias "${alias}"` : 'no alias'}, so the two read the same in the README checklist. Tell the user; if it is not the same workflow, give this one its own alias.`,
                ],
              }
            : result;

        await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
        const experimenter = parseExperimenterFromReadme(await ctx.fs.read(readmePath));
        const workflowPath = posix.join(labnoteDir, fileName);
        // The new workflow file cannot be open yet, but the README very well
        // may be — both go through the hook so the host owns note writes.
        const content = createWorkflowContent(info, experimenter, alias, { locale: ctx.locale });
        // The README is written next, with what goes with a new note in it (its date): one change.
        if (!(await processNote(ctx, workflowPath, () => content, true))) {
          return { ok: false, ...noteNotWritten(workflowPath) };
        }

        const title = [info.id, info.name, alias].filter(Boolean).join(' ');
        // A README whose section was renamed beyond recognition lists nothing (#298).
        const listed = await changeNote(ctx, readmePath, readme => {
          if (!hasWorkflowChecklistSection(readme)) throw new NoteLeft(false);
          return { text: insertWorkflowChecklistEntries(readme, [{ done: false, title, fileName }]), data: true };
        });
        if ('error' in listed) {
          return withWarnings({
            ok: true,
            data: { path: workflowPath, fileName, registered: false, warning: listed.error },
          });
        }
        if (!listed.data) {
          // Not listed: the README gets only what goes with the new note in it.
          await processNote(ctx, readmePath, text => text);
          return withWarnings({
            ok: true,
            data: {
              path: workflowPath,
              fileName,
              registered: false,
              warning:
                'The README has no "Related Workflows" section, so the workflow was not added to its checklist. Tell the user.',
            },
          });
        }
        return withWarnings({ ok: true, data: { path: workflowPath, fileName, registered: true } });
      },
      async describe(ctx, args) {
        const resolved = await resolveWorkflowCreate(ctx, args);
        if ('error' in resolved) return resolved;
        return {
          kind: 'workflowCreate',
          workflowId: resolved.info.id,
          workflowName: resolved.info.name,
          fileName: resolved.fileName,
          readmePath: resolved.readmePath,
          ...(resolved.sameAliasAs ? { sameAliasAs: resolved.sameAliasAs } : {}),
        };
      },
    },

    {
      name: 'insert_unit_operation',
      mutates: true,
      description:
        'Add a unit operation block from the catalog to a workflow note (###_….labnote.md), after its last unit operation, and update the note\'s unit operation list. ' +
        'The block has the template sections with placeholder lines and the experimenter and start date filled in, as the app\'s "Insert unit operation" makes it. ' +
        'Then fill its sections with update_section, passing the returned parentHeading so a unit operation already in the note is not edited instead. ' +
        'An optional alias names this instance (e.g. "rerun"): it follows the catalog name in the heading.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: 'The workflow note, e.g. labnote/001_Exp/001_WD010_Design.labnote.md.' },
          opId: { type: 'string', description: 'Catalog unit operation id, e.g. UHW010 or USW020 (case-insensitive).' },
          alias: {
            type: 'string',
            description:
              'Optional name for this unit operation, added after the catalog name in the heading. Must not contain "#" or "*", nor "_" except between ASCII letters and digits.',
          },
        },
        required: ['documentPath', 'opId'],
      },
      async handler(ctx, args) {
        const call = await resolveUnitOpCall(ctx, args);
        if ('error' in call) return { ok: false, ...call };
        const { documentPath, op, opType, alias } = call;

        await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
        // The note's own experimenter first, then the README author, as in the app (#404).
        const readmePath = posix.join(posix.dirname(documentPath), README_NAME);
        const author = (await ctx.fs.exists(readmePath)) ? parseExperimenterFromReadme(await ctx.fs.read(readmePath)) : '';
        const info = {
          opId: op.id,
          opName: op.name,
          opDescription: op.description ?? '',
          descriptionExtra: alias ? ` ${alias}` : undefined,
        };
        const dateTime = getSeoulDateTimeString();
        // Placed in the note as it is when written: typing not saved yet included.
        const done = await changeNote(ctx, documentPath, text => {
          const { md, at, sameAliasAs } = unitOpInsertIn(call, text);
          const meta = { experimenter: parseExperimenterFromNote(md) || author, dateTime };
          const block =
            opType === 'sw'
              ? buildSwUnitOpMarkdown(info, { ...meta, software: op.software })
              : buildHwUnitOpMarkdown(info, { ...meta, equipment: op.equipment });
          const inserted = md.slice(0, at.offset) + block + md.slice(at.offset);
          const next = syncUnitOpTocAfterInsert(inserted, at.offset, ctx.sortUnitOpToc ?? true);
          return { text: next, data: { at, sameAliasAs, next } };
        });
        if ('error' in done) return { ok: false, ...done };
        const { at, sameAliasAs, next } = done.data;

        const heading = `[${op.id} ${op.name}]${alias ? ` ${alias}` : ''}`;
        return {
          ok: true,
          data: {
            documentPath,
            heading,
            opType,
            place: at.place,
            ...(at.after ? { after: at.after } : {}),
            tocUpdated: unitOpSectionLine(next) !== -1,
            parentHeading: heading,
            sectionsToFill: opType === 'sw' ? ['Method', 'Discussion'] : ['Method', 'Results & Discussions'],
          },
          ...(sameAliasAs
            ? {
                warnings: [
                  `${sameAliasAs} is already in this note with the same ID and ${alias ? `alias "${alias}"` : 'no alias'}, so the two read the same in the headings and the unit operation list, and update_section needs occurrence to tell them apart. Tell the user; if it is not a repeat, give this one its own alias.`,
                ],
              }
            : {}),
        };
      },
      async describe(ctx, args) {
        const resolved = await resolveUnitOpInsert(ctx, args);
        if ('error' in resolved) return resolved;
        const { at } = resolved;
        return {
          kind: 'unitOpInsert',
          documentPath: resolved.documentPath,
          opId: resolved.op.id,
          opName: resolved.op.name,
          ...(resolved.alias ? { alias: resolved.alias } : {}),
          opType: resolved.opType,
          place: at.place,
          ...(at.after ? { after: at.after } : {}),
          ...(at.beforeConclusions ? { beforeConclusions: true } : {}),
          ...(resolved.sameAliasAs ? { sameAliasAs: resolved.sameAliasAs } : {}),
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
function unsupportedArgs(tool: ToolDef, args: unknown): { unsupported: string[]; supported: string } | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const keys = Object.keys(tool.inputSchema.properties);
  const unsupported = Object.keys(args).filter(k => !keys.includes(k));
  return unsupported.length === 0 ? undefined : { unsupported, supported: keys.join(', ') || '(none)' };
}

function unsupportedArgsWarning(tool: ToolDef, args: unknown): string | undefined {
  const found = unsupportedArgs(tool, args);
  if (!found) return undefined;
  return `Ignored unsupported argument(s): ${found.unsupported.join(', ')}. Supported: ${found.supported}.`;
}

/**
 * A mutating call with arguments its schema does not declare is refused
 * before it is put to the user (#554): an ignored `mode: "append"` turned an
 * append into a replace the user was asked to allow.
 */
function unsupportedWriteArgsError(tool: ToolDef, args: unknown): ToolError | undefined {
  const found = tool.mutates ? unsupportedArgs(tool, args) : undefined;
  if (!found) return undefined;
  return {
    error: `Unsupported argument(s): ${found.unsupported.join(', ')}; nothing was written. Supported: ${found.supported}.`,
  };
}

/**
 * What a mutating call would change ({@link ToolDef.describe}), or the error
 * it would fail with, unsupported arguments included. Hosts call this before
 * asking the user.
 */
export async function previewTool(
  tool: ToolDef,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolPreview | undefined> {
  const refused = unsupportedWriteArgsError(tool, args);
  if (refused) return refused;
  return tool.describe ? await tool.describe(ctx, args) : undefined;
}

/**
 * Invoke a tool by name; returns a structured {@link ToolResult}. A read
 * tool's unsupported arguments are reported in `warnings`; a mutating tool
 * refuses them without writing (see {@link unsupportedWriteArgsError}).
 */
export async function runTool(
  tools: ToolDef[],
  name: string,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const refused = unsupportedWriteArgsError(tool, args);
  if (refused) return { ok: false, ...refused };
  let result: ToolResult;
  try {
    result = await tool.handler(ctx, args);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const warning = unsupportedArgsWarning(tool, args);
  return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
}
