/**
 * An edit target whose view went to another note refuses to read or write it. On the command
 * paths that use one, the user is told so once, in those words: not as "Command failed", and
 * with no error left unhandled.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createObsidianHost } from '../../src/obsidianHost';

// main.ts brings in every view and suggester; the stub has no base class for those.
vi.mock('obsidian', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  const Base = class {};
  return {
    ...real,
    Plugin: Base,
    PluginSettingTab: Base,
    ItemView: Base,
    EditorSuggest: Base,
    Menu: Base,
    WorkspaceLeaf: Base,
    getLanguage: () => 'en',
    loadPdfJs: async () => ({}),
    requireApiVersion: () => true,
    setIcon: () => {},
  };
});
const chat = vi.fn();
vi.mock('../../src/llm/provider', () => ({ createLlmProvider: vi.fn(() => ({ name: 'Fake', chat })) }));
vi.mock('../../src/modals', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiAnswerModal: vi.fn(),
}));

const { default: LabnotePlugin } = await import('../../src/main');
const { insertUnitOpAndUpdateToc } = await import('../../src/commands');
const { insertSampleReference } = await import('../../src/sampleActions');
const { draftMethodCommand } = await import('../../src/llm/commands');
const { aiAnswerModal } = await import('../../src/modals');

const A = 'labnote/001_Test/001_WD010_A.labnote.md';
const B = 'labnote/001_Test/002_WD030_B.labnote.md';
const SWITCHED = 'The note was switched to another while the command ran, so it was not changed. Run the command again.';
const BODY = ['## [WD010 A]', '', '---', '', '### [UHW010 Spin]', '', '#### Method', '', '', '#### Output', ''].join('\n');
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

/** A source view on A, its editor at `cursor`; `goToB()` puts the view on B. */
function openOnA(cursor = 0) {
  const view = new MarkdownView();
  view.file = new TFile(A);
  view.mode = 'source';
  let text = BODY;
  let onRead: (() => void) | undefined;
  view.editor = {
    getValue: () => {
      const now = text;
      onRead?.();
      return now;
    },
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    posToOffset: (pos: { ch: number }) => pos.ch,
    getCursor: () => ({ line: 0, ch: cursor }),
    replaceRange: (r: string, from: { ch: number }, to: { ch: number }) => {
      text = text.slice(0, from.ch) + r + text.slice(to.ch);
    },
    replaceSelection: () => undefined,
    setCursor: () => undefined,
    scrollIntoView: () => undefined,
    focus: () => undefined,
  };
  const app = {
    workspace: { getActiveViewOfType: () => view, getMostRecentLeaf: () => null, getActiveFile: () => view.file },
    vault: { getFileByPath: (p: string) => new TFile(p) },
  } as unknown as App;
  const host = createObsidianHost(app, new MemFileSystem(), t);
  const notices: { level: string; msg: string }[] = [];
  host.notify = (level: string, msg: string) => void notices.push({ level, msg });
  const goToB = () => {
    view.file = new TFile(B);
    text = 'other note\n';
  };
  return { app, host, notices, goToB, text: () => text, switchOnNextRead: () => (onRead = () => ((onRead = undefined), goToB())) };
}

/** The plugin's command runner over `host`. */
function plugin(app: App, host: ReturnType<typeof createObsidianHost>) {
  const p = Object.create(LabnotePlugin.prototype) as InstanceType<typeof LabnotePlugin>;
  Object.assign(p, {
    app,
    host,
    t,
    settings: { customSampleTypes: [], globalSampleFolder: 'resources/labsamples', llmModel: 'm', llmProvider: 'ollama' },
    markUserEdit: () => undefined,
  });
  return p;
}

/** `run` reports on its own: wait for it. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('a command whose edit target is on another note by the time it writes', () => {
  it('inserting a unit operation: said once, as it is', async () => {
    const { app, host, notices, goToB } = openOnA();
    const stale = host.editTarget()!;
    goToB();
    const p = plugin(app, { ...host, editTarget: () => stale });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    p.run(() => insertUnitOpAndUpdateToc({ ...host, editTarget: () => stale }, { opId: 'UHW020', opName: 'Mix', opDescription: '', opType: 'hw' } as never));
    await settle();
    expect(notices).toEqual([{ level: 'warn', msg: SWITCHED }]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('inserting a sample reference: said once, as it is', async () => {
    const { app, host, notices, goToB, text } = openOnA();
    const stale = host.editTarget()!;
    goToB();
    const p = plugin(app, host);
    p.run(() => insertSampleReference(p, stale, '@DNA;DNA-1', 0));
    await settle();
    expect(notices).toEqual([{ level: 'warn', msg: SWITCHED }]);
    expect(text()).toBe('other note\n');
  });

  it("an AI Method draft: said once, as it is, and offered to copy", async () => {
    const inMethod = BODY.indexOf('#### Method') + 2;
    const { app, host, notices, switchOnNextRead } = openOnA(inMethod);
    const p = plugin(app, host);
    chat.mockImplementation(async () => {
      // The view goes to B as the draft is put in, after its note is read.
      switchOnNextRead();
      return { content: '1. Spin' };
    });
    await draftMethodCommand(p);
    expect(notices).toEqual([{ level: 'warn', msg: SWITCHED }]);
    expect(aiAnswerModal).toHaveBeenCalledTimes(1);
  });
});
