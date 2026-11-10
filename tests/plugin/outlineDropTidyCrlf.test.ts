/**
 * The Outline-drop tidy as the plugin wires it, on a note open in an editor while its file has
 * CRLF line ends. The tidy reads offsets in the file as the Outline wrote it, so it writes to
 * the file, not the editor: the section is nested back as with the note closed.
 */
import { describe, it, expect, vi } from 'vitest';
import { findUnitOpInsertOffset, rebuildUnitOpToc, simulateOutlineHeadingMove } from '@labnoteo/core';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { OutlineDropTidy, OutlineDropTidyDeps } from '../../src/outlineDropTidy';

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

// The tidy the plugin makes, kept so the test can arm it as a drop would.
const made: OutlineDropTidy[] = [];
vi.mock('../../src/outlineDropTidy', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/outlineDropTidy')>();
  return {
    ...real,
    createOutlineDropTidy: (deps: OutlineDropTidyDeps) => {
      const tidy = real.createOutlineDropTidy(deps);
      made.push(tidy);
      return tidy;
    },
  };
});

const { default: LabnotePlugin } = await import('../../src/main');

const NOTE = 'labnote/001_Exp/001_WD010_Design.labnote.md';

function buildNote(): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, { noteId: 'LN-00000000' });
  for (const opId of ['UHW010', 'UHW020', 'UHW030']) {
    const block = buildHwUnitOpMarkdown({ opId, opName: `Op ${opId}`, opDescription: 'step' }, { experimenter: 'Dr. Kim', dateTime: '2026-09-29 10:00' });
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

function headingsOf(md: string, nl: string) {
  const out: { level: number; start: number; text: string }[] = [];
  let at = 0;
  for (const line of md.split(nl)) {
    const m = /^(#{1,6})\s/.exec(line);
    if (m) out.push({ level: m[1].length, start: at, text: line });
    at += line.length + nl.length;
  }
  return out;
}

/** UHW030 dropped in the Outline right below UHW010's heading, then the tidy on the write. */
async function dropAndTidy(nl: string, open: boolean): Promise<{ written: string; tidied: string }> {
  const before = buildNote().replace(/\n/g, nl);
  const hs = headingsOf(before, nl);
  const moved = hs.findIndex(h => h.text.startsWith('### [UHW030'));
  const target = hs.findIndex(h => h.text.startsWith('### [UHW010')) + 1;
  const end = hs.findIndex(h => h.text.startsWith('## Conclusions'));
  const written = simulateOutlineHeadingMove(before, hs[moved].start, hs[end].start, hs[target].start)!;
  const state = { disk: written, editor: before.replace(/\r\n/g, '\n') };
  const view = new MarkdownView();
  view.file = new TFile(NOTE);
  view.editor = {
    getValue: () => state.editor,
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      state.editor = state.editor.slice(0, from) + text + state.editor.slice(to);
    },
  };
  const app = {
    workspace: { getLeavesOfType: () => (open ? [{ view }] : []) },
    vault: {
      getAbstractFileByPath: (p: string) => (p === NOTE ? new TFile(NOTE) : null),
      read: async () => state.disk,
      process: async (_file: TFile, fn: (data: string) => string) => (state.disk = fn(state.disk)),
      on: () => ({}),
    },
  };
  made.length = 0;
  // The drop listener goes on the document; none is dropped here.
  vi.stubGlobal('document', {});
  const plugin = Object.create(LabnotePlugin.prototype) as Record<string, unknown>;
  Object.assign(plugin, { app, settings: { autoSyncUnitOpToc: true }, registerDomEvent: () => {}, registerEvent: () => {} });
  (plugin as unknown as { registerOutlineDropTidy(): void }).registerOutlineDropTidy();
  const tidy = made[0];
  tidy.arm(NOTE, { before: Promise.resolve(before), headings: hs.map(h => ({ level: h.level, start: h.start })), movedIdx: moved });
  await tidy.onModify(NOTE);
  return { written, tidied: state.disk };
}

describe('the Outline-drop tidy on a note open in an editor with CRLF in its file', () => {
  it('nests the dropped section back as with the note closed', async () => {
    const closed = await dropAndTidy('\r\n', false);
    const open = await dropAndTidy('\r\n', true);
    expect(open.tidied).toBe(closed.tidied);
    // The tidy did rewrite what the Outline wrote.
    expect(open.tidied).not.toBe(open.written);
  });
});
