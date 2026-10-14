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
  upsertSampleRecord,
  getLabsamplesFolder,
  isSameSampleFolder,
  type SampleRecord,
} from '../lib/sampleStorage';
import {
  generateSampleId,
  normalizeSampleId,
  canonicalSampleType,
  getSampleDisplayMeta,
} from '../lib/sampleUtils';
import { getExperimentDir } from '../lib/labnoteStructure';
import {
  ensureWorkflowResources,
  loadWorkflows,
  loadUnitOperations,
  type UnitOperationItem,
} from '../lib/workflowDataLoader';
import {
  getNextWorkflowNumber,
  createWorkflowFileName,
  createWorkflowContent,
  parseWorkflowChecklistFromReadme,
  generateWorkflowChecklist,
  updateReadmeWorkflowSection,
  parseExperimenterFromReadme,
} from '../lib/workflowStructure';
import {
  findSectionMatches,
  replaceSectionBodyAt,
  sectionBodyAt,
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
export type ToolPreview = { error: string } | SectionEditPreview;

/** `update_section` preview: the section that will be replaced or cleared. */
export interface SectionEditPreview {
  kind: 'sectionEdit';
  documentPath: string;
  heading: string;
  /** Enclosing heading of the target section, `''` at the top level. */
  parentHeading: string;
  /** Non-blank lines the current body holds. */
  removedLines: number;
  /** Nested headings replaced along with the body. */
  removedSubheadings: number;
  /** True when the call empties the section (`clear: true`). */
  clearing: boolean;
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
  if (all.length === 0) return { error: `Section not found: ${heading}` };

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
  return { documentPath, heading, content, md, target: candidates[index], index, total: candidates.length };
}

const README_NAME = 'README.labnote.md';

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

// --- tool definitions ------------------------------------------------------

export function createLabnoteTools(): ToolDef[] {
  return [
    {
      name: 'get_sample',
      mutates: false,
      description:
        'Look up a stored sample definition by type and id, searching the document-local labsamples folder then the vault-global one.',
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
        const type = str(args, 'type');
        const id = str(args, 'id');
        if (!type || !id) return { ok: false, error: 'type and id are required' };

        const documentPath = safePath(ctx, args, 'documentPath');
        const folders: string[] = [];
        if (documentPath) folders.push(getLabsamplesFolder(documentPath));
        if (ctx.globalSampleFolder) folders.push(ctx.globalSampleFolder);

        for (const folder of folders) {
          const records = await loadSamplesByType(ctx.fs, folder, type);
          if (records[id]) return { ok: true, data: { ...records[id], id } };
        }
        return { ok: false, error: `Sample not found: ${type}/${id}` };
      },
    },

    {
      name: 'list_samples',
      mutates: false,
      description: 'List all stored samples of a given type (local scope merged over global).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          documentPath: { type: 'string' },
        },
        required: ['type'],
      },
      async handler(ctx, args) {
        const type = str(args, 'type');
        if (!type) return { ok: false, error: 'type is required' };
        const documentPath = safePath(ctx, args, 'documentPath');

        const merged: Record<string, SampleRecord> = {};
        if (ctx.globalSampleFolder) {
          Object.assign(merged, await loadSamplesByType(ctx.fs, ctx.globalSampleFolder, type));
        }
        if (documentPath) {
          Object.assign(merged, await loadSamplesByType(ctx.fs, getLabsamplesFolder(documentPath), type));
        }
        const data = Object.entries(merged).map(([id, rec]) => ({
          id,
          alias: rec.alias,
          description: rec.descriptions?.[0] ?? null,
          location: rec.location ?? null,
        }));
        return { ok: true, data };
      },
    },

    {
      name: 'create_sample',
      mutates: true,
      description:
        'Create (or overwrite) a sample definition in the document-local labsamples folder, optionally with its storage location. Generates an id when none is given.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: {
            type: 'string',
            description:
              'Optional; auto-generated when omitted. Must be "<type>-<number>" (e.g. "Equip-3"); anything else is rejected, so omit it rather than inventing one.',
          },
          alias: { type: 'string' },
          description: { type: 'string' },
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
        const rawType = str(args, 'type');
        const documentPath = safePath(ctx, args, 'documentPath');
        if (!documentPath) {
          const outside = outsideVaultError(args, 'documentPath');
          if (outside) return outside;
        }
        if (!rawType || !documentPath) return { ok: false, error: 'type and documentPath are required' };
        // Unknown types are still accepted, as before; known ones take their
        // canonical spelling so `equip` and `Equip` share one file and id prefix.
        const type = canonicalSampleType(rawType, getSampleDisplayMeta(ctx.customTypes).types) ?? rawType;
        const rawId = str(args, 'id');
        const normalizedId = rawId === undefined ? undefined : normalizeSampleId(type, rawId);
        if (rawId !== undefined && !normalizedId) {
          return {
            ok: false,
            error: `Invalid id "${rawId}": expected ${type}-<number>. Omit id to generate one.`,
          };
        }
        // The samples folder is derived from the note's directory and created on
        // write, so a mistyped path would leave a stray folder no experiment
        // owns. A folder path passes `exists` (it is true for folders too) but
        // would put the samples in its parent, hence the `.md` check.
        if (!/\.md$/i.test(documentPath) || !(await ctx.fs.exists(documentPath))) {
          return {
            ok: false,
            error: `Note not found: ${documentPath} (documentPath must be an existing note; the sample is stored next to it)`,
          };
        }

        const folder = getLabsamplesFolder(documentPath);
        const id = normalizedId ?? generateSampleId(type);
        const alias = str(args, 'alias') ?? null;
        const description = str(args, 'description') ?? null;
        // Unlike alias/description, an absent location is kept rather than
        // overwritten, so a client that predates the field cannot wipe a
        // location entered in Obsidian by re-creating the sample.
        const location = str(args, 'location');

        // Atomic upsert (binds this note as the sample's source), replacing the
        // previous load → mutate → saveSamplesByType round-trip that raced the
        // debounced sample-sync.
        await upsertSampleRecord(ctx.fs, folder, type, id, {
          alias,
          description,
          sources: [posix.basename(documentPath)],
          location,
        });
        // A note outside any experiment (e.g. a vault-root note) resolves to the
        // same folder as the global samples; say so instead of calling it local.
        const scope =
          ctx.globalSampleFolder && isSameSampleFolder(folder, ctx.globalSampleFolder) ? 'global' : 'local';
        const result: ToolResult = { ok: true, data: { id, type, folder, scope } };
        if (scope === 'global') {
          result.warnings = [
            `${documentPath} is outside an experiment folder, so the sample was written to the global samples folder (${folder}).`,
          ];
        }
        return result;
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
        return {
          kind: 'sectionEdit',
          documentPath: resolved.documentPath,
          heading: resolved.heading,
          parentHeading: resolved.target.parentHeading,
          removedLines: body?.lines ?? 0,
          removedSubheadings: body?.subheadings ?? 0,
          clearing: resolved.content === '',
        };
      },
    },

    {
      name: 'create_workflow',
      mutates: true,
      description:
        'Create a new workflow file in an experiment folder from the catalog and register it in the README checklist.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: 'Any path inside the target labnote/### experiment folder.' },
          workflowId: { type: 'string', description: 'Catalog workflow id, e.g. WD010.' },
        },
        required: ['documentPath', 'workflowId'],
      },
      async handler(ctx, args) {
        const documentPath = safePath(ctx, args, 'documentPath');
        const workflowId = str(args, 'workflowId');
        if (!documentPath) {
          const outside = outsideVaultError(args, 'documentPath');
          if (outside) return outside;
        }
        if (!documentPath || !workflowId) {
          return { ok: false, error: 'documentPath and workflowId are required' };
        }
        const labnoteDir = getExperimentDir(documentPath);
        if (!labnoteDir) {
          return { ok: false, error: 'documentPath is not inside a labnote/### experiment folder' };
        }
        // An experiment is its README; without one the write below would
        // create a stray folder that no experiment view or automation sees.
        const readmePath = posix.join(labnoteDir, README_NAME);
        if (!(await ctx.fs.exists(readmePath))) {
          return { ok: false, error: `Experiment not found: ${labnoteDir} (no ${README_NAME})` };
        }

        await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
        const catalog = await loadWorkflows(ctx.fs, ctx.workspaceRoot);
        const wf = catalog.workflows.find(w => w.id === workflowId);
        if (!wf) return { ok: false, error: `Workflow not found: ${workflowId}` };

        const experimenter = parseExperimenterFromReadme(await ctx.fs.read(readmePath));

        const existingFiles = await ctx.fs.list(labnoteDir);
        const sequence = getNextWorkflowNumber(existingFiles);
        const info = { id: wf.id, name: wf.name, description: wf.description };
        const fileName = createWorkflowFileName(sequence, info);
        const workflowPath = posix.join(labnoteDir, fileName);
        // The new workflow file cannot be open yet, but the README very well
        // may be — both go through the hook so the host owns note writes.
        await writeNote(
          ctx,
          workflowPath,
          createWorkflowContent(info, experimenter, undefined, { locale: ctx.locale })
        );

        const readme = await ctx.fs.read(readmePath);
        const items = parseWorkflowChecklistFromReadme(readme);
        items.push({ done: false, title: `${wf.id} ${wf.name}`, fileName });
        await writeNote(
          ctx,
          readmePath,
          updateReadmeWorkflowSection(readme, generateWorkflowChecklist(items))
        );

        return { ok: true, data: { path: workflowPath, fileName } };
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
