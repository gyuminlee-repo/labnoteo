/**
 * Workflow Structure - Functions for creating workflow files and managing workflow checklist
 */

import * as path from '../util/posixPath';
import { getSeoulDateString } from './dateUtils';
import { sanitizePathSegment } from './regexUtils';
import { parseFrontMatterYaml, serializeFrontMatterEntry } from '../sections/frontMatter';
import { getExperimentDir } from './labnoteStructure';

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
 */
export function createWorkflowContent(
  workflow: WorkflowInfo,
  experimenter: string,
  alias?: string
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
> Press Ctrl+P (Cmd+P on macOS) and run "Insert unit operation" to add one.

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
  const safeAlias = alias && alias.trim() ? `_${sanitizeWorkflowName(alias)}` : '';

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
 * Two files can trade numbers (`001<->002`), so renaming straight to the target
 * would collide with a file that has not moved yet. Every file is therefore
 * staged first. The temporary name keeps the `NNN_ID_` shape so it still passes
 * `isValidWorkflowPath` and `parseWorkflowFileName` — the vault rename listener
 * only records events for valid workflow paths, and dropping one would break
 * the chain {@link collapseWorkflowRenames} needs to relink the README.
 */
export function buildRenumberStagingName(rename: WorkflowRename, index: number): string {
  const parts = parseWorkflowFileName(rename.to);
  if (!parts) return rename.to;
  return `${parts.sequence}_${parts.id}_${parts.safeName}_staging${index}.labnote.md`;
}

/**
 * Reorder the README "Related Workflows" checklist to match the on-disk `NNN`
 * order after workflow files were renamed in the file explorer.
 *
 * `renames` (old->new basenames captured from vault rename events) are applied
 * to each item's link first, so reordering is correct even when Obsidian's
 * "Automatically update internal links" setting is off. When that setting is
 * on, Obsidian has already rewritten the link and the remap is a harmless
 * no-op. Standard items are then sorted by the numeric `NNN` prefix of their
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
  renames: WorkflowRename[]
): ReconcileChecklistResult {
  const items = parseWorkflowChecklistFromReadme(readmeContent);
  if (items.length === 0) {
    return { changed: false, content: readmeContent };
  }

  // Remap each link by basename (a checklist link may carry a `./` or subpath).
  // Chained hops are collapsed first so a file that moved twice before this
  // flush (`a->b->c`) relinks to `c`, not to the intermediate `b`.
  const remap = new Map<string, string>();
  for (const r of collapseWorkflowRenames(renames)) {
    remap.set(r.from, r.to);
  }
  const baseName = (fileName: string): string => fileName.split('/').pop() ?? fileName;
  const remapped = items.map(item => {
    const to = remap.get(baseName(item.fileName));
    return to ? { ...item, fileName: to } : item;
  });

  // Stable sort: standard `NNN` items first (numeric), then unparseable ones in
  // their original relative order.
  const decorated = remapped.map((item, index) => {
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

  const reordered = decorated.map(d => d.item);
  const content = updateReadmeWorkflowSection(
    readmeContent,
    generateWorkflowChecklist(reordered)
  );
  return { changed: content !== readmeContent, content };
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
