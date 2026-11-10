/**
 * The unit-operation TOC sync of an open workflow note edits the editor only while it holds
 * the file as it is: after a change to the file Obsidian has yet to read back, an edit made
 * from the editor's older text would be merged with that change by text and could garble it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '@labnoteo/core';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { MarkdownView, TFile } from '../stubs/obsidian';

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

const { default: LabnotePlugin } = await import('../../src/main');

const NOTE = 'labnote/001_Exp/001_WD010_Design.labnote.md';

/** A note whose last unit operation is not in its TOC yet. */
function staleToc(): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, { noteId: 'LN-00000000' });
  for (const [i, opId] of ['UHW010', 'UHW020'].entries()) {
    const block = buildHwUnitOpMarkdown({ opId, opName: `Op ${opId}`, opDescription: 'step' }, { experimenter: 'Dr. Kim', dateTime: '2026-09-29 10:00' });
    const off = findUnitOpInsertOffset(md);
    md = md.slice(0, off) + block + md.slice(off);
    if (i === 0) md = rebuildUnitOpToc(md);
  }
  return md;
}

async function edited(pendingRead: boolean): Promise<boolean> {
  const text = staleToc();
  expect(rebuildUnitOpToc(text)).not.toBe(text);
  const state = { editor: text, edits: 0 };
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
  // What the view last read; the file may have changed since, not read back yet.
  view.lastSavedData = text;
  const editor = {
    getValue: () => state.editor,
    getCursor: () => 0,
    posToOffset: (pos: number) => pos,
    offsetToPos: (offset: number) => offset,
    replaceRange: (r: string, from: number, to: number) => {
      state.editor = state.editor.slice(0, from) + r + state.editor.slice(to);
      state.edits++;
    },
  };
  view.editor = editor;
  let onChange: ((e: unknown, info: unknown) => void) | undefined;
  const app = {
    workspace: {
      getLeavesOfType: () => [{ view }],
      on: (_name: string, cb: (e: unknown, info: unknown) => void) => {
        onChange = cb;
        return {};
      },
    },
    vault: { read: async () => (pendingRead ? `${text}\nChanged elsewhere.\n` : text) },
  };
  const plugin = Object.create(LabnotePlugin.prototype) as Record<string, unknown>;
  Object.assign(plugin, {
    app,
    settings: { autoSyncUnitOpToc: true },
    registerEvent: () => {},
    unitOpTocTimers: new Map(),
    lastChangeFromHistory: new Map(),
  });
  (plugin as unknown as { registerUnitOpTocAutoSync(): void }).registerUnitOpTocAutoSync();
  onChange!(editor, { file: view.file });
  await vi.advanceTimersByTimeAsync(2000);
  return state.edits > 0;
}

describe('the TOC sync of an open workflow note', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('edits the editor that holds the file as it is', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    expect(await edited(false)).toBe(true);
  });

  it('leaves the editor alone while a change to the file is to be read back', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    expect(await edited(true)).toBe(false);
  });
});
