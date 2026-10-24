/**
 * LabnoteHost — the platform abstraction that lets command logic live in core.
 *
 * Rather than a declarative command registry (which fit only ~11 of 37 real
 * commands), commands become plain `async` functions that receive a
 * `LabnoteHost`. Multi-step QuickPick chains, confirmations, and rollbacks are
 * then expressed as ordinary control flow with `await`.
 *
 * VS Code implements this over the editor/webview APIs; Obsidian implements it
 * over Modal/SuggestModal/Menu and the CodeMirror editor. Because Obsidian has
 * no Section Editor webview, its `editTarget` collapses to a single CM6
 * implementation — the dual edit-target branch that exists in the VS Code
 * commands simply disappears there.
 */

import type { LabnoteFs } from './fs/labnoteFs';

/** A selectable option presented by {@link LabnoteHost.pick}. */
export interface PickItem<T> {
  /** Primary line shown to the user. */
  label: string;
  /** Optional dimmed description shown alongside the label. */
  description?: string;
  /** Optional detail line (rendered smaller / on a second row). */
  detail?: string;
  /** Extra words the filter matches, not shown (e.g. a Korean name or abbreviation). */
  keywords?: readonly string[];
  /** Ticked when a multi-select list opens; ignored by single-select pickers. */
  checked?: boolean;
  /** The value returned when this item is chosen. */
  value: T;
}

/** Options for a single-line text prompt. */
export interface PromptOpts {
  /** Prompt/question text. */
  prompt?: string;
  /** Placeholder shown in the empty input. */
  placeholder?: string;
  /** Pre-filled value. */
  value?: string;
  /** Title for the input dialog (where the platform supports one). */
  title?: string;
  /**
   * Synchronous or async validator. Return a non-empty string to show a
   * validation error and keep the dialog open; return null/undefined/'' to
   * accept.
   */
  validate?: (value: string) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * A note under the input, worked out again on every change (e.g. how much
   * of the value fits in a file name); `warn` shows it in the warning colour.
   * It never blocks the submit.
   */
  hint?: (value: string) => PromptHint | undefined;
}

/** {@link PromptOpts.hint} result. */
export interface PromptHint {
  text: string;
  warn?: boolean;
}

export type NotifyKind = 'info' | 'warn' | 'error';

/**
 * An abstract editing surface for the *currently active* lab note document.
 *
 * This generalises the VS Code `ActiveLabnoteEditTarget` union (README text
 * editor vs Section Editor webview) into a single interface so command logic
 * never branches on the platform edit surface.
 */
export interface EditTarget {
  /** Absolute (or vault-relative on Obsidian) path of the target document. */
  readonly path: string;
  /** Full current text of the document. */
  getText(): Promise<string>;
  /** Insert `text` at the current cursor/selection position. */
  insertAtCursor(text: string): Promise<void>;
  /**
   * Replace the half-open `[start, end)` character range (offsets into the
   * document text) with `text`.
   */
  replaceRange(start: number, end: number, text: string): Promise<void>;
  /**
   * Current cursor (selection start) as a character offset into the document.
   * Optional: hosts without cursor tracking may omit it.
   */
  getCursorOffset?(): Promise<number>;
  /**
   * The selected text as `[start, end)` offsets, or undefined when nothing is
   * selected. Optional: targets whose selection does not map onto the note
   * (a table cell editor) omit it.
   */
  getSelectionRange?(): Promise<{ start: number; end: number } | undefined>;
  /**
   * Move the cursor to `offset`, scroll it into view, and focus the editor.
   * Optional: hosts without cursor control may omit it.
   */
  revealOffset?(offset: number): Promise<void>;
}

/**
 * Platform services a command needs. Deliberately imperative: every method maps
 * to a concrete UI/editor primitive on each host.
 */
export interface LabnoteHost {
  /** File-system port (already platform-neutral). */
  readonly fs: LabnoteFs;

  /** Single-select quick pick. Resolves undefined if dismissed. */
  pick<T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string }): Promise<T | undefined>;

  /** Multi-select quick pick. Resolves [] if dismissed. */
  pickMany<T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string }): Promise<T[]>;

  /** Single-line text input. Resolves undefined if dismissed. */
  prompt(opts: PromptOpts): Promise<string | undefined>;

  /**
   * Yes/No confirmation. Resolves false if dismissed, or when `signal` aborts
   * (the dialog closes so nobody answers a question that no longer applies).
   * `destructive` makes Cancel the default, so Enter does not confirm.
   */
  confirm(
    message: string,
    opts?: { confirmLabel?: string; signal?: AbortSignal; destructive?: boolean }
  ): Promise<boolean>;

  /** Show a transient notification. */
  notify(kind: NotifyKind, message: string): void;

  /** The active lab note edit surface, if any. */
  editTarget(): EditTarget | undefined;

  /** Open a file in the platform's editor, with the cursor at `at` (0-based) when given. */
  openFile(path: string, at?: { line: number; ch?: number }): Promise<void>;

  /** Localise a message key with positional args. */
  t(key: string, ...args: Array<string | number | boolean>): string;
}
