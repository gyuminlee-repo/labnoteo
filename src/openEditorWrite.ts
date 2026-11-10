/**
 * Writes to a note that is open in an editor while its file has CRLF line ends.
 *
 * Obsidian (seen in 1.12.4) holds such a note as LF in the editor and later saves that
 * buffer over the file, also when the plugin is off. A write made through the vault in
 * between is then lost. Such a write goes into the editor instead and the note is saved
 * at once, so it stays; the note is LF from then on, as Obsidian leaves any open CRLF
 * note. A note that is not open, or whose file has no CR, is written as before.
 */
import { MarkdownView, type App, type TFile } from 'obsidian';
import { minimalReplacement } from '@labnoteo/core';

/** The view `path` is open in, in source or live preview mode. */
export function openSourceView(app: App, path: string): MarkdownView | undefined {
  // An app with no workspace (a test's) has no editor open.
  for (const leaf of app.workspace?.getLeavesOfType?.('markdown') ?? []) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source') return view;
  }
  return undefined;
}

/**
 * Apply `transform` to the note in the editor it is open in, when its file has a CR, and save
 * it. Returns whether the note changed, or undefined when it is not such a note: the caller
 * then writes through the vault as before.
 */
export async function processInOpenCrlfEditor(
  app: App,
  file: TFile,
  transform: (content: string) => string
): Promise<boolean | undefined> {
  const view = openSourceView(app, file.path);
  if (!view || !(await app.vault.read(file)).includes('\r')) return undefined;
  const before = view.editor.getValue();
  const edit = minimalReplacement(before, transform(before));
  if (!edit) return false;
  view.editor.replaceRange(edit.text, view.editor.offsetToPos(edit.start), view.editor.offsetToPos(edit.end));
  await view.save();
  return true;
}

/** {@link processInOpenCrlfEditor}, else `app.vault.process` as before. */
export async function processNote(app: App, file: TFile, transform: (content: string) => string): Promise<void> {
  if ((await processInOpenCrlfEditor(app, file, transform)) === undefined) await app.vault.process(file, transform);
}
