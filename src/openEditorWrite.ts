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
 * How long a write waits for a save Obsidian has under way on the note before it gives up
 * and writes nothing: some 20 times the longest such save measured in Obsidian 1.15.0
 * (median 3 ms, longest 142 ms), so a slow disk still gets its write; only a save stalled
 * that long makes a write wait so.
 */
export const OPEN_SAVE_WAIT_MS = 3000;

/**
 * Wait for the saves under way in the views `path` is open in, until none of them has one or
 * `deadline` passes (by default {@link OPEN_SAVE_WAIT_MS} from now; one write shares its
 * deadline across its waits), so a write does not land before one of them and get written
 * over by it. Obsidian 1.15.0 keeps a save under way in the view's `savePromise` (null when
 * none; not in the API) and its own save waits for it the same way, in a loop; that promise
 * is awaited, not `save()` called, which would write the buffer again. A view without it is
 * not waited for. Returns false when a save was still under way at the deadline: that save
 * writes a buffer without the change, so a change written before it would be written over;
 * the write is not made and its caller is told so.
 */
export async function waitForOpenSaves(app: App, path: string, deadline = Date.now() + OPEN_SAVE_WAIT_MS): Promise<boolean> {
  for (;;) {
    // An app with no workspace (a test's) has no editor open.
    const pending = (app.workspace?.getLeavesOfType?.('markdown') ?? [])
      .map(leaf => leaf.view as unknown as { file?: { path?: string } | null; savePromise?: unknown })
      .filter(view => view?.file?.path === path && view.savePromise instanceof Promise)
      .map(view => (view.savePromise as Promise<unknown>).catch(() => undefined));
    if (pending.length === 0) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise(resolve => (timer = setTimeout(resolve, left)))]);
    clearTimeout(timer);
  }
}

/**
 * Apply `transform` to the note in the editor it is open in, when its file has a CR, and save
 * it. Nothing is written while a save Obsidian has under way on it does not end in time
 * ({@link waitForOpenSaves}): false. Text typed in the editor and not saved yet is saved with the change, not lost. When the
 * save fails or leaves the file as it was (the view closing, say), the change is applied to
 * the file through the vault, once, and only to the file as it was before the save. Returns whether the file changed, or undefined when
 * it is not such a note: the caller then writes through the vault as before.
 */
export async function processInOpenCrlfEditor(
  app: App,
  file: TFile,
  transform: (content: string) => string,
  deadline?: number
): Promise<boolean | undefined> {
  // A save still under way past the wait would write over the change (and would hold this
  // one's save too: Obsidian's save waits for the one under way, with no limit): nothing is
  // written, through the editor or the vault.
  if (!(await waitForOpenSaves(app, file.path, deadline))) return false;
  const view = openSourceView(app, file.path);
  if (!view) return undefined;
  const disk = await app.vault.read(file);
  if (!disk.includes('\r')) return undefined;
  const before = view.editor.getValue();
  // Only a view that holds this file as it is now: Obsidian 1.15.0 keeps in `lastSavedData`
  // the text it last read or saved (the file's own text, CRLF and all), null while it reads a
  // note and the previous note's text while it switches to another. The field is not in the
  // API: when it is missing, or is not the file's text (loading, switching, another writer
  // having changed the file since), the change is made on the file through the vault, as for
  // a closed note. Text typed and not saved yet leaves it as it is, so that text stays. An
  // empty editor over a file with text is taken for one still loading all the same.
  const lastSaved: unknown = (view as unknown as { lastSavedData?: unknown }).lastSavedData;
  if (lastSaved !== disk || (before === '' && disk.trim() !== '')) return undefined;
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

/**
 * {@link processInOpenCrlfEditor}, else `app.vault.process` as before. False when the change
 * was not written there (or the editor needed none); true after `app.vault.process`.
 */
export async function processNote(app: App, file: TFile, transform: (content: string) => string): Promise<boolean> {
  const inEditor = await processInOpenCrlfEditor(app, file, transform);
  if (inEditor !== undefined) return inEditor;
  await app.vault.process(file, transform);
  return true;
}
