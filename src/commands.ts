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
  unitOpInsertPointAtCursor,
  EXPERIMENT_STATUSES,
  generateIssueMarkerId,
  isDiscussFlagged,
  parseFrontMatterYaml,
  parseIssueMarkers,
  planIssueMarkerInsertion,
  planDateInsertion,
  issueSentenceRange,
  serializeFrontMatterEntry,
  setDiscussFlag,
} from '@labnoteo/core';
import { ISSUE_SYNC_WORKFLOW_PATH, SETUP_DOC_PATH } from './scaffold/assets';
import * as posix from '@labnoteo/core/posix';
import { workflowAliasModal } from './modals';
import { getObsidianLanguage } from './i18n';
import {
  createLabnoteStructure,
  diagnoseExperimentPath,
  sanitizeTitle,
} from '@labnoteo/core/lib/labnoteStructure';
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
  planTableCsvMoves,
  siblingTableCsvs,
  planWorkflowChecklistSync,
  removeWorkflowChecklistEntries,
  relabelWorkflowChecklistEntries,
  dedupeWorkflowChecklistEntries,
  normalizeWorkflowChecklistLabels,
  normalizeWorkflowChecklistLinks,
  normalizeChecklistLink,
  relinkWorkflowChecklistEntries,
  collapseWorkflowRenames,
  defaultWorkflowTitle,
  isValidWorkflowPath,
  parseWorkflowFileName,
  planWorkflowRetitle,
  planWorkflowExperimenterSync,
  workflowLabelFor,
  type WorkflowRename,
  type WorkflowRelabel,
  type WorkflowSubfolderNotes,
} from '@labnoteo/core/lib/workflowStructure';
import { removeWorkflowFromReadme } from '@labnoteo/core/lib/workflowDelete';
// Re-exported so command registration in main.ts imports every command from one
// place; the implementation lives under src/scaffold with its asset registry.
export { setupResearchAutomationCommand } from './scaffold/scaffold';
import { isVaultGitRepository } from './scaffold/scaffold';
import { removeSourcesForDocument } from '@labnoteo/core/lib/sampleStorage';

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
  const found = active ? diagnoseExperimentPath(active) : ({ kind: 'outside' } as const);
  if (found.kind === 'ok') return found.folder;
  host.notify(
    'warn',
    found.kind === 'noPrefix'
      ? host.t(
          '"{0}" is not an experiment folder: its name must start with ###_ (e.g. 001_Name).',
          posix.basename(found.folder)
        )
      : host.t('Open a lab note first.')
  );
  return undefined;
}

/** Create a new experiment folder (labnote/###_Title) + README scaffold. */
export async function createExperimentCommand(app: App, host: LabnoteHost): Promise<void> {
  const title = await host.prompt({
    title: host.t('New experiment'),
    prompt: host.t('Experiment title'),
    validate: v => {
      if (!v.trim()) return host.t('Title is required.');
      if (!sanitizeTitle(v.trim())) {
        return host.t('The title has no characters usable in a folder name. Add letters or numbers.');
      }
      return null;
    },
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
export async function changeExperimentStatusCommand(
  app: App,
  host: LabnoteHost,
  stamp: (content: string) => string = c => c,
  experimentDir?: string
): Promise<void> {
  // The workflow view names the experiment itself; the active file may be another one (#128).
  const labnoteDir = experimentDir ?? (await resolveLabnoteDir(app, host));
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
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

  await writeNoteThroughVault(app, host, readmePath, stamp(updated));
  let message = host.t('Experiment status changed: {0} → {1}', current ?? host.t('(none)'), chosen);
  // Ctrl+Z only reaches the README when it is the open note (#126).
  if (app.workspace.getActiveFile()?.path !== readmePath) {
    message += ` ${host.t("Changed {0}'s README, not this note.", posix.basename(labnoteDir))}`;
    if (current) {
      message += ` ${host.t('To undo, run "{0}" again and pick {1}.', host.t('Change experiment status'), current)}`;
    }
  }
  // `needs-review` only opens a review issue through the automation (#79).
  if (chosen === 'needs-review') {
    const state = await issueAutomationState(host);
    if (state === 'no-git') {
      message += ` ${host.t(
        'This vault is not a git repository yet, so no review issue will open. Finish the repository setup in {0} first.',
        SETUP_DOC_PATH
      )}`;
    } else if (state === 'none') {
      message += ` ${host.t('To open a review issue, run "Setup research automation" first.')}`;
    }
  }
  host.notify('info', message);
}

/**
 * Insert a date (or date and time) over the selection. In the front matter it
 * only fills a key with an empty value; elsewhere there it is refused with a
 * warning, since the text would break the YAML (#106).
 */
export function insertDateCommand(editor: Editor, host: LabnoteHost, text: string): boolean {
  const plan = planDateInsertion(
    editor.getValue(),
    editor.posToOffset(editor.getCursor('from')),
    editor.posToOffset(editor.getCursor('to')),
    text
  );
  if ('reason' in plan) {
    host.notify(
      'warn',
      host.t('A date cannot go on a front matter line that has a value. Run this in the body or on an empty value.')
    );
    return false;
  }
  editor.replaceRange(plan.text, editor.offsetToPos(plan.from), editor.offsetToPos(plan.to));
  editor.setCursor(editor.offsetToPos(plan.from + plan.text.length));
  return true;
}

/**
 * Insert an `@issue` marker for the selection, with a freshly generated ID.
 * Returns whether a marker was inserted.
 *
 * Discussion comes up mid-sentence while writing, so this is an editor command
 * rather than a note-level one: select the sentence that raises the question
 * and it becomes the topic. With no selection the topic is asked for,
 * prefilled with the sentence on the cursor's line; a marker without one would
 * be rejected by `validate` (#100). Text after the selection is never pulled
 * into the marker — see {@link planIssueMarkerInsertion} for where it goes.
 * Only the primary selection is used, so one command yields one ID.
 *
 * The ID exists so the topic can be reworded later without orphaning the issue
 * it opened, which is also why it is generated rather than typed.
 */
export async function insertIssueMarkerCommand(editor: Editor, host: LabnoteHost): Promise<boolean> {
  // IDs are a timestamp plus a counter, so generating a duplicate is not
  // actually possible; this scan is kept only because it costs nothing.
  //
  // The real source of duplicates is copying a marker line into another note,
  // which carries the ID along and never goes through this command. Two notes
  // then point at one issue and the discussions merge silently. The pre-commit
  // hook and the server `validate` catch that, since only they see the folder.
  const newId = (doc: string): string => {
    const used = new Set(parseIssueMarkers(doc).markers.map(m => m.id));
    let id = generateIssueMarkerId();
    while (used.has(id)) id = generateIssueMarkerId();
    return id;
  };
  const refuse = (reason: 'conflict' | 'table' | 'frontMatter' | 'codeBlock'): false => {
    host.notify(
      'warn',
      reason === 'table'
        ? host.t('Issue markers cannot go inside a table. Run this on a line below the table.')
        : reason === 'frontMatter'
          ? host.t('Issue markers cannot go in the front matter. Run this in the note body.')
          : reason === 'codeBlock'
            ? host.t('Issue markers inside a code block open no issue. Run this on a line outside the code block.')
            : host.t('This line already has an issue marker. A line can hold only one.')
    );
    return false;
  };

  let doc = editor.getValue();
  const from = editor.posToOffset(editor.getCursor('from'));
  const to = editor.posToOffset(editor.getCursor('to'));
  let plan;
  if (from !== to) {
    plan = planIssueMarkerInsertion(doc, from, to, newId(doc));
  } else {
    // Refuse a line that cannot take a marker before asking for a topic.
    const probe = planIssueMarkerInsertion(doc, from, to, newId(doc), '-');
    if ('reason' in probe) return refuse(probe.reason);
    const topic = (
      await host.prompt({
        title: host.t('Issue topic sentence'),
        prompt: host.t('This sentence becomes the issue title. Keep the sentence from this line or type another.'),
        value: issueSentenceRange(doc, from)?.text ?? '',
        validate: v => (v.trim() ? null : host.t('Enter the topic sentence of the issue.')),
      })
    )?.trim();
    if (!topic) return false;
    // The note may have changed while the prompt was open.
    doc = editor.getValue();
    const caret = editor.posToOffset(editor.getCursor('from'));
    const sentence = issueSentenceRange(doc, caret);
    plan =
      sentence && sentence.text === topic
        ? // As if the sentence had been selected: it becomes the marker.
          planIssueMarkerInsertion(doc, sentence.from, sentence.to, newId(doc))
        : // A new sentence leaves the line as written.
          planIssueMarkerInsertion(doc, caret, caret, newId(doc), topic);
  }
  if ('reason' in plan) return refuse(plan.reason);

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
 * Whether an `@issue` marker or the `discuss` flag can become an issue:
 * `'none'` without the automation, `'no-git'` when it is installed but the
 * vault is not a git repository yet (nothing can be pushed), `'ready'` otherwise.
 */
export async function issueAutomationState(host: LabnoteHost): Promise<'none' | 'no-git' | 'ready'> {
  if (!(await isIssueAutomationInstalled(host))) return 'none';
  return (await isVaultGitRepository(host)) ? 'ready' : 'no-git';
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
export async function toggleDiscussionFlagCommand(
  app: App,
  host: LabnoteHost,
  stamp: (content: string) => string = c => c,
  experimentDir?: string
): Promise<void> {
  // The workflow view names the experiment itself (#134), like the status change (#128).
  const labnoteDir = experimentDir ?? (await resolveLabnoteDir(app, host));
  if (!labnoteDir) return;

  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
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
    stamp(renderNote(setDiscussFlag(frontMatter, next), body))
  );

  const state = await issueAutomationState(host);
  let message: string;
  if (next) {
    message =
      state === 'ready'
        ? host.t('Flagged for discussion. An issue opens on the next push.')
        : state === 'no-git'
          ? host.t(
              'Flagged for discussion. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.',
              SETUP_DOC_PATH
            )
          : host.t('Flagged for discussion. To open it as an issue, run "Setup research automation" first.');
  } else {
    message =
      state === 'ready'
        ? host.t('Discussion flag cleared. Any issue already opened stays open.')
        : host.t('Discussion flag cleared.');
  }
  // The flag belongs to the experiment, so say so when run from another note (#108).
  if (app.workspace.getActiveFile()?.path !== readmePath) {
    message += ` ${host.t("Changed {0}'s README, not this note.", posix.basename(labnoteDir))}`;
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
  chosen: WorkflowItem,
  stamp: (content: string) => string
): Promise<void> {
  const created = await createWorkflowFile(app, host, labnoteDir, chosen, stamp);
  if (!created) return;
  await host.openFile(created.path);
  notifyWorkflowCreated(host, created);
}

/** Details of a freshly created workflow file. */
interface CreatedWorkflow {
  /** Vault-relative path of the new workflow file. */
  path: string;
  /** File name (basename with extension). */
  fileName: string;
  /** Human-readable `id name [alias]` used for checklist/link display. */
  displayTitle: string;
  /** Whether it was added to the README checklist (false without a README). */
  registered: boolean;
}

/** The "created" notice, plus a warning when no README checklist lists it (#88). */
function notifyWorkflowCreated(host: LabnoteHost, created: CreatedWorkflow): void {
  host.notify('info', host.t('Workflow created: {0}', created.fileName));
  if (!created.registered) {
    host.notify(
      'warn',
      host.t('This experiment has no README.labnote.md, so the workflow was not added to a checklist.')
    );
  }
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
  chosen: WorkflowItem,
  stamp: (content: string) => string
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

  const registered = await registerWorkflowInReadme(
    app,
    host,
    readmePath,
    { title: displayTitle, fileName },
    stamp
  );

  return { path: workflowPath, fileName, displayTitle, registered };
}

/**
 * Append a new workflow to the README "Related Workflows" checklist
 * (non-destructive) and stamp the README's `last_updated_date`: creating a
 * workflow is a change to the experiment. Applied through the vault to the
 * README as it is at write time, so an open README editor neither overwrites it
 * nor loses its own unsaved text. Returns false, writing nothing, without a
 * README.
 */
export async function registerWorkflowInReadme(
  app: App,
  host: LabnoteHost,
  readmePath: string,
  entry: { title: string; fileName: string },
  stamp: (content: string) => string = c => c
): Promise<boolean> {
  if (!(await host.fs.exists(readmePath))) return false;
  await processNoteThroughVault(app, host, readmePath, readme => {
    const items = parseWorkflowChecklistFromReadme(readme);
    items.push({ done: false, title: entry.title, fileName: entry.fileName });
    return stamp(updateReadmeWorkflowSection(readme, generateWorkflowChecklist(items)));
  });
  return true;
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
  chosen: WorkflowItem,
  stamp: (content: string) => string = c => c
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;
  await createWorkflowFromChoice(app, host, labnoteDir, chosen, stamp);
}

/** Create a new workflow file inside an experiment + register it in the README. */
export async function createWorkflowCommand(
  app: App,
  host: LabnoteHost,
  stamp: (content: string) => string = c => c
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const chosen = await pickWorkflow(host);
  if (!chosen) return;

  await createWorkflowFromChoice(app, host, labnoteDir, chosen, stamp);
}

/**
 * Create a workflow file (same flow as {@link createWorkflowCommand}) and insert
 * a link to it at the current cursor position. Invoked from the editor
 * right-click menu on a `.labnote.md` note.
 */
export async function insertWorkflowLinkCommand(
  app: App,
  host: LabnoteHost,
  editor: Editor,
  stamp: (content: string) => string = c => c
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const chosen = await pickWorkflow(host);
  if (!chosen) return;

  const created = await createWorkflowFile(app, host, labnoteDir, chosen, stamp);
  if (!created) return;

  // `createWorkflowFile` already registered the workflow in the experiment
  // README's "Related Workflows" checklist. When this command is invoked on the
  // README itself, that checklist entry *is* the link — inserting another one at
  // the cursor would duplicate it (the reported bug). So only add a cursor link
  // when editing some other note.
  const readmePath = posix.join(labnoteDir, README);
  if (app.workspace.getActiveFile()?.path === readmePath) {
    notifyWorkflowCreated(host, created);
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
  notifyWorkflowCreated(host, created);
}

/**
 * Insert a unit-operation block into the `## Related Unit Operations` section
 * (after the block the cursor is in, see `insertUnitOperation`), then rebuild
 * that section's TOC so its entries follow the document order of the actual
 * `### [..]` headings. Finally, move the cursor/focus to the just-inserted
 * heading. Shared by the command and the workflow sidebar's context menu, which
 * uses the cursor of the editor last active.
 */
export async function insertUnitOpAndUpdateToc(
  host: LabnoteHost,
  input: InsertUnitOperationInput,
  askAlias?: (input: InsertUnitOperationInput) => Promise<string | undefined>
): Promise<boolean> {
  // Asked only where the insert will go ahead: `insertUnitOperation` refuses a
  // note that is no workflow, which would come after the alias was typed.
  let alias = input.alias;
  const opened = host.editTarget();
  if (askAlias && opened && isValidWorkflowPath(opened.path)) {
    alias = await askAlias(input);
    if (alias === undefined) return false;
  }

  // Resolve the insertion point BEFORE inserting and hand it to the insert, so
  // the new heading can be found again after the whole-doc TOC rewrite.
  const before = host.editTarget();
  const at = before ? await unitOpInsertPointAtCursor(before) : undefined;
  const insertOffset = at?.offset ?? -1;

  const ok = await insertUnitOperation(host, { ...input, alias, at });
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

/** Insert a unit-operation block after the one the cursor is in + update the workflow TOC. */
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
  await insertUnitOpAndUpdateToc(
    host,
    {
      opId: op.id,
      opName: op.name,
      opDescription: op.description,
      opType: kind,
      equipment: op.equipment,
      software: op.software,
    },
    unitOpAliasPrompt(app, host)
  );
}

/**
 * The alias prompt of {@link insertUnitOpAndUpdateToc} (#118): the same fixed
 * `[id name]` prefix as a workflow's name. Empty inserts without an alias;
 * Escape inserts nothing.
 */
export function unitOpAliasPrompt(
  app: App,
  host: LabnoteHost
): (input: InsertUnitOperationInput) => Promise<string | undefined> {
  return input =>
    workflowAliasModal(app, {
      id: input.opId,
      catalogName: input.opName,
      title: host.t('Unit operation alias'),
      placeholder: host.t('Run or condition of this step (optional)'),
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
  readmeSync: ReadmeSyncControl,
  renameSampleSources?: (dir: string, renames: ReadonlyMap<string, string>) => Promise<void>
): Promise<void> {
  const labnoteDir = await resolveLabnoteDir(app, host);
  if (!labnoteDir) return;

  const existing = await host.fs.list(labnoteDir);
  const renames = planWorkflowRenumber(existing);
  const readmePath = posix.join(labnoteDir, README);
  // Files the checklist does not list are renumbered too, so register them in
  // the same run; otherwise one takes 001 and the overview starts at 002 (#56).
  const unlisted = (await host.fs.exists(readmePath))
    ? planWorkflowChecklistSync(await host.fs.read(readmePath), existing, undefined, undefined, labnoteDir).added.length
    : 0;
  if (renames.length === 0 && unlisted === 0) {
    host.notify('info', host.t('Workflow numbering is already sequential.'));
    return;
  }

  const folder = posix.basename(labnoteDir);
  const question =
    unlisted === 0
      ? host.t('Renumber {0} workflow file(s) in {1}?', String(renames.length), folder)
      : renames.length === 0
        ? host.t('Add {0} workflow file(s) missing from the README checklist of {1}?', String(unlisted), folder)
        : host.t(
            'Renumber {0} workflow file(s) in {1} and add {2} file(s) missing from the README checklist?',
            String(renames.length),
            folder,
            String(unlisted)
          );
  if (!(await host.confirm(question))) return;

  await readmeSync.flushNow(labnoteDir);
  readmeSync.hold(labnoteDir);
  const baseline = (await host.fs.exists(readmePath)) ? await host.fs.read(readmePath) : undefined;

  const moved: WorkflowRename[] = [];
  let added = 0;
  let csvSkipped = 0;
  // Live folder listing, so a CSV is never moved onto a name taken mid-run.
  const names = new Set(existing);
  try {
    for (const move of planRenumberMoves(renames, existing)) {
      const file = app.vault.getFileByPath(posix.join(labnoteDir, move.from));
      if (!(file instanceof TFile)) continue;
      await app.fileManager.renameFile(file, posix.join(labnoteDir, move.to));
      moved.push(move);
      names.delete(move.from);
      names.add(move.to);
      csvSkipped += await moveTableCsvs(app, labnoteDir, move, names);
    }
  } finally {
    try {
      await readmeSync.settle();
      if (baseline !== undefined) {
        const relink = (content: string): string =>
          moved.length > 0 ? reconcileWorkflowChecklist(content, moved, { baseline, dir: labnoteDir }).content : content;
        const { names, notes } = await readWorkflowFolder(host, labnoteDir);
        const titles = workflowLabels(notes);
        await processNoteThroughVault(app, host, readmePath, content => {
          const plan = planWorkflowChecklistSync(relink(content), names, titles, undefined, labnoteDir);
          added = plan.added.length;
          return plan.content;
        });
      }
    } finally {
      await readmeSync.release(labnoteDir, { dropRenames: true });
    }
  }
  // The rename listener skips the held folder; the Local registry follows the
  // net renames here, staging names left out (#149).
  const net = netRenames(moved);
  if (renameSampleSources && net.size > 0) await renameSampleSources(labnoteDir, net);

  if (renames.length > 0) {
    const done = host.t('Renumbered {0} workflow file(s).', String(renames.length));
    // Without a README there is no checklist to follow the new numbers (#88).
    if (baseline === undefined) {
      host.notify('warn', `${done} ${host.t('This experiment has no README.labnote.md.')}`);
    } else {
      host.notify('info', done);
    }
  }
  if (added > 0) {
    host.notify('info', host.t('Added {0} workflow file(s) to the README checklist.', String(added)));
  }
  if (csvSkipped > 0) {
    host.notify(
      'warn',
      host.t('{0} table CSV file(s) kept their old name: the new name was taken or the rename failed.', String(csvSkipped))
    );
  }
}

/** Each original name of a chain of `moves` mapped to its final name, unchanged ones left out. */
export function netRenames(moves: readonly WorkflowRename[]): Map<string, string> {
  const origin = new Map<string, string>();
  for (const { from, to } of moves) {
    const first = origin.get(from) ?? from;
    origin.delete(from);
    origin.set(to, first);
  }
  return new Map([...origin].filter(([to, from]) => to !== from).map(([to, from]) => [from, to]));
}

/**
 * Move a workflow note's `<note>_tableN.csv` exports along with it (#60), so
 * they keep the note's name and number. `names` is the folder's current
 * listing (base names) and is updated as files move. A CSV whose new name is
 * taken, or whose rename fails, stays put; returns how many did.
 */
export async function moveTableCsvs(
  app: App,
  dir: string,
  note: WorkflowRename,
  names: Set<string>
): Promise<number> {
  let skipped = 0;
  if (note.from === note.to) return 0;
  for (const csv of planTableCsvMoves(note.from, note.to, [...names])) {
    const file = app.vault.getFileByPath(posix.join(dir, csv.from));
    if (!(file instanceof TFile) || names.has(csv.to)) {
      skipped++;
      continue;
    }
    try {
      await app.fileManager.renameFile(file, posix.join(dir, csv.to));
      names.delete(csv.from);
      names.add(csv.to);
    } catch (err) {
      console.warn('[labnoteo] could not move table CSV:', err);
      skipped++;
    }
  }
  return skipped;
}

/**
 * Move the table CSVs `names` (base names in `dir`) to the trash (#74, #75).
 * Returns how many stayed because the move failed.
 */
export async function trashTableCsvs(app: App, dir: string, names: readonly string[]): Promise<number> {
  let kept = 0;
  for (const name of names) {
    const path = posix.join(dir, name);
    try {
      const file = app.vault.getFileByPath(path);
      if (file instanceof TFile) {
        // `trashFile` (1.6.6+) follows the user's "Deleted files" setting.
        if (typeof app.fileManager.trashFile === 'function') await app.fileManager.trashFile(file);
        else await app.vault.trash(file, true);
      } else if (!(await app.vault.adapter.trashSystem(path))) {
        // Written through the adapter, a fresh CSV may not be indexed as a TFile yet.
        await app.vault.adapter.trashLocal(path);
      }
    } catch (err) {
      console.warn('[labnoteo] could not trash table CSV:', err);
      kept++;
    }
  }
  return kept;
}

/** One file name per line, the first `max` of them and a count of the rest. */
export function listFileNames(host: Pick<LabnoteHost, 't'>, names: readonly string[], max = 10): string {
  const shown = names.slice(0, max).join('\n');
  return names.length > max ? host.t('{0} (+{1} more)', shown, String(names.length - max)) : shown;
}

/**
 * After workflow notes were deleted, offer to trash the table CSVs still named
 * after them (#75). A note that is back (e.g. restored by git) keeps its CSVs.
 */
export async function offerTableCsvCleanupOnDelete(
  app: App,
  host: LabnoteHost,
  deletedPaths: readonly string[]
): Promise<void> {
  const byDir = new Map<string, string[]>();
  const listings = new Map<string, string[]>();
  for (const p of deletedPaths) {
    const dir = posix.dirname(p);
    const files = listings.get(dir) ?? (await host.fs.list(dir));
    listings.set(dir, files);
    const note = posix.basename(p);
    if (files.includes(note)) continue;
    const found = byDir.get(dir) ?? [];
    for (const csv of siblingTableCsvs(note, files)) if (!found.includes(csv)) found.push(csv);
    byDir.set(dir, found);
  }
  const all = [...byDir.values()].flat();
  if (all.length === 0) return;

  const ok = await host.confirm(
    host.t(
      'The table CSV files of the deleted note(s) are still in the folder. Move them to the trash?\n\n{0}',
      listFileNames(host, all)
    ),
    { confirmLabel: host.t('Move to trash') }
  );
  if (!ok) return;

  let kept = 0;
  for (const [dir, names] of byDir) kept += await trashTableCsvs(app, dir, names);
  host.notify('info', host.t('{0} CSV file(s) moved to the trash.', String(all.length - kept)));
  if (kept > 0) host.notify('warn', host.t('{0} CSV file(s) could not be moved to the trash.', String(kept)));
}

/**
 * A workflow note was renamed by hand from `from` to `to` in `dir`: its title
 * and `## [ID name]` heading follow the new name when they matched the old one
 * (#71). Returns whether the note changed.
 */
export async function retitleWorkflowAfterRename(
  app: App,
  host: LabnoteHost,
  dir: string,
  from: string,
  to: string
): Promise<boolean> {
  const notePath = posix.join(dir, to);
  if (!(await host.fs.exists(notePath))) return false;
  return processNoteThroughVault(app, host, notePath, content => planWorkflowRetitle(content, to, from)?.content ?? content);
}

/** A workflow note's text, or undefined when it cannot be read (moved or deleted meanwhile). */
async function readWorkflowNote(host: LabnoteHost, dir: string, fileName: string): Promise<string | undefined> {
  try {
    return await host.fs.read(posix.join(dir, fileName));
  } catch {
    return undefined;
  }
}

/**
 * The checklist label for a workflow file, from its note (see
 * `workflowLabelFor`); built from the file name alone when the note cannot be
 * read (moved or deleted meanwhile).
 */
export async function readWorkflowLabel(host: LabnoteHost, dir: string, fileName: string): Promise<string> {
  return workflowLabelFor(fileName, await readWorkflowNote(host, dir, fileName));
}

/**
 * The folder listing and the text of every workflow note in it — the inputs
 * of `planWorkflowChecklistSync` (via {@link workflowLabels}) and
 * `planWorkflowRetitle`, read up front because `processNoteThroughVault`
 * needs a synchronous transform.
 */
async function readWorkflowFolder(
  host: LabnoteHost,
  labnoteDir: string
): Promise<{ names: string[]; notes: Map<string, string | undefined> }> {
  const names = await host.fs.list(labnoteDir);
  const notes = new Map<string, string | undefined>();
  for (const name of names) {
    if (parseWorkflowFileName(name)) notes.set(name, await readWorkflowNote(host, labnoteDir, name));
  }
  return { names, notes };
}

/** Workflow notes below `labnoteDir`'s top level, by file name. */
function workflowNotesInSubfolders(app: App, labnoteDir: string): WorkflowSubfolderNotes {
  const prefix = `${labnoteDir}/`;
  const files = new Map<string, string[]>();
  for (const file of app.vault.getFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const rel = file.path.slice(prefix.length);
    if (!rel.includes('/') || !parseWorkflowFileName(file.name)) continue;
    files.set(file.name, [...(files.get(file.name) ?? []), rel]);
  }
  return { dir: labnoteDir, files };
}

/** The checklist label of each workflow note read by {@link readWorkflowFolder}. */
function workflowLabels(notes: ReadonlyMap<string, string | undefined>): Map<string, string> {
  return new Map([...notes].map(([name, content]) => [name, workflowLabelFor(name, content)]));
}

/**
 * Add one workflow file of `labnoteDir` to its README checklist unless it is
 * already listed. Returns whether the README changed.
 */
export async function addWorkflowFileToChecklist(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  fileName: string
): Promise<boolean> {
  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) return false;
  const titles = new Map([[fileName, await readWorkflowLabel(host, labnoteDir, fileName)]]);
  return processNoteThroughVault(
    app,
    host,
    readmePath,
    content => planWorkflowChecklistSync(content, [fileName], titles, undefined, labnoteDir).content
  );
}

/**
 * Make an experiment's README "Related Workflows" checklist match its folder:
 * list workflow files that are missing from it (moved in, copied, renumbered)
 * and, after asking, drop entries whose file is not in the folder and fix notes
 * and labels that no longer match their file names. `dir` defaults to the
 * active note's experiment.
 */
export async function syncWorkflowChecklistCommand(
  app: App,
  host: LabnoteHost,
  readmeSync: ReadmeSyncControl,
  dir?: string,
  /** Offer the Local samples these notes left in another experiment (#97); returns how many came in. */
  adoptSamples?: (experimentDir: string, names: string[]) => Promise<number>
): Promise<void> {
  const labnoteDir = dir ?? (await resolveLabnoteDir(app, host));
  if (!labnoteDir) return;
  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
    return;
  }

  await readmeSync.flushNow(labnoteDir);
  let readme = await host.fs.read(readmePath);
  let { names, notes } = await readWorkflowFolder(host, labnoteDir);
  let titles = workflowLabels(notes);
  let subfolders = workflowNotesInSubfolders(app, labnoteDir);
  let plan = planWorkflowChecklistSync(readme, names, titles, subfolders);
  if (!plan.hasSection) {
    host.notify('warn', host.t('README.labnote.md has no "Related Workflows" section.'));
    return;
  }

  // A note dragged into `images/` or another subfolder stops being a step (#94).
  let movedBack = 0;
  const inSubfolder = plan.stale.filter(s => s.reason === 'subfolder');
  const movable = inSubfolder.filter(s => s.found?.length === 1);
  const ambiguous = inSubfolder.filter(s => (s.found?.length ?? 0) > 1);
  if (ambiguous.length > 0) {
    host.notify(
      'warn',
      host.t(
        'These workflow notes are in more than one subfolder of this experiment. Move the right one back to the experiment folder yourself: {0}',
        ambiguous.map(s => `${posix.basename(s.link)} (${s.found!.join(', ')})`).join('; ')
      )
    );
  }
  if (movable.length > 0) {
    const list = movable.map(s => `- ${posix.basename(s.link)} (${posix.dirname(s.found![0])}/)`).join('\n');
    const ok = await host.confirm(
      `${host.t('These workflow notes are in a subfolder of this experiment. Move them back to the experiment folder?')}\n\n${list}`,
      { confirmLabel: host.t('Move to experiment folder') }
    );
    if (ok) {
      const relinks: { from: string; to: string }[] = [];
      for (const s of movable) {
        const name = posix.basename(s.found![0]);
        const file = app.vault.getFileByPath(posix.join(labnoteDir, s.found![0]));
        if (!file) continue;
        if (await host.fs.exists(posix.join(labnoteDir, name))) {
          host.notify(
            'warn',
            host.t('{0} was not moved: the experiment folder already has a file with that name.', s.found![0])
          );
          continue;
        }
        await app.fileManager.renameFile(file, posix.join(labnoteDir, name));
        movedBack++;
        if (s.link !== name) relinks.push({ from: s.link, to: name });
      }
      // Obsidian rewrites the link only when "Automatically update internal links" is on.
      if (relinks.length > 0) {
        await processNoteThroughVault(app, host, readmePath, content => relinkWorkflowChecklistEntries(content, relinks));
      }
      if (movedBack > 0) {
        readme = await host.fs.read(readmePath);
        ({ names, notes } = await readWorkflowFolder(host, labnoteDir));
        titles = workflowLabels(notes);
        subfolders = workflowNotesInSubfolders(app, labnoteDir);
        plan = planWorkflowChecklistSync(readme, names, titles, subfolders);
      }
    }
  }

  let remove: string[] = [];
  const removable = plan.stale.filter(s => s.reason !== 'subfolder');
  if (removable.length > 0) {
    const list = removable
      .map(s => `- ${s.link} (${host.t(s.reason === 'missing' ? 'file not found' : 'in another folder')})`)
      .join('\n');
    const ok = await host.confirm(
      `${host.t('These checklist entries do not point to a workflow file in this folder. Remove them from the checklist?')}\n\n${list}`,
      { confirmLabel: host.t('Remove from checklist') }
    );
    if (ok) remove = removable.map(s => s.link);
  }

  // A note renamed before its title followed the file name (#71). Fixed only
  // when asked, before the labels so they are planned from the new titles.
  const retitles = [...notes].flatMap(([name, content]) => {
    const retitle = content === undefined ? undefined : planWorkflowRetitle(content, name);
    return retitle ? [{ name, ...retitle }] : [];
  });
  const updatedNotes = new Set<string>();
  if (retitles.length > 0) {
    const list = retitles.map(r => `- ${r.from} → ${r.to}`).join('\n');
    const ok = await host.confirm(
      `${host.t("These notes' title and heading do not match their file names. Update them?")}\n\n${list}`,
      { confirmLabel: host.t('Update notes') }
    );
    if (ok) {
      for (const { name } of retitles) {
        const notePath = posix.join(labnoteDir, name);
        const changed = await processNoteThroughVault(
          app,
          host,
          notePath,
          content => planWorkflowRetitle(content, name)?.content ?? content
        );
        if (changed) {
          updatedNotes.add(name);
          notes.set(name, await readWorkflowNote(host, labnoteDir, name));
        }
      }
      titles = workflowLabels(notes);
      plan = planWorkflowChecklistSync(readme, names, titles, subfolders);
    }
  }

  // The README author changed after the notes took it as their experimenter (#83).
  const author = parseExperimenterFromReadme(readme);
  const experimenters = [...notes].flatMap(([name, content]) => {
    const sync = content === undefined ? undefined : planWorkflowExperimenterSync(content, author);
    return sync ? [{ name, ...sync }] : [];
  });
  if (experimenters.length > 0) {
    const list = experimenters
      .map(e => `- ${e.name}: ${e.from || host.t('(empty)')} → ${e.to}`)
      .join('\n');
    const ok = await host.confirm(
      `${host.t("These notes' experimenter differs from the README author. Update them?")}\n\n${list}`,
      { confirmLabel: host.t('Update notes') }
    );
    if (ok) {
      for (const { name } of experimenters) {
        const changed = await processNoteThroughVault(
          app,
          host,
          posix.join(labnoteDir, name),
          content => planWorkflowExperimenterSync(content, author)?.content ?? content
        );
        if (changed) updatedNotes.add(name);
      }
    }
  }
  const notesUpdated = updatedNotes.size;

  // A label may have been written by hand, so labels change only when asked (#68).
  let relabel: WorkflowRelabel[] = [];
  if (plan.relabel.length > 0) {
    const list = plan.relabel.map(r => `- ${r.from} → ${r.to}`).join('\n');
    const ok = await host.confirm(
      `${host.t('These checklist labels do not match their file names. Update them?')}\n\n${list}`,
      { confirmLabel: host.t('Update labels') }
    );
    if (ok) relabel = plan.relabel;
  }

  // Entries piled up while a bracketed alias broke the line (#95).
  let duplicates: string[] = [];
  if (plan.duplicates.length > 0) {
    const list = [...new Set(plan.duplicates)].map(name => `- ${name}`).join('\n');
    const ok = await host.confirm(
      `${host.t('These workflow files are listed more than once in the checklist. Remove the extra entries?')}\n\n${list}`,
      { confirmLabel: host.t('Remove duplicates') }
    );
    if (ok) duplicates = plan.duplicates;
  }
  // Escaping a label changes only the link text, not what it reads, and so does
  // shortening a link Obsidian made vault-absolute (#102).
  const relinked = plan.unescaped.length + normalizeWorkflowChecklistLinks(readme, labnoteDir).count;

  const samplesBrought = adoptSamples ? await adoptSamples(labnoteDir, names) : 0;

  if (
    plan.added.length === 0 &&
    remove.length === 0 &&
    relabel.length === 0 &&
    duplicates.length === 0 &&
    relinked === 0 &&
    notesUpdated === 0 &&
    movedBack === 0 &&
    samplesBrought === 0
  ) {
    host.notify(
      'info',
      host.t(
        plan.stale.length > 0 ||
          plan.relabel.length > 0 ||
          plan.duplicates.length > 0 ||
          retitles.length > 0 ||
          experimenters.length > 0
          ? 'No changes made.'
          : 'The workflow checklist already matches the folder.'
      )
    );
    return;
  }

  // Links are shortened first, so the entries to remove are matched in that form.
  const removeLinks = remove.map(link => normalizeChecklistLink(link, labnoteDir));
  await processNoteThroughVault(app, host, readmePath, content => {
    const shortened = normalizeWorkflowChecklistLinks(content, labnoteDir).content;
    return normalizeWorkflowChecklistLabels(
      dedupeWorkflowChecklistEntries(
        relabelWorkflowChecklistEntries(
          removeWorkflowChecklistEntries(
            planWorkflowChecklistSync(shortened, names, titles, undefined, labnoteDir).content,
            removeLinks
          ),
          relabel,
          labnoteDir
        ),
        [...new Set(duplicates)],
        labnoteDir
      )
    );
  });
  const parts = [
    host.t('Workflow checklist updated: {0} added, {1} removed.', String(plan.added.length), String(remove.length)),
  ];
  if (movedBack > 0) parts.push(host.t('{0} note(s) moved back to the experiment folder.', String(movedBack)));
  if (notesUpdated > 0) parts.push(host.t('{0} note(s) updated.', String(notesUpdated)));
  if (relabel.length > 0) parts.push(host.t('{0} label(s) updated.', String(relabel.length)));
  if (duplicates.length > 0) parts.push(host.t('{0} duplicate entry(ies) removed.', String(duplicates.length)));
  if (relinked > 0) parts.push(host.t('{0} checklist link(s) fixed.', String(relinked)));
  if (samplesBrought > 0) {
    parts.push(host.t('Brought {0} local sample(s) into {1}.', String(samplesBrought), posix.basename(labnoteDir)));
  }
  host.notify('info', parts.join(' '));
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
  // Labels that matched the old file name follow the new one (#68). Read up
  // front: the transform below must be synchronous.
  const labels = new Map<string, string>();
  for (const { to } of collapseWorkflowRenames(renames)) {
    labels.set(to, await readWorkflowLabel(host, labnoteDir, to));
  }
  await processNoteThroughVault(
    app,
    host,
    readmePath,
    content =>
      reconcileWorkflowChecklist(content, renames, {
        labelFor: name => labels.get(name) ?? defaultWorkflowTitle(name),
        dir: labnoteDir,
      }).content
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
 * checklist entries (surgically — preserving order + any manual links) and drop
 * the deleted notes from each sample's `sources`. The samples themselves are
 * kept, so sample data survives a note deletion.
 */
export async function syncReadmeAndSamplesOnDelete(
  app: App,
  host: LabnoteHost,
  labnoteDir: string,
  deletedPaths: string[],
  opts: SampleCleanupOpts = {}
): Promise<void> {
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
  //    record that listed this note as a source drops it from `sources`, but the
  //    sample itself stays. Failures are non-fatal: the file is already gone.
  for (const p of deletedPaths) {
    try {
      await removeSourcesForDocument(
        host.fs,
        p,
        '',
        opts.globalSampleFolder,
        opts.customTypes
      );
    } catch (err) {
      console.warn('[labnoteo] sample cleanup during workflow delete failed:', err);
    }
  }
}
