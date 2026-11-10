/**
 * Notices after a copied experiment or workflow note, while Obsidian is still saving the open
 * note past the wait: nothing is written, so nothing is said as done. The checklist relink
 * says what it says when it could not run; the save may start before the write or between
 * its first wait and the write in the editor.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { MarkdownView, TFile, TFolder } from '../stubs/obsidian';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

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

const COPY = 'labnote/002_Copy';
const README = `${COPY}/README.labnote.md`;
const NOTE = `${COPY}/001_WD010_A.labnote.md`;
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);
type When = 'none' | 'before' | 'during' | 'otherWriter';

/** A plugin on `files`, with a save of `path` under way from the start, from its first read, or never. */
function plugin(files: Map<string, string>, path: string, when: When) {
  const notices: { level: string; msg: string }[] = [];
  let view = { file: new TFile(path), savePromise: when === 'before' ? new Promise(() => {}) : null } as { file: TFile; savePromise: Promise<unknown> | null };
  if (when === 'otherWriter') {
    // Open in source mode with CRLF in its file; its save fails while another writer changes the file.
    const open = new MarkdownView();
    let text = files.get(path)!.replace(/\r\n/g, '\n');
    open.file = new TFile(path);
    open.lastSavedData = files.get(path)!;
    open.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    open.save = async () => {
      files.set(path, files.get(path)!.replace('title: WD010 A', 'title: Other'));
      throw new Error('save failed');
    };
    view = open as unknown as typeof view;
  }
  const folder = Object.assign(new TFolder(), { path: COPY, name: '002_Copy', children: [...files.keys()].map(p => new TFile(p)) });
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
      getAbstractFileByPath: (p: string) => (p === COPY ? folder : files.has(p) ? new TFile(p) : null),
      read: async (f: TFile) => files.get(f.path)!,
      process: async (f: TFile, fn: (s: string) => string) => {
        const next = fn(files.get(f.path)!);
        files.set(f.path, next);
        return next;
      },
    },
  };
  const host = {
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => {
        // Obsidian starts saving the note right after the write's first wait.
        if (when === 'during' && p === path && !view.savePromise) view.savePromise = new Promise(() => {});
        return files.get(p)!;
      },
      write: async (p: string, s: string) => void files.set(p, s),
    },
    t,
    notify: (level: string, msg: string) => notices.push({ level, msg }),
  };
  const p = Object.create(LabnotePlugin.prototype) as Record<string, unknown>;
  Object.assign(p, { app, host, t, settings: { customSampleTypes: [] }, settleModals: async () => true, sampleTrackingFor: () => false });
  return { p, notices };
}

describe('the checklist relink of a copied experiment', () => {
  const start = ['# Copy', '', '## Related Workflows', '', '- [ ] [A](../001_Orig/001_WD010_A.labnote.md)', ''].join('\n');
  const run = async (when: When) => {
    const files = new Map([[README, start], [NOTE, '# A\n']]);
    const { p, notices } = plugin(files, README, when);
    await (p as unknown as { relinkCopiedChecklist(d: string): Promise<void> }).relinkCopiedChecklist(COPY);
    return { notices, readme: files.get(README)! };
  };
  const unchecked = `Check that the checklist of 002_Copy links to its own notes, not the original's; run "Sync workflow checklist with folder" to fix it.`;

  it.each(['before', 'during'] as const)('a save that does not end in time (%s the write): not said as done, the check asked for', async when => {
    const { notices, readme } = await run(when);
    expect(readme).toBe(start);
    expect(notices).toEqual([{ level: 'warn', msg: unchecked }]);
  }, OPEN_SAVE_WAIT_MS + 10000);

  it('no save under way: relinked and said', async () => {
    const { notices, readme } = await run('none');
    expect(readme).toContain('](./001_WD010_A.labnote.md)');
    expect(notices).toEqual([{ level: 'info', msg: "Pointed 1 checklist link(s) of 002_Copy back at its own notes instead of the original's." }]);
  });
});

describe('the dates of a copied workflow note', () => {
  // Made on another day, so a copy made today gets new dates.
  const start = createWorkflowContent({ id: 'WD010', name: 'A', description: '' }, 'Dr. Kim').replace(/\d{4}-\d{2}-\d{2}/g, '2020-01-01');
  const run = async (when: When) => {
    const files = new Map([[NOTE, start]]);
    const { p, notices } = plugin(files, NOTE, when);
    await (p as unknown as { resetCopyDates(f: TFile): Promise<void> }).resetCopyDates(new TFile(NOTE));
    return { notices, note: files.get(NOTE)! };
  };

  // The change goes into the editor, whose save fails while another writer changes the file:
  // not known to be in it, so not said.
  it('another writer meanwhile: not said as reset', async () => {
    const crlf = start.replace(/\n/g, '\r\n');
    const files = new Map([[NOTE, crlf]]);
    const { p, notices } = plugin(files, NOTE, 'otherWriter');
    await (p as unknown as { resetCopyDates(f: TFile): Promise<void> }).resetCopyDates(new TFile(NOTE));
    expect(files.get(NOTE)).toBe(crlf.replace('title: WD010 A', 'title: Other'));
    expect(notices.filter(n => n.level === 'info')).toEqual([]);
  });

  it('a save that does not end in time: not written, not said as reset', async () => {
    const { notices, note } = await run('before');
    expect(note).toBe(start);
    expect(notices.filter(n => n.level === 'info')).toEqual([]);
  }, OPEN_SAVE_WAIT_MS + 10000);

  it('no save under way: reset and said', async () => {
    const { notices, note } = await run('none');
    expect(note).not.toBe(start);
    expect(notices.filter(n => n.level === 'info').map(n => n.msg)[0]).toMatch(/^Reset the dates of the copy 001_WD010_A\.labnote\.md/);
  });
});
