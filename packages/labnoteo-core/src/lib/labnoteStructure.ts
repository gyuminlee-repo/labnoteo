/**
 * Labnote Structure - Functions for creating labnote folder structures
 */

import * as path from '../util/posixPath';
import { getSeoulDateString } from './dateUtils';
import { sanitizePathSegment } from './regexUtils';
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

/** Options for the note templates' command-palette hints. */
export interface TemplateHintOptions {
  /** UI language of the creating host (e.g. 'en', 'ko', 'ko-KR'). */
  locale?: string;
}

/** Korean palette labels; must match the plugin's `l10n.ko.ts` entries. */
export const KO_COMMAND_NAMES = {
  createWorkflow: '워크플로 생성',
  insertUnitOperation: '유닛 오퍼레이션 삽입',
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
    serializeFrontMatterEntry('sample_tracking', 'yes'),
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
  const sanitizedTitle = sanitizeTitle(title);
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
