/**
 * Labnote Structure - Functions for creating labnote folder structures
 */

import * as path from '../util/posixPath';
import { getSeoulDateString } from './dateUtils';
import { sanitizePathSegment, capPathSegment, EXPERIMENT_FOLDER_TITLE_MAX } from './regexUtils';
import { serializeFrontMatterEntry } from '../sections/frontMatter';

/**
 * Structure returned by createLabnoteStructure
 */
export interface LabnoteStructure {
  labnoteFolder: string;
  readmePath: string;
  imagesFolder: string;
  resourcesFolder: string;
  readmeContent: string;
}

/**
 * Derive the `labnote/{###_Name}` experiment folder that `p` belongs to.
 *
 * Pure path logic: normalises separators (incl. Windows `\`) and redundant
 * segments, then returns everything up to and including the `###_Name` folder
 * that follows the LAST `labnote` segment. Returns undefined when `p` is not
 * inside a `labnote/###_*` experiment. This is the single source of truth for
 * experiment scoping — the plugin (`commands.ts`) and the core tool set
 * (`tools/index.ts`) both delegate here instead of re-implementing it.
 */
export function getExperimentDir(p: string): string | undefined {
  const parts = path.normalize(p).split('/');
  const idx = parts.lastIndexOf('labnote');
  if (idx === -1 || idx + 1 >= parts.length) return undefined;
  if (!/^\d{3}_/.test(parts[idx + 1])) return undefined;
  return parts.slice(0, idx + 2).join('/');
}

/** {@link diagnoseExperimentPath} result. */
export type ExperimentPathDiagnosis =
  /** Inside an experiment; `folder` is its `labnote/###_Name` folder. */
  | { kind: 'ok'; folder: string }
  /** Not under a `labnote/` folder at all, or a file directly in `labnote/`. */
  | { kind: 'outside' }
  /** In (or is) a folder directly under `labnote/` whose name lacks the `###_` prefix (#67). */
  | { kind: 'noPrefix'; folder: string }
  /**
   * In (or is) a `###_` folder deeper than directly under `labnote/`, e.g. an
   * experiment moved into a grouping folder (#166); `folder` is that folder.
   */
  | { kind: 'nested'; folder: string };

/**
 * Why `p` is or is not inside an experiment, using the same path rules as
 * {@link getExperimentDir}. Tells "no experiment here" apart from "an
 * experiment folder that lost its number", which commands report differently.
 * With `isFolder`, `p` itself may be the folder under `labnote/`; otherwise
 * `p` is a file and needs a folder between it and `labnote/`, so
 * `labnote/README.md` stays `outside`.
 */
export function diagnoseExperimentPath(p: string, opts: { isFolder?: boolean } = {}): ExperimentPathDiagnosis {
  const folder = getExperimentDir(p);
  if (folder) return { kind: 'ok', folder };
  const parts = path.normalize(p).split('/');
  const idx = parts.lastIndexOf('labnote');
  if (idx === -1) return { kind: 'outside' };
  const minLength = opts.isFolder ? idx + 2 : idx + 3;
  if (parts.length < minLength || parts[idx + 1] === '') return { kind: 'outside' };
  // The last part of a file path is the file itself, not a folder.
  const lastFolder = opts.isFolder ? parts.length - 1 : parts.length - 2;
  for (let i = idx + 2; i <= lastFolder; i++) {
    if (/^\d{3}_/.test(parts[i])) return { kind: 'nested', folder: parts.slice(0, i + 1).join('/') };
  }
  return { kind: 'noPrefix', folder: parts.slice(0, idx + 2).join('/') };
}

/**
 * The name to give an experiment folder that lost its `###_` prefix: the old
 * folder's number in front of the new name, without any leading digits or `_`
 * left in it (`020_GFP` renamed to `GFP_v2` → `020_GFP_v2`). Undefined when
 * the old name had no number or nothing is left of the new one.
 */
export function suggestExperimentFolderName(oldName: string, newName: string): string | undefined {
  const num = /^(\d{3})_/.exec(oldName)?.[1];
  const rest = newName.replace(/^[\d_\s]+/, '');
  return num && rest ? `${num}_${rest}` : undefined;
}

/**
 * The `resources/labsamples` folder for the experiment that `p` belongs to, or
 * undefined when `p` is not inside a `labnote/###_*` experiment.
 */
export function getExperimentLabsamplesFolder(p: string): string | undefined {
  const dir = getExperimentDir(p);
  return dir ? path.join(dir, 'resources', 'labsamples') : undefined;
}

/**
 * Get the next labnote number based on existing folders
 * @param existingFolders Array of existing folder names (e.g., ['001_First', '002_Second'])
 * @returns Next number as 3-digit string (e.g., '003')
 */
export function getNextLabnoteNumber(existingFolders: string[]): string {
  const numbers = existingFolders
    .map(folder => {
      const match = folder.match(/^(\d{3})_/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter(n => n > 0);

  const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
  return String(maxNumber + 1).padStart(3, '0');
}

/**
 * Sanitize title for use as folder name
 * - Replaces spaces with underscores
 * - Removes special characters except Korean, alphanumeric, and underscores
 */
export function sanitizeTitle(title: string): string {
  return sanitizePathSegment(title);
}

/**
 * Code points of `title` that go into the experiment folder name, which
 * {@link createLabnoteStructure} cuts at {@link experimentTitleBudget}. Counted
 * after sanitizing, so spaces become `_`, symbols drop out and a word-ending
 * `+` is spelled out: the count can differ from what was typed.
 */
export function experimentTitleLength(title: string): number {
  return Array.from(sanitizeTitle(title.trim())).length;
}

/** Room for the title in an experiment folder name (`NNN_` comes on top). */
export function experimentTitleBudget(): number {
  return EXPERIMENT_FOLDER_TITLE_MAX;
}

/** Options for the note templates' command-palette hints. */
export interface TemplateHintOptions {
  /** UI language of the creating host (e.g. 'en', 'ko', 'ko-KR'). */
  locale?: string;
}

/** Korean palette labels; must match the plugin's `l10n.ko.ts` entries. */
export const KO_COMMAND_NAMES = {
  createWorkflow: '워크플로 생성',
  insertUnitOperation: '유닛 오퍼레이션 삽입',
  syncWorkflowChecklist: '폴더와 워크플로 체크리스트 맞추기',
} as const;

function isKoreanLocale(locale: string | undefined): boolean {
  return !!locale && locale.toLowerCase().split('-')[0] === 'ko';
}

/**
 * A command name as the palette shows it: the English name alone, or followed
 * by the Korean one when the note is created under a Korean UI.
 */
export function commandName(en: string, ko: string, locale?: string): string {
  return isKoreanLocale(locale) ? `\`${en}\` (\`${ko}\`)` : `\`${en}\``;
}

/** `sample_tracking` value a new experiment README starts with. */
const SAMPLE_TRACKING_DEFAULT = 'yes';

/**
 * Whether an experiment README's `sample_tracking` value turns sample tracking
 * off for that experiment (#105): `no`, `false` or `off` in any case, or a YAML
 * boolean `false` (an unquoted `no` may parse as one). A missing value is on.
 */
export function isSampleTrackingOff(value: unknown): boolean {
  if (value === false) return true;
  return typeof value === 'string' && /^(no|false|off)$/i.test(value.trim());
}

/**
 * Whether sample tracking runs for the note at `notePath`: the global setting
 * `enabled`, narrowed by its experiment README's `sample_tracking`, read through
 * `readmeFrontMatter` (undefined when not available yet). A note outside an
 * experiment follows the setting alone.
 */
export function isSampleTrackingOn(
  enabled: boolean,
  notePath: string | undefined,
  readmeFrontMatter: (readmePath: string) => Record<string, unknown> | undefined
): boolean {
  if (!enabled) return false;
  const dir = notePath ? getExperimentDir(notePath) : undefined;
  if (!dir) return true;
  return !isSampleTrackingOff(readmeFrontMatter(path.join(dir, 'README.labnote.md'))?.sample_tracking);
}

/**
 * Generate README.md content for a new labnote
 * Follows labnote-lite template format
 * @param title Experiment title
 * @param author Optional author name
 * @param opts Hint options (UI locale for command names)
 */
export function generateReadmeContent(
  title: string,
  author?: string,
  opts: TemplateHintOptions = {}
): string {
  const today = getSeoulDateString(new Date());
  
  const authorValue = author || '';

  // Front matter goes through serializeFrontMatterEntry so a title/author
  // containing a colon is emitted as valid, round-trippable YAML.
  // `status` seeds the experiment lifecycle at `planned`; `project` is emitted
  // empty so researchers can fill it in. Both are additive/optional — existing
  // notes without them keep working (see @labnoteo/core experimentStatus).
  // `id`/`issue` are intentionally NOT seeded (optional, added on demand).
  const frontMatter = [
    serializeFrontMatterEntry('title', title),
    serializeFrontMatterEntry('author', authorValue),
    serializeFrontMatterEntry('experiment_type', 'labnote'),
    serializeFrontMatterEntry('sample_tracking', SAMPLE_TRACKING_DEFAULT),
    serializeFrontMatterEntry('status', 'planned'),
    serializeFrontMatterEntry('project', null),
    serializeFrontMatterEntry('created_date', today),
    serializeFrontMatterEntry('last_updated_date', today),
  ].join('\n');

  return `---
${frontMatter}
---

## 🎯 Experiment Objective
> Briefly describe the main objective and hypothesis of this experiment.

## 🗂️ Related Workflows

> Press \`Ctrl+P\` (\`Cmd+P\` on macOS) to open the command palette, then run ${commandName('Create workflow', KO_COMMAND_NAMES.createWorkflow, opts.locale)}; a checklist entry for the new workflow is added to this section automatically.
> Workflow notes moved or copied into this folder are not listed automatically; run ${commandName('Sync workflow checklist with folder', KO_COMMAND_NAMES.syncWorkflowChecklist, opts.locale)} to add them.
> The name entered in the author: field of the YAML block above will be automatically entered as the experimenter's name when creating workflows and unit operations.



## Summary and Discussion



`;
}

export function createLabnoteStructure(
  workspaceRoot: string,
  title: string,
  existingFolders: string[],
  author?: string,
  opts: TemplateHintOptions = {}
): LabnoteStructure {
  const number = getNextLabnoteNumber(existingFolders);
  // The README keeps the whole title; only the folder name is capped (#148).
  const sanitizedTitle = capPathSegment(sanitizeTitle(title), EXPERIMENT_FOLDER_TITLE_MAX);
  const folderName = `${number}_${sanitizedTitle}`;
  
  const labnoteFolder = path.join(workspaceRoot, 'labnote', folderName);
  
  return {
    labnoteFolder,
    readmePath: path.join(labnoteFolder, 'README.labnote.md'),
    imagesFolder: path.join(labnoteFolder, 'images'),
    resourcesFolder: path.join(labnoteFolder, 'resources'),
    readmeContent: generateReadmeContent(title, author, opts),
  };
}
