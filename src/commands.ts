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
import { Platform, TFile, type App, type Editor } from 'obsidian';
import type {
  LabnoteHost,
  WorkflowItem,
  UnitOperationItem,
  ExperimentStatus,
  PickItem,
  PromptHint,
  InsertUnitOperationInput,
} from '@labnoteo/core';
import {
  insertUnitOperation,
  workflowPathProblem,
  rebuildUnitOpToc,
  locateInsertedUnitOpHeading,
  unitOpInsertPointAtCursor,
  EXPERIMENT_STATUSES,
  isValidStatus,
  catalogKoEntry,
  catalogDescriptionFor,
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
  experimentTitleBudget,
  experimentTitleLength,
  getExperimentDir,
  sanitizeTitle,
} from '@labnoteo/core/lib/labnoteStructure';
import { fullPathLength, WINDOWS_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import {
  ensureWorkflowResources,
  loadWorkflows,
  loadUnitOperations,
} from '@labnoteo/core/lib/workflowDataLoader';
import {
  getNextWorkflowNumber,
  workflowAliasBudget,
  workflowAliasLength,
  createWorkflowFileName,
  createWorkflowContent,
  parseWorkflowChecklistFromReadme,
  insertWorkflowChecklistEntries,
  hasWorkflowChecklistSection,
  findSameAliasWorkflow,
  isWorkflowChecklistEntryLine,
  workflowChecklistEntryLabel,
  parseExperimenterFromReadme,
  reconcileWorkflowChecklist,
  planWorkflowRenumber,
  workflowChecklistOrder,
  isMisnumberedWorkflowFileName,
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
    found.kind === 'nested'
      ? host.t(
          '"{0}" is not recognized as an experiment: experiment folders must be directly under labnote/. Move it back to labnote/.',
          posix.basename(found.folder)
        )
      : found.kind === 'noPrefix'
        ? host.t(
            '"{0}" is not an experiment folder: its name must start with ###_ (e.g. 001_Name).',
            posix.basename(found.folder)
          )
        : host.t('Open a lab note first.')
  );
  return undefined;
}

/**
 * Names under `labnote/`, plus the `###_` folders one level down in an
 * unnumbered folder: an experiment moved into a grouping folder is no longer
 * recognised, but its number must not be handed out again (#166).
 */
async function experimentFolderNames(host: LabnoteHost): Promise<string[]> {
  const names = await host.fs.list('labnote');
  const nested: string[] = [];
  for (const name of names) {
    if (/^\d{3}_/.test(name) || name.includes('.')) continue;
    try {
      nested.push(...(await host.fs.list(posix.join('labnote', name))).filter(n => /^\d{3}_/.test(n)));
    } catch {
      // Not a folder.
    }
  }
  return [...names, ...nested];
}

/**
 * Warn, without stopping, when a file just made is past Windows' path limit
 * once the vault's own folder is counted (#148): names are capped, but a vault
 * deep in the disk can still push the whole path over.
 */
function warnIfWindowsPathTooLong(app: App, host: LabnoteHost, vaultPath: string): void {
  if (!Platform.isWin) return;
  const basePath = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
  if (!basePath) return;
  const length = fullPathLength(basePath, vaultPath);
  if (length < WINDOWS_PATH_MAX) return;
  host.notify(
    'warn',
    host.t(
      '"{0}" is {1} characters long including the vault folder, past the {2} Windows allows. Opening it on Windows (including git clones) may fail; move the vault to a shorter folder path or shorten the name.',
      posix.basename(vaultPath),
      String(length),
      String(WINDOWS_PATH_MAX - 1)
    )
  );
}

/**
 * How much of a new experiment's title fits in its folder name (#213). Never
 * blocks: past the cap only the folder name is cut.
 */
export function experimentTitleHint(host: Pick<LabnoteHost, 't'>): (value: string) => PromptHint {
  const budget = experimentTitleBudget();
  return value => {
    const length = experimentTitleLength(value);
    return {
      text: host.t(
        '{0}/{1} characters in the folder name. Anything longer is cut from the folder name only; the experiment title keeps it all.',
        String(length),
        String(budget)
      ),
      warn: length > budget,
    };
  };
}

/**
 * How much of a workflow alias fits in the file name after `ID_name_` (#213);
 * the room differs per workflow. Never blocks: past it only the file name is cut.
 */
export function workflowAliasHint(
  host: Pick<LabnoteHost, 't'>,
  id: string,
  name: string,
  /** The experiment folder's file names: an alias another workflow of this ID has is flagged (#297). */
  existing: readonly string[] = []
): (value: string) => PromptHint {
  const budget = workflowAliasBudget(id, name);
  return value => {
    const twin = findSameAliasWorkflow(existing, id, name, value);
    if (twin) {
      return {
        text: host.t(
          '{0} already has this ID and alias, so the two would read the same in the README checklist. Give this one its own alias to tell them apart.',
          twin
        ),
        warn: true,
      };
    }
    const length = workflowAliasLength(value);
    if (budget === 0) {
      return {
        text: host.t(
          "This workflow's name is long, so the alias won't fit in the file name. The title and checklist still keep it."
        ),
        warn: length > 0,
      };
    }
    return {
      text: host.t(
        '{0}/{1} characters in the file name. Anything longer is cut from the file name only; the workflow title and checklist keep it all.',
        String(length),
        String(budget)
      ),
      warn: length > budget,
    };
  };
}

/** A unit-operation alias goes into no file name, so it has no limit (#213). */
export function unitOpAliasHint(host: Pick<LabnoteHost, 't'>): (value: string) => PromptHint {
  return value =>
    ({
      text: host.t('{0} characters · no limit (not used in a file name)', String(Array.from(value.trim()).length)),
    });
}

/** What a workflow is, for the workflow name prompts (#213). */
export function workflowConcept(host: Pick<LabnoteHost, 't'>): string {
  return host.t(
    'A workflow is a note for one design, build, test or learn stage of the experiment. The alias tells uses of the same workflow apart and also goes into the file name and the README checklist. You can leave it empty.'
  );
}

/** A catalog item's description in the UI language, when the vault's copy still has the bundled text (#213). */
export function catalogDescription(id: string, description: string): string {
  return catalogDescriptionFor(id, description, getObsidianLanguage());
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
    hint: experimentTitleHint(host),
  });
  if (!title) return;

  const existing = await experimentFolderNames(host);
  const structure = createLabnoteStructure(VAULT_ROOT, title.trim(), existing, undefined, {
    locale: getObsidianLanguage(),
  });

  await host.fs.mkdir(structure.labnoteFolder);
  await host.fs.mkdir(structure.imagesFolder);
  await host.fs.mkdir(structure.resourcesFolder);
  await host.fs.write(structure.readmePath, structure.readmeContent);

  await host.openFile(structure.readmePath);
  host.notify('info', host.t('Experiment created: {0}', posix.basename(structure.labnoteFolder)));
  warnIfWindowsPathTooLong(app, host, structure.readmePath);
}

/**
 * What each status means, shown under its name in the picker, and the words
 * its search also matches (#249). The stored value stays the English term;
 * only the explanation and the search words are translated, so a Korean user
 * finds `needs-repeat` by typing 재실험.
 */
function statusMeanings(host: LabnoteHost): Record<ExperimentStatus, { detail: string; keywords: string }> {
  return {
    planned: {
      detail: host.t('Planned: written down, not started yet'),
      keywords: host.t('planned not started yet'),
    },
    'in-progress': {
      detail: host.t('In progress: being run now'),
      keywords: host.t('in progress running now'),
    },
    'needs-review': {
      // The GitHub issue only happens through the vault automation (#79).
      detail: host.t('Needs review: with the research automation, a push opens a GitHub issue for this experiment'),
      keywords: host.t('needs review discussion issue'),
    },
    completed: {
      detail: host.t('Completed: finished, with the results written down'),
      keywords: host.t('completed done finished'),
    },
    failed: {
      detail: host.t('Failed: it did not work'),
      keywords: host.t('failed did not work'),
    },
    discontinued: {
      detail: host.t('Discontinued: stopped on the way, not to be taken up again'),
      keywords: host.t('discontinued stopped abandoned'),
    },
    'needs-repeat': {
      detail: host.t('Needs repeat: to be run once more'),
      keywords: host.t('needs repeat again redo'),
    },
  };
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
  const folderName = posix.basename(labnoteDir);
  // A value typed in the properties panel may be outside the list (#143);
  // validate fails on it only after a push, so say so here.
  const placeholder =
    current && !isValidStatus(current)
      ? host.t('The current status "{0}" is not an allowed value. Select a status', current)
      : host.t('Select a status');
  // The stored values are English, so the list says what each one means and
  // takes Korean search words too (#249).
  const meanings = statusMeanings(host);
  const chosen = await host.pick(
    EXPERIMENT_STATUSES.map(status => ({
      label: status,
      description: status === current ? host.t('current') : undefined,
      detail: meanings[status].detail,
      keywords: meanings[status].keywords.split(/\s+/).filter(Boolean),
      value: status,
    })),
    { title: `${host.t('Change experiment status')}: ${folderName}`, placeholder }
  );
  if (!chosen || chosen === current) return;

  if (chosen === 'completed' && !(await confirmCompleted(host, labnoteDir, body))) return;

  // Set (or insert, when absent) `status`. Spreading keeps the order of the
  // existing keys and appends `status` for notes that predate the field.
  const updated = renderNote({ ...frontMatter, status: chosen }, body);

  await writeNoteThroughVault(app, host, readmePath, stamp(updated));
  let message = host.t('Experiment status changed ({0}): {1} → {2}', folderName, current ?? host.t('(none)'), chosen);
  // Ctrl+Z only reaches the README when it is the open note (#126).
  const active = app.workspace.getActiveFile()?.path;
  if (active !== readmePath) {
    message += ` ${host.t("Changed {0}'s README, not this note.", folderName)}`;
    if (current) {
      // From the workflow view with another experiment open, the palette
      // command would change the open experiment instead (#141).
      const sameExperiment = active !== undefined && getExperimentDir(active) === labnoteDir;
      message += ` ${
        experimentDir !== undefined && !sameExperiment
          ? host.t('To undo, right-click this experiment in the workflow view again and pick {0}.', current)
          : host.t('To undo, run "{0}" again and pick {1}.', host.t('Change experiment status'), current)
      }`;
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
 * Before an experiment is marked completed — the state the automation drafts
 * papers from — ask when its checklist still has unchecked workflows or
 * workflow notes without an `end_date` (#174). True to go ahead. Only what was
 * found is named, so a count of zero does not send the user looking (#275).
 */
export async function confirmCompleted(host: LabnoteHost, labnoteDir: string, readmeBody: string): Promise<boolean> {
  const items = parseWorkflowChecklistFromReadme(readmeBody);
  const unchecked = items.filter(i => !i.done).length;
  let noEndDate = 0;
  for (const item of items) {
    let name = normalizeChecklistLink(item.fileName, labnoteDir);
    try {
      name = decodeURI(name);
    } catch {
      // Used as written.
    }
    if (name.includes('/')) continue;
    const path = posix.join(labnoteDir, name);
    if (!(await host.fs.exists(path))) continue;
    const { frontMatter } = parseFrontMatterYaml((await host.fs.read(path)).replace(/\r\n/g, '\n'));
    const end = frontMatter.end_date;
    if ('end_date' in frontMatter && (end === null || end === undefined || String(end).trim() === '')) noEndDate++;
  }
  if (unchecked === 0 && noEndDate === 0) return true;
  const message =
    noEndDate === 0
      ? host.t('{0} workflow(s) in the checklist are not checked. Mark the experiment completed anyway?', String(unchecked))
      : unchecked === 0
        ? host.t('{0} workflow note(s) have no end_date. Mark the experiment completed anyway?', String(noEndDate))
        : host.t(
            '{0} workflow(s) in the checklist are not checked and {1} workflow note(s) have no end_date. Mark the experiment completed anyway?',
            String(unchecked),
            String(noEndDate)
          );
  return host.confirm(message, { confirmLabel: host.t('Mark completed') });
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
      plan.reason === 'metaDate'
        ? host.t('This Start_date/End_date already has a value. Use the 📅 picker next to it to change the date.')
        : host.t('A date cannot go on a front matter line that has a value. Run this in the body or on an empty value.')
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
  const refuse = (reason: 'conflict' | 'table' | 'frontMatter' | 'codeBlock' | 'comment'): false => {
    host.notify(
      'warn',
      reason === 'table'
        ? host.t('Issue markers cannot go inside a table. Run this on a line below the table.')
        : reason === 'frontMatter'
          ? host.t('Issue markers cannot go in the front matter. Run this in the note body.')
          : reason === 'codeBlock'
            ? host.t('Issue markers inside a code block open no issue. Run this on a line outside the code block.')
            : reason === 'comment'
              ? host.t('Issue markers inside a comment open no issue. Run this on a line outside the comment.')
              : host.t('This line already has an issue marker. A line can hold only one.')
    );
    return false;
  };

  // A README workflow entry whose link became the marker would no longer be an
  // entry (#293): there the marker always goes after the link.
  const lineAt = (text: string, offset: number): string => {
    const nl = text.indexOf('\n', offset);
    return text.slice(text.lastIndexOf('\n', offset - 1) + 1, nl === -1 ? text.length : nl);
  };

  let doc = editor.getValue();
  const from = editor.posToOffset(editor.getCursor('from'));
  const to = editor.posToOffset(editor.getCursor('to'));
  let plan;
  if (from !== to) {
    const selected = doc.slice(from, to);
    plan =
      !selected.includes('\n') && isWorkflowChecklistEntryLine(lineAt(doc, from))
        ? planIssueMarkerInsertion(doc, to, to, newId(doc), selected)
        : planIssueMarkerInsertion(doc, from, to, newId(doc));
  } else {
    // Refuse a line that cannot take a marker before asking for a topic.
    const probe = planIssueMarkerInsertion(doc, from, to, newId(doc), '-');
    if ('reason' in probe) return refuse(probe.reason);
    const topic = (
      await host.prompt({
        title: host.t('Issue topic sentence'),
        prompt: host.t('This sentence becomes the issue title. Keep the sentence from this line or type another.'),
        value: workflowChecklistEntryLabel(lineAt(doc, from)) ?? issueSentenceRange(doc, from)?.text ?? '',
        validate: v => (v.trim() ? null : host.t('Enter the topic sentence of the issue.')),
      })
    )?.trim();
    if (!topic) return false;
    // The note may have changed while the prompt was open.
    doc = editor.getValue();
    const caret = editor.posToOffset(editor.getCursor('from'));
    const sentence = issueSentenceRange(doc, caret);
    plan =
      sentence && sentence.text === topic && !isWorkflowChecklistEntryLine(lineAt(doc, caret))
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
  /** Whether it was added to the README checklist; see {@link registerWorkflowInReadme}. */
  registered: WorkflowRegistration;
}

/** The "created" notice, plus a warning when no README checklist lists it (#88, #298). */
function notifyWorkflowCreated(host: LabnoteHost, created: CreatedWorkflow): void {
  host.notify('info', host.t('Workflow created: {0}', created.fileName));
  if (created.registered === 'noReadme') {
    host.notify(
      'warn',
      host.t('This experiment has no README.labnote.md, so the workflow was not added to a checklist.')
    );
  } else if (created.registered === 'noSection') {
    host.notify(
      'warn',
      host.t(
        'README.labnote.md has no "Related Workflows" section, so the workflow was not added to its checklist. Add the section back, then run "{0}".',
        host.t('Sync workflow checklist with folder')
      )
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
  // Listed before the prompt, which warns about an alias already in use (#297).
  const existingFiles = await host.fs.list(labnoteDir);
  // Ask for an optional per-instance alias. The catalog name stays inside the
  // `[id name]` prefix; the alias (if any) is appended after it.
  const alias = await workflowAliasModal(app, {
    id: chosen.id,
    catalogName: chosen.name,
    title: host.t('Workflow name'),
    placeholder: host.t('Enter a name for this workflow'),
    about: workflowConcept(host),
    description: chosen.description ? catalogDescription(chosen.id, chosen.description) : undefined,
    hint: workflowAliasHint(host, chosen.id, chosen.name, existingFiles),
  });
  if (alias === undefined) return undefined; // cancelled
  const cleanAlias = alias.trim();

  const readmePath = posix.join(labnoteDir, README);
  let experimenter = '';
  if (await host.fs.exists(readmePath)) {
    experimenter = parseExperimenterFromReadme(await host.fs.read(readmePath));
  }

  const sequence = getNextWorkflowNumber(await host.fs.list(labnoteDir));
  const info = { id: chosen.id, name: chosen.name, description: chosen.description };
  const fileName = createWorkflowFileName(sequence, info, cleanAlias || undefined);
  const workflowPath = posix.join(labnoteDir, fileName);

  await host.fs.write(
    workflowPath,
    createWorkflowContent(info, experimenter, cleanAlias || undefined, {
      locale: getObsidianLanguage(),
    })
  );
  warnIfWindowsPathTooLong(app, host, workflowPath);

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

/** What {@link registerWorkflowInReadme} did. */
export type WorkflowRegistration = 'registered' | 'noSection' | 'noReadme';

/**
 * Add a new workflow to the README "Related Workflows" checklist
 * (non-destructive) and stamp the README's `last_updated_date`: creating a
 * workflow is a change to the experiment. Applied through the vault to the
 * README as it is at write time, so an open README editor neither overwrites it
 * nor loses its own unsaved text. Writes nothing without a README or without
 * the section to list it in (#298), and says which.
 */
export async function registerWorkflowInReadme(
  app: App,
  host: LabnoteHost,
  readmePath: string,
  entry: { title: string; fileName: string },
  stamp: (content: string) => string = c => c
): Promise<WorkflowRegistration> {
  if (!(await host.fs.exists(readmePath))) return 'noReadme';
  if (!hasWorkflowChecklistSection(await host.fs.read(readmePath))) return 'noSection';
  await processNoteThroughVault(app, host, readmePath, readme => {
    if (!hasWorkflowChecklistSection(readme)) return readme;
    return stamp(
      insertWorkflowChecklistEntries(readme, [{ done: false, title: entry.title, fileName: entry.fileName }])
    );
  });
  return 'registered';
}

/**
 * A catalog item's picker lines: in the Korean UI its Korean name before the
 * category, with its search words (#163), and its description translated
 * (#213). The English description then stays searchable as a keyword.
 * Nothing Korean for items a lab added or descriptions a lab edited.
 */
function catalogKoFields(
  id: string,
  category: string,
  description: string
): { description: string; detail: string; keywords?: readonly string[] } {
  const ko = getObsidianLanguage().toLowerCase().startsWith('ko') ? catalogKoEntry(id) : undefined;
  const detail = catalogDescription(id, description);
  const keywords = [...(ko ? [ko.name, ...(ko.keywords ?? [])] : []), ...(detail !== description ? [description] : [])];
  return {
    description: ko ? `${ko.name} · ${category}` : category,
    detail,
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

/** Present the workflow catalog picker (seeding catalog resources first). */
async function pickWorkflow(host: LabnoteHost): Promise<WorkflowItem | undefined> {
  await ensureWorkflowResources(host.fs, VAULT_ROOT);
  const catalog = await loadWorkflows(host.fs, VAULT_ROOT);
  return host.pick(
    catalog.workflows.map<PickItem<WorkflowItem>>(wf => ({
      label: `${wf.id}: ${wf.name}`,
      ...catalogKoFields(wf.id, wf.category, wf.description),
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
  const opened = host.editTarget();
  if (!opened) {
    host.notify('warn', host.t('Please open a workflow file.'));
    return;
  }
  const problem = workflowPathProblem(host, opened.path);
  if (problem) {
    host.notify('warn', problem);
    return;
  }

  await ensureWorkflowResources(host.fs, VAULT_ROOT);
  const hw = await loadUnitOperations(host.fs, VAULT_ROOT, 'hw');
  const sw = await loadUnitOperations(host.fs, VAULT_ROOT, 'sw');

  const items: PickItem<{ op: UnitOperationItem; kind: 'hw' | 'sw' }>[] = [
    ...hw.unitOperations.map(op => ({
      label: `${op.id}: ${op.name}`,
      ...catalogKoFields(op.id, 'HW', op.description),
      value: { op, kind: 'hw' as const },
    })),
    ...sw.unitOperations.map(op => ({
      label: `${op.id}: ${op.name}`,
      ...catalogKoFields(op.id, 'SW', op.description),
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
      about: host.t(
        'A unit operation is a single task within a workflow (one step using a piece of equipment or software). The alias tells repeats of the same task apart by run or condition and appears in its heading and the table of contents. You can leave it empty.'
      ),
      description: input.opDescription ? catalogDescription(input.opId, input.opDescription) : undefined,
      hint: unitOpAliasHint(host),
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
 * sequence, in the order of the README checklist (#289).
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
  const readmePath = posix.join(labnoteDir, README);
  const readmeBefore = (await host.fs.exists(readmePath)) ? await host.fs.read(readmePath) : undefined;
  // The checklist is where the researcher orders the experiment (#289).
  const order = readmeBefore === undefined ? [] : workflowChecklistOrder(readmeBefore, existing, labnoteDir);
  const renames = planWorkflowRenumber(existing, order);
  // Files the checklist does not list are renumbered too, so register them in
  // the same run; otherwise one takes 001 and the overview starts at 002 (#56).
  const syncPlan =
    readmeBefore === undefined
      ? undefined
      : planWorkflowChecklistSync(readmeBefore, existing, undefined, undefined, labnoteDir);
  const unlisted = syncPlan?.added.length ?? 0;
  // Without the section nothing can be listed or follow the new numbers (#298).
  const noSection = host.t('README.labnote.md has no "Related Workflows" section.');
  if (renames.length === 0 && unlisted === 0) {
    if (syncPlan && !syncPlan.hasSection) host.notify('warn', noSection);
    else host.notify('info', host.t('Workflow numbering already follows the README checklist.'));
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
  const preview =
    renames.length === 0
      ? ''
      : `\n\n${host.t(
          order.length > 0
            ? 'New numbers follow the order of the README checklist.'
            : 'New numbers follow the current file numbers.'
        )}\n${listFileNames(
          host,
          renames.map(r =>
            isMisnumberedWorkflowFileName(r.from)
              ? host.t('{0} → {1} (name format fixed)', r.from, r.to)
              : `${r.from} → ${r.to}`
          )
        )}`;
  const sectionNote = syncPlan && !syncPlan.hasSection ? `\n\n${noSection}` : '';
  if (!(await host.confirm(`${question}${preview}${sectionNote}`))) return;

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
      csvSkipped += (await moveTableCsvs(app, { from: labnoteDir, to: labnoteDir }, move, names)).skipped;
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
 * they keep the note's name and number, from `dirs.from` to `dirs.to` (the
 * same folder for a rename, another one for a move, #206). `names` and
 * `toNames` are the two folders' current listings (base names; one set for a
 * rename) and are updated as files move. A CSV whose new name is taken, or
 * whose rename fails, stays put and counts as skipped.
 */
export async function moveTableCsvs(
  app: App,
  dirs: { from: string; to: string },
  note: WorkflowRename,
  names: Set<string>,
  toNames: Set<string> = names
): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  if (dirs.from === dirs.to && note.from === note.to) return { moved, skipped };
  for (const csv of planTableCsvMoves(note.from, note.to, [...names])) {
    const file = app.vault.getFileByPath(posix.join(dirs.from, csv.from));
    if (!(file instanceof TFile) || toNames.has(csv.to)) {
      skipped++;
      continue;
    }
    try {
      await app.fileManager.renameFile(file, posix.join(dirs.to, csv.to));
      names.delete(csv.from);
      toNames.add(csv.to);
      moved++;
    } catch (err) {
      console.warn('[labnoteo] could not move table CSV:', err);
      skipped++;
    }
  }
  return { moved, skipped };
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
      .map(e => {
        const counts = [
          host.t('{0} unit operation line(s)', String(e.unitOpLines)),
          ...(e.skippedLines > e.skippedEmptyLines
            ? [host.t('{0} kept because the unit operation has an End_date', String(e.skippedLines - e.skippedEmptyLines))]
            : []),
          ...(e.skippedEmptyLines > 0
            ? [host.t('{0} left empty because the unit operation is finished; fill it in yourself', String(e.skippedEmptyLines))]
            : []),
        ].join(', ');
        return `- ${e.name}: ${e.from || host.t('(empty)')} → ${e.to} (${counts})`;
      })
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
  // The checklist cannot order notes that share a number (#288).
  const clashNotice = (): void => {
    if (plan.numberClashes.length === 0) return;
    host.notify('warn', workflowNumberClashNotice(host, plan.numberClashes));
  };

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
    clashNotice();
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
  clashNotice();
}

/** The warning that workflow notes `names` share a number, pointing at "Renumber workflows" (#288). */
export function workflowNumberClashNotice(host: Pick<LabnoteHost, 't'>, names: readonly string[]): string {
  return host.t('Workflow notes share a number: {0}. Run "{1}" to give each its own.', names.join(', '), host.t('Renumber workflows'));
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
 * After workflow files were renamed in the file explorer, relink their README
 * "Related Workflows" entries and move an entry the new number puts out of
 * order. `renames` are the old->new basenames accumulated for one experiment
 * folder; passing them lets reconcile relink correctly even when Obsidian's
 * "Automatically update internal links" setting is off. Only writes when the
 * section actually changes.
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
        move: true,
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
