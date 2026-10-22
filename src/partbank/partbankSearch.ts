/**
 * The search box behind "Search partbank": a `SuggestModal` that asks the
 * server as you type.
 *
 * Autocomplete itself cannot do this. `EditorSuggest` fires on every keystroke
 * with no debounce of its own, so wiring a network call into it would send one
 * request per character. The debounce and the stale-response rule live in
 * {@link SearchDebouncer}, which is where they are tested.
 */
import { SuggestModal, type App } from 'obsidian';
import type { PartbankSearchEntity, PartbankType } from '@labnoteo/core';
import type { PartbankClient, PartbankSearchHit } from './client';

/** Characters before a search is worth making; below this everything matches. */
export const MIN_QUERY_CHARS = 2;
/** How long typing has to pause before the request goes out. */
export const SEARCH_DEBOUNCE_MS = 400;

export interface SearchDebouncerOpts<T> {
  search(query: string): Promise<T[]>;
  onResults(query: string, results: T[]): void;
  onError(query: string, err: unknown): void;
  delayMs?: number;
  minChars?: number;
  /** Injected so tests can drive the clock without a global timer stub. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/**
 * Turns a stream of keystrokes into at most one request per pause, and drops
 * the answer to any query that is no longer the one on screen — a slow reply
 * to "gf" must not replace the results for "gfp".
 */
export class SearchDebouncer<T> {
  private timer: number | undefined;
  /** The query of the most recent request; answers to any other are ignored. */
  private latest = '';

  constructor(private readonly opts: SearchDebouncerOpts<T>) {}

  private get setTimer(): (fn: () => void, ms: number) => number {
    return this.opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  }

  /** The text in the box changed. */
  query(text: string): void {
    this.cancel();
    const trimmed = text.trim();
    this.latest = trimmed;
    if (trimmed.length < (this.opts.minChars ?? MIN_QUERY_CHARS)) {
      this.opts.onResults(trimmed, []);
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.run(trimmed);
    }, this.opts.delayMs ?? SEARCH_DEBOUNCE_MS);
  }

  /** Drop a pending request; an in-flight one still returns but is ignored. */
  cancel(): void {
    if (this.timer === undefined) return;
    (this.opts.clearTimer ?? (h => window.clearTimeout(h)))(this.timer);
    this.timer = undefined;
  }

  private async run(query: string): Promise<void> {
    try {
      const results = await this.opts.search(query);
      if (this.latest === query) this.opts.onResults(query, results);
    } catch (err) {
      if (this.latest === query) this.opts.onError(query, err);
    }
  }
}

/** What a partbank type is called in the list. */
export function partbankTypeLabel(
  type: PartbankType,
  t: (key: string, ...args: string[]) => string
): string {
  switch (type) {
    case 'part':
      return t('part');
    case 'device':
      return t('device');
    case 'plasmid':
      return t('plasmid');
    case 'primer':
      return t('primer');
    case 'molecule':
      return t('molecule');
    case 'strain':
      return t('strain');
  }
}

/**
 * How a search hit is described in the list. Whose it is matters as much as
 * what it is: a public item from another lab looks the same otherwise.
 */
export function describeHit(
  hit: PartbankSearchHit,
  t: (key: string, ...args: string[]) => string
): { title: string; detail: string } {
  const sharing = hit.ownedByMe
    ? t('mine')
    : hit.sharingLevel === 'public'
      ? t('public')
      : t('shared');
  const detail = [hit.kid, partbankTypeLabel(hit.type, t), sharing, hit.description]
    .filter((p): p is string => Boolean(p))
    .join(' · ');
  return { title: hit.name?.trim() || hit.kid || hit.id, detail };
}

/** Search partbank and return the chosen item, or undefined when dismissed. */
export function searchPartbankModal(
  app: App,
  client: PartbankClient,
  entities: readonly PartbankSearchEntity[],
  opts: {
    initialQuery: string;
    placeholder: string;
    emptyText: string;
    t: (key: string, ...args: string[]) => string;
    onError(err: unknown): void;
  }
): Promise<PartbankSearchHit | undefined> {
  return new Promise(resolve => {
    new PartbankSearchModal(app, client, entities, opts, resolve).open();
  });
}

class PartbankSearchModal extends SuggestModal<PartbankSearchHit> {
  private hits: PartbankSearchHit[] = [];
  private readonly debouncer: SearchDebouncer<PartbankSearchHit>;
  private settled = false;
  /** The last text a search was started for; `\0` so the first call never matches. */
  private lastAsked = '\u0000';

  constructor(
    app: App,
    client: PartbankClient,
    entities: readonly PartbankSearchEntity[],
    private readonly opts: {
      initialQuery: string;
      placeholder: string;
      emptyText: string;
      t: (key: string, ...args: string[]) => string;
      onError(err: unknown): void;
    },
    private readonly resolve: (hit: PartbankSearchHit | undefined) => void
  ) {
    super(app);
    this.setPlaceholder(opts.placeholder);
    this.emptyStateText = opts.emptyText;
    this.debouncer = new SearchDebouncer({
      search: query => client.searchGlobal(query, entities),
      onResults: (_query, results) => {
        this.hits = results;
        // Re-ask Obsidian for the list now that the answer is in.
        this.inputEl.dispatchEvent(new Event('input'));
      },
      onError: (_query, err) => opts.onError(err),
    });
  }

  onOpen(): void {
    super.onOpen();
    if (!this.opts.initialQuery) return;
    this.inputEl.value = this.opts.initialQuery;
    this.inputEl.dispatchEvent(new Event('input'));
  }

  getSuggestions(query: string): PartbankSearchHit[] {
    // Asking only when the text actually changed stops the `input` event we
    // dispatch with the results from starting another search.
    if (query.trim() !== this.lastAsked) {
      this.lastAsked = query.trim();
      this.debouncer.query(query);
    }
    return this.hits;
  }

  renderSuggestion(hit: PartbankSearchHit, el: HTMLElement): void {
    const { title, detail } = describeHit(hit, this.opts.t);
    el.createEl('div', { text: title });
    el.createEl('small', { text: detail, cls: 'labnote-pick-desc' });
  }

  onChooseSuggestion(hit: PartbankSearchHit): void {
    this.settle(hit);
  }

  onClose(): void {
    this.debouncer.cancel();
    // Obsidian fires onClose() before onChooseSuggestion(); defer so a real
    // pick settles first and only a dismissal resolves to undefined.
    window.setTimeout(() => this.settle(undefined), 0);
  }

  private settle(hit: PartbankSearchHit | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(hit);
  }
}
