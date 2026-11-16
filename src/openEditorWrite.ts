/**
 * Writes to a note that is open in an editor.
 *
 * Obsidian holds an open note in its editor and saves that buffer over the file. A write made
 * through the vault meanwhile is read back and merged with the buffer by text a moment later,
 * and a save before that (leaving the note, say) or typing during that merge loses one of
 * them. Such a write goes into the editor instead, applied to its text at once with no await
 * in between, and the note is saved: typing goes on around it. A file with CRLF line ends is
 * LF from then on, as Obsidian leaves any open CRLF note (it holds such a note as LF and later
 * saves that buffer). A note that is not open in source or live preview mode, or whose view
 * has not read the file as it is now, is written through the vault as before.
 */
import { MarkdownView, type App, type Editor, type TFile } from 'obsidian';
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

/** How often a save Obsidian before 1.15.0 has under way is looked at again: it has no promise. */
const SAVING_POLL_MS = 20;

/**
 * Wait for the saves under way in the views `path` is open in, until none of them has one or
 * `deadline` passes (by default {@link OPEN_SAVE_WAIT_MS} from now; one write shares its
 * deadline across its waits), so a write does not land before one of them and get written
 * over by it. Obsidian 1.15.0 keeps a save under way in the view's `savePromise` (null when
 * none; not in the API) and its own save waits for it the same way, in a loop; that promise
 * is awaited, not `save()` called, which would write the buffer again. Obsidian 1.12.4 and
 * 1.14.5 have no such promise: a view sets `saving` while its save writes (and a save called
 * meanwhile only asks for another after it), so that flag is looked at again every
 * {@link SAVING_POLL_MS} until the same deadline. A view with neither is not waited for.
 * Returns false when a save was still under way at the deadline: that save writes a buffer
 * without the change, so a change written before it would be written over; the write is not
 * made and its caller is told so.
 */
export async function waitForOpenSaves(app: App, path: string, deadline = Date.now() + OPEN_SAVE_WAIT_MS): Promise<boolean> {
  for (;;) {
    // An app with no workspace (a test's) has no editor open.
    const views = (app.workspace?.getLeavesOfType?.('markdown') ?? [])
      .map(leaf => leaf.view as unknown as { file?: { path?: string } | null; savePromise?: unknown; saving?: unknown })
      .filter(view => view?.file?.path === path);
    const pending = views
      .filter(view => view.savePromise instanceof Promise)
      .map(view => (view.savePromise as Promise<unknown>).catch(() => undefined));
    const saving = views.some(view => view.saving === true);
    if (pending.length === 0 && !saving) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitFor = saving ? Math.min(left, SAVING_POLL_MS) : left;
    await Promise.race([
      ...(pending.length > 0 ? [Promise.all(pending)] : []),
      new Promise(resolve => (timer = setTimeout(resolve, waitFor))),
    ]);
    clearTimeout(timer);
  }
}

/**
 * Apply `transform` to the note in the editor it is open in (source or live preview), with no
 * await between reading the editor's text and putting the change in, and save it. Nothing is written while a save Obsidian has under way on it does not end in time
 * ({@link waitForOpenSaves}): false. Text typed in the editor and not saved yet is saved with the change, not lost. When the
 * save fails or leaves the file as it was, the file gets the editor's text with the change
 * while the view keeps the note, else (the view left it) the change made of the file's text;
 * through the vault, once, and only to the file as it was before the save. Returns whether the file changed, or undefined when
 * it is not such a note: the caller then writes through the vault as before.
 */
/**
 * Whether a change went into a note: 'uncertain' when its open editor's save failed as another
 * writer changed the file, so it may or may not be there (and is not to be asked for again
 * before the note is looked at, which could put it in twice).
 */
export type NoteWritten = boolean | 'uncertain';

/**
 * {@link NoteWritten}, telling apart 'kept': in the open note's editor, its save having failed,
 * for its next save to write; not on disk yet. Written for what the note says; not for an
 * undoing step that goes by the disk (an image trashed, say).
 */
export type NoteWrittenOnDisk = NoteWritten | 'kept';

export async function processInOpenEditor(
  app: App,
  file: TFile,
  transform: (content: string) => string,
  deadline?: number
): Promise<NoteWritten | undefined> {
  const result = await processInOpenEditorOnDisk(app, file, transform, deadline);
  return result === 'kept' ? true : result;
}

/** {@link processInOpenEditor}, saying 'kept' for a change only its editor holds. */
export async function processInOpenEditorOnDisk(
  app: App,
  file: TFile,
  transform: (content: string) => string,
  deadline?: number
): Promise<NoteWrittenOnDisk | undefined> {
  const result = await writeInOpenEditor(app, file, transform, deadline);
  return result === 'timedOut' ? false : result;
}

/** {@link processInOpenEditor}, saying 'timedOut' for nothing written past the wait. */
async function writeInOpenEditor(
  app: App,
  file: TFile,
  transform: (content: string) => string,
  deadline?: number
): Promise<NoteWrittenOnDisk | undefined | 'timedOut'> {
  // A save still under way past the wait would write over the change (and would hold this
  // one's save too: Obsidian's save waits for the one under way, with no limit): nothing is
  // written, through the editor or the vault.
  const until = deadline ?? Date.now() + OPEN_SAVE_WAIT_MS;
  let view: MarkdownView | undefined;
  let disk: string;
  for (;;) {
    if (!(await waitForOpenSaves(app, file.path, until))) return 'timedOut';
    view = openSourceView(app, file.path);
    if (!view) return undefined;
    disk = await app.vault.read(file);
    // A save started (typing goes on) while the file was read: what it saved is not the file
    // read yet. Read again once it is on the file, rather than take the view for one behind.
    if (await waitForOpenSaves(app, file.path, 0)) break;
  }
  // Looked at again after every wait: the view may have gone to another note meanwhile, whose
  // editor and last saved text (alike, it may be) are not this file's. Gone, the change is made
  // on this file through the vault, as for a closed note.
  const shown = view;
  const onFile = () => openSourceView(app, file.path) === shown;
  if (!onFile()) return undefined;
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
  // Made of the editor's text, typing not saved yet and all: nothing to merge it with. LF, as
  // the editor holds a note.
  const after = transform(before).replace(/\r\n?/g, '\n');
  if (after === before) return false;
  putInEditor(view.editor, before, after);
  const lf = (text: string) => text.replace(/\r\n?/g, '\n');
  // Saved, and looked at as the save left it: whether it wrote (Obsidian 1.15.0 holds what a
  // save wrote as last saved, puts the text before back when it fails, and a save that writes
  // nothing, its view reading the note again, holds null), the editor's text then (a view does
  // not read the file again while it saves, so the change is in it), and the file.
  const save = async () => {
    let saved = false;
    // What the save writes: the editor's text as it starts (it holds no save under way here).
    const toSave = onFile() ? lf(view.editor.getValue()) : undefined;
    try {
      await view.save();
      saved = true;
    } catch {
      // The file is looked at below either way.
    }
    // The editor's text as the save left it, read only while the view is on the note: gone to
    // another, its editor holds that note, which says nothing of this one.
    const atSave = onFile() ? lf(view.editor.getValue()) : undefined;
    const now = await app.vault.read(file);
    const still = atSave !== undefined && onFile();
    // Gone to another note (not closed): its editor holds that note now.
    const elsewhere = !still && view.file != null && view.file.path !== file.path;
    const savedAs: unknown = still ? (view as unknown as { lastSavedData?: unknown }).lastSavedData : undefined;
    // Looked at with `savedAs`, no await between: what the view holds as it last read or saved.
    const editorNow = still ? lf(view.editor.getValue()) : undefined;
    const wrote = saved && still && typeof savedAs === 'string' && savedAs !== disk;
    // The view still on the note, holding the file's text as last saved: its editor keeps the
    // change, and saves it on its next save.
    const keeps = still && typeof savedAs === 'string';
    // A failed save whose view has read the file another writer changed already, its editor
    // now that file: the change is there only if that file has it, which this cannot tell (a
    // formatter may have rewritten the editor's text, change and all, or another edit not).
    const readOver = !saved && typeof savedAs === 'string' && savedAs !== disk && editorNow === lf(savedAs);
    return { saved, elsewhere, toSave, atSave, now, wrote, keeps, readOver };
  };
  // A file no longer as it was holds the change when the save wrote (the view still on the
  // note: the editor's text, the change in it, even when another plugin changed the file right
  // after), or when it reads as the change or as the editor's text as the save left it.
  // Else another writer changed it. A save that wrote nothing, its view reading the file again
  // or gone: the change is not there, false. A save that failed: 'uncertain'. The view does not
  // read a change made while it saves, and its editor keeps the change for its next save, over
  // that writer's text; a change made once the save is over it reads, over its editor, after a
  // read of the file of its own, which may not have ended yet. Read over the editor, the file
  // may or may not have the change (rewritten by a formatter, say); read merged with typing, the
  // editor differs from the file whether the merge kept the change or dropped it (a part it
  // could not place). The change is not applied again, which could put it in twice.
  const landed = (text: string, atSave: string | undefined) => lf(text) === after || lf(text) === atSave;
  // A view that read the file over its editor has the two alike, whether or not the file has the
  // change: not taken for the file reading as the editor.
  const changedMeanwhile = (at: { saved: boolean; elsewhere: boolean; toSave?: string; atSave?: string; now: string; wrote: boolean; readOver: boolean }) => {
    // The file as the save was to write it: the change is in it, the view gone or not.
    if (at.wrote || lf(at.now) === after || lf(at.now) === at.toSave) return true;
    if (at.readOver) return 'uncertain' as const;
    if (landed(at.now, at.atSave)) return true;
    // A save that wrote nothing, its view on the note or closed: not there. One whose view went
    // to another note as it saved: what it wrote, typing and all, is not known from that view.
    if (at.saved) return at.elsewhere ? ('uncertain' as const) : false;
    return 'uncertain' as const;
  };
  let at = await save();
  if (at.now !== disk) return changedMeanwhile(at);
  // The file as it was, the save having failed (Obsidian says so itself, keeping a backup) or
  // written nothing. A view still on the note keeps the change in its editor: it is saved once
  // more, not written through the vault, which the view would merge with what was typed during
  // the save, the base being the file before the change, and so put an insertion in twice.
  // Still failing, the editor keeps the change for the view's next save: written, as far as
  // can be known now (a writer changing the file later has the view, no longer dirty, read
  // that over its editor, which no write can tell).
  if (at.keeps) {
    // A save Obsidian started meanwhile would hold this one with no limit: waited for as any.
    // Past the wait, that save, made of the editor's text, has the change in it, and the editor
    // keeps it: written, not to be asked for again (which would put an insertion in twice).
    if (!(await waitForOpenSaves(app, file.path, until))) return at.keeps ? 'kept' : false;
    // Gone to another note meanwhile: that note is not saved for this one; the change, left in
    // this file's editor as it switched, is looked for in the file below.
    if (onFile()) {
      at = await save();
      if (at.now !== disk) return changedMeanwhile(at);
      return at.keeps ? 'kept' : false;
    }
  }
  // A view that left the note, or reads it again, does not keep the editor's text: the change
  // is made of the file's, through the vault, once, only to the file as it was before the
  // save; changed meanwhile (a save landing late, another writer), that write stands, and the
  // change is there only if it reads so.
  let final = disk;
  let applied = false;
  await app.vault.process(file, data => {
    if (data !== disk) return (final = data);
    applied = true;
    return (final = transform(data));
  });
  return applied ? final !== disk : landed(final, at.atSave);
}

/** A run of the text, [start, end), replaced by `text`. */
interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The changes that make `after` of `before`, each where it is: by lines, a line both keep
 * between two changes keeping them two, then each cut to the characters it changes. Put into
 * the editor one by one, a cursor between two changes stays by the text it was at, and one
 * where text is only put in stays before it, rather than going to the start or the end of one
 * replacement from the first change to the last. Applied in order they make `after`.
 */
export function editsBetween(before: string, after: string): TextEdit[] {
  const lines = (x: string) => (x === '' ? [] : x.split(/(?<=\n)/));
  const a = lines(before);
  const offsets = [0];
  for (const line of a) offsets.push(offsets[offsets.length - 1] + line.length);
  return hunks(a, lines(after)).map(h => {
    const start = offsets[h.s];
    const end = offsets[h.e];
    const text = h.t.join('');
    let p = 0;
    while (p < end - start && p < text.length && before[start + p] === text[p]) p++;
    let q = 0;
    while (q < end - start - p && q < text.length - p && before[end - 1 - q] === text[text.length - 1 - q]) q++;
    return { start: start + p, end: end - q, text: text.slice(p, text.length - q) };
  });
}

/** `edits` ({@link editsBetween}) applied to `text`. */
function applyEdits(text: string, edits: TextEdit[]): string {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/**
 * Put `after` into `editor`, which holds `before`, change by change ({@link editsBetween}),
 * in one transaction: one undo step. The text made is `after` whatever the changes.
 */
function putInEditor(editor: Editor, before: string, after: string): void {
  let edits = editsBetween(before, after);
  if (applyEdits(before, edits) !== after) {
    const one = minimalReplacement(before, after);
    edits = one ? [one] : [];
  }
  // Positions in the text before any change, as a transaction takes them.
  const changes = edits.map(e => ({ from: editor.offsetToPos(e.start), to: editor.offsetToPos(e.end), text: e.text }));
  if (typeof editor.transaction === 'function') editor.transaction({ changes });
  // An editor without transactions (a test's): the last change first, so the others stay put.
  else for (const c of changes.reverse()) editor.replaceRange(c.text, c.from, c.to);
}

/** A run of `a` units, [s, e), replaced by `t`. */
interface Hunk {
  s: number;
  e: number;
  t: string[];
}

/**
 * Above this many cells a longest common subsequence is not worked out: the lines found once
 * on both sides split the runs instead, and a run with none is diffed as long as it differs in
 * at most {@link DIFF_STEPS_MAX} units ({@link fewestEdits}), else it is one hunk.
 */
const DIFF_CELLS_MAX = 4_000_000;
const DIFF_STEPS_MAX = 1000;

/** The runs of `a` that `b` replaces, from a longest common subsequence of their units. */
function hunks(a: string[], b: string[]): Hunk[] {
  const out: Hunk[] = [];
  hunksIn(a, 0, a.length, b, 0, b.length, out);
  return out;
}

/** {@link hunks} of a[a0, a1) and b[b0, b1), put in `out`. */
function hunksIn(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number, out: Hunk[]): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    a0++;
    b0++;
  }
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    a1--;
    b1--;
  }
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) > DIFF_CELLS_MAX) {
    const anchors = uniqueCommon(a, a0, a1, b, b0, b1);
    if (anchors.length > 0) {
      let i = a0;
      let j = b0;
      for (const [x, y] of anchors) {
        hunksIn(a, i, x, b, j, y, out);
        i = x + 1;
        j = y + 1;
      }
      hunksIn(a, i, a1, b, j, b1, out);
      return;
    }
  }
  const few = n > 0 && m > 0 && (n + 1) * (m + 1) > DIFF_CELLS_MAX ? fewestEdits(a, a0, n, b, b0, m) : undefined;
  if (few) {
    out.push(...few);
    return;
  }
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > DIFF_CELLS_MAX) {
    out.push({ s: a0, e: a1, t: b.slice(b0, b1) });
    return;
  }
  const w = m + 1;
  const L = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[a0 + i] === b[b0 + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[a0 + i] === b[b0 + j]) {
      if (cur) out.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    cur ??= { s: a0 + i, e: a0 + i, t: [] };
    if (j < m && (i >= n || L[i * w + j + 1] > L[(i + 1) * w + j])) cur.t.push(b[b0 + j++]);
    else {
      i++;
      cur.e = a0 + i;
    }
  }
  if (cur) out.push(cur);
}

/**
 * The hunks of a[a0, a0 + n) that b[b0, b0 + m) replaces, by the fewest units put in and taken
 * out (Myers' diff), undefined past {@link DIFF_STEPS_MAX} of them: time and memory grow with
 * how much differs, not with the length, so a long note with a few changes is diffed in full.
 */
function fewestEdits(a: string[], a0: number, n: number, b: string[], b0: number, m: number): Hunk[] | undefined {
  const max = Math.min(DIFF_STEPS_MAX, n + m);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // `v` before each step d, for k in [-d - 1, d + 1], to walk back.
  const trace: Int32Array[] = [];
  let steps = -1;
  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        steps = d;
        break search;
      }
    }
  }
  if (steps < 0) return undefined;
  // Walk back: each step one unit of `b` put in before a[x], or a[x] taken out.
  const ops: { x: number; y: number; put: boolean }[] = [];
  let x = n;
  let y = m;
  for (let d = steps; d > 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const put = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const px = at(put ? k + 1 : k - 1);
    const py = px - (put ? k + 1 : k - 1);
    ops.push({ x: px, y: py, put });
    x = px;
    y = py;
  }
  const out: Hunk[] = [];
  for (const op of ops.reverse()) {
    let cur = out[out.length - 1];
    if (!cur || cur.e !== a0 + op.x) out.push((cur = { s: a0 + op.x, e: a0 + op.x, t: [] }));
    if (op.put) cur.t.push(b[b0 + op.y]);
    else cur.e = a0 + op.x + 1;
  }
  return out;
}

/**
 * The units found once in a[a0, a1) and once in b[b0, b1), as pairs of their places, the
 * longest run of them in the same order on both sides (patience diff).
 */
function uniqueCommon(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): [number, number][] {
  const count = (x: string[], from: number, to: number) => {
    const seen = new Map<string, number>();
    for (let k = from; k < to; k++) seen.set(x[k], seen.has(x[k]) ? -1 : k);
    return seen;
  };
  const inA = count(a, a0, a1);
  const inB = count(b, b0, b1);
  const pairs: [number, number][] = [];
  for (const [unit, x] of inA) {
    const y = inB.get(unit);
    if (x !== -1 && y !== undefined && y !== -1) pairs.push([x, y]);
  }
  pairs.sort((p, q) => p[0] - q[0]);
  // Longest increasing run of `y`: the tail of each length, and where each pair came from.
  const tails: number[] = [];
  const prev: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const run: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) run.push(pairs[k]);
  return run.reverse();
}

/**
 * Whether a view open on `file` (source or live preview) has read the file as it is now, or
 * has not read it at all. False while Obsidian has yet to read a change to the file back:
 * an edit made in the editor then is merged with that change by text, which can garble both.
 */
export async function openViewHasDisk(app: App, file: TFile): Promise<boolean> {
  const view = openSourceView(app, file.path);
  const last: unknown = view ? (view as unknown as { lastSavedData?: unknown }).lastSavedData : null;
  return typeof last !== 'string' || last === (await app.vault.read(file));
}

/**
 * The text of the note at `path` as a write to it now finds it ({@link processInOpenEditor}):
 * the editor's, typing not saved yet included, when it is open in source or live preview mode
 * and its view holds the file as it is now. Undefined otherwise: the file's.
 */
export async function openEditorText(app: App, path: string): Promise<string | undefined> {
  const view = openSourceView(app, path);
  if (!view) return undefined;
  const file = app.vault.getFileByPath(path);
  if (!file) return undefined;
  const disk = await app.vault.read(file);
  // Gone to another note while the file was read: its editor is not this note's.
  if (openSourceView(app, path) !== view) return undefined;
  const text = view.editor.getValue();
  const lastSaved: unknown = (view as unknown as { lastSavedData?: unknown }).lastSavedData;
  if (lastSaved !== disk || (text === '' && disk.trim() !== '')) return undefined;
  return text;
}

/**
 * {@link processInOpenEditor}, else `app.vault.process` as before. False when the change
 * was not written there (or the editor needed none); true after `app.vault.process`.
 */
export async function processNote(app: App, file: TFile, transform: (content: string) => string): Promise<boolean> {
  return (await processNoteResult(app, file, transform)) === 'written';
}

/**
 * {@link processNote}, saying why nothing was written: 'timedOut' when a save of the open note
 * did not end in time, 'uncertain' when the open note's save failed as another writer changed
 * it ({@link NoteWritten}), 'notWritten' otherwise (the editor needed no change, or another
 * writer changed the file meanwhile).
 */
export async function processNoteResult(
  app: App,
  file: TFile,
  transform: (content: string) => string
): Promise<'written' | 'notWritten' | 'timedOut' | 'uncertain'> {
  const deadline = Date.now() + OPEN_SAVE_WAIT_MS;
  const inEditor = await writeInOpenEditor(app, file, transform, deadline);
  if (inEditor === 'timedOut') return 'timedOut';
  if (inEditor === 'uncertain') return 'uncertain';
  if (inEditor === 'kept') return 'written';
  if (inEditor !== undefined) return inEditor ? 'written' : 'notWritten';
  // A save another write started on the note may still be writing: it would land over this one.
  if (!(await waitForOpenSaves(app, file.path, deadline))) return 'timedOut';
  await app.vault.process(file, transform);
  return 'written';
}
