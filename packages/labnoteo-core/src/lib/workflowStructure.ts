/**
 * Workflow Structure - Functions for creating workflow files and managing workflow checklist
 */

import * as path from '../util/posixPath';
import { getSeoulDateString } from './dateUtils';
import { sanitizePathSegment, escapeRegExp } from './regexUtils';
import { parseFrontMatterYaml, serializeFrontMatterEntry } from '../sections/frontMatter';
import {
  commandName,
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
  return `${baseName.slice(0, -'.md'.length).replace(/\.labnote/i, '')}.labnote.md`;
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
 * Create workflow file content with YAML front matter
 * @param workflow Workflow information
 * @param experimenter Experimenter name (from README author field)
 * @param opts Hint options (UI locale for command names)
 */
export function createWorkflowContent(
  workflow: WorkflowInfo,
  experimenter: string,
  alias?: string,
  opts: TemplateHintOptions = {}
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

  return `${sequence}_${workflow.id}_${safeName}${safeAlias}.labnote.md`;
}

/**
 * A "Related Workflows" checklist entry: optional `-` marker, checkbox, link
 * title, and a `.labnote.md` target.
 *
 * Deliberately ONE regex shared by the parser and the section rewriter. While
 * the two disagreed the difference was deleted in silence: the rewriter
 * consumed every `[ ]`/`- [x]` line in the section, but only lines matching
 * this pattern were parsed back out and regenerated. A researcher's own
 * `- [ ] ask Dr. Kim about the annealing temp` therefore disappeared the next
 * time anything touched the checklist.
 *
 * The link part stays permissive (optional `./`, any characters up to the
 * suffix) so manually created links with non-ASCII file names are recognised —
 * the same reasoning as {@link removeWorkflowFromReadme}. No `g` flag, so the
 * object is safe to share.
 */
const CHECKLIST_ENTRY_RE =
  /^(?:-\s+)?\[([ x])\]\s*\[([^\]]+)\]\((?:\.\/)?([^)]+\.labnote\.md)\)/i;

/** Whether `line` is a workflow checklist entry this module owns. */
function isWorkflowChecklistLine(line: string): boolean {
  return CHECKLIST_ENTRY_RE.test(line.trim());
}

/**
 * Find the `## Related Workflows` header and the line the section ends on (the
 * next `## ` heading, or end of document). `header` is -1 when absent.
 */
function findWorkflowSection(lines: string[]): { header: number; end: number } {
  const header = lines.findIndex(line => /^##\s.*Related Workflows/i.test(line.trim()));
  if (header === -1) return { header: -1, end: lines.length };

  for (let i = header + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) return { header, end: i };
  }
  return { header, end: lines.length };
}

/**
 * Parse workflow checklist from README content
 * Looks for items in the "Related Workflows" section
 */
export function parseWorkflowChecklistFromReadme(readmeContent: string): WorkflowChecklistItem[] {
  const lines = readmeContent.split('\n');
  const headerIndex = lines.findIndex(line => /^##\s.*Related Workflows/i.test(line.trim()));
  
  if (headerIndex === -1) {
    return [];
  }
  
  const items: WorkflowChecklistItem[] = [];
  
  // Start from line after header
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Stop at next section
    if (line.startsWith('## ')) {
      break;
    }
    
    // Downstream commands still validate each name via `parseWorkflowFileName`.
    const checkboxMatch = line.match(CHECKLIST_ENTRY_RE);
    if (checkboxMatch) {
      items.push({
        done: checkboxMatch[1].toLowerCase() === 'x',
        title: checkboxMatch[2],
        fileName: checkboxMatch[3],
      });
    }
  }
  
  return items;
}

/**
 * Generate workflow checklist markdown
 * @param items Array of workflow checklist items
 */
export function generateWorkflowChecklist(items: WorkflowChecklistItem[]): string {
  if (items.length === 0) {
    return '';
  }
  
  return items
    .map(item => {
      const checkbox = item.done ? '[x]' : '[ ]';
      // Standard Markdown task-list item (`- [ ]`) so Obsidian renders an
      // interactive checkbox instead of literal `[ ]` text.
      return `- ${checkbox} [${item.title}](./${item.fileName})`;
    })
    .join('\n');
}

/**
 * Update Related Workflows section in README content
 * @param readmeContent Current README content
 * @param newChecklistContent New checklist content to insert
 * @returns Updated README content
 */
export function updateReadmeWorkflowSection(
  readmeContent: string,
  newChecklistContent: string
): string {
  const lines = readmeContent.split('\n');
  const { header, end } = findWorkflowSection(lines);
  if (header === -1) {
    return readmeContent;
  }

  const newEntries = newChecklistContent === '' ? [] : newChecklistContent.split('\n');

  // Replace ONLY the lines this module owns (see CHECKLIST_ENTRY_RE) and leave
  // every other line in the section byte-for-byte intact: the researcher's own
  // checkboxes, prose, and the instruction blockquote all live here too. The
  // regenerated block lands where the first entry was, so entries stay
  // together even when notes were interleaved between them.
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const insideSection = i > header && i < end;
    if (insideSection && isWorkflowChecklistLine(lines[i])) {
      if (!replaced) {
        out.push(...newEntries);
        replaced = true;
      }
      continue;
    }
    out.push(lines[i]);
  }
  if (replaced || newEntries.length === 0) {
    return out.join('\n');
  }

  // No entry to anchor to: insert after the header, past the blank lines and
  // the instruction blockquote. `out` still mirrors `lines` here, so the
  // indices line up.
  let at = header + 1;
  while (at < end && lines[at].trim() === '') at++;
  while (at < end && lines[at].trim().startsWith('>')) at++;
  while (at < end && lines[at].trim() === '') at++;

  // Keep a blank line between the new block and whatever follows it.
  const separator = at < lines.length && lines[at].trim() !== '' ? [''] : [];
  out.splice(at, 0, ...newEntries, ...separator);
  return out.join('\n');
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
 * Plan a gap-free renumbering of an experiment folder's workflow files.
 *
 * Files are ordered exactly like {@link reconcileWorkflowChecklist} sorts the
 * README checklist (numeric `NNN`, ties broken by name) and then handed the
 * sequence numbers `001, 002, ...` with no gaps. The `id` and name parts are
 * carried over verbatim rather than rebuilt through
 * {@link createWorkflowFileName}: the on-disk name is already sanitized, and
 * re-sanitizing could alter a name this operation is supposed to leave alone.
 *
 * Entries that {@link parseWorkflowFileName} cannot decode (README, notes,
 * manually named files) are ignored, and files that already carry their target
 * number are omitted, so an already-sequential folder plans to no renames.
 */
export function planWorkflowRenumber(fileNames: readonly string[]): WorkflowRename[] {
  const parsed = fileNames
    .map(fileName => ({ fileName, parts: parseWorkflowFileName(fileName) }))
    .filter((e): e is { fileName: string; parts: ParsedWorkflowFileName } => e.parts !== null);

  parsed.sort((a, b) => {
    const seqA = parseInt(a.parts.sequence, 10);
    const seqB = parseInt(b.parts.sequence, 10);
    if (seqA !== seqB) return seqA - seqB;
    if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1;
    return 0;
  });

  const renames: WorkflowRename[] = [];
  parsed.forEach((entry, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    if (sequence === entry.parts.sequence) return;
    renames.push({
      from: entry.fileName,
      to: `${sequence}_${entry.parts.id}_${entry.parts.safeName}.labnote.md`,
    });
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
 * {@link buildRenumberStagingName} name only when it is still taken. Closing
 * gaps never needs parking: the k-th file's number is at least k, so walking
 * the plan in order always finds the target vacated. Parking is left for
 * duplicate numbers, where a file moves up onto a name not yet vacated.
 * `existingNames` is the folder listing before any move.
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
 * The table CSVs of `noteName` numbered above `tableCount` (#74): left over
 * from tables the note no longer has. Sorted by table number.
 */
export function staleTableCsvs(noteName: string, files: readonly string[], tableCount: number): string[] {
  const offset = `${tableCsvStem(noteName)}_table`.length;
  const number = (f: string) => Number(f.slice(offset, -'.csv'.length));
  return siblingTableCsvs(noteName, files)
    .filter(f => number(f) > tableCount)
    .sort((a, b) => number(a) - number(b));
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
}

/**
 * Reorder the README "Related Workflows" checklist to match the on-disk `NNN`
 * order after workflow files were renamed in the file explorer.
 *
 * `renames` (old->new basenames captured from vault rename events) are applied
 * to each item's link first, so reordering is correct even when Obsidian's
 * "Automatically update internal links" setting is off. When Obsidian has
 * already rewritten a link, the remap is usually a no-op — but not when one
 * file's new name is another file's old name (two workflows with the same id
 * and name, renumbered): the already-updated link is then remapped a second
 * time onto the wrong file. Batches that can do that pass `opts.baseline`, the
 * README as it was before the batch, so every link is remapped exactly once.
 * Standard items are then sorted by the numeric `NNN` prefix of their
 * (remapped) filename (`001 < 010 < 100`, ties broken by name); non-standard or
 * manually authored links that `parseWorkflowFileName` cannot decode are kept,
 * in their original relative order, after the standard ones.
 *
 * This function ONLY reorders/relinks. It never drops an entry whose file is
 * missing on disk — deletion is handled separately (surgically) so a user's
 * manual order is not clobbered on delete. Returns `{changed:false}` when the
 * README has no "Related Workflows" section or the content is unaffected.
 */
export function reconcileWorkflowChecklist(
  readmeContent: string,
  renames: WorkflowRename[],
  opts: ReconcileChecklistOptions = {}
): ReconcileChecklistResult {
  const items = parseWorkflowChecklistFromReadme(opts.baseline ?? readmeContent);
  if (items.length === 0) {
    return { changed: false, content: readmeContent };
  }

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
  const remapped = items.map(item => {
    const base = baseName(item.fileName);
    const to = remap.get(base);
    const moved = to ? { ...item, fileName: to } : item;
    if (!opts.labelFor) return moved;
    const oldName = to ? base : origin.get(base);
    const newName = to ?? base;
    if (oldName === undefined || !labelMatchesFileName(item.title, oldName)) return moved;
    return { ...moved, title: opts.labelFor(newName) };
  });

  const content = updateReadmeWorkflowSection(
    readmeContent,
    generateWorkflowChecklist(sortWorkflowChecklistItems(remapped))
  );
  return { changed: content !== readmeContent, content };
}

/**
 * Checklist order: standard `NNN` items first (numeric, ties broken by name),
 * then the ones `parseWorkflowFileName` cannot decode in their original
 * relative order. Stable.
 */
function sortWorkflowChecklistItems(items: WorkflowChecklistItem[]): WorkflowChecklistItem[] {
  const baseName = (fileName: string): string => fileName.split('/').pop() ?? fileName;
  const decorated = items.map((item, index) => {
    const parsed = parseWorkflowFileName(baseName(item.fileName));
    return {
      item,
      index,
      seq: parsed ? parseInt(parsed.sequence, 10) : Number.POSITIVE_INFINITY,
      name: parsed ? parsed.safeName : '',
    };
  });
  decorated.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.seq === Number.POSITIVE_INFINITY) return a.index - b.index;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.index - b.index;
  });
  return decorated.map(d => d.item);
}

/** A checklist entry {@link planWorkflowChecklistSync} proposes to remove. */
export interface StaleWorkflowEntry {
  /** The link exactly as written in the README (without a leading `./`). */
  link: string;
  title: string;
  /** `missing`: points into this folder at a file that is not there. `elsewhere`: points into another folder. */
  reason: 'missing' | 'elsewhere';
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
  /** README with `added` appended and the checklist re-sorted; unchanged when nothing is added. */
  content: string;
}

/**
 * Where a checklist link points, relative to the README's folder: the file
 * name when it stays in the folder, or null when it leaves it. Obsidian
 * rewrites a moved workflow's link to `../002_B/001_X.labnote.md`, which must
 * not be taken for this folder's `001_X.labnote.md`.
 */
function linkTargetInFolder(link: string): string | null {
  let decoded = link;
  try {
    decoded = decodeURI(link);
  } catch {
    // Keep the raw link; a malformed escape is compared as written.
  }
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
 * `002_WT020_ProteinEnzyme_Expression.labnote.md`.
 */
export function labelMatchesFileName(label: string, fileName: string): boolean {
  const parts = parseWorkflowFileName(fileName);
  if (!parts) return false;
  return sanitizePathSegment(label) === sanitizePathSegment(`${parts.id}_${parts.safeName}`);
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
  const safe = sanitizePathSegment(heading.name);
  if (parts.safeName === safe) return '';
  if (safe && parts.safeName.startsWith(`${safe}_`)) {
    return parts.safeName.slice(safe.length + 1).replace(/_/g, ' ');
  }
  return undefined;
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
  const matchedOld = (label: string) => fromName === undefined || labelMatchesFileName(label, fromName);
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
 * point, not by base name.
 */
export function planWorkflowChecklistSync(
  readmeContent: string,
  existingNames: readonly string[],
  titles: ReadonlyMap<string, string> = new Map()
): WorkflowChecklistSyncPlan {
  const hasSection = findWorkflowSection(readmeContent.split('\n')).header !== -1;
  const items = parseWorkflowChecklistFromReadme(readmeContent);
  const present = new Set(existingNames);

  const listed = new Set<string>();
  const stale: StaleWorkflowEntry[] = [];
  const relabel: WorkflowRelabel[] = [];
  for (const item of items) {
    const target = linkTargetInFolder(item.fileName);
    if (target === null) {
      stale.push({ link: item.fileName, title: item.title, reason: 'elsewhere' });
      continue;
    }
    listed.add(target);
    if (!present.has(target)) {
      stale.push({ link: item.fileName, title: item.title, reason: 'missing' });
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

  if (!hasSection || added.length === 0) {
    return {
      hasSection,
      added: hasSection ? added : [],
      stale,
      relabel: hasSection ? relabel : [],
      content: readmeContent,
    };
  }
  const content = updateReadmeWorkflowSection(
    readmeContent,
    generateWorkflowChecklist(sortWorkflowChecklistItems([...items, ...added]))
  );
  return { hasSection, added, stale, relabel, content };
}

/**
 * Apply {@link WorkflowChecklistSyncPlan.relabel}: replace the label of each
 * entry that links to `fileName` in this folder and still reads `from`. Only
 * the label text changes; order, checkboxes and other lines stay as they are.
 */
export function relabelWorkflowChecklistEntries(
  readmeContent: string,
  relabel: readonly WorkflowRelabel[]
): string {
  if (relabel.length === 0) return readmeContent;
  const lines = readmeContent.split('\n');
  const { header, end } = findWorkflowSection(lines);
  if (header === -1) return readmeContent;
  for (let i = header + 1; i < end; i++) {
    const m = lines[i].trim().match(CHECKLIST_ENTRY_RE);
    if (!m) continue;
    const target = linkTargetInFolder(m[3]);
    const r = relabel.find(x => x.fileName === target && x.from === m[2]);
    if (r) lines[i] = lines[i].replace(`[${m[2]}](`, () => `[${r.to}](`);
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
  const { header, end } = findWorkflowSection(lines);
  if (header === -1) return readmeContent;
  const kept = lines.filter((line, i) => {
    if (i <= header || i >= end) return true;
    const match = line.trim().match(CHECKLIST_ENTRY_RE);
    return !(match && wanted.has(match[3]));
  });
  return kept.join('\n');
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
  return `${getNextWorkflowNumber([...existingNames])}_${parts.id}_${parts.safeName}.labnote.md`;
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
