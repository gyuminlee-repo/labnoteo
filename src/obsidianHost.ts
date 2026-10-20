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
import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type {
  LabnoteHost,
  EditTarget,
  PickItem,
  PromptOpts,
  NotifyKind,
  LabnoteFs,
  Translator,
} from '@labnoteo/core';
import { pickModal, pickManyModal, promptModal, confirmModal } from './modals';
import { noteTargetBelowTable, tableCellHostView } from './tableCellTarget';

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
    const editor = view.editor;
    const noteView = tableCellHostView(editor);
    if (noteView) {
      const cell = (editor as unknown as { cm: { dom: HTMLElement } }).cm.dom;
      return noteTargetBelowTable(file.path, noteView, cell);
    }
    return {
      path: file.path,
      async getText() {
        return editor.getValue();
      },
      async insertAtCursor(text: string) {
        editor.replaceSelection(text);
      },
      async replaceRange(start: number, end: number, text: string) {
        editor.replaceRange(text, editor.offsetToPos(start), editor.offsetToPos(end));
      },
      async getCursorOffset() {
        return editor.posToOffset(editor.getCursor('from'));
      },
      async revealOffset(offset: number) {
        // setCursor treats a bare number as a line index, so convert first.
        const pos = editor.offsetToPos(offset);
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
        editor.focus();
      },
    };
  }

  return {
    fs,

    pick<T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string }) {
      return pickModal(app, items, opts);
    },

    pickMany<T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string }) {
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

    async openFile(path: string) {
      let file = app.vault.getAbstractFileByPath(path);
      // A file just written through the adapter (VaultFileSystem.write) may not
      // be registered in the vault index yet, so getAbstractFileByPath returns
      // null for a brief moment. Retry briefly before falling back.
      for (let i = 0; i < 10 && !(file instanceof TFile); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        file = app.vault.getAbstractFileByPath(path);
      }
      if (file instanceof TFile) {
        await app.workspace.getLeaf(false).openFile(file);
      } else {
        // Last resort: resolve lazily by link text (vault-relative path).
        await app.workspace.openLinkText(path, '', false);
      }
    },

    t,
  };
}
