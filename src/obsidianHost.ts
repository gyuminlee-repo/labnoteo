/**
 * ObsidianHost — the Obsidian implementation of {@link LabnoteHost}.
 *
 * Mirrors `src/host/vscodeHost.ts` on the extension side so the same core
 * command logic (e.g. `insertUnitOperation`) runs unchanged. Because
 * Obsidian has no Section Editor webview, the {@link EditTarget} collapses to a
 * single CodeMirror editor implementation.
 *
 * Path convention: `editTarget().path` returns the **vault-relative** path of
 * the active note (e.g. `labnote/001_Exp/002_WD010_Design.labnote.md`). This is
 * exactly what `isValidWorkflowPath` expects (parent folder must be `labnote`)
 * and what {@link VaultFileSystem} reads, so no absolute-path conversion is
 * needed anywhere in shared logic.
 */
import { App, MarkdownView, Notice, TFile, type Editor } from 'obsidian';
import type {
  LabnoteHost,
  EditTarget,
  PickItem,
  PickManyOpts,
  PromptOpts,
  NotifyKind,
  LabnoteFs,
  Translator,
} from '@labnoteo/core';
import { pickModal, pickManyModal, promptModal, confirmModal } from './modals';
import { activeTableCellEditor, editorView, noteTargetBelowTable, tableCellHostView } from './tableCellTarget';

const readingViewChecks = new WeakMap<EditTarget, () => boolean>();

/**
 * An edit target called once its view showed another note: nothing was read or changed. Its
 * message is for the user as it is, not a failure of the command.
 */
export class NoteSwitchedError extends Error {}
const tableCellEditors = new WeakMap<EditTarget, Editor>();

/**
 * The editor of the table cell `target` was made for, or undefined when no
 * cell was focused. `target` itself writes to the note below the table, which
 * is where text holding a newline or a `|` has to go; text that fits in a cell
 * goes into this editor instead (#196, #543).
 */
export function tableCellEditorOf(target: EditTarget): Editor | undefined {
  return tableCellEditors.get(target);
}

/**
 * Whether `target` is a note shown in reading view, where a write switches
 * the view to editing. A write the user did not ask for in that note should
 * go through the vault instead.
 */
export function isReadingViewTarget(target: EditTarget): boolean {
  return readingViewChecks.get(target)?.() ?? false;
}

export function createObsidianHost(
  app: App,
  fs: LabnoteFs,
  t: Translator
): LabnoteHost {
  function editTarget(): EditTarget | undefined {
    // Prefer the focused markdown view (editor right-click / command palette).
    let view = app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      // A sidebar/tree is focused (e.g. the workflow or sample tree context
      // menu): fall back to the most recently active main-area leaf, which is
      // the editor the user was last in — including its live cursor position.
      // getMostRecentLeaf() excludes sidebars, so this is exactly that editor.
      const leaf = app.workspace.getMostRecentLeaf();
      if (leaf?.view instanceof MarkdownView) view = leaf.view;
    }
    const file = view?.file;
    if (!view || !file) return undefined;
    const noteView = view;
    const editor = view.editor;
    // A focused table cell is edited in its own editor holding the cell text
    // alone (#196). Obsidian 1.14 keeps `view.editor` on the note and hands out
    // that cell editor through the editor component instead (#303, #543), so it
    // is probed first; earlier versions, where `view.editor` *is* the cell
    // editor, still match the second case.
    const cellEditor = activeTableCellEditor(editor);
    const cell = cellEditor ?? (tableCellHostView(editor) ? editor : null);
    const cellHost = cell ? tableCellHostView(cell) ?? editorView(editor) : undefined;
    const cellDom = cell ? editorView(cell)?.dom : undefined;
    // Looked at on every call: a call after a wait (a prompt, a read) may find the view gone
    // to another note, whose editor this one now is; it is not read or changed as this note.
    const stillOnNote = (): void => {
      if (noteView.file?.path !== file.path) {
        throw new NoteSwitchedError(t('The note was switched to another while the command ran, so it was not changed. Run the command again.'));
      }
    };
    const onNote = <T extends EditTarget>(target: T): T => {
      for (const key of Object.keys(target) as (keyof T)[]) {
        const call = target[key];
        if (typeof call !== 'function') continue;
        target[key] = (async (...args: unknown[]) => {
          stillOnNote();
          return (call as (...a: unknown[]) => unknown).apply(target, args);
        }) as T[keyof T];
      }
      return target;
    };
    if (cell && cellHost && cellDom) {
      const target = onNote(noteTargetBelowTable(file.path, cellHost, cellDom));
      tableCellEditors.set(target, cell);
      return target;
    }
    // In reading view the editor is hidden: what is written to it is never
    // saved (#216), and its cursor is not where the reader is. Reads take the
    // note's text and treat the cursor as the end of the note; the first write
    // switches the view to editing, which reloads the editor from that text.
    const inPreview = (): boolean => noteView.getMode() === 'preview';
    const toSource = async (): Promise<void> => {
      if (!inPreview()) return;
      const before = noteView.getViewData();
      await noteView.setState({ ...noteView.getState(), mode: 'source' }, { history: false });
      // Looked at again before the editor is: the view may have gone to another note meanwhile.
      stillOnNote();
      if (editor.getValue() !== before) {
        throw new Error(t('The note changed while switching to editing view. Run the command again.'));
      }
      new Notice(t('This note was in reading view, so it was switched to editing view to make the change.'));
    };
    const target: EditTarget = {
      path: file.path,
      async getText() {
        return inPreview() ? noteView.getViewData() : editor.getValue();
      },
      async insertAtCursor(text: string) {
        if (inPreview()) {
          await toSource();
          stillOnNote();
          const end = editor.offsetToPos(editor.getValue().length);
          editor.replaceRange(text, end, end);
          return;
        }
        editor.replaceSelection(text);
      },
      async replaceRange(start: number, end: number, text: string) {
        await toSource();
        // Looked at after every wait, whatever the mode: even an await with nothing to wait for
        // lets the view go to another note first.
        stillOnNote();
        editor.replaceRange(text, editor.offsetToPos(start), editor.offsetToPos(end));
      },
      async getCursorOffset() {
        if (inPreview()) return noteView.getViewData().length;
        return editor.posToOffset(editor.getCursor('from'));
      },
      async getSelectionRange() {
        if (inPreview()) return undefined;
        const start = editor.posToOffset(editor.getCursor('from'));
        const end = editor.posToOffset(editor.getCursor('to'));
        return end > start ? { start, end } : undefined;
      },
      async revealOffset(offset: number) {
        await toSource();
        stillOnNote();
        // setCursor treats a bare number as a line index, so convert first.
        const pos = editor.offsetToPos(offset);
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
        editor.focus();
      },
    };
    onNote(target);
    readingViewChecks.set(target, inPreview);
    return target;
  }

  return {
    fs,

    pick<T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string; selected?: T }) {
      return pickModal(app, items, opts);
    },

    pickMany<T>(items: PickItem<T>[], opts?: PickManyOpts) {
      return pickManyModal(app, items, opts);
    },

    prompt(opts: PromptOpts) {
      return promptModal(app, opts);
    },

    confirm(message: string, opts?: { confirmLabel?: string; signal?: AbortSignal; destructive?: boolean }) {
      return confirmModal(app, message, opts?.confirmLabel ?? t('Yes'), {
        signal: opts?.signal,
        destructive: opts?.destructive,
      });
    },

    notify(kind: NotifyKind, message: string) {
      // Obsidian has a single Notice surface; prefix errors/warnings for clarity.
      const prefix = kind === 'error' ? '❌ ' : kind === 'warn' ? '⚠️ ' : '';
      new Notice(prefix + message);
    },

    editTarget,

    async openFile(path: string, at?: { line: number; ch?: number }) {
      let file = app.vault.getAbstractFileByPath(path);
      // A file just written through the adapter (VaultFileSystem.write) may not
      // be registered in the vault index yet, so getAbstractFileByPath returns
      // null for a brief moment. Retry briefly before falling back.
      for (let i = 0; i < 10 && !(file instanceof TFile); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        file = app.vault.getAbstractFileByPath(path);
      }
      if (file instanceof TFile) {
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file, at ? { eState: { line: at.line } } : undefined);
        if (at && leaf.view instanceof MarkdownView && leaf.view.getMode() !== 'preview') {
          const pos = { line: at.line, ch: at.ch ?? 0 };
          leaf.view.editor.setCursor(pos);
          leaf.view.editor.scrollIntoView({ from: pos, to: pos }, true);
        }
      } else {
        // Last resort: resolve lazily by link text (vault-relative path).
        await app.workspace.openLinkText(path, '', false);
      }
    },

    t,
  };
}
