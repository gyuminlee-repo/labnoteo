/**
 * Writing the front matter `last_updated_date` stamp (#42). The decision of
 * *when* an editor edit warrants a stamp lives in `lastUpdatedTracker`; these
 * helpers only apply a `stamp` transform to a note, its experiment README, or
 * an AI-written note on its way to disk.
 */
import { MarkdownView, type App } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { minimalReplacement } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { processNoteThroughVault, writeNoteThroughVault } from './commands';

/** Rewrites a note's `last_updated_date`; identity when the setting is off. */
export type StampNote = (content: string) => string;

/** A `.labnote.md` inside a `labnote/###_*` experiment folder. */
export function isLabNotePath(path: string): boolean {
  return path.toLowerCase().endsWith('.labnote.md') && getExperimentDir(path) !== undefined;
}

/** The experiment README to stamp alongside a workflow note, if `path` is one. */
export function experimentReadmeOf(path: string): string | undefined {
  if (!isValidWorkflowPath(path)) return undefined;
  const dir = getExperimentDir(path);
  return dir ? posix.join(dir, 'README.labnote.md') : undefined;
}

/**
 * Stamp one note. An open editor (source or live preview) is edited in place,
 * changing only the date span, so the caret stays put and unsaved typing is
 * not overwritten; otherwise the file is rewritten through the vault.
 */
export async function stampNote(
  app: App,
  host: LabnoteHost,
  path: string,
  stamp: StampNote
): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file?.path !== path) continue;
    if (view.getMode() !== 'source') continue;
    const editor = view.editor;
    const before = editor.getValue();
    const edit = minimalReplacement(before, stamp(before));
    if (edit) {
      editor.replaceRange(edit.text, editor.offsetToPos(edit.start), editor.offsetToPos(edit.end));
    }
    return;
  }
  if (!(await host.fs.exists(path))) return;
  await processNoteThroughVault(app, host, path, stamp);
}

/** Stamp a note and, for a workflow note, its experiment README. */
export async function stampNoteAndReadme(
  app: App,
  host: LabnoteHost,
  path: string,
  stamp: StampNote
): Promise<void> {
  await stampNote(app, host, path, stamp);
  const readme = experimentReadmeOf(path);
  if (readme) await stampNote(app, host, readme, stamp);
}

/**
 * The `writeNote` hook for AI tools: stamp a lab note before writing it, then
 * the experiment README of a workflow note. Resolves only once the README is
 * written, because `create_workflow` re-reads it right after.
 */
export async function writeNoteStamped(
  app: App,
  host: LabnoteHost,
  path: string,
  content: string,
  stamp: StampNote
): Promise<void> {
  if (!isLabNotePath(path)) {
    await writeNoteThroughVault(app, host, path, content);
    return;
  }
  await writeNoteThroughVault(app, host, path, stamp(content));
  const readme = experimentReadmeOf(path);
  if (readme) await stampNote(app, host, readme, stamp);
}
