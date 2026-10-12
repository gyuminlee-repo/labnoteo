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
  type SampleRecord,
} from '../lib/sampleStorage';
import { generateSampleId } from '../lib/sampleUtils';
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
import { replaceSectionBody } from '../sections/sectionEdit';
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
          id: { type: 'string', description: 'Optional; auto-generated when omitted.' },
          alias: { type: 'string' },
          description: { type: 'string' },
          location: {
            type: 'string',
            description:
              'Storage location, e.g. "Freezer-2 / Box-3 / A1". Omit (or leave empty) to keep the existing one.',
          },
          documentPath: { type: 'string', description: 'Note the sample belongs to (defines the folder + source).' },
        },
        required: ['type', 'documentPath'],
      },
      async handler(ctx, args) {
        const type = str(args, 'type');
        const documentPath = safePath(ctx, args, 'documentPath');
        if (!type || !documentPath) return { ok: false, error: 'type and documentPath are required' };

        const folder = getLabsamplesFolder(documentPath);
        const id = str(args, 'id') ?? generateSampleId(type);
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
        return { ok: true, data: { id, type } };
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
        'Replace the body of a section (matched by heading text at any level) in a note, without re-serializing the rest of the document.',
      inputSchema: {
        type: 'object',
        properties: {
          documentPath: { type: 'string' },
          heading: { type: 'string', description: 'Heading text without the leading #s, e.g. "Method".' },
          content: { type: 'string', description: 'New Markdown body for the section.' },
        },
        required: ['documentPath', 'heading', 'content'],
      },
      async handler(ctx, args) {
        const documentPath = safePath(ctx, args, 'documentPath');
        const heading = str(args, 'heading');
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (!documentPath || !heading || content === undefined) {
          return { ok: false, error: 'documentPath, heading and content are required' };
        }
        if (!(await ctx.fs.exists(documentPath))) {
          return { ok: false, error: `File not found: ${documentPath}` };
        }
        const md = await ctx.fs.read(documentPath);
        const { ok, md: next } = replaceSectionBody(md, heading, content);
        if (!ok) return { ok: false, error: `Section not found: ${heading}` };
        await writeNote(ctx, documentPath, next);
        return { ok: true, data: { documentPath, heading } };
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
        if (!documentPath || !workflowId) {
          return { ok: false, error: 'documentPath and workflowId are required' };
        }
        const labnoteDir = getExperimentDir(documentPath);
        if (!labnoteDir) {
          return { ok: false, error: 'documentPath is not inside a labnote/### experiment folder' };
        }

        await ensureWorkflowResources(ctx.fs, ctx.workspaceRoot);
        const catalog = await loadWorkflows(ctx.fs, ctx.workspaceRoot);
        const wf = catalog.workflows.find(w => w.id === workflowId);
        if (!wf) return { ok: false, error: `Workflow not found: ${workflowId}` };

        const readmePath = posix.join(labnoteDir, README_NAME);
        let experimenter = '';
        if (await ctx.fs.exists(readmePath)) {
          experimenter = parseExperimenterFromReadme(await ctx.fs.read(readmePath));
        }

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

        if (await ctx.fs.exists(readmePath)) {
          const readme = await ctx.fs.read(readmePath);
          const items = parseWorkflowChecklistFromReadme(readme);
          items.push({ done: false, title: `${wf.id} ${wf.name}`, fileName });
          await writeNote(
            ctx,
            readmePath,
            updateReadmeWorkflowSection(readme, generateWorkflowChecklist(items))
          );
        }

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
