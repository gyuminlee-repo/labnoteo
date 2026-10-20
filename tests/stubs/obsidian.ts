/**
 * Runtime stub for the `obsidian` module.
 *
 * The published `obsidian` package is types-only (`"main": ""`), so anything
 * importing it as a *value* — `new Notice(...)`, `x instanceof TFile`, a class
 * extending `Modal` — has no implementation under vitest. This module supplies
 * the minimum surface the plugin touches at import time or in the code paths we
 * test, and is wired in through the `plugin` project's `resolve.alias`.
 *
 * Only add symbols here as tests need them: a fuller fake would drift from the
 * real API without anyone noticing.
 */

export class TAbstractFile {
  path = '';
  name = '';
  parent: unknown = null;
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = '';

  constructor(path?: string) {
    super();
    if (path !== undefined) {
      this.path = path;
      this.name = path.split('/').pop() ?? path;
      const dot = this.name.lastIndexOf('.');
      this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
      this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
    }
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** Every `new Notice(...)` is recorded so tests can assert on user feedback. */
export class Notice {
  static readonly shown: string[] = [];

  constructor(public readonly message: string) {
    Notice.shown.push(message);
  }

  hide(): void {}

  /** Test helper: drop everything recorded so far. */
  static reset(): void {
    Notice.shown.length = 0;
  }
}

/** Mutable so a test can exercise the desktop-only branches. */
export const Platform = {
  isDesktopApp: true,
  isMobile: false,
  isWin: false,
};

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json?: unknown;
  headers: Record<string, string>;
}

/**
 * `requestUrl` is a network call, so tests install their own handler rather
 * than letting it reach out. Unset, it fails loudly instead of returning a
 * plausible-looking empty response.
 */
let requestUrlHandler: ((param: RequestUrlParam) => RequestUrlResponse) | null = null;

export function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  if (!requestUrlHandler) {
    throw new Error(`requestUrl stub called without a handler: ${param.url}`);
  }
  return Promise.resolve(requestUrlHandler(param));
}

/** Test helper: install (or clear, with `null`) the `requestUrl` handler. */
export function __setRequestUrlHandler(
  handler: ((param: RequestUrlParam) => RequestUrlResponse) | null
): void {
  requestUrlHandler = handler;
}

/**
 * `getLanguage` only exists from Obsidian 1.8.7, so it is a swappable binding
 * rather than a function: unset (the default) reproduces an older Obsidian.
 */
export let getLanguage: (() => string) | undefined = undefined;

/** Test helper: install (or clear, with `undefined`) `getLanguage`. */
export function __setGetLanguage(fn: (() => string) | undefined): void {
  getLanguage = fn;
}

export class App {}

/** CM6 state field Obsidian puts the editor's file in; only its identity is used. */
export const editorInfoField = {};

/** Only what `instanceof` checks and the open-editor branches read. */
export class MarkdownView {
  file: TFile | null = null;
  editor: unknown = null;
  mode: 'source' | 'preview' = 'source';

  getMode(): 'source' | 'preview' {
    return this.mode;
  }
}

export class Component {
  load(): void {}
  unload(): void {}
}

export const MarkdownRenderer = {
  render(): Promise<void> {
    return Promise.resolve();
  },
};

export class Modal {
  contentEl = { empty(): void {}, createEl(): unknown { return {}; } };

  constructor(public readonly app: App) {}

  open(): void {}
  close(): void {}
  setTitle(_title: string): this {
    return this;
  }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  setPlaceholder(_text: string): void {}
  getSuggestions(_query: string): T[] {
    return [];
  }
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  setClass(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
