/**
 * Obsidian command implementations.
 *
 * These are thin orchestrators: all domain logic (structure/content generation,
 * checklist parsing, TOC building, path validation) lives in `@labnoteo/core`
 * and is unit-tested there. Each command wires core functions to the
 * {@link LabnoteHost} (modals/notices) and the {@link VaultFileSystem}.
 *
 * Vault root is the empty string: core path helpers join it away, so
 * `join('', 'labnote', ...)` yields vault-relative `labnote/...` paths that the
 * adapter understands.
 */
import { TFile, type App, type Editor } from 'obsidian';
import type {
  LabnoteHost,
  WorkflowItem,
  UnitOperationItem,
  PickItem,
  InsertUnitOperationInput,
} from '@labnoteo/core';
import {
  insertUnitOperation,
  rebuildUnitOpToc,
  locateInsertedUnitOpHeading,
  findUnitOpInsertOffset,
  EXPERIMENT_STATUSES,
  generateIssueMarkerId,
  isDiscussFlagged,
  parseFrontMatterYaml,
  parseIssueMarkers,
  planIssueMarkerInsertion,
  serializeFrontMatterEntry,
  setDiscussFlag,
} from '@labnoteo/core';
import { ISSUE_SYNC_WORKFLOW_PATH } from './scaffold/assets';
import * as posix from '@labnoteo/core/posix';
import { workflowAliasModal } from './modals';
import { getObsidianLanguage } from './i18n';
import { createLabnoteStructure, getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import {
  ensureWorkflowResources,
  loadWorkflows,
  loadUnitOperations,
} from '@labnoteo/core/lib/workflowDataLoader';
import {
  getNextWorkflowNumber,
  createWorkflowFileName,
  createWorkflowContent,
  parseWorkflowChecklistFromReadme,
  generateWorkflowChecklist,
  updateReadmeWorkflowSection,
  parseExperimenterFromReadme,
  reconcileWorkflowChecklist,
  planWorkflowRenumber,
  planRenumberMoves,
  type WorkflowRename,
} from '@labnoteo/core/lib/workflowStructure';
import { removeWorkflowFromReadme } from '@labnoteo/core/lib/workflowDelete';
// Re-exported so command registration in main.ts imports every command from one
// place; the implementation lives under src/scaffold with its asset registry.
export { setupResearchAutomationCommand } from './scaffold/scaffold';
import {
  removeSourcesForDocument,
  type RemovedSampleRef,
} from '@labnoteo/core/lib/sampleStorage';

// Vault root sentinel. Core loaders treat a falsy root as "no workspace" and
// bail, so we use '.' — it is truthy yet normalises away, keeping every derived
// path clean and vault-relative (e.g. `resources/workflows/...`, `labnote/...`).
const VAULT_ROOT = '.';
const README = 'README.labnote.md';

/**
 * Resolve the target experiment folder from the active note's path. Warns and
 * returns undefined when no lab note (a file under `labnote/###_*`) is open.
 */
async function resolveLabnoteDir(app: App, host: LabnoteHost): Promise<string | undefined> {
  // Use the active *file* (not the active MarkdownView) so resolution still
  // works when focus is on a sidebar/tree, e.g. the workflow view context menu.
  const active = app.workspace.getActiveFile()?.path;
  const dir = active ? getExperimentDir(active) : undefined;
  if (!dir) {
    host.notify('warn', host.t('Open a lab note first.'));
    return undefined;
  }
  return dir;
}

/** Create a new experiment folder (labnote/###_Title) + README scaffold. */
export async function createExperimentCommand(app: App, host: LabnoteHost): Promise<void> {
  const title = await host.prompt({
    title: host.t('New experiment'),
    prompt: host.t('Experiment title'),
    validate: v => (v.trim() ? null : host.t('Title is required.')),
  });
  if (!title) return;

  const existing = await host.fs.list('labnote');
  const structure = createLabnoteStructure(VAULT_ROOT, title.trim(), existing, undefined, {
    locale: getObsidianLanguage(),
  });

  await host.fs.mkdir(structure.labnoteFolder);
  await host.fs.mkdir(structure.imagesFolder);
  await host.fs.mkdir(structure.resourcesFolder);
  await host.fs.write(structure.readmePath, structure.readmeContent);

  await host.openFile(structure.readmePath);
  host.notify('info', host.t('Experiment created: {0}', posix.basename(structure.labnoteFolder)));
}

/**
 * Change the `status` front-matter of the active experiment's README via a
 * picker.
 *
 * Thin Obsidian wiring over core domain functions: the experiment folder is
 * resolved with `getExperimentDir`, the README front matter parsed with
 * `parseFrontMatterYaml`, the value chosen from the shared `EXPERIMENT_STATUSES`
 * vocabulary, and the block re-emitted with `serializeFrontMatterEntry`. The
 * `status` key is inserted when a pre-existing note lacks it, and the original
 * body is preserved verbatim (only the front-matter block is rewritten).
 */
export async function changeExperimentStatusCommand(app: App, host: LabnoteHost): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('Open a lab note first.'));
    return;
  }

  const parsed = await readNoteForFrontMatterEdit(host, readmePath);
  if (!parsed) return;
  const { frontMatter, body } = parsed;

  const current = typeof frontMatter.status === 'string' ? frontMatter.status : undefined;
  const chosen = await host.pick(
    EXPERIMENT_STATUSES.map(status => ({
      label: status,
      description: status === current ? host.t('current') : undefined,
      value: status,
    })),
    { title: host.t('Change experiment status'), placeholder: host.t('Select a status') }
  );
  if (!chosen || chosen === current) return;

  // Set (or insert, when absent) `status`. Spreading keeps the order of the
  // existing keys and appends `status` for notes that predate the field.
  const updated = renderNote({ ...frontMatter, status: chosen }, body);

  await writeNoteThroughVault(app, host, readmePath, updated);
  host.notify('info', host.t('Experiment status changed: {0}', chosen));
}

/**
 * Insert an `@issue` marker for the selection, with a freshly generated ID.
 * Returns whether a marker was inserted.
 *
 * Discussion comes up mid-sentence while writing, so this is an editor command
 * rather than a note-level one: select the sentence that raises the question
 * and it becomes the topic; with no selection the marker is left open and the
 * cursor lands where the topic goes. Text after the selection is never pulled
 * into the marker — see {@link planIssueMarkerInsertion} for where it goes.
 * Only the primary selection is used, so one command yields one ID.
 *
 * The ID exists so the topic can be reworded later without orphaning the issue
 * it opened, which is also why it is generated rather than typed.
 */
export function insertIssueMarkerCommand(editor: Editor, host: LabnoteHost): boolean {
  // IDs are a timestamp plus a counter, so generating a duplicate is not
  // actually possible; this scan is kept only because it costs nothing.
  //
  // The real source of duplicates is copying a marker line into another note,
  // which carries the ID along and never goes through this command. Two notes
  // then point at one issue and the discussions merge silently. The pre-commit
  // hook and the server `validate` catch that, since only they see the folder.
  const doc = editor.getValue();
  const used = new Set(parseIssueMarkers(doc).markers.map(m => m.id));
  let id = generateIssueMarkerId();
  while (used.has(id)) id = generateIssueMarkerId();

  const plan = planIssueMarkerInsertion(
    doc,
    editor.posToOffset(editor.getCursor('from')),
    editor.posToOffset(editor.getCursor('to')),
    id
  );
  if ('reason' in plan) {
    host.notify(
      'warn',
      plan.reason === 'table'
        ? host.t('Issue markers cannot go inside a table. Run this on a line below the table.')
        : host.t('This line already has an issue marker. A line can hold only one.')
    );
    return false;
  }

  const { edit, cursor } = plan;
  editor.replaceRange(edit.insert, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
  editor.setCursor(editor.offsetToPos(cursor));
  return true;
}

/**
 * Whether this vault has the workflow that turns `@issue` markers and the
 * `discuss` flag into GitHub Issues. Without it both are inert, which the
 * commands must say instead of promising an issue on the next push. Whether
 * the vault is pushed with Actions enabled is beyond what the plugin can see.
 */
export async function isIssueAutomationInstalled(host: LabnoteHost): Promise<boolean> {
  return host.fs.exists(ISSUE_SYNC_WORKFLOW_PATH);
}

/**
 * Read an experiment README for a front-matter edit, refusing to continue when
 * the YAML cannot be parsed.
 *
 * Both callers re-serialize the parsed front matter through {@link renderNote}.
 * A failed parse yields an empty object, so writing it back replaced the whole
 * block with the single field the command sets and erased `title`, `author`,
 * `created_date` and everything else. One unquoted colon in a value
 * (`title: EXP: 3rd try`) is enough to break the parse, which makes this a
 * realistic way to lose the metadata of the note that is the single source of
 * truth. Leave the note alone and say which line to fix instead.
 */
async function readNoteForFrontMatterEdit(
  host: LabnoteHost,
  readmePath: string
): Promise<{ frontMatter: Record<string, unknown>; body: string } | undefined> {
  // `parseFrontMatterYaml` requires LF-normalised text (a bare `\n` after the
  // opening `---`); normalise CRLF so Windows-authored notes parse correctly.
  const original = (await host.fs.read(readmePath)).replace(/\r\n/g, '\n');
  const { frontMatter, body, parseError } = parseFrontMatterYaml(original);
  if (parseError) {
    host.notify(
      'warn',
      host.t(
        'Front matter of this note could not be read, so it was left unchanged. ' +
          'Fix the YAML and try again: {0}',
        parseError
      )
    );
    return undefined;
  }
  return { frontMatter, body };
}

/** Re-emit a note from front matter plus an untouched body. */
function renderNote(frontMatter: Record<string, unknown>, body: string): string {
  const fmBlock = Object.entries(frontMatter)
    .map(([key, value]) => serializeFrontMatterEntry(key, value))
    .join('\n');
  return `---\n${fmBlock}\n---\n\n${body}`;
}

/**
 * Turn the `discuss` front-matter flag of the active experiment on or off.
 *
 * Separate from the status picker on purpose: flagging a note for discussion is
 * not a lifecycle change, so an `in-progress` experiment can ask for a decision
 * without pretending to be `needs-review`. The flag is what `issue-sync`
 * promotes to a GitHub Issue on the next push — writing "논의 필요" in the body
 * does nothing by itself.
 */
export async function toggleDiscussionFlagCommand(app: App, host: LabnoteHost): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('Open a lab note first.'));
    return;
  }

  const parsed = await readNoteForFrontMatterEdit(host, readmePath);
  if (!parsed) return;
  const { frontMatter, body } = parsed;

  const next = !isDiscussFlagged(frontMatter);
  await writeNoteThroughVault(
    app,
    host,
    readmePath,
    renderNote(setDiscussFlag(frontMatter, next), body)
  );

  const automated = await isIssueAutomationInstalled(host);
  let message: string;
  if (next) {
    message = automated
      ? host.t('Flagged for discussion. An issue opens on the next push.')
      : host.t('Flagged for discussion. To open it as an issue, run "Setup research automation" first.');
  } else {
    message = automated
      ? host.t('Discussion flag cleared. Any issue already opened stays open.')
      : host.t('Discussion flag cleared.');
  }
  host.notify('info', message);
}

/**
 * Create the workflow file for an already-chosen catalog item inside a resolved
 * experiment folder, register it in the README checklist, and open it. Shared by
 * the command (after the picker) and the sidebar context menu.
 */
async function createWorkflowFromChoice(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  chosen: WorkflowItem
): Promise<void> {
  const created = await createWorkflowFile(app, host, labnoteDir, chosen);
  if (!created) return;
  await host.openFile(created.path);
  host.notify('info', host.t('Workflow created: {0}', created.fileName));
}

/** Details of a freshly created workflow file. */
interface CreatedWorkflow {
  /** Vault-relative path of the new workflow file. */
  path: string;
  /** File name (basename with extension). */
  fileName: string;
  /** Human-readable `id name [alias]` used for checklist/link display. */
  displayTitle: string;
}

/**
 * Prompt for an optional alias, write the workflow file and register it in the
 * README checklist. Does NOT open the file — callers decide what to do with the
 * result (open it, or insert a link at the cursor). Returns undefined if the
 * alias prompt was cancelled.
 */
async function createWorkflowFile(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  chosen: WorkflowItem
): Promise<CreatedWorkflow | undefined> {
  // Ask for an optional per-instance alias. The catalog name stays inside the
  // `[id name]` prefix; the alias (if any) is appended after it.
  const alias = await workflowAliasModal(app, {
    id: chosen.id,
    catalogName: chosen.name,
    title: host.t('Workflow name'),
    placeholder: host.t('Enter a name for this workflow'),
  });
  if (alias === undefined) return undefined; // cancelled
  const cleanAlias = alias.trim();

  const readmePath = posix.join(labnoteDir, README);
  let experimenter = '';
  if (await host.fs.exists(readmePath)) {
    experimenter = parseExperimenterFromReadme(await host.fs.read(readmePath));
  }

  const existingFiles = await host.fs.list(labnoteDir);
  const sequence = getNextWorkflowNumber(existingFiles);
  const info = { id: chosen.id, name: chosen.name, description: chosen.description };
  const fileName = createWorkflowFileName(sequence, info, cleanAlias || undefined);
  const workflowPath = posix.join(labnoteDir, fileName);

  await host.fs.write(
    workflowPath,
    createWorkflowContent(info, experimenter, cleanAlias || undefined, {
      locale: getObsidianLanguage(),
    })
  );

  const displayTitle = cleanAlias
    ? `${chosen.id} ${chosen.name} ${cleanAlias}`
    : `${chosen.id} ${chosen.name}`;

  // Register in the README "Related Workflows" checklist (non-destructive).
  if (await host.fs.exists(readmePath)) {
    const readme = await host.fs.read(readmePath);
    const items = parseWorkflowChecklistFromReadme(readme);
    items.push({ done: false, title: displayTitle, fileName });
    const updated = updateReadmeWorkflowSection(readme, generateWorkflowChecklist(items));
    await host.fs.write(readmePath, updated);
  }

  return { path: workflowPath, fileName, displayTitle };
}

/** Present the workflow catalog picker (seeding catalog resources first). */
async function pickWorkflow(host: LabnoteHost): Promise<WorkflowItem | undefined> {
  await ensureWorkflowResources(host.fs, VAULT_ROOT);
  const catalog = await loadWorkflows(host.fs, VAULT_ROOT);
  return host.pick(
    catalog.workflows.map<PickItem<WorkflowItem>>(wf => ({
      label: `${wf.id}: ${wf.name}`,
      description: wf.category,
      detail: wf.description,
      value: wf,
    })),
    { title: host.t('Select workflow'), placeholder: host.t('Search workflows') }
  );
}

/**
 * Create a specific catalog workflow into the current experiment, resolving the
 * target experiment folder from the active note. Used by the workflow sidebar's
 * context menu, where the workflow is already known.
 */
export async function createWorkflowForItem(
  app: App,
  host: LabnoteHost,
  chosen: WorkflowItem
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;
  await createWorkflowFromChoice(app, host, labnoteDir, chosen);
}

/** Create a new workflow file inside an experiment + register it in the README. */
export async function createWorkflowCommand(app: App, host: LabnoteHost): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const chosen = await pickWorkflow(host);
  if (!chosen) return;

  await createWorkflowFromChoice(app, host, labnoteDir, chosen);
}

/**
 * Create a workflow file (same flow as {@link createWorkflowCommand}) and insert
 * a link to it at the current cursor position. Invoked from the editor
 * right-click menu on a `.labnote.md` note.
 */
export async function insertWorkflowLinkCommand(
  app: App,
  host: LabnoteHost,
  editor: Editor
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const chosen = await pickWorkflow(host);
  if (!chosen) return;

  const created = await createWorkflowFile(app, host, labnoteDir, chosen);
  if (!created) return;

  // `createWorkflowFile` already registered the workflow in the experiment
  // README's "Related Workflows" checklist. When this command is invoked on the
  // README itself, that checklist entry *is* the link — inserting another one at
  // the cursor would duplicate it (the reported bug). So only add a cursor link
  // when editing some other note.
  const readmePath = posix.join(labnoteDir, README);
  if (app.workspace.getActiveFile()?.path === readmePath) {
    host.notify('info', host.t('Workflow created: {0}', created.fileName));
    return;
  }

  // Resolve the TFile for a settings-aware link. A file written through the
  // adapter may lag the vault index, so retry briefly before falling back.
  let file = app.vault.getAbstractFileByPath(created.path);
  for (let i = 0; i < 10 && !(file instanceof TFile); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    file = app.vault.getAbstractFileByPath(created.path);
  }

  const sourcePath = app.workspace.getActiveFile()?.path ?? '';
  const link =
    file instanceof TFile
      ? app.fileManager.generateMarkdownLink(file, sourcePath, undefined, created.displayTitle)
      : `[[${created.fileName.replace(/\.md$/, '')}|${created.displayTitle}]]`;

  editor.replaceSelection(link);
  host.notify('info', host.t('Workflow created: {0}', created.fileName));
}

/**
 * Insert a unit-operation block at the end of the `## Related Unit Operations`
 * section, then rebuild that section's TOC so its entries follow the document
 * order of the actual `### [..]` headings. Finally, move the cursor/focus to
 * the just-inserted heading. Shared by the command and the workflow sidebar's
 * context menu.
 */
export async function insertUnitOpAndUpdateToc(
  host: LabnoteHost,
  input: InsertUnitOperationInput
): Promise<boolean> {
  // Resolve the insertion point BEFORE inserting: the block lands here, which
  // lets us relocate the new heading after the whole-doc TOC rewrite. The same
  // pure helper drives the insert itself, so both agree on the offset.
  const before = host.editTarget();
  const insertOffset = before ? findUnitOpInsertOffset(await before.getText()) : -1;

  const ok = await insertUnitOperation(host, input);
  if (!ok) return false;

  const target = host.editTarget();
  if (target) {
    const md = await target.getText();
    const updated = rebuildUnitOpToc(md);
    if (updated !== md) {
      await target.replaceRange(0, md.length, updated);
    }
    // Whole-doc replaceRange resets the cursor, so explicitly move focus to the
    // inserted unit-operation heading in the final (rebuilt) text.
    if (target.revealOffset && insertOffset >= 0) {
      const off = locateInsertedUnitOpHeading(md, insertOffset, updated);
      if (off >= 0) await target.revealOffset(off);
    }
  }
  return true;
}

/** Insert a unit-operation block at the cursor + update the workflow TOC. */
export async function insertUnitOperationCommand(app: App, host: LabnoteHost): Promise<void> {
  await ensureWorkflowResources(host.fs, VAULT_ROOT);
  const hw = await loadUnitOperations(host.fs, VAULT_ROOT, 'hw');
  const sw = await loadUnitOperations(host.fs, VAULT_ROOT, 'sw');

  const items: PickItem<{ op: UnitOperationItem; kind: 'hw' | 'sw' }>[] = [
    ...hw.unitOperations.map(op => ({
      label: `${op.id}: ${op.name}`,
      description: 'HW',
      detail: op.description,
      value: { op, kind: 'hw' as const },
    })),
    ...sw.unitOperations.map(op => ({
      label: `${op.id}: ${op.name}`,
      description: 'SW',
      detail: op.description,
      value: { op, kind: 'sw' as const },
    })),
  ];

  const chosen = await host.pick(items, {
    title: host.t('Insert unit operation'),
    placeholder: host.t('Search unit operations'),
  });
  if (!chosen) return;

  const { op, kind } = chosen;
  await insertUnitOpAndUpdateToc(host, {
    opId: op.id,
    opName: op.name,
    opDescription: op.description,
    opType: kind,
    equipment: op.equipment,
    software: op.software,
  });
}

/**
 * Control over the README auto-sync (see `registerWorkflowReadmeSync` in
 * main.ts) for a command that renames workflow files in bulk.
 */
export interface ReadmeSyncControl {
  /** Wait for the folder's pending and running syncs to be applied. */
  flushNow(dir: string): Promise<void>;
  /** Queue the folder's rename/delete events without writing the README. */
  hold(dir: string): void;
  /** Wait until no modal is open and Obsidian has applied confirmed link edits. */
  settle(): Promise<void>;
  /** Stop holding; drop the queued renames if the caller handled them, flush the rest. */
  release(dir: string, opts?: { dropRenames?: boolean }): Promise<void>;
}

/**
 * Renumber an experiment's workflow files to a gap-free `001, 002, ...`
 * sequence, in their current order.
 *
 * Ordering and the target names come from `planWorkflowRenumber`, the rename
 * sequence from `planRenumberMoves` (straight to the target, parked under a
 * staging name only while the target is still taken).
 *
 * The README checklist is rewritten here once, after every move, rather than
 * by the rename listeners: each `renameFile` may wait on Obsidian's "update
 * links?" prompt, which then edits the README at offsets computed before the
 * prompt, so a listener writing in between corrupts the README (#41). The
 * entries are rebuilt from the README as it was before the first move, because
 * whether Obsidian already relinked them depends on the user's answers.
 */
export async function renumberWorkflowsCommand(
  app: App,
  host: LabnoteHost,
  readmeSync: ReadmeSyncControl
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const existing = await host.fs.list(labnoteDir);
  const renames = planWorkflowRenumber(existing);
  if (renames.length === 0) {
    host.notify('info', host.t('Workflow numbering is already sequential.'));
    return;
  }

  const confirmed = await host.confirm(
    host.t(
      'Renumber {0} workflow file(s) in {1}?',
      String(renames.length),
      posix.basename(labnoteDir)
    )
  );
  if (!confirmed) return;

  await readmeSync.flushNow(labnoteDir);
  readmeSync.hold(labnoteDir);
  const readmePath = posix.join(labnoteDir, README);
  const baseline = (await host.fs.exists(readmePath)) ? await host.fs.read(readmePath) : undefined;

  const moved: WorkflowRename[] = [];
  try {
    for (const move of planRenumberMoves(renames, existing)) {
      const file = app.vault.getFileByPath(posix.join(labnoteDir, move.from));
      if (!(file instanceof TFile)) continue;
      await app.fileManager.renameFile(file, posix.join(labnoteDir, move.to));
      moved.push(move);
    }
  } finally {
    try {
      await readmeSync.settle();
      if (baseline !== undefined && moved.length > 0) {
        await processNoteThroughVault(
          app,
          host,
          readmePath,
          content => reconcileWorkflowChecklist(content, moved, { baseline }).content
        );
      }
    } finally {
      await readmeSync.release(labnoteDir, { dropRenames: true });
    }
  }

  host.notify('info', host.t('Renumbered {0} workflow file(s).', String(renames.length)));
}

// === README auto-sync on native rename / delete ==============================
//
// Rather than mirror the file explorer with custom rename/delete commands, we
// react to Obsidian's own rename/delete events (wired in main.ts) and keep the
// README "Related Workflows" checklist — and, on delete, the sample tree — in
// sync. `renumberWorkflowsCommand` holds these listeners while it moves files
// and rewrites the checklist itself (see there).
// The pure domain logic lives in `@labnoteo/core`
// (reconcileWorkflowChecklist / removeWorkflowFromReadme / removeSourcesForDocument);
// these helpers sequence the Obsidian-side reads/writes.

/**
 * Write note content, preferring the Vault API so an already-open README
 * refreshes immediately. `vault.process` fires only a 'modify' event (never
 * rename/delete), so it cannot re-enter the workflow README sync listeners.
 * Falls back to the adapter when the file is not (yet) in the vault index.
 * (Data files such as `{Type}.json` keep using the adapter directly.)
 *
 * Exported as the `writeNote` hook for `ToolContext`: AI tools edit notes the
 * user may have open, and writing those through the adapter would be silently
 * undone the next time the editor flushed its buffer.
 */
export async function writeNoteThroughVault(
  app: App,
  host: LabnoteHost,
  notePath: string,
  content: string
): Promise<void> {
  const file = app.vault.getFileByPath(notePath);
  if (file instanceof TFile) {
    await app.vault.process(file, () => content);
  } else {
    await host.fs.write(notePath, content);
  }
}

/**
 * Rewrite a note by applying `transform` to its content at write time, not to
 * a copy read earlier. Obsidian may rewrite links in the same note after its
 * "update links?" prompt, and overwriting with a stale copy would undo that.
 * Does nothing (no save, no 'modify' event) when `transform` would not change
 * the note. Returns whether a write happened.
 */
export async function processNoteThroughVault(
  app: App,
  host: LabnoteHost,
  notePath: string,
  transform: (content: string) => string
): Promise<boolean> {
  const current = await host.fs.read(notePath);
  const next = transform(current);
  if (next === current) return false;
  const file = app.vault.getFileByPath(notePath);
  if (file instanceof TFile) {
    await app.vault.process(file, data => transform(data));
  } else {
    await host.fs.write(notePath, next);
  }
  return true;
}

/**
 * After workflow files were renamed in the file explorer, reorder the README
 * "Related Workflows" checklist to match the new `NNN` order. `renames` are the
 * old->new basenames accumulated for one experiment folder; passing them lets
 * reconcile relink correctly even when Obsidian's "Automatically update
 * internal links" setting is off. Only writes when the section actually changes.
 */
export async function syncReadmeOrderOnRename(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  renames: WorkflowRename[]
): Promise<void> {
  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) return;
  await processNoteThroughVault(
    app,
    host,
    readmePath,
    content => reconcileWorkflowChecklist(content, renames).content
  );
}

/** Sample-tree cleanup context for {@link syncReadmeAndSamplesOnDelete}. */
export interface SampleCleanupOpts {
  globalSampleFolder?: string;
  customTypes?: string[];
  /** Called after samples were pruned so the caller can refresh views/caches. */
  onSamplesChanged?: () => void;
}

/**
 * After workflow files were deleted in the file explorer, remove their README
 * checklist entries (surgically — preserving order + any manual links) and
 * prune the sample tree of sources only these documents defined. Returns every
 * auto-removed sample so the caller can surface a toast + refresh views.
 */
export async function syncReadmeAndSamplesOnDelete(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  deletedPaths: string[],
  opts: SampleCleanupOpts = {}
): Promise<RemovedSampleRef[]> {
  // 1) README: drop each deleted entry in one read-modify-write. The README may
  //    itself be gone (whole-folder delete); then there is nothing to prune.
  const readmePath = posix.join(labnoteDir, README);
  if (await host.fs.exists(readmePath)) {
    await processNoteThroughVault(app, host, readmePath, content => {
      for (const p of deletedPaths) {
        const res = removeWorkflowFromReadme(content, posix.basename(p));
        if (res.changed) content = res.content;
      }
      return content;
    });
  }

  // 2) Samples: a deleted document defines nothing, so pass empty text — every
  //    record that listed this note as a source drops it (and is deleted if it
  //    becomes orphaned). Failures are non-fatal: the file is already gone.
  const removed: RemovedSampleRef[] = [];
  for (const p of deletedPaths) {
    try {
      const r = await removeSourcesForDocument(
        host.fs,
        p,
        '',
        opts.globalSampleFolder,
        opts.customTypes
      );
      removed.push(...r);
    } catch (err) {
      console.warn('[labnoteo] sample cleanup during workflow delete failed:', err);
    }
  }
  return removed;
}
