/**
 * Tidy a workflow note in the SAME transaction that reorders its unit-op
 * blocks (e.g. an Outline drag): the `## Related Unit Operations` TOC is
 * re-ordered and the `---` separators restored, so the move and the cleanup are
 * one undo step with no intermediate state.
 *
 * Reorders and whole-block deletions are handled here; other added, removed or
 * renamed headings are left to the debounced TOC sync in `main.ts`. The pure edit
 * computation lives in `@labnoteo/core` and is unit-tested there.
 *
 * An Outline drag is NOT an editor edit: Obsidian rewrites the file and mirrors
 * it into the editor as a `set` transaction. Changing that transaction would
 * leave the editor out of step with the file (and the heading positions the
 * Outline navigates by), so `set` is skipped and `outlineDropTidy` tidies the
 * file itself.
 */
import { EditorState, type Extension, type Text, type Transaction } from '@codemirror/state';
import { computeUnitOpSyncEdits, pruneUnitOpTocEntries } from '@labnoteo/core';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { readLastUpdatedDate } from '@labnoteo/core/lib/dateUtils';

const UNIT_OP_HEADING_MARK = '### [';

export interface UnitOpReorderFilterOptions {
  /** Read live so toggling the setting takes effect without a reload. */
  isEnabled: () => boolean;
  /** Vault path of the note being edited, or null (canvas embeds, hover previews, …). */
  getFilePath: (state: EditorState) => string | null;
  /** Called for every document change of a file-backed editor, undo/redo included. */
  onDocChange?: (path: string, fromHistory: boolean, kind: DocChangeKind) => void;
}

export interface DocChangeKind {
  /**
   * Typed, pasted, dropped or deleted by the user. File reloads (`set`),
   * undo/redo and programmatic edits carry no such event and are excluded.
   */
  userEdit: boolean;
  /** A user edit that changed the front matter `last_updated_date` value. */
  dateEdited: boolean;
}

/** Front matter scan stops here; real notes close theirs long before. */
const FRONT_MATTER_MAX_LINES = 200;

/** End offset of the leading front matter's closing `---` line, or -1. */
function frontMatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return -1;
  const last = Math.min(doc.lines, FRONT_MATTER_MAX_LINES);
  for (let n = 2; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() === '---') return line.to;
  }
  return -1;
}

function lastUpdatedOf(doc: Text): string | undefined {
  const end = frontMatterEnd(doc);
  return end === -1 ? undefined : readLastUpdatedDate(doc.sliceString(0, end));
}

function classify(tr: Transaction): DocChangeKind {
  const userEdit = tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move');
  if (!userEdit) return { userEdit, dateEdited: false };
  const fmEnd = frontMatterEnd(tr.startState.doc);
  let inFrontMatter = false;
  tr.changes.iterChangedRanges(fromA => {
    if (fromA <= fmEnd) inFrontMatter = true;
  });
  const dateEdited =
    inFrontMatter && lastUpdatedOf(tr.startState.doc) !== lastUpdatedOf(tr.newDoc);
  return { userEdit, dateEdited };
}

/**
 * A user deletion that took at least one whole `### [` heading line with it
 * (deleting or cutting a unit-op block). Its TOC entry is dropped in the same
 * transaction, so one undo brings the block and the entry back (#207). Deleting
 * a heading character by character is left to the debounced sync, since the
 * heading is usually being retyped.
 */
function deletesWholeUnitOpHeading(tr: Transaction): boolean {
  if (!tr.isUserEvent('delete')) return false;
  const doc = tr.startState.doc;
  let hit = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (hit || inserted.length > 0 || toA === fromA) return;
    const removed = doc.sliceString(fromA, toA);
    if (!removed.includes('\n')) return;
    const atLineStart = doc.lineAt(fromA).from === fromA;
    hit = (atLineStart && removed.startsWith(UNIT_OP_HEADING_MARK)) || removed.includes(`\n${UNIT_OP_HEADING_MARK}`);
  });
  return hit;
}

/** Cheap pre-check: a block move always inserts or deletes a `### [` heading. */
function touchesUnitOpHeading(tr: Transaction): boolean {
  let hit = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (hit) return;
    hit =
      inserted.toString().includes(UNIT_OP_HEADING_MARK) ||
      tr.startState.doc.sliceString(fromA, toA).includes(UNIT_OP_HEADING_MARK);
  });
  return hit;
}

export function createUnitOpReorderFilter(opts: UnitOpReorderFilterOptions): Extension {
  // Undo/redo are dispatched with `filter: false`, so only an extender sees
  // them; reporting from the filter left the last user edit's flag in place
  // and the debounced TOC sync re-applied the change being undone (#207).
  const report = EditorState.transactionExtender.of(tr => {
    try {
      if (!tr.docChanged || !opts.onDocChange) return null;
      const path = opts.getFilePath(tr.startState);
      if (path) opts.onDocChange(path, tr.isUserEvent('undo') || tr.isUserEvent('redo'), classify(tr));
    } catch (err) {
      console.warn('[labnoteo] document change report failed:', err);
    }
    return null;
  });

  const filter = EditorState.transactionFilter.of(tr => {
    try {
      if (!tr.docChanged) return tr;
      const path = opts.getFilePath(tr.startState);
      const fromHistory = tr.isUserEvent('undo') || tr.isUserEvent('redo');
      // Never interfere with IME composition or file reloads (`set`). Undo/redo
      // already restore a tidy document, because the move and its cleanup were
      // recorded together.
      if (tr.isUserEvent('input.type.compose') || tr.isUserEvent('set') || fromHistory) return tr;
      if (!path || !isValidWorkflowPath(path)) return tr;
      if (!touchesUnitOpHeading(tr)) return tr;

      // CodeMirror documents are `\n`-only, so string offsets map 1:1 to positions.
      // With sorting off, a deleted block still takes its own entry (#406); a cut
      // block is usually pasted back elsewhere, so its entry stays.
      const edits = !opts.isEnabled()
        ? deletesWholeUnitOpHeading(tr) && !tr.isUserEvent('delete.cut')
          ? pruneUnitOpTocEntries(tr.newDoc.toString())
          : []
        : computeUnitOpSyncEdits(tr.newDoc.toString(), {
            onlyOnReorder: !deletesWholeUnitOpHeading(tr),
          });
      if (edits.length === 0) return tr;
      return [tr, { changes: edits, sequential: true }];
    } catch (err) {
      console.warn('[labnoteo] unit-op reorder sync failed:', err);
      return tr;
    }
  });

  return [report, filter];
}
