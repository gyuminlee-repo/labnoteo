/**
 * Reusable Obsidian modal wrappers that adapt native UI to the promise-based
 * {@link LabnoteHost} primitives (pick / pickMany / prompt / confirm).
 *
 * Each wrapper resolves a Promise so command logic in `@labnoteo/core` can use
 * ordinary `await` control flow, exactly as it does with the VS Code host.
 */
import { App, Component, MarkdownRenderer, Modal, Notice, SuggestModal, Setting } from 'obsidian';
import type { PickItem, PromptHint, PromptOpts } from '@labnoteo/core';
import { createObsidianTranslator } from './i18n';

// Module-level translator for the generic button labels ('OK'/'Cancel') these
// host-agnostic modal wrappers render. They only receive an `App`, not the
// plugin's `t()`, so the shared catalog is resolved once at load.
const t = createObsidianTranslator();

/**
 * How well `item` matches the lowercased query `q`, lower first, or undefined
 * when it does not (#324): the label, a word of it or a short keyword (such
 * as a Korean name) equal to the query; the label containing it; a short
 * keyword or the description containing it; then only the detail or a long
 * keyword (an English description kept searchable).
 */
function pickRank<T>(item: PickItem<T>, q: string): number | undefined {
  const label = item.label.toLowerCase();
  const keywords = item.keywords?.map(k => k.toLowerCase()) ?? [];
  const short = keywords.filter(k => k.split(/\s+/).length <= 3);
  if (label === q || short.includes(q) || label.split(/[\s:·|]+/).includes(q)) return 0;
  if (label.includes(q)) return 1;
  if (short.some(k => k.includes(q)) || item.description?.toLowerCase().includes(q)) return 2;
  if (item.detail?.toLowerCase().includes(q) || keywords.some(k => k.includes(q))) return 3;
  return undefined;
}

/** The items matching `query`, best match first and in their given order otherwise. */
export function rankPickItems<T>(items: readonly PickItem<T>[], query: string): PickItem<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items
    .map((item, index) => ({ item, index, rank: pickRank(item, q) }))
    .filter((r): r is { item: PickItem<T>; index: number; rank: number } => r.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(r => r.item);
}

/** Single-select fuzzy picker backed by Obsidian's `SuggestModal`. */
class PickModal<T> extends SuggestModal<PickItem<T>> {
  private done = false;

  constructor(
    app: App,
    private readonly items: PickItem<T>[],
    private readonly resolve: (value: T | undefined) => void,
    opts?: { title?: string; placeholder?: string }
  ) {
    super(app);
    if (opts?.placeholder) this.setPlaceholder(opts.placeholder);
    // A SuggestModal has no title bar; without this the picker never says
    // what is being chosen or for which note (#141).
    if (opts?.title) this.modalEl.prepend(createDiv({ cls: 'labnote-pick-title', text: opts.title }));
  }

  getSuggestions(query: string): PickItem<T>[] {
    return rankPickItems(this.items, query);
  }

  renderSuggestion(item: PickItem<T>, el: HTMLElement): void {
    el.createEl('div', { text: item.label });
    if (item.description) {
      el.createEl('small', { text: item.description, cls: 'labnote-pick-desc' });
    }
    if (item.detail) {
      el.createEl('small', { text: item.detail, cls: 'labnote-pick-detail' });
    }
  }

  /** Resolve exactly once; later calls are no-ops. */
  private settle(value: T | undefined): void {
    if (this.done) return;
    this.done = true;
    this.resolve(value);
  }

  onChooseSuggestion(item: PickItem<T>): void {
    this.settle(item.value);
  }

  onClose(): void {
    // In Obsidian's SuggestModal, onClose() fires BEFORE onChooseSuggestion()
    // when an item is selected. Defer the cancel-resolve so a real selection
    // settles first; on dismissal (Esc / click-away) this timer wins.
    window.setTimeout(() => this.settle(undefined), 0);
  }
}

export function pickModal<T>(
  app: App,
  items: PickItem<T>[],
  opts?: { title?: string; placeholder?: string }
): Promise<T | undefined> {
  return new Promise(resolve => new PickModal(app, items, resolve, opts).open());
}

/** Multi-select picker: a checkbox list in a plain `Modal`. */
class PickManyModal<T> extends Modal {
  private resolved = false;
  private readonly selected = new Set<number>();

  constructor(
    app: App,
    private readonly items: PickItem<T>[],
    private readonly resolve: (values: T[]) => void,
    private readonly opts?: { title?: string; placeholder?: string }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    if (this.opts?.title) this.setTitle(this.opts.title);

    this.items.forEach((item, idx) => {
      if (item.checked) this.selected.add(idx);
      new Setting(contentEl)
        .setName(item.label)
        .setDesc(item.description ?? '')
        .addToggle(t =>
          t.setValue(Boolean(item.checked)).onChange(v => {
            if (v) this.selected.add(idx);
            else this.selected.delete(idx);
          })
        );
    });

    new Setting(contentEl).addButton(b =>
      b
        .setButtonText(t('OK'))
        .setCta()
        .onClick(() => {
          this.resolved = true;
          this.resolve([...this.selected].map(i => this.items[i].value));
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve([]);
  }
}

export function pickManyModal<T>(
  app: App,
  items: PickItem<T>[],
  opts?: { title?: string; placeholder?: string }
): Promise<T[]> {
  return new Promise(resolve => new PickManyModal(app, items, resolve, opts).open());
}

/** Single-line text input with optional (async) validation. */
class PromptModal extends Modal {
  private resolved = false;
  private value: string;

  constructor(
    app: App,
    private readonly opts: PromptOpts,
    private readonly resolve: (value: string | undefined) => void
  ) {
    super(app);
    this.value = opts.value ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    if (this.opts.title) this.setTitle(this.opts.title);
    if (this.opts.prompt) contentEl.createEl('p', { text: this.opts.prompt });

    const errorEl = contentEl.createEl('div', { cls: 'labnote-prompt-error' });
    // Its own line under the input: the change handler clears the error line.
    let hintEl: HTMLElement | undefined;
    const showHint = () => {
      if (hintEl && this.opts.hint) renderHint(hintEl, this.opts.hint(this.value));
    };

    const submit = async () => {
      if (this.opts.validate) {
        const err = await this.opts.validate(this.value);
        if (err) {
          errorEl.setText(err);
          return;
        }
      }
      this.resolved = true;
      this.resolve(this.value);
      this.close();
    };

    // `labnote-prompt-row` collapses the (unused) label column so the input
    // spans the modal instead of being squeezed against the right edge.
    new Setting(contentEl).setClass('labnote-prompt-row').addText(t => {
      t.setValue(this.value).onChange(v => {
        this.value = v;
        errorEl.setText('');
        showHint();
      });
      if (this.opts.placeholder) t.setPlaceholder(this.opts.placeholder);
      t.inputEl.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void submit();
        }
      });
      // Focus the input on open.
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    if (this.opts.hint) {
      hintEl = contentEl.createDiv({ cls: 'labnote-input-hint' });
      showHint();
    }

    new Setting(contentEl).addButton(b =>
      b.setButtonText(t('OK')).setCta().onClick(() => void submit())
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(undefined);
  }
}

/** Show a {@link PromptHint} in `el`; nothing clears it. */
function renderHint(el: HTMLElement, hint: PromptHint | undefined): void {
  el.setText(hint?.text ?? '');
  el.toggleClass('is-warning', !!hint?.warn);
}

export function promptModal(app: App, opts: PromptOpts): Promise<string | undefined> {
  return new Promise(resolve => new PromptModal(app, opts, resolve).open());
}

/** Yes/No confirmation dialog. */
/**
 * How a confirm dialog draws its confirm button: red only for what cannot be
 * undone, the accent colour otherwise, so a plain "Insert" does not read as a
 * warning (#285).
 */
export function confirmButtonStyle(destructive: boolean): 'warning' | 'cta' {
  return destructive ? 'warning' : 'cta';
}

class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly resolve: (ok: boolean) => void,
    private readonly destructive = false
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message, cls: 'labnote-confirm-message' });
    new Setting(contentEl)
      .addButton(b => {
        b.setButtonText(this.confirmLabel).onClick(() => {
          this.resolved = true;
          this.resolve(true);
          this.close();
        });
        if (confirmButtonStyle(this.destructive) === 'warning') b.setWarning();
        else b.setCta();
      })
      .addButton(b => {
        b.setButtonText(t('Cancel')).onClick(() => {
          this.resolved = true;
          this.resolve(false);
          this.close();
        });
        // Obsidian focuses the first button, so Enter would run a deletion or
        // a move that breaks references before the warning is read (#198).
        if (this.destructive) window.setTimeout(() => b.buttonEl.focus(), 0);
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(false);
  }
}

/**
 * Aborting `signal` closes the dialog, which then resolves false.
 * `destructive` focuses Cancel, so Enter does not confirm something that
 * cannot be undone.
 */
export function confirmModal(
  app: App,
  message: string,
  confirmLabel = 'Yes',
  opts: { signal?: AbortSignal; destructive?: boolean } = {}
): Promise<boolean> {
  const { signal, destructive } = opts;
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const modal = new ConfirmModal(
      app,
      message,
      confirmLabel,
      ok => {
        signal?.removeEventListener('abort', onAbort);
        resolve(ok);
      },
      destructive
    );
    const onAbort = (): void => modal.close();
    signal?.addEventListener('abort', onAbort);
    modal.open();
  });
}

/** Options for {@link aiAnswerModal}. */
export interface AiAnswerOpts {
  /** The model's Markdown answer. */
  content: string;
  /** The note the answer is about; links in the answer resolve from it. */
  sourcePath: string;
  /** Put the answer into the note. Resolves false when it was not inserted. */
  onInsert: () => Promise<boolean>;
}

/**
 * Shows an AI answer rendered as Markdown (#77). The note only changes when
 * the user presses "Insert into note".
 */
class AiAnswerModal extends Modal {
  private readonly component = new Component();

  constructor(
    app: App,
    private readonly opts: AiAnswerOpts
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(t('AI answer'));
    this.component.load();
    const body = contentEl.createDiv({ cls: 'labnote-ai-answer markdown-rendered' });
    void MarkdownRenderer.render(this.app, this.opts.content, body, this.opts.sourcePath, this.component);

    new Setting(contentEl)
      .addButton(b =>
        b
          .setButtonText(t('Insert into note'))
          .setCta()
          .onClick(async () => {
            if (await this.opts.onInsert()) this.close();
          })
      )
      .addButton(b =>
        b.setButtonText(t('Copy')).onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.opts.content);
            new Notice(t('Copied to clipboard.'));
          } catch (err) {
            new Notice(t('Could not copy: {0}', err instanceof Error ? err.message : String(err)));
          }
        })
      )
      .addButton(b => b.setButtonText(t('Close')).onClick(() => this.close()));
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

export function aiAnswerModal(app: App, opts: AiAnswerOpts): void {
  new AiAnswerModal(app, opts).open();
}

/** Options for {@link workflowAliasModal}. */
export interface WorkflowAliasOpts {
  /** Catalog workflow id, e.g. `WT010`. */
  id: string;
  /** Catalog workflow name, e.g. `Nucleotide Sequencing`. */
  catalogName: string;
  /** Modal heading. */
  title: string;
  /** Placeholder shown in the empty alias input. */
  placeholder?: string;
  /** Initial alias, selected so typing replaces it. */
  value?: string;
  /** What this kind of item is, shown under the title. */
  about?: string;
  /** The chosen catalog item's description, under {@link about}. */
  description?: string;
  /** A note under the input, worked out again on every change; never blocks the submit. */
  hint?: (value: string) => PromptHint | undefined;
}

/**
 * Workflow-name entry modal: shows a fixed, non-editable `[id catalogName]`
 * prefix on the left and an empty input for the per-instance alias on the
 * right. Resolves the (trimmable) alias string — possibly `''` when submitted
 * empty — or `undefined` when dismissed.
 */
class WorkflowAliasModal extends Modal {
  private resolved = false;
  private value = '';

  constructor(
    app: App,
    private readonly opts: WorkflowAliasOpts,
    private readonly resolve: (value: string | undefined) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.opts.title);

    const submit = () => {
      this.resolved = true;
      this.resolve(this.value);
      this.close();
    };

    // Layout: the fixed `[id catalogName]` prefix on the left with a wide
    // alias input flowing immediately to its right (fills the remaining width).
    // Styling lives in styles.css under the `labnote-alias-*` classes.
    if (this.opts.about) contentEl.createDiv({ cls: 'labnote-alias-about', text: this.opts.about });
    if (this.opts.description) {
      contentEl.createDiv({ cls: 'labnote-alias-description', text: this.opts.description });
    }
    const row = contentEl.createDiv({ cls: 'labnote-alias-row' });

    row.createSpan({
      cls: 'labnote-alias-prefix',
      text: `[${this.opts.id} ${this.opts.catalogName}]`,
    });

    const input = row.createEl('input', { type: 'text', cls: 'labnote-alias-input' });
    if (this.opts.placeholder) input.placeholder = this.opts.placeholder;
    if (this.opts.value) {
      input.value = this.opts.value;
      this.value = this.opts.value;
    }
    const hintEl = this.opts.hint ? contentEl.createDiv({ cls: 'labnote-input-hint' }) : undefined;
    const showHint = () => {
      if (hintEl && this.opts.hint) renderHint(hintEl, this.opts.hint(this.value));
    };
    showHint();
    input.addEventListener('input', () => {
      this.value = input.value;
      showHint();
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    new Setting(contentEl).addButton(b => b.setButtonText(t('OK')).setCta().onClick(() => submit()));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(undefined);
  }
}

export function workflowAliasModal(
  app: App,
  opts: WorkflowAliasOpts
): Promise<string | undefined> {
  return new Promise(resolve => new WorkflowAliasModal(app, opts, resolve).open());
}
