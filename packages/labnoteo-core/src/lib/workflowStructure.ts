/**
 * Workflow Structure - Functions for creating workflow files and managing workflow checklist
 */

import * as path from '../util/posixPath';
import { getSeoulDateString, findMetaDateFieldInLine } from './dateUtils';
import {
  sanitizePathSegment,
  legacySanitizePathSegment,
  capPathSegment,
  escapeRegExp,
  WORKFLOW_FILE_NAME_MAX,
} from './regexUtils';
import { parseFrontMatterYaml, serializeFrontMatterEntry } from '../sections/frontMatter';
import { normalizeHeadingText, stepFence, type OpenFence } from '../sections/sectionEdit';
import { generateNoteId, NOTE_ID_KEY } from './noteId';
import {
  commandName,
  diagnoseExperimentPath,
  generateReadmeContent,
  getExperimentDir,
  KO_COMMAND_NAMES,
  type TemplateHintOptions,
} from './labnoteStructure';

/**
 * Workflow information for creating workflow files
 */
export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
}

/**
 * Workflow checklist item parsed from README
 */
export interface WorkflowChecklistItem {
  fileName: string;
  title: string;
  done: boolean;
}

/**
 * Check if a file path is a valid workflow file in a labnote subfolder
 * Path should be: {workspace}/labnote/{###_ExperimentName}/{###_WX###_Name}.md
 */
export function isValidWorkflowPath(filePath: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const baseName = path.basename(normalizedPath).toLowerCase();
  
  if (!normalizedPath.toLowerCase().endsWith('.labnote.md') || baseName === 'readme.labnote.md') {
    return false;
  }
  
  // Check if filename starts with 3-digit prefix
  const fileName = path.basename(normalizedPath);
  if (!/^\d{3}_/.test(fileName)) {
    return false;
  }
  
  try {
    const dirPath = path.dirname(normalizedPath);
    const experimentDirName = path.basename(dirPath);
    const labnoteDirPath = path.dirname(dirPath);
    const labnoteDirName = path.basename(labnoteDirPath).toLowerCase();
    
    // Check if parent folder is 'labnote' and experiment folder has 3-digit prefix
    return labnoteDirName === 'labnote' && /^\d{3}_/.test(experimentDirName);
  } catch {
    return false;
  }
}

/** {@link diagnoseWorkflowPath} result. */
export type WorkflowPathDiagnosis =
  /** A workflow note: `labnote/###_Experiment/###_….labnote.md`. */
  | { kind: 'ok' }
  /** The experiment's `README.labnote.md`, which holds no unit operations (#201). */
  | { kind: 'readme'; folder: string }
  /** In an experiment, but not a workflow note (no `###_`, not `.labnote.md`, or in a subfolder). */
  | { kind: 'notWorkflow'; folder: string }
  /** In a `###_` folder deeper than directly under `labnote/` (#166); `folder` is that folder. */
  | { kind: 'nested'; folder: string }
  /** In a folder under `labnote/` whose name lacks `###_`; `folder` is that folder. */
  | { kind: 'noPrefix'; folder: string }
  /** Not under `labnote/` at all. */
  | { kind: 'outside' };

/**
 * Why `filePath` is or is not a workflow note, so a command that needs one
 * can say what is wrong before asking for anything else (#201, #166). Uses
 * {@link isValidWorkflowPath} for the positive case and
 * {@link diagnoseExperimentPath} for where the note sits.
 */
export function diagnoseWorkflowPath(filePath: string): WorkflowPathDiagnosis {
  if (isValidWorkflowPath(filePath)) return { kind: 'ok' };
  const where = diagnoseExperimentPath(filePath);
  if (where.kind !== 'ok') return where;
  const normalized = filePath.replace(/\\/g, '/');
  if (path.dirname(normalized) === where.folder && path.basename(normalized).toLowerCase() === 'readme.labnote.md') {
    return { kind: 'readme', folder: where.folder };
  }
  return { kind: 'notWorkflow', folder: where.folder };
}

/**
 * The workflow file name a format-breaking rename most likely meant, or
 * undefined when there is no safe guess.
 *
 * Obsidian's rename box hides only the final `.md`, so `.labnote` reads as part
 * of the name and text typed at the end lands after it
 * (`001_X.labnote v3.md`). Moving that `.labnote` back to the end keeps what
 * the user typed: `001_X v3.labnote.md`. A name without the `###_` prefix is
 * not guessed at — the prefix carries the workflow's position.
 */
export function suggestWorkflowFileName(baseName: string): string | undefined {
  if (!/^\d{3}_/.test(baseName) || !/\.md$/i.test(baseName)) return undefined;
  if (baseName.toLowerCase().endsWith('.labnote.md')) return undefined;
  const moved = `${baseName.slice(0, -'.md'.length).replace(/\.labnote/i, '')}.labnote.md`;
  return suggestLinkableFileName(moved) ?? moved;
}

const UNLINKABLE_CHAR_RE = /[#^|[\]]/g;

/**
 * The characters of `fileName` that no link can reach it through (#326):
 * Obsidian reads `#` as a heading, `^` as a block and `|` as an alias in a
 * link target, and `[`/`]` end the link; neither `%23` nor `\#` helps. A
 * workflow note named so drops out of its README checklist.
 */
export function unlinkableNameChars(fileName: string): string[] {
  return [...new Set(fileName.match(UNLINKABLE_CHAR_RE) ?? [])];
}

/**
 * `fileName` without the characters of {@link unlinkableNameChars}, with
 * doubled or trailing `_` tidied, when that is still a workflow file name;
 * else undefined (also when nothing needs removing).
 */
export function suggestLinkableFileName(fileName: string): string | undefined {
  if (unlinkableNameChars(fileName).length === 0) return undefined;
  const fixed = fileName
    .replace(UNLINKABLE_CHAR_RE, '')
    .replace(/_{2,}/g, '_')
    .replace(/_+(?=\.labnote\.md$)/i, '');
  return /^\d{3}_.+\.labnote\.md$/i.test(fixed) ? fixed : undefined;
}

/** What a vault rename means for the README checklist; see {@link classifyWorkflowRename}. */
export type WorkflowRenameEffect =
  /** Workflow note renamed to another valid name: relink `from` → `to`. */
  | { kind: 'renamed'; dir: string; from: string; to: string }
  /** Workflow note renamed out of the `###_*.labnote.md` format. */
  | { kind: 'broken'; dir: string; origin: string; suggestion?: string }
  /** A previously broken note is a workflow note again: relink its original name. */
  | { kind: 'restored'; dir: string; from: string; to: string }
  /** A broken note renamed to another broken name; keep tracking its origin. */
  | { kind: 'strayMoved'; dir: string; origin: string };

/**
 * Classify a rename inside one experiment folder. `strayOrigin` is the original
 * workflow name of `oldPath` when an earlier rename broke its format — without
 * it a broken-to-valid rename cannot be tied back to a README entry. Renames
 * across folders or below the experiment folder are not handled (null).
 */
export function classifyWorkflowRename(
  oldPath: string,
  newPath: string,
  strayOrigin?: string
): WorkflowRenameEffect | null {
  const dir = path.dirname(newPath);
  if (dir !== path.dirname(oldPath) || getExperimentDir(newPath) !== dir) return null;

  const from = path.basename(oldPath);
  const to = path.basename(newPath);
  const wasValid = isValidWorkflowPath(oldPath);
  const isValid = isValidWorkflowPath(newPath);

  if (wasValid && isValid) return { kind: 'renamed', dir, from, to };
  if (wasValid) {
    const suggestion = suggestWorkflowFileName(to);
    return suggestion ? { kind: 'broken', dir, origin: from, suggestion } : { kind: 'broken', dir, origin: from };
  }
  if (!strayOrigin) return null;
  return isValid
    ? { kind: 'restored', dir, from: strayOrigin, to }
    : { kind: 'strayMoved', dir, origin: strayOrigin };
}

/** {@link classifyWorkflowMoveOut} result. */
export interface WorkflowMoveOut {
  /** The experiment folder the note left. */
  dir: string;
  /** Where it went: relative to `dir` (`images/`) when still inside it, else the vault folder (`/` for the root). */
  location: string;
}

/**
 * A workflow note moved to a folder where it is no longer a workflow step
 * (#94): a subfolder of its experiment such as `images/`, or anywhere outside
 * an experiment folder's top level. Null for other renames, for a move to
 * another experiment folder (still a workflow note there), and for a move into
 * a dot folder such as Obsidian's `.trash/`, which is a deletion.
 */
export function classifyWorkflowMoveOut(oldPath: string, newPath: string): WorkflowMoveOut | null {
  if (!isValidWorkflowPath(oldPath) || isValidWorkflowPath(newPath)) return null;
  const dir = path.dirname(oldPath);
  const newDir = path.dirname(newPath);
  if (newDir === dir) return null;
  if (newDir === '.') return { dir, location: '/' };
  if (newDir.split('/').some(segment => segment.startsWith('.'))) return null;
  const location = newDir.startsWith(`${dir}/`) ? newDir.slice(dir.length + 1) : newDir;
  return { dir, location: `${location}/` };
}

/**
 * Get the next workflow number based on existing files
 * @param existingFiles Array of existing file names (e.g., ['001_WD010_Design.md'])
 * @returns Next number as 3-digit string (e.g., '002')
 */
export function getNextWorkflowNumber(existingFiles: string[]): string {
  const numbers = existingFiles
    .filter(file => /^\d{3}_.*\.labnote\.md$/i.test(file) && file.toLowerCase() !== 'readme.labnote.md')
    .map(file => {
      const match = file.match(/^(\d{3})_/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter(n => n > 0);

  const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
  return String(maxNumber + 1).padStart(3, '0');
}

/**
 * Sanitize workflow name for use in filename
 * - Replaces spaces with underscores
 * - Removes punctuation/symbols but keeps Unicode letters (e.g. Korean),
 *   digits and underscores, so non-ASCII aliases survive in file names
 */
export function sanitizeWorkflowName(name: string): string {
  return sanitizePathSegment(name);
}

/**
 * Why `alias` cannot name a workflow or unit operation, or undefined (#411).
 * A `#` anywhere in the heading makes a link to it (`[[note#heading]]`, the
 * TOC's `(#anchor)`) end early, as a sample alias's does.
 */
export function workflowAliasProblem(alias: string): 'hash' | undefined {
  return alias.includes('#') ? 'hash' : undefined;
}

/**
 * Create workflow file content with YAML front matter
 * @param workflow Workflow information
 * @param experimenter Experimenter name (from README author field)
 * @param opts Hint options (UI locale for command names); `noteId` fixes the
 *   note's `labnote_id`, otherwise a fresh one is generated
 */
export function createWorkflowContent(
  workflow: WorkflowInfo,
  experimenter: string,
  alias?: string,
  opts: TemplateHintOptions & { noteId?: string } = {}
): string {
  const today = getSeoulDateString(new Date());
  // An optional per-instance alias is appended *after* the bracketed catalog
  // name (e.g. `[WT010 Nucleotide Sequencing] Genetic Circuit Sequencing`),
  // leaving the `[id name]` prefix intact for downstream parsing.
  const suffix = alias && alias.trim() ? ` ${alias.trim()}` : '';
  const title = `${workflow.id} ${workflow.name}${suffix}`;

  // Front matter goes through serializeFrontMatterEntry so a title/alias
  // containing a colon is emitted as valid, round-trippable YAML.
  const frontMatter = [
    serializeFrontMatterEntry('title', title),
    serializeFrontMatterEntry(NOTE_ID_KEY, opts.noteId ?? generateNoteId()),
    serializeFrontMatterEntry('experimenter', experimenter),
    serializeFrontMatterEntry('created_date', today),
    serializeFrontMatterEntry('last_updated_date', today),
    serializeFrontMatterEntry('end_date', ''),
  ].join('\n');

  return `---
${frontMatter}
---

## [${workflow.id} ${workflow.name}]${suffix}

> ${workflow.description}

## Related Unit Operations

> Unit operations are appended here automatically.
> Press Ctrl+P (Cmd+P on macOS) and run ${commandName('Insert unit operation', KO_COMMAND_NAMES.insertUnitOperation, opts.locale)} to add one.

## Conclusions and Discussion



`;
}

/**
 * Room left for an alias in the `ID_name_alias` part of a workflow file name
 * once `ID_name_` is in, never below 0; {@link createWorkflowFileName} cuts the
 * alias there.
 */
export function workflowAliasBudget(id: string, name: string): number {
  return Math.max(0, WORKFLOW_FILE_NAME_MAX - Array.from(`${id}_${sanitizeWorkflowName(name)}_`).length);
}

/** Code points of `alias` that go into a workflow file name, counted after sanitizing. */
export function workflowAliasLength(alias: string): number {
  return Array.from(sanitizeWorkflowName(alias.trim())).length;
}

/**
 * Create workflow filename with .md extension
 * @param sequence 3-digit sequence number (e.g., '001')
 * @param workflow Workflow information
 */
export function createWorkflowFileName(
  sequence: string,
  workflow: WorkflowInfo,
  alias?: string
): string {
  const safeName = sanitizeWorkflowName(workflow.name);
  // An alias made only of symbols/emoji sanitizes to '' — drop it rather than
  // leave a dangling `_` before the extension.
  const aliasSegment = alias && alias.trim() ? sanitizeWorkflowName(alias) : '';
  const safeAlias = aliasSegment ? `_${aliasSegment}` : '';

  // The title and alias stay whole in the note; only the file name is capped (#148).
  return `${sequence}_${capPathSegment(`${workflow.id}_${safeName}${safeAlias}`, WORKFLOW_FILE_NAME_MAX)}.labnote.md`;
}

/**
 * A "Related Workflows" checklist entry: indent and list marker, checkbox, link
 * title, a `.labnote.md` target, and whatever follows the link on the line.
 *
 * Deliberately ONE regex shared by the parser and every writer. While the two
 * disagreed the difference was deleted in silence: a researcher's own
 * `- [ ] ask Dr. Kim about the annealing temp` disappeared the next time
 * anything touched the checklist, and so did an `@issue` marker or a note
 * written after an entry's link (#293). Writers therefore change an entry's
 * link or label in place and keep its prefix and tail.
 *
 * The link part stays permissive (optional `./`, any characters up to the
 * suffix) so manually created links with non-ASCII file names are recognised —
 * the same reasoning as {@link removeWorkflowFromReadme}. No `g` flag, so the
 * object is safe to share.
 */
const CHECKLIST_ENTRY_RE =
  /^(\s*(?:[-*+]\s+)?)\[([ x])\]\s*\[(.+?)\]\((?:\.\/)?([^)]+\.labnote\.md)\)(.*)$/i;

/** One checklist entry line, split so a writer can change one part of it. */
interface ChecklistEntryLine {
  /** Line index in the README. */
  index: number;
  /** Indentation and list marker (`- `, `  * `), possibly empty. */
  prefix: string;
  /** The checkbox character as written (` `, `x` or `X`). */
  box: string;
  /** The label as written, still escaped. */
  raw: string;
  /** The link as written, without a leading `./`. */
  link: string;
  /** Everything after the link: an `@issue` marker, a note. */
  tail: string;
}

function parseChecklistEntryLine(line: string, index: number): ChecklistEntryLine | null {
  const m = CHECKLIST_ENTRY_RE.exec(line);
  if (!m) return null;
  return { index, prefix: m[1], box: m[2], raw: m[3], link: m[4], tail: m[5] };
}

/**
 * A checklist link with its `%20`-style escapes undone, so it compares with a
 * file name; a malformed escape is kept as written (#412).
 */
export function decodeChecklistLink(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

/** A file name as a Markdown link target: a space would end the link, so it becomes `%20` (#412). */
const encodeChecklistLink = (fileName: string): string => fileName.replace(/ /g, '%20');

/** The link as written into a checklist line; one with a folder part is not made relative (#102). */
function checklistLinkText(fileName: string): string {
  const link = encodeChecklistLink(fileName);
  return link.includes('/') ? link : `./${link}`;
}

function renderChecklistEntryLine(e: Omit<ChecklistEntryLine, 'index'>): string {
  return `${e.prefix}[${e.box}] [${e.raw}](${checklistLinkText(e.link)})${e.tail}`;
}

/**
 * A checklist label as written into the link text. An alias may carry
 * brackets (`[재]`, `LOC-01]`, #95); unescaped, an unbalanced one ends the
 * link text early and the entry renders as plain text.
 */
export function escapeChecklistLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

/** The label {@link escapeChecklistLabel} wrote. */
function unescapeChecklistLabel(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, '$1');
}

/**
 * Whether `line` is a workflow checklist entry (`- [ ] [label](./….labnote.md)`).
 * An `@issue` marker that replaced its link text would stop it being one (#293).
 */
export function isWorkflowChecklistEntryLine(line: string): boolean {
  return CHECKLIST_ENTRY_RE.test(line);
}

/** The label of a workflow checklist entry line, unescaped; undefined for any other line. */
export function workflowChecklistEntryLabel(line: string): string | undefined {
  const e = parseChecklistEntryLine(line, 0);
  return e ? unescapeChecklistLabel(e.raw) : undefined;
}

/** Heading words that name the "Related Workflows" section, after {@link normalizeHeadingText}. */
const WORKFLOW_SECTION_NAMES = ['related workflows', '관련 워크플로'];

/**
 * Find the "Related Workflows" header and the line the section ends on (the
 * next `## ` heading, or end of document). `header` is -1 when absent.
 *
 * The heading is matched loosely — emoji and case aside, any `##` heading
 * containing "Related Workflows" or "관련 워크플로" — since researchers
 * translate it (#298). Failing that, the first `##` section holding a
 * workflow entry is taken: a heading renamed to anything else still has its
 * entries under it.
 */
function findWorkflowSection(lines: readonly string[]): { header: number; end: number } {
  const isH2 = (line: string): boolean => /^##\s/.test(line.trim());
  const endOf = (header: number): number => {
    for (let i = header + 1; i < lines.length; i++) if (isH2(lines[i])) return i;
    return lines.length;
  };
  const named = lines.findIndex(line => {
    if (!isH2(line)) return false;
    const text = normalizeHeadingText(line.trim().replace(/^##\s+/, ''));
    return WORKFLOW_SECTION_NAMES.some(name => text.includes(name));
  });
  if (named !== -1) return { header: named, end: endOf(named) };
  for (let i = 0; i < lines.length; i++) {
    if (!isH2(lines[i])) continue;
    const end = endOf(i);
    if (lines.slice(i + 1, end).some(isWorkflowChecklistEntryLine)) return { header: i, end };
    i = end - 1;
  }
  return { header: -1, end: lines.length };
}

/** Whether the README has a "Related Workflows" section (see {@link findWorkflowSection}) to list workflows in. */
export function hasWorkflowChecklistSection(readmeContent: string): boolean {
  return findWorkflowSection(readmeContent.split('\n')).header !== -1;
}

/**
 * Parse workflow checklist from README content
 * Looks for items in the "Related Workflows" section
 */
export function parseWorkflowChecklistFromReadme(readmeContent: string): WorkflowChecklistItem[] {
  // Downstream commands still validate each name via `parseWorkflowFileName`.
  return entriesInLines(readmeContent.split('\n')).map(e => ({
    done: e.box.toLowerCase() === 'x',
    title: unescapeChecklistLabel(e.raw),
    fileName: decodeChecklistLink(e.link),
  }));
}

/** The checklist entry lines of the "Related Workflows" section of `lines`. */
function entriesInLines(lines: readonly string[]): ChecklistEntryLine[] {
  const { header, end } = findWorkflowSection(lines);
  if (header === -1) return [];
  const entries: ChecklistEntryLine[] = [];
  for (let i = header + 1; i < end; i++) {
    const e = parseChecklistEntryLine(lines[i], i);
    if (e) entries.push(e);
  }
  return entries;
}

/** The `NNN` of a checklist link's workflow file name, or undefined when it is not one. */
function checklistSequence(link: string): number | undefined {
  const parsed = parseWorkflowFileName(link.split('/').pop() ?? link);
  return parsed ? parseInt(parsed.sequence, 10) : undefined;
}

const leadingSpace = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * End (exclusive) of the entry at line `start`: the entry and the indented,
 * non-blank lines under it, which belong to it (a sub-task, a note). A line
 * at the entry's own depth — a researcher's to-do between two entries — does
 * not, so it stays where it was written when the entry moves (#290).
 */
function entryBlockEnd(lines: readonly string[], start: number, end: number): number {
  const depth = leadingSpace(lines[start]);
  let i = start + 1;
  while (i < end && lines[i].trim() !== '' && leadingSpace(lines[i]) > depth) i++;
  return i;
}

/**
 * Where a checklist line for workflow number `seq` goes among `entries`: after
 * the block of the last numbered entry at or below `seq`, else before the
 * first numbered entry. Entries are compared by number, not position, so an
 * order the researcher arranged by hand is left alone. Without a number (or
 * with no numbered entry) it goes after the last entry.
 */
function checklistInsertAt(
  lines: readonly string[],
  entries: readonly ChecklistEntryLine[],
  seq: number | undefined,
  end: number
): number {
  const last = entries[entries.length - 1];
  const afterLast = entryBlockEnd(lines, last.index, end);
  if (seq === undefined) return afterLast;
  const numbered = entries.filter(e => checklistSequence(e.link) !== undefined);
  if (numbered.length === 0) return afterLast;
  const below = numbered.filter(e => checklistSequence(e.link)! <= seq);
  if (below.length === 0) return numbered[0].index;
  return entryBlockEnd(lines, below[below.length - 1].index, end);
}

/**
 * Add checklist entries for `items` to the "Related Workflows" section. Each
 * goes where {@link checklistInsertAt} puts it, written with the list marker
 * of the entries already there. Every other line — an entry's tail, the
 * researcher's own to-dos, prose — stays as it was. With no entry yet the
 * first one goes after the instruction blockquote. Unchanged without the
 * section.
 */
export function insertWorkflowChecklistEntries(
  readmeContent: string,
  items: readonly WorkflowChecklistItem[]
): string {
  const lines = readmeContent.split('\n');
  if (items.length === 0 || findWorkflowSection(lines).header === -1) return readmeContent;
  for (const item of items) {
    const { header, end } = findWorkflowSection(lines);
    const entries = entriesInLines(lines);
    const line = renderChecklistEntryLine({
      prefix: entries[0]?.prefix ?? '- ',
      box: item.done ? 'x' : ' ',
      raw: escapeChecklistLabel(item.title),
      link: item.fileName,
      tail: '',
    });
    if (entries.length > 0) {
      lines.splice(checklistInsertAt(lines, entries, checklistSequence(item.fileName), end), 0, line);
      continue;
    }
    // After the header, past the blank lines and the instruction blockquote.
    let at = header + 1;
    while (at < end && lines[at].trim() === '') at++;
    while (at < end && lines[at].trim().startsWith('>')) at++;
    while (at < end && lines[at].trim() === '') at++;
    // Keep a blank line between the new entry and whatever follows it.
    const separator = at < lines.length && lines[at].trim() !== '' ? [''] : [];
    lines.splice(at, 0, line, ...separator);
  }
  return lines.join('\n');
}

/**
 * Generate workflow checklist markdown
 * @param items Array of workflow checklist items
 */
export function generateWorkflowChecklist(items: WorkflowChecklistItem[]): string {
  if (items.length === 0) {
    return '';
  }
  
  // Standard Markdown task-list item (`- [ ]`) so Obsidian renders an
  // interactive checkbox instead of literal `[ ]` text.
  return items
    .map(item =>
      renderChecklistEntryLine({
        prefix: '- ',
        box: item.done ? 'x' : ' ',
        raw: escapeChecklistLabel(item.title),
        link: item.fileName,
        tail: '',
      })
    )
    .join('\n');
}

/**
 * Parsed components of a workflow filename `{sequence}_{id}_{safeName}.labnote.md`.
 * Used by the rename-workflow command (issue #19) to decompose a file before
 * computing the new on-disk path while keeping `sequence` and `id` immutable.
 */
export interface ParsedWorkflowFileName {
  sequence: string;
  id: string;
  safeName: string;
}

/**
 * Parse a workflow filename into its components, or return `null` when the
 * filename does not match the standard pattern enforced by
 * `createWorkflowFileName`. Accepts any `[A-Z]{2}\d{3}` id (including `WX` for
 * uncategorised entries).
 */
export function parseWorkflowFileName(fileName: string): ParsedWorkflowFileName | null {
  const match = fileName.match(/^(\d{3})_([A-Z]{2}\d{3})_(.+)\.labnote\.md$/);
  if (!match) return null;
  return { sequence: match[1], id: match[2], safeName: match[3] };
}

/**
 * A single old-to-new workflow filename remap captured from a vault rename
 * event. Both are plain basenames (e.g. `001_WD010_Design.labnote.md`).
 */
export interface WorkflowRename {
  from: string;
  to: string;
}

/** Result of {@link reconcileWorkflowChecklist}. */
export interface ReconcileChecklistResult {
  changed: boolean;
  content: string;
}

/**
 * Collapse a sequence of renames into one hop per original name.
 *
 * Renames arrive as an ordered log (`a->b`, then `b->c`), because one user
 * action can move a file more than once before the README sync flushes — the
 * renumber command does exactly that, staging every file under a temporary
 * name so two files can swap numbers without colliding. A naive
 * `Map<from,to>` would then rewrite a README link to the intermediate name
 * (`b`), so each hop is chained onto the entry that produced it, yielding
 * `a->c`. Renames that cycle back to the original name drop out entirely.
 */
export function collapseWorkflowRenames(renames: readonly WorkflowRename[]): WorkflowRename[] {
  // origin-of-current-name -> current name, so a later `b->c` can find that `b`
  // originally came from `a`.
  const originOf = new Map<string, string>();
  const finalName = new Map<string, string>();

  for (const { from, to } of renames) {
    if (!from || !to) continue;
    const origin = originOf.get(from) ?? from;
    originOf.delete(from);
    originOf.set(to, origin);
    finalName.set(origin, to);
  }

  const collapsed: WorkflowRename[] = [];
  for (const [from, to] of finalName) {
    if (from !== to) collapsed.push({ from, to });
  }
  return collapsed;
}

/**
 * A workflow file name whose number has the wrong number of digits
 * (`01_WB030_X.labnote.md`, #289): "Renumber workflows" gives it a proper
 * one. Undefined for a standard name or anything else.
 */
function parseMisnumberedWorkflowFileName(fileName: string): ParsedWorkflowFileName | undefined {
  if (parseWorkflowFileName(fileName)) return undefined;
  const match = fileName.match(/^(\d{1,4})_([A-Z]{2}\d{3})_(.+)\.labnote\.md$/);
  return match ? { sequence: match[1], id: match[2], safeName: match[3] } : undefined;
}

/**
 * A workflow file name that lost its number (`WT110_X.labnote.md`, #382): a
 * note the checklist lists under it gets the number of its place there.
 */
function parseUnnumberedWorkflowFileName(fileName: string): ParsedWorkflowFileName | undefined {
  const match = fileName.match(/^([A-Z]{2}\d{3})_(.+)\.labnote\.md$/);
  return match ? { sequence: '000', id: match[1], safeName: match[2] } : undefined;
}

/**
 * Whether {@link planWorkflowRenumber} renames `fileName` only to fix the
 * format of its number: wrong digits, or none at all.
 */
export function isMisnumberedWorkflowFileName(fileName: string): boolean {
  return (
    parseMisnumberedWorkflowFileName(fileName) !== undefined || parseUnnumberedWorkflowFileName(fileName) !== undefined
  );
}

/**
 * The workflow files of the folder in the order the README checklist lists
 * them: in-folder targets present in `existingNames`, each once (#289).
 */
export function workflowChecklistOrder(
  readmeContent: string,
  existingNames: readonly string[],
  dir?: string
): string[] {
  const present = new Set(existingNames);
  const order: string[] = [];
  for (const { target } of checklistEntries(readmeContent, dir)) {
    if (target !== null && present.has(target) && !order.includes(target)) order.push(target);
  }
  return order;
}

/**
 * Plan a gap-free renumbering of an experiment folder's workflow files.
 *
 * Files are ordered as `checklistOrder` (see {@link workflowChecklistOrder})
 * lists them, since the README checklist is where the researcher arranges the
 * experiment (#289). A file it does not list goes before the first listed one
 * whose number and name sort after its own, so a note moved in from another
 * experiment lands where its number puts it (#56); with no checklist every
 * file is ordered that way. They are then handed `001, 002, ...` with no gaps.
 * The `id` and name parts are carried over verbatim rather than rebuilt through
 * {@link createWorkflowFileName}: the on-disk name is already sanitized, and
 * re-sanitizing could alter a name this operation is supposed to leave alone.
 *
 * Besides standard names, a name whose number has the wrong number of digits
 * is renumbered too ({@link isMisnumberedWorkflowFileName}), and so is one
 * with no number that the checklist lists (#382). Other entries (README,
 * notes, manually named files) are ignored, and files that already
 * carry their target number are omitted, so a folder whose numbers follow the
 * checklist plans to no renames.
 */
export function planWorkflowRenumber(
  fileNames: readonly string[],
  checklistOrder: readonly string[] = []
): WorkflowRename[] {
  const parts = new Map<string, ParsedWorkflowFileName>();
  const inChecklist = new Set(checklistOrder);
  for (const fileName of fileNames) {
    const parsed =
      parseWorkflowFileName(fileName) ??
      parseMisnumberedWorkflowFileName(fileName) ??
      (inChecklist.has(fileName) ? parseUnnumberedWorkflowFileName(fileName) : undefined);
    if (parsed) parts.set(fileName, parsed);
  }
  const before = (a: string, b: string): boolean => {
    const seqA = parseInt(parts.get(a)!.sequence, 10);
    const seqB = parseInt(parts.get(b)!.sequence, 10);
    return seqA !== seqB ? seqA < seqB : a < b;
  };

  const listed = new Set(checklistOrder.filter(name => parts.has(name)));
  const order = [...listed];
  const unlisted = [...parts.keys()].filter(name => !listed.has(name)).sort((a, b) => (before(a, b) ? -1 : 1));
  for (const name of unlisted) {
    const at = order.findIndex(other => listed.has(other) && before(name, other));
    if (at === -1) order.push(name);
    else order.splice(at, 0, name);
  }

  const renames: WorkflowRename[] = [];
  order.forEach((fileName, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    const { id, safeName } = parts.get(fileName)!;
    const to = `${sequence}_${id}_${safeName}.labnote.md`;
    if (to !== fileName) renames.push({ from: fileName, to });
  });
  return renames;
}

/**
 * Build the intermediate name a file is parked under during a renumber.
 *
 * A file can move onto a name another file has not vacated yet; it is then
 * parked here first (see {@link planRenumberMoves}). The temporary name keeps
 * the `NNN_ID_` shape so it still passes `isValidWorkflowPath` and
 * `parseWorkflowFileName`: a parked note stays a workflow note, so the rename
 * listeners do not mistake it for one renamed out of the format.
 */
export function buildRenumberStagingName(rename: WorkflowRename, index: number): string {
  const parts = parseWorkflowFileName(rename.to);
  if (!parts) return rename.to;
  return `${parts.sequence}_${parts.id}_${parts.safeName}_staging${index}.labnote.md`;
}

/**
 * Turn a {@link planWorkflowRenumber} plan into the renames to actually run,
 * in order.
 *
 * Every rename asks Obsidian to update links (a prompt when its "Automatically
 * update internal links" setting is off), so a file is moved straight to its
 * target whenever that name is free at that point, and parked under a
 * {@link buildRenumberStagingName} name only when it is still taken: a file
 * moving onto a name another file has not vacated yet, as when two files
 * trade places in the checklist or share a number. `existingNames` is the
 * folder listing before any move.
 */
export function planRenumberMoves(
  renames: readonly WorkflowRename[],
  existingNames: readonly string[]
): WorkflowRename[] {
  const occupied = new Set(existingNames);
  const moves: WorkflowRename[] = [];
  const parked: WorkflowRename[] = [];
  renames.forEach((rename, index) => {
    occupied.delete(rename.from);
    if (!occupied.has(rename.to)) {
      moves.push(rename);
      occupied.add(rename.to);
      return;
    }
    const staging = buildRenumberStagingName(rename, index);
    moves.push({ from: rename.from, to: staging });
    occupied.add(staging);
    parked.push({ from: staging, to: rename.to });
  });
  return [...moves, ...parked];
}

/** `001_X.labnote.md` → `001_X.labnote`: the prefix "Export tables to CSV" names its files with. */
function tableCsvStem(noteName: string): string {
  return noteName.replace(/\.md$/i, '');
}

/** The `<note>_tableN.csv` exports of `noteName` among `files` (base names). */
export function siblingTableCsvs(noteName: string, files: readonly string[]): string[] {
  const re = new RegExp(`^${escapeRegExp(tableCsvStem(noteName))}_table\\d+\\.csv$`);
  return files.filter(f => re.test(f));
}

/**
 * The CSV name of table `number` (1-based) of a note with `tableCount` tables.
 * The number has as many digits as `tableCount`, so the files sort in table
 * order by name (`_table01` … `_table11`, #217).
 */
export function tableCsvName(noteName: string, number: number, tableCount: number): string {
  const digits = String(Math.max(tableCount, 1)).length;
  return `${tableCsvStem(noteName)}_table${String(number).padStart(digits, '0')}.csv`;
}

/** What "Export tables to CSV" does to the table CSVs already next to a note. */
export interface TableCsvPlan {
  /** The CSV name of each table, in table order. */
  names: string[];
  /** Existing CSVs of a table whose name differs only in its digits, to take the new name. */
  renames: WorkflowRename[];
  /** The CSVs left over once renamed: numbered above the table count, or not renamed for a collision. Sorted by table number. */
  stale: string[];
}

/**
 * Plan the table CSVs of `noteName` for `tableCount` tables among `files`
 * (base names). Renames and leftovers are planned together: a CSV about to be
 * renamed is not also offered for the trash.
 */
export function planTableCsvNames(noteName: string, files: readonly string[], tableCount: number): TableCsvPlan {
  const names = Array.from({ length: tableCount }, (_, i) => tableCsvName(noteName, i + 1, tableCount));
  const offset = `${tableCsvStem(noteName)}_table`.length;
  const number = (f: string) => Number(f.slice(offset, -'.csv'.length));
  const taken = new Set(files);
  const renames: WorkflowRename[] = [];
  const stale: string[] = [];
  const siblings = siblingTableCsvs(noteName, files).sort((a, b) => number(a) - number(b) || a.localeCompare(b));
  for (const f of siblings) {
    const n = number(f);
    const name = n >= 1 && n <= tableCount ? names[n - 1] : undefined;
    if (name === f) continue;
    if (name && !taken.has(name)) {
      renames.push({ from: f, to: name });
      taken.add(name);
      continue;
    }
    stale.push(f);
  }
  return { names, renames, stale };
}

/**
 * The table CSVs of `noteName` that do not belong to its `tableCount` tables
 * (#74): left over from tables the note no longer has. Sorted by table number.
 */
export function staleTableCsvs(noteName: string, files: readonly string[], tableCount: number): string[] {
  return planTableCsvNames(noteName, files, tableCount).stale;
}

/**
 * The `<note>.labnote_tableN.csv` exports among `files` (base names in one
 * folder) whose note is not there: left behind by a note deleted, or by a
 * rename that found the new CSV name taken (#374). Only lab notes' CSVs, so
 * a CSV of another source that happens to end in `_table1` is left alone.
 */
export function orphanTableCsvs(files: readonly string[]): string[] {
  const present = new Set(files);
  return files.filter(f => {
    const stem = /^(.+\.labnote)_table\d+\.csv$/.exec(f)?.[1];
    return stem !== undefined && !present.has(`${stem}.md`);
  });
}

/**
 * The renames that keep a note's table CSVs named after it when the note goes
 * from `fromNote` to `toNote` (#60). Collisions are left to the caller.
 */
export function planTableCsvMoves(
  fromNote: string,
  toNote: string,
  files: readonly string[]
): WorkflowRename[] {
  const from = tableCsvStem(fromNote);
  const to = tableCsvStem(toNote);
  return siblingTableCsvs(fromNote, files).map(f => ({ from: f, to: `${to}${f.slice(from.length)}` }));
}

/** Options for {@link reconcileWorkflowChecklist}. */
export interface ReconcileChecklistOptions {
  /**
   * README content to read the checklist entries from instead of
   * `readmeContent`, e.g. a snapshot taken before a batch of renames. The
   * rebuilt entries still replace the entries in `readmeContent`.
   */
  baseline?: string;
  /**
   * The label for a renamed file's new name. When given, an entry whose label
   * matched its old file name (see {@link labelMatchesFileName}) takes this
   * label; a label the user wrote by hand is kept (#68). Without it labels
   * never change.
   */
  labelFor?: (fileName: string) => string;
  /**
   * The README's folder. A link Obsidian wrote vault-absolute because another
   * folder has a file of the same name goes back to `./<file name>` (#102).
   */
  dir?: string;
  /**
   * Move an entry whose number a rename changed when it now sits out of number
   * order with its neighbours (a file renamed in the explorer). Off for
   * "Renumber workflows", whose new numbers already follow the checklist.
   */
  move?: boolean;
}

/**
 * Follow workflow files renamed in the file explorer or by "Renumber
 * workflows" in the README "Related Workflows" checklist.
 *
 * `renames` (old->new basenames captured from vault rename events) are applied
 * to each entry's link, so the checklist follows even when Obsidian's
 * "Automatically update internal links" setting is off. When Obsidian has
 * already rewritten a link, the remap is usually a no-op — but not when one
 * file's new name is another file's old name (two workflows with the same id
 * and name, renumbered): the already-updated link is then remapped a second
 * time onto the wrong file. Batches that can do that pass `opts.baseline`, the
 * README as it was before the batch, so every link is remapped exactly once.
 *
 * Only an entry's link and label change, in place: its checkbox, list marker
 * and whatever follows the link (#293) stay, and so does the order the
 * researcher gave the entries, with their own lines among them (#290, #289).
 * With `opts.move` an entry a rename put out of number order moves, alone with
 * the lines indented under it. Entries whose file is missing are never dropped
 * — deletion is handled separately. Returns `{changed:false}` when the README
 * has no "Related Workflows" section or the content is unaffected.
 */
export function reconcileWorkflowChecklist(
  readmeContent: string,
  renames: WorkflowRename[],
  opts: ReconcileChecklistOptions = {}
): ReconcileChecklistResult {
  const dir = opts.dir;
  const lines = readmeContent.split('\n');
  const current = entriesInLines(lines);
  if (current.length === 0) {
    return { changed: false, content: readmeContent };
  }
  // The baseline gives each entry the link it had before the batch; entries
  // pair up by position, which a batch of renames does not change.
  const baseline = opts.baseline === undefined ? undefined : entriesInLines(opts.baseline.split('\n'));
  const source = baseline && baseline.length === current.length ? baseline : current;

  // Remap each link by basename (a checklist link may carry a `./` or subpath).
  // Chained hops are collapsed first so a file that moved twice before this
  // flush (`a->b->c`) relinks to `c`, not to the intermediate `b`.
  const remap = new Map<string, string>();
  // new -> old: with "Automatically update internal links" on, Obsidian has
  // already relinked the entry, and the old name is needed to compare labels.
  const origin = new Map<string, string>();
  for (const r of collapseWorkflowRenames(renames)) {
    remap.set(r.from, r.to);
    origin.set(r.to, r.from);
  }
  const baseName = (fileName: string): string => fileName.split('/').pop() ?? fileName;
  const renumbered: string[] = [];
  current.forEach((entry, k) => {
    const written = dir === undefined ? source[k].link : normalizeChecklistLink(source[k].link, dir);
    const base = decodeChecklistLink(baseName(written));
    const to = remap.get(base);
    const link = to ?? written;
    let raw = entry.raw;
    if (opts.labelFor) {
      const oldName = to ? base : origin.get(base);
      const label = unescapeChecklistLabel(entry.raw);
      if (oldName !== undefined && labelMatchesFileName(label, oldName)) {
        raw = escapeChecklistLabel(opts.labelFor(to ?? base));
      }
    }
    if (link !== entry.link || raw !== entry.raw) {
      lines[entry.index] = renderChecklistEntryLine({ ...entry, raw, link });
    }
    const was = checklistSequence(origin.get(base) ?? base);
    if (opts.move && was !== checklistSequence(link)) renumbered.push(link);
  });
  for (const link of renumbered) moveEntryIntoNumberOrder(lines, link);

  const content = lines.join('\n');
  return { changed: content !== readmeContent, content };
}

/**
 * Move the entry linking to `link` when its number no longer fits between its
 * numbered neighbours, to where {@link checklistInsertAt} would put it. An
 * entry still in order — renamed 004 → 006 at the end of the list — stays, so
 * the lines around it are not reshuffled.
 */
function moveEntryIntoNumberOrder(lines: string[], link: string): void {
  const entries = entriesInLines(lines);
  const at = entries.findIndex(e => decodeChecklistLink(e.link) === decodeChecklistLink(link));
  const seq = checklistSequence(link);
  if (at === -1 || seq === undefined) return;
  const prev = entries.slice(0, at).reverse().find(e => checklistSequence(e.link) !== undefined);
  const next = entries.slice(at + 1).find(e => checklistSequence(e.link) !== undefined);
  const inOrder =
    (!prev || checklistSequence(prev.link)! <= seq) && (!next || checklistSequence(next.link)! >= seq);
  if (inOrder) return;

  const { end } = findWorkflowSection(lines);
  const start = entries[at].index;
  const block = lines.splice(start, entryBlockEnd(lines, start, end) - start);
  const rest = entriesInLines(lines);
  if (rest.length === 0) {
    lines.splice(start, 0, ...block);
    return;
  }
  lines.splice(checklistInsertAt(lines, rest, seq, findWorkflowSection(lines).end), 0, ...block);
}

/** A checklist entry {@link planWorkflowChecklistSync} proposes to remove. */
export interface StaleWorkflowEntry {
  /** The link exactly as written in the README (without a leading `./`). */
  link: string;
  title: string;
  /**
   * `missing`: points into this folder at a file that is not there.
   * `elsewhere`: points into another folder. `subfolder`: the file sits in a
   * subfolder of this experiment (#94), at each of `found`.
   */
  reason: 'missing' | 'elsewhere' | 'subfolder';
  /** For `subfolder`: the file's paths relative to the experiment folder (`images/003_….labnote.md`). */
  found?: string[];
}

/**
 * Workflow notes below an experiment folder's top level, for
 * {@link planWorkflowChecklistSync}: `files` maps a file name to its paths
 * relative to `dir`.
 */
export interface WorkflowSubfolderNotes {
  dir: string;
  files: ReadonlyMap<string, readonly string[]>;
}

/** A checklist label to replace: entry for `fileName`, label `from` → `to`. */
export interface WorkflowRelabel {
  fileName: string;
  from: string;
  to: string;
}

/** Result of {@link planWorkflowChecklistSync}. */
export interface WorkflowChecklistSyncPlan {
  /** Whether the README has a `## Related Workflows` section to write into. */
  hasSection: boolean;
  /** Workflow files in the folder that the checklist does not list yet. */
  added: WorkflowChecklistItem[];
  /** Entries whose target is not a file in this folder. Not removed by `content`. */
  stale: StaleWorkflowEntry[];
  /**
   * Listed files whose label no longer matches their name, with the label
   * `titles` gives them. Not applied by `content`; see
   * {@link relabelWorkflowChecklistEntries}.
   */
  relabel: WorkflowRelabel[];
  /**
   * Files of this folder listed more than once, one name per extra entry. Not
   * removed by `content`; see {@link dedupeWorkflowChecklistEntries}.
   */
  duplicates: string[];
  /**
   * Labels of entries whose link text is not escaped the way
   * {@link escapeChecklistLabel} writes it (#95); see
   * {@link normalizeWorkflowChecklistLabels}.
   */
  unescaped: string[];
  /**
   * Workflow files of the folder whose number another file also has, sorted
   * (#288). The checklist cannot tell their order; "Renumber workflows" can.
   */
  numberClashes: string[];
  /**
   * Workflow files of the folder whose name no checklist link can reach
   * (see {@link unlinkableNameChars}), sorted (#326). Their entries look
   * matched here but do not open; only renaming the file helps.
   */
  unlinkable: string[];
  /** README with `added` inserted by number (see {@link insertWorkflowChecklistEntries}); unchanged when nothing is added. */
  content: string;
}

/**
 * A checklist link (as parsed, without a leading `./`) that points at a file
 * directly in `dir`, reduced to its file name. Obsidian writes a vault-absolute
 * link (`labnote/001_A/001_X.labnote.md`) when another folder has a file of the
 * same name, and older versions prefixed that with `./` (#102). Any other link
 * is returned as is.
 */
export function normalizeChecklistLink(link: string, dir: string): string {
  const decoded = decodeChecklistLink(link);
  const normalized = path.normalize(decoded).replace(/^\/+/, '');
  if (!normalized.includes('/')) return link;
  const folder = path.normalize(dir).replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.dirname(normalized) !== folder) return link;
  return link.slice(link.lastIndexOf('/') + 1);
}

/**
 * Rewrite the checklist entries whose link reaches a file of `dir` by a longer
 * path (see {@link normalizeChecklistLink}) to `./<file name>`, keeping
 * checkbox and label. Returns how many entries changed.
 */
export function normalizeWorkflowChecklistLinks(
  readmeContent: string,
  dir: string
): { content: string; count: number } {
  const lines = readmeContent.split('\n');
  let count = 0;
  for (const { index, link } of checklistEntries(readmeContent)) {
    const short = normalizeChecklistLink(link, dir);
    if (short === link) continue;
    const written = lines[index].includes(`](./${link})`) ? `](./${link})` : `](${link})`;
    lines[index] = lines[index].replace(written, () => `](${checklistLinkText(short)})`);
    count++;
  }
  return count === 0 ? { content: readmeContent, count } : { content: lines.join('\n'), count };
}

/**
 * Where a checklist link points, relative to the README's folder: the file
 * name when it stays in the folder, or null when it leaves it. Obsidian
 * rewrites a moved workflow's link to `../002_B/001_X.labnote.md`, which must
 * not be taken for this folder's `001_X.labnote.md`.
 */
function linkTargetInFolder(link: string, dir?: string): string | null {
  if (dir !== undefined) link = normalizeChecklistLink(link, dir);
  const decoded = decodeChecklistLink(link);
  const normalized = path.normalize(decoded);
  return normalized.includes('/') ? null : normalized;
}

/** Checklist title for a workflow file the checklist does not list yet: `WT020 Protein Expression`. */
export function defaultWorkflowTitle(fileName: string): string {
  const parts = parseWorkflowFileName(fileName);
  if (!parts) return fileName.replace(/\.labnote\.md$/i, '');
  return `${parts.id} ${parts.safeName.replace(/_/g, ' ')}`;
}

/**
 * Whether a checklist label names the same workflow as `fileName`: the label
 * and the file's `{ID}_{name}` part are equal once both go through the path
 * sanitizer, so `WT020 Protein/Enzyme Expression` matches
 * `002_WT020_ProteinEnzyme_Expression.labnote.md`. A file named before the
 * current rules (#148 length cap, #165 `_plus`/`_minus`) matches under the
 * rules it was named with, so `IND+` still matches `..._IND.labnote.md`. Both
 * sides are cut to the current cap, so a file cut at the longer cap of 0.101.0
 * still matches its label.
 */
export function labelMatchesFileName(label: string, fileName: string): boolean {
  const parts = parseWorkflowFileName(fileName);
  if (!parts) return false;
  const file = `${parts.id}_${parts.safeName}`;
  return (
    capPathSegment(sanitizePathSegment(label), WORKFLOW_FILE_NAME_MAX) ===
      capPathSegment(sanitizePathSegment(file), WORKFLOW_FILE_NAME_MAX) ||
    legacySanitizePathSegment(label) === legacySanitizePathSegment(file)
  );
}

/**
 * A workflow file among `names` that a new workflow `id name alias` would be
 * indistinguishable from (#297): same ID and alias, both possibly empty, so
 * its checklist label and file name differ only by number. Compared like
 * {@link labelMatchesFileName}.
 */
export function findSameAliasWorkflow(
  names: readonly string[],
  id: string,
  name: string,
  alias: string
): string | undefined {
  const label = [id, name, alias.trim()].filter(Boolean).join(' ');
  return names.find(file => parseWorkflowFileName(file)?.id === id && labelMatchesFileName(label, file));
}

/** The `## [ID name] alias` heading a workflow note starts with. */
export interface WorkflowHeading {
  id: string;
  /** Catalog name, punctuation intact (`Protein/Enzyme Expression`). */
  name: string;
  /** Text after the bracket, trimmed; `''` when there is none. */
  alias: string;
}

const WORKFLOW_HEADING_RE = /^##\s+\[([A-Z]{2}\d{3})\s+([^\]]+)\](.*)$/;

/** The note's `## [ID name] alias` heading, or undefined when it has none. */
export function parseWorkflowHeading(content: string): WorkflowHeading | undefined {
  for (const line of content.split(/\r?\n/)) {
    const m = WORKFLOW_HEADING_RE.exec(line);
    if (m) return { id: m[1], name: m[2].trim(), alias: m[3].trim() };
  }
  return undefined;
}

/**
 * The checklist label for workflow file `fileName` whose note text is
 * `content` (#65, #68). In order: the front-matter `title` when it matches the
 * file name; else the catalog name from the `## [ID name]` heading plus the
 * file name's alias part, so catalog punctuation (`Protein/Enzyme`) survives;
 * else {@link defaultWorkflowTitle}.
 */
export function workflowLabelFor(fileName: string, content?: string): string {
  const parts = parseWorkflowFileName(fileName);
  if (!parts || content === undefined) return defaultWorkflowTitle(fileName);
  const text = content.replace(/\r\n/g, '\n');
  const title = frontMatterTitle(text);
  if (title && labelMatchesFileName(title, fileName)) return title;
  const heading = parseWorkflowHeading(text);
  const alias = heading ? workflowAliasFromFileName(fileName, heading) : undefined;
  if (heading && alias !== undefined) return workflowTitleText(heading.id, heading.name, alias);
  return defaultWorkflowTitle(fileName);
}

/** The note's front-matter `title`, trimmed; undefined when absent, empty or unreadable. */
function frontMatterTitle(text: string): string | undefined {
  let title: unknown;
  try {
    title = parseFrontMatterYaml(text).frontMatter.title;
  } catch {
    return undefined;
  }
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

/** `ID name alias` — the {@link createWorkflowContent} title form. */
function workflowTitleText(id: string, name: string, alias: string): string {
  return alias.trim() ? `${id} ${name} ${alias.trim()}` : `${id} ${name}`;
}

/**
 * The alias part of workflow file `fileName` whose note has `heading`: what
 * follows the heading's catalog name in the file name, `_` read as spaces, or
 * `''` when nothing follows. Undefined when the file's ID or catalog-name part
 * no longer matches the heading.
 */
export function workflowAliasFromFileName(fileName: string, heading: WorkflowHeading): string | undefined {
  const parts = parseWorkflowFileName(fileName);
  if (!parts || heading.id !== parts.id) return undefined;
  for (const safe of new Set([sanitizePathSegment(heading.name), legacySanitizePathSegment(heading.name)])) {
    if (parts.safeName === safe) return '';
    if (safe && parts.safeName.startsWith(`${safe}_`)) {
      return parts.safeName.slice(safe.length + 1).replace(/_/g, ' ');
    }
  }
  return undefined;
}

/**
 * The catalog IDs of workflow file `fileName` and of its note's `## [ID name]`
 * heading when they differ (#240), the one case where
 * {@link planWorkflowRetitle} gives up without anything to fix.
 */
export function workflowIdMismatch(fileName: string, content: string): { fileId: string; noteId: string } | undefined {
  const fileId = parseWorkflowFileName(fileName)?.id;
  const noteId = parseWorkflowHeading(content.replace(/\r\n/g, '\n'))?.id;
  return fileId && noteId && fileId !== noteId ? { fileId, noteId } : undefined;
}

/** {@link planWorkflowRetitle} result. */
export interface WorkflowRetitle {
  /** The note's title before (its heading text when it has no title). */
  from: string;
  /** The title the note gets. */
  to: string;
  /** The note with its title and/or heading rewritten. */
  content: string;
}

/**
 * Make a workflow note's front-matter `title` and `## [ID name] alias` heading
 * name the same workflow as its file `toName` (#71), with the alias taken from
 * the file name ({@link workflowAliasFromFileName}, the text the checklist
 * label gets too). Only the parts that do not match `toName` are rewritten.
 *
 * With `fromName` (a rename), the note changes only when its title — its
 * heading when it has no title — matched the old name, and each part only if
 * it did: a title or heading edited by hand is kept. Undefined when nothing
 * changes, the note has no such heading, or the file's ID or catalog-name part
 * no longer matches the heading.
 */
export function planWorkflowRetitle(
  content: string,
  toName: string,
  fromName?: string
): WorkflowRetitle | undefined {
  const text = content.replace(/\r\n/g, '\n');
  const heading = parseWorkflowHeading(text);
  if (!heading) return undefined;
  const alias = workflowAliasFromFileName(toName, heading);
  if (alias === undefined) return undefined;

  const title = frontMatterTitle(text);
  const headingText = workflowTitleText(heading.id, heading.name, heading.alias);
  const current = title ?? headingText;
  // A file whose catalog ID was changed by hand, with the offer to put it back
  // declined, keeps a title naming the heading's ID: compare under that ID too,
  // or the next alias change leaves the title behind for good (#268).
  const fromParts = fromName === undefined ? null : parseWorkflowFileName(fromName);
  const fromUnderHeadingId =
    fromParts && fromParts.id !== heading.id
      ? `${fromParts.sequence}_${heading.id}_${fromParts.safeName}.labnote.md`
      : undefined;
  const matchedOld = (label: string) =>
    fromName === undefined ||
    labelMatchesFileName(label, fromName) ||
    (fromUnderHeadingId !== undefined && labelMatchesFileName(label, fromUnderHeadingId));
  if (!matchedOld(current)) return undefined;

  const fixTitle = title !== undefined && !labelMatchesFileName(title, toName) && matchedOld(title);
  const fixHeading = !labelMatchesFileName(headingText, toName) && matchedOld(headingText);
  if (!fixTitle && !fixHeading) return undefined;
  const next = rewriteWorkflowTitle(content, heading.id, heading.name, alias, {
    title: fixTitle,
    heading: fixHeading,
  });
  if (next === content) return undefined;
  return { from: current, to: workflowTitleText(heading.id, heading.name, alias), content: next };
}

/**
 * Give a workflow note a new alias: its front-matter `title` becomes
 * `ID name alias` (the {@link createWorkflowContent} form) and its
 * `## [ID name]` heading line carries the alias. Nothing else changes; the
 * front matter is edited line by line, not re-serialized. `parts` limits the
 * rewrite to the title or the heading.
 */
export function rewriteWorkflowTitle(
  content: string,
  id: string,
  name: string,
  alias: string,
  parts: { title?: boolean; heading?: boolean } = {}
): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const suffix = alias.trim() ? ` ${alias.trim()}` : '';

  if (parts.title !== false && lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      if (/^title\s*:/.test(lines[i])) {
        lines[i] = serializeFrontMatterEntry('title', `${id} ${name}${suffix}`);
        break;
      }
    }
  }
  if (parts.heading !== false) {
    const h2 = new RegExp(`^##\\s+\\[${escapeRegExp(id)}\\s+[^\\]]+\\]`);
    const at = lines.findIndex(l => h2.test(l));
    if (at !== -1) lines[at] = `## [${id} ${name}]${suffix}`;
  }
  return lines.join(newline);
}

/**
 * Compare an experiment folder with its README "Related Workflows" checklist.
 *
 * `existingNames` is the folder listing (any file); only names that
 * `parseWorkflowFileName` decodes are proposed for adding, under the title from
 * `titles` (the note's front-matter title) or {@link defaultWorkflowTitle}.
 * Stale entries are only reported: the caller asks before removing them with
 * {@link removeWorkflowChecklistEntries}. Links are compared by where they
 * point, not by base name. `dir`, the README's folder, lets a vault-absolute
 * link into it count as this folder's file (#102); it defaults to `subfolders.dir`.
 */
export function planWorkflowChecklistSync(
  readmeContent: string,
  existingNames: readonly string[],
  titles: ReadonlyMap<string, string> = new Map(),
  subfolders?: WorkflowSubfolderNotes,
  dir: string | undefined = subfolders?.dir
): WorkflowChecklistSyncPlan {
  const hasSection = hasWorkflowChecklistSection(readmeContent);
  const items = parseWorkflowChecklistFromReadme(readmeContent);
  const present = new Set(existingNames);

  const listed = new Set<string>();
  const stale: StaleWorkflowEntry[] = [];
  const relabel: WorkflowRelabel[] = [];
  for (const item of items) {
    const target = linkTargetInFolder(item.fileName, dir);
    if (target === null) {
      const found = subfolderMatches(item.fileName, subfolders);
      stale.push(
        found
          ? { link: item.fileName, title: item.title, reason: 'subfolder', found }
          : { link: item.fileName, title: item.title, reason: 'elsewhere' }
      );
      continue;
    }
    listed.add(target);
    if (!present.has(target)) {
      const found = subfolders?.files.get(target);
      stale.push(
        found && found.length > 0
          ? { link: item.fileName, title: item.title, reason: 'subfolder', found: [...found] }
          : { link: item.fileName, title: item.title, reason: 'missing' }
      );
      continue;
    }
    const label = titles.get(target);
    if (label && label !== item.title && !labelMatchesFileName(item.title, target)) {
      relabel.push({ fileName: target, from: item.title, to: label });
    }
  }

  const added: WorkflowChecklistItem[] = existingNames
    .filter(name => parseWorkflowFileName(name) !== null && !listed.has(name))
    .map(name => ({ done: false, title: titles.get(name) || defaultWorkflowTitle(name), fileName: name }));

  const duplicates: string[] = [];
  const unescaped: string[] = [];
  const seen = new Set<string>();
  for (const { raw, target } of checklistEntries(readmeContent, dir)) {
    if (target !== null && present.has(target)) {
      if (seen.has(target)) duplicates.push(target);
      seen.add(target);
    }
    const label = unescapeChecklistLabel(raw);
    if (escapeChecklistLabel(label) !== raw) unescaped.push(label);
  }

  const numberClashes = workflowNumberClashes(existingNames);
  const unlinkable = existingNames
    .filter(name => parseWorkflowFileName(name) !== null && unlinkableNameChars(name).length > 0)
    .sort();
  if (!hasSection || added.length === 0) {
    return {
      hasSection,
      added: hasSection ? added : [],
      stale,
      relabel: hasSection ? relabel : [],
      duplicates,
      unescaped,
      numberClashes,
      unlinkable,
      content: readmeContent,
    };
  }
  const content = insertWorkflowChecklistEntries(readmeContent, added);
  return { hasSection, added, stale, relabel, duplicates, unescaped, numberClashes, unlinkable, content };
}

/**
 * A new `README.labnote.md` for experiment folder `folderName` whose README
 * was deleted (#340): titled from the folder name (`003_효모_삽입` →
 * `효모 삽입`), with the workflow notes among `names` checklisted by number
 * under the labels `titles` gives. Status, objective and summary start over.
 */
export function rebuildExperimentReadme(
  folderName: string,
  names: readonly string[],
  titles: ReadonlyMap<string, string>,
  author: string | undefined,
  opts: TemplateHintOptions = {}
): string {
  const title = folderName.replace(/^\d{3}_/, '').replace(/_/g, ' ').trim() || folderName;
  return planWorkflowChecklistSync(generateReadmeContent(title, author, opts), names, titles).content;
}

/** The workflow file names among `names` that share their number with another, sorted. */
export function workflowNumberClashes(names: readonly string[]): string[] {
  const bySequence = new Map<string, string[]>();
  for (const name of names) {
    const parsed = parseWorkflowFileName(name);
    if (parsed) bySequence.set(parsed.sequence, [...(bySequence.get(parsed.sequence) ?? []), name]);
  }
  return [...bySequence.values()].filter(group => group.length > 1).flat().sort();
}

/**
 * The subfolder path a link with a folder part points at, when it is one of
 * `subfolders`: relative (`images/X`) or vault-absolute (`labnote/001_A/images/X`).
 * A link into another experiment (`../002_B/images/X`) does not match.
 */
function subfolderMatches(link: string, subfolders: WorkflowSubfolderNotes | undefined): string[] | undefined {
  if (!subfolders) return undefined;
  const decoded = decodeChecklistLink(link);
  const normalized = path.normalize(decoded).replace(/^\//, '');
  const rel = (subfolders.files.get(path.basename(normalized)) ?? []).find(
    r => normalized === r || normalized === `${subfolders.dir}/${r}`
  );
  return rel === undefined ? undefined : [rel];
}

/**
 * Checklist entries whose file is gone, each paired with the one workflow file
 * the checklist does not list that has the same ID and name whatever its
 * number (#381): an undo in the README after "Renumber workflows", or a
 * rename the README missed, leaves an entry on the old number. `relink` is
 * for {@link relinkWorkflowChecklistEntries}; `missing` are the links that
 * match no file, or more than one.
 */
export function matchMissingChecklistEntries(
  readmeContent: string,
  existingNames: readonly string[],
  dir?: string
): { relink: { from: string; to: string }[]; missing: string[] } {
  const present = new Set(existingNames);
  const entries = checklistEntries(readmeContent, dir);
  const listed = new Set(entries.flatMap(e => (e.target !== null && present.has(e.target) ? [e.target] : [])));
  const unnumbered = (name: string): string => name.replace(/^\d{1,4}_/, '');
  const unlisted = existingNames.filter(
    name => !listed.has(name) && /^(?:\d{1,4}_)?[A-Z]{2}\d{3}_.+\.labnote\.md$/.test(name)
  );
  const relink: { from: string; to: string }[] = [];
  const missing: string[] = [];
  const taken = new Set<string>();
  for (const { link, target } of entries) {
    if (target === null || present.has(target) || !/\.labnote\.md$/.test(target)) continue;
    const found = unlisted.filter(name => unnumbered(name) === unnumbered(target) && !taken.has(name));
    if (found.length === 1) {
      relink.push({ from: link, to: found[0] });
      taken.add(found[0]);
    } else {
      missing.push(target);
    }
  }
  return { relink, missing };
}

/**
 * Point the checklist entries linking exactly to `from` at `./to` instead,
 * keeping checkbox and label: a note moved back from a subfolder whose link
 * Obsidian did not update (#94).
 */
export function relinkWorkflowChecklistEntries(
  readmeContent: string,
  links: readonly { from: string; to: string }[]
): string {
  if (links.length === 0) return readmeContent;
  const lines = readmeContent.split('\n');
  for (const { index, link } of checklistEntries(readmeContent)) {
    const r = links.find(l => l.from === link);
    if (!r) continue;
    const written = lines[index].includes(`](./${link})`) ? `](./${link})` : `](${link})`;
    lines[index] = lines[index].replace(written, () => `](./${encodeChecklistLink(r.to)})`);
  }
  return lines.join('\n');
}

/**
 * Point the checklist of a copied experiment back at its own notes (#320).
 * Renaming the copy makes Obsidian write vault-absolute links, because the
 * original holds notes of the same names; copied again, those links reach
 * the earlier experiment. An entry whose link reaches a note directly in
 * some experiment folder, when `copyDir` holds a note of that name (`names`),
 * becomes `./<name>`, keeping checkbox, label and tail. Returns how many changed.
 */
export function relinkCopiedExperimentChecklist(
  readmeContent: string,
  copyDir: string,
  names: readonly string[]
): { content: string; count: number } {
  const own = new Set(names);
  const lines = readmeContent.split('\n');
  let count = 0;
  for (const e of entriesInLines(lines)) {
    const decoded = decodeChecklistLink(e.link);
    const resolved = decoded.startsWith('../')
      ? path.normalize(path.join(copyDir, decoded))
      : path.normalize(decoded).replace(/^\/+/, '');
    if (!resolved.includes('/')) continue;
    const folder = path.dirname(resolved);
    const name = path.basename(resolved);
    if (getExperimentDir(folder) !== folder || !own.has(name)) continue;
    lines[e.index] = renderChecklistEntryLine({ ...e, link: name });
    count++;
  }
  return count === 0 ? { content: readmeContent, count } : { content: lines.join('\n'), count };
}

/** Each checklist entry of the "Related Workflows" section: line index, raw label, in-folder target. */
function checklistEntries(
  readmeContent: string,
  dir?: string
): { index: number; done: boolean; raw: string; link: string; target: string | null }[] {
  return entriesInLines(readmeContent.split('\n')).map(e => ({
    index: e.index,
    done: e.box.toLowerCase() === 'x',
    raw: e.raw,
    link: e.link,
    target: linkTargetInFolder(e.link, dir),
  }));
}

/**
 * Apply {@link WorkflowChecklistSyncPlan.duplicates}: keep the first entry for
 * each of `fileNames` and drop the later ones, checking the kept one when any
 * of them was checked.
 */
export function dedupeWorkflowChecklistEntries(
  readmeContent: string,
  fileNames: readonly string[],
  dir?: string
): string {
  if (fileNames.length === 0) return readmeContent;
  const wanted = new Set(fileNames);
  const lines = readmeContent.split('\n');
  const first = new Map<string, number>();
  const drop = new Set<number>();
  for (const { index, done, target } of checklistEntries(readmeContent, dir)) {
    if (target === null || !wanted.has(target)) continue;
    const kept = first.get(target);
    if (kept === undefined) {
      first.set(target, index);
      continue;
    }
    drop.add(index);
    if (done) lines[kept] = lines[kept].replace(/^(\s*(?:[-*+]\s+)?)\[ \]/, '$1[x]');
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/**
 * Apply {@link WorkflowChecklistSyncPlan.unescaped}: rewrite each entry's link
 * text the way {@link escapeChecklistLabel} writes it. The label reads the same.
 */
export function normalizeWorkflowChecklistLabels(readmeContent: string): string {
  const lines = readmeContent.split('\n');
  for (const { index, raw } of checklistEntries(readmeContent)) {
    const label = escapeChecklistLabel(unescapeChecklistLabel(raw));
    if (label !== raw) lines[index] = lines[index].replace(`[${raw}](`, () => `[${label}](`);
  }
  return lines.join('\n');
}

/**
 * Apply {@link WorkflowChecklistSyncPlan.relabel}: replace the label of each
 * entry that links to `fileName` in this folder and still reads `from`. Only
 * the label text changes; order, checkboxes and other lines stay as they are.
 */
export function relabelWorkflowChecklistEntries(
  readmeContent: string,
  relabel: readonly WorkflowRelabel[],
  dir?: string
): string {
  if (relabel.length === 0) return readmeContent;
  const lines = readmeContent.split('\n');
  for (const e of entriesInLines(lines)) {
    const target = linkTargetInFolder(e.link, dir);
    const r = relabel.find(x => x.fileName === target && x.from === unescapeChecklistLabel(e.raw));
    if (r) lines[e.index] = renderChecklistEntryLine({ ...e, raw: escapeChecklistLabel(r.to) });
  }
  return lines.join('\n');
}

/**
 * Remove the "Related Workflows" checklist entries whose link is exactly one of
 * `links` (as parsed, without a leading `./`). Unlike `removeWorkflowFromReadme`
 * this does not compare base names, so removing `../002_B/001_X.labnote.md`
 * leaves this folder's `001_X.labnote.md` entry alone.
 */
export function removeWorkflowChecklistEntries(
  readmeContent: string,
  links: readonly string[]
): string {
  if (links.length === 0) return readmeContent;
  const wanted = new Set(links);
  const lines = readmeContent.split('\n');
  const drop = new Set(entriesInLines(lines).filter(e => wanted.has(e.link)).map(e => e.index));
  return drop.size === 0 ? readmeContent : lines.filter((_, i) => !drop.has(i)).join('\n');
}

/**
 * Whether `baseName` looks like a copy of a workflow note: `###_` prefix and
 * `.labnote` followed by more text before `.md` — Obsidian's "Make a copy"
 * (`001_X.labnote 1.md`) or an OS file manager copy (`001_X.labnote - Copy.md`).
 */
export function isCopiedWorkflowFileName(baseName: string): boolean {
  return /^\d{3}_.*\.labnote.+\.md$/i.test(baseName) && !/\.labnote\.md$/i.test(baseName);
}

/**
 * The workflow name to give a copied note: the original name under the next
 * free sequence number (`001_WT020_X.labnote 1.md` → `003_WT020_X.labnote.md`).
 * `suggestWorkflowFileName` would keep the original number instead. Undefined
 * when the part before `.labnote` is not a standard workflow name.
 */
export function suggestCopiedWorkflowFileName(
  baseName: string,
  existingNames: readonly string[]
): string | undefined {
  if (!isCopiedWorkflowFileName(baseName)) return undefined;
  const stem = baseName.slice(0, baseName.search(/\.labnote/i));
  const parts = parseWorkflowFileName(`${stem}.labnote.md`);
  if (!parts) return undefined;
  const name = `${getNextWorkflowNumber([...existingNames])}_${parts.id}_${parts.safeName}.labnote.md`;
  return suggestLinkableFileName(name) ?? name;
}

/** {@link planWorkflowExperimenterSync} result. */
export interface WorkflowExperimenterSync {
  /** The note's `experimenter` before ('' when empty). */
  from: string;
  /** The README author it gets. */
  to: string;
  /** The note with the experimenter lines rewritten. */
  content: string;
  /** Unit-op `- Experimenter:` lines rewritten. */
  unitOpLines: number;
  /** Unit-op `- Experimenter:` lines kept because their unit op has an `End_date` (#155). */
  skippedLines: number;
  /** How many of {@link skippedLines} are empty, so nobody's name is kept there (#193). */
  skippedEmptyLines: number;
}

/**
 * Make a workflow note's experimenter the README `author` again after the
 * author was changed (#83). The front-matter `experimenter` line is rewritten,
 * and so is each `- Experimenter:` line of a unit operation outside code
 * blocks that still reads the old value or nothing: a unit op inserted after
 * the change already has the new name, and another person's name was written
 * on purpose. A unit op (from its `### [` heading to the next) whose
 * `End_date` is filled in is finished work and keeps who did it (#155). The
 * label is the same in every locale. Undefined when `author` is empty, the
 * note has no `experimenter` key, or it already matches.
 */
/**
 * Whether the workflow note `content` has unit operations and each has its
 * Meta `End_date` filled: the work is done even if the front matter
 * `end_date`, which nothing fills, is still empty (#355).
 */
export function unitOpsAllEnded(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const ended: boolean[] = [];
  let fence: OpenFence | null = null;
  for (const line of lines) {
    const next = stepFence(line, fence);
    if (next !== fence || fence) {
      fence = next;
      continue;
    }
    if (/^###\s+\[/.test(line)) {
      ended.push(false);
      continue;
    }
    const date = findMetaDateFieldInLine(line);
    if (ended.length > 0 && date?.field === 'End_date' && date.value.trim() !== '') ended[ended.length - 1] = true;
  }
  return ended.length > 0 && ended.every(Boolean);
}

export function planWorkflowExperimenterSync(
  content: string,
  author: string
): WorkflowExperimenterSync | undefined {
  const to = author.trim();
  if (!to) return undefined;
  const { frontMatter, parseError } = parseFrontMatterYaml(content.replace(/\r\n/g, '\n'));
  if (parseError || !('experimenter' in frontMatter)) return undefined;
  const value = frontMatter.experimenter;
  const from = value === null || value === undefined ? '' : String(value).trim();
  if (from === to) return undefined;

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (lines[0]?.trim() !== '---' || fmEnd === -1) return undefined;
  for (let i = 1; i < fmEnd; i++) {
    if (/^experimenter\s*:/.test(lines[i])) lines[i] = serializeFrontMatterEntry('experimenter', to);
  }
  // Experimenter lines to rewrite, grouped by unit op, and which unit ops ended.
  const blocks: { lines: number[]; empty: number; ended: boolean }[] = [{ lines: [], empty: 0, ended: false }];
  let fence: OpenFence | null = null;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence || fence) {
      fence = next;
      continue;
    }
    if (/^###\s+\[/.test(lines[i])) {
      blocks.push({ lines: [], empty: 0, ended: false });
      continue;
    }
    const block = blocks[blocks.length - 1];
    const date = findMetaDateFieldInLine(lines[i]);
    if (date?.field === 'End_date' && date.value.trim() !== '') block.ended = true;
    const m = /^(\s*-\s*Experimenter:)(.*)$/.exec(lines[i]);
    if (m && (m[2].trim() === from || m[2].trim() === '')) {
      block.lines.push(i);
      if (m[2].trim() === '') block.empty++;
    }
  }
  let unitOpLines = 0;
  let skippedLines = 0;
  let skippedEmptyLines = 0;
  for (const block of blocks) {
    if (block.ended) {
      skippedLines += block.lines.length;
      skippedEmptyLines += block.empty;
      continue;
    }
    for (const i of block.lines) {
      lines[i] = `${/^(\s*-\s*Experimenter:)/.exec(lines[i])![1]} ${to}`;
      unitOpLines++;
    }
  }
  const next = lines.join(newline);
  return next === content ? undefined : { from, to, content: next, unitOpLines, skippedLines, skippedEmptyLines };
}

/**
 * Start a copied workflow note's dates over (#160): the front-matter
 * `created_date` and `last_updated_date` become `today`, `end_date` and every
 * unit op's `- Start_date:`/`- End_date:` (outside code blocks) are emptied,
 * so the copy does not claim the original's dates. Only keys the note has are
 * touched. Returns the content unchanged when there is nothing to reset.
 */
export function resetCopiedWorkflowDates(content: string, today: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const fmEnd = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  for (let i = 1; i < fmEnd; i++) {
    const key = /^(created_date|last_updated_date|end_date)\s*:/.exec(lines[i])?.[1];
    if (key) lines[i] = serializeFrontMatterEntry(key, key === 'end_date' ? '' : today);
  }
  let fence: OpenFence | null = null;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const next = stepFence(lines[i], fence);
    if (next !== fence || fence) {
      fence = next;
      continue;
    }
    const date = findMetaDateFieldInLine(lines[i]);
    if (!date || date.value === '') continue;
    const line = lines[i];
    lines[i] = date.quote
      ? line.slice(0, date.valueStart) + line.slice(date.valueEnd)
      : `${line.slice(0, date.valueStart)}''${line.slice(date.valueEnd)}`;
  }
  const next = lines.join(newline);
  return next === content ? content : next;
}

/**
 * Parse experimenter name from README YAML front matter
 */
export function parseExperimenterFromReadme(readmeContent: string): string {
  // Read `author:` through the shared YAML parser (single front-matter source of
  // truth) so a quoted author value is unquoted correctly. Issue #36 (an empty
  // author swallowing the next line) is handled structurally: an empty/missing
  // author parses to null/'' rather than the following key. Input is
  // CRLF-normalized for parsing only.
  const { frontMatter } = parseFrontMatterYaml(readmeContent.replace(/\r\n/g, '\n'));
  const author = frontMatter.author;
  return typeof author === 'string' ? author.trim() : '';
}
