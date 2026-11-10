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
 * it. Text typed in the editor and not saved yet is saved with the change, not lost. When the
 * save fails or leaves the file as it was (the view closing, say), the change is applied to
 * the file through the vault, once, and only to the file as it was before the save. Returns whether the file changed, or undefined when
 * it is not such a note: the caller then writes through the vault as before.
 */
export async function processInOpenCrlfEditor(
  app: App,
  file: TFile,
  transform: (content: string) => string
): Promise<boolean | undefined> {
  const view = openSourceView(app, file.path);
  if (!view) return undefined;
  const disk = await app.vault.read(file);
  if (!disk.includes('\r')) return undefined;
  const before = view.editor.getValue();
  // A view still loading the note holds none of it yet (an empty editor; Obsidian 1.15.0 sets
  // the view's file before it reads it, and its `data` is null until then, which the API does
  // not document): the change is made on the file through the vault, as for a closed note.
  // An editor with other text than the file is loaded, with text typed and not saved yet.
  if ((view as { data: string | null }).data === null || (before === '' && disk.trim() !== '')) return undefined;
  const after = transform(before);
  const edit = minimalReplacement(before, after);
  if (!edit) return false;
  view.editor.replaceRange(edit.text, view.editor.offsetToPos(edit.start), view.editor.offsetToPos(edit.end));
  let saved = false;
  try {
    await view.save();
    saved = true;
  } catch {
    // The file is looked at below either way.
  }
  // A save that ended with the view still on the note wrote the editor's text (assumed of
  // TextFileView.save: the API documents getViewData as what a save writes): the file holds the
  // change even when another plugin changed it right after. Else a file no longer as it was
  // holds the save when it reads as the editor's text (the change, and anything typed
  // meanwhile); else another writer changed it and the change is not known to be there. It is not applied again then, which could put it in twice with a
  // save landing late: false, and the editor keeps the change, which Obsidian may save later.
  const lf = (text: string) => text.replace(/\r\n?/g, '\n');
  const landed = (text: string) => lf(text) === after || lf(text) === lf(view.editor.getValue());
  const now = await app.vault.read(file);
  if (now !== disk) return (saved && openSourceView(app, file.path) === view) || landed(now);
  let final = disk;
  let applied = false;
  // Applied to the file, once, only as it was before the save; changed meanwhile (a save
  // landing late, say), that write stands.
  await app.vault.process(file, data => {
    if (data !== disk) return (final = data);
    applied = true;
    return (final = transform(data));
  });
  return applied ? final !== disk : landed(final);
}

/** {@link processInOpenCrlfEditor}, else `app.vault.process` as before. */
export async function processNote(app: App, file: TFile, transform: (content: string) => string): Promise<void> {
  if ((await processInOpenCrlfEditor(app, file, transform)) === undefined) await app.vault.process(file, transform);
}
