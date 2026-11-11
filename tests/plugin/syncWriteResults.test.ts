/**
 * A note the checklist sync or a checklist entry is written to, whose write did not go in or
 * may not have: it is said with the note's path and the command to run, and not counted as
 * updated or added.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { addWorkflowFileToChecklist, syncWorkflowChecklistCommand, type ReadmeSyncControl } from '../../src/commands';

// What the open editor's write comes to, for the note under test: as the module does, or forced.
// Both entry points are forced, so the same test runs on code that calls either.
const forced = vi.hoisted(() => ({ path: '', result: undefined as unknown, landed: false, events: [] as string[] }));
vi.mock('../../src/openEditorWrite', async importActual => {
  const actual = await importActual<Record<string, unknown>>();
  const force = (name: string) => {
    const real = actual[name] as ((app: unknown, file: TFile, ...rest: unknown[]) => Promise<unknown>) | undefined;
    return (
      real &&
      (async (app: unknown, file: TFile, ...rest: unknown[]) => {
        if (file.path !== forced.path) return real(app, file, ...rest);
        forced.events.push('write');
        // The change, or another writer's like it, reached the file although the write is not known to be in.
        if (forced.landed) await (app as App).vault.process(file as never, rest[0] as (s: string) => string);
        return forced.result;
      })
    );
  };
  const openEditorText = actual.openEditorText as (app: unknown, path: string) => Promise<string | undefined>;
  return {
    ...actual,
    processInOpenEditor: force('processInOpenEditor'),
    processInOpenEditorOnDisk: force('processInOpenEditorOnDisk'),
    openEditorText: async (app: unknown, path: string) => {
      if (path === forced.path) forced.events.push('read');
      return openEditorText(app, path);
    },
  };
});
// The note text the checklist labels are planned from.
vi.mock('@labnoteo/core/lib/workflowStructure', async importActual => {
  const actual = await importActual<typeof import('@labnoteo/core/lib/workflowStructure')>();
  return {
    ...actual,
    workflowLabelFor: (fileName: string, content?: string) => {
      if (forced.path.endsWith(`/${fileName}`)) forced.events.push(`label ${/^title: (.*)$/m.exec(content ?? '')?.[1]}`);
      return actual.workflowLabelFor(fileName, content);
    },
  };
});

const DIR = 'labnote/002_Target';
const README = `${DIR}/README.labnote.md`;
const REGISTERED = '002_WD030_Design.labnote.md';
const RENAMED = '002_WD030_Design_2차.labnote.md';
const readme = (entries: string[]) =>
  ['# Target', '', '## 🗂️ Related Workflows', '', ...entries, '', '## Summary', '', '요약.', ''].join('\n');

function harness(files: Record<string, string>) {
  const fs = new MemFileSystem(files);
  const notices: string[] = [];
  const app = {
    workspace: { getActiveFile: () => new TFile(README), getLeavesOfType: () => [] },
    vault: {
      getFiles: () => Object.keys(fs.snapshot()).map(p => new TFile(p)),
      getFileByPath: (path: string) => (path in fs.snapshot() ? new TFile(path) : null),
      read: async (file: TFile) => fs.read(file.path),
      process: async (file: TFile, fn: (data: string) => string) => {
        const next = fn(await fs.read(file.path));
        await fs.write(file.path, next);
        return next;
      },
    },
  } as unknown as App;
  const host = {
    fs,
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    confirm: async () => true,
    notify: (level: string, msg: string) => notices.push(`${level} ${msg}`),
  } as unknown as LabnoteHost;
  const sync: ReadmeSyncControl = {
    flushNow: async () => undefined,
    hold: () => undefined,
    settle: async () => undefined,
    release: async () => undefined,
  };
  return { fs, notices, app, host, sync };
}

const UNCERTAIN = (path: string) =>
  `warn ${path} may or may not have the change: it was being saved when another change reached it. Check the note before trying again.`;
const NOT_WRITTEN = (path: string) =>
  `warn ${path} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.`;

beforeEach(() => {
  forced.path = '';
  forced.result = undefined;
  forced.landed = false;
  forced.events = [];
});

describe('the checklist sync, a note it updates not written or maybe not', () => {
  const retitled = {
    [README]: readme([`- [ ] [WD030 Design 2차](./${RENAMED})`]),
    [`${DIR}/${RENAMED}`]: '---\ntitle: WD030 Design\n---\n\n## [WD030 Design]\n',
  };
  const unnamed = {
    [README]: `---\nauthor: 이영희\n---\n\n${readme([`- [ ] [WD030 Design](./${REGISTERED})`])}`,
    [`${DIR}/${REGISTERED}`]: "---\ntitle: WD030 Design\nexperimenter: ''\n---\n\n## [WD030 Design]\n\n- Experimenter:\n",
  };

  it.each([
    ['title', 'uncertain', retitled, RENAMED, UNCERTAIN],
    ['title', false, retitled, RENAMED, NOT_WRITTEN],
    ['experimenter', 'uncertain', unnamed, REGISTERED, UNCERTAIN],
    ['experimenter', false, unnamed, REGISTERED, NOT_WRITTEN],
  ] as const)('its %s write coming to %s is said and not counted', async (_what, result, files, name, said) => {
    const h = harness(files);
    forced.path = `${DIR}/${name}`;
    forced.result = result;
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    expect(h.notices).toContain(said(`${DIR}/${name}`));
    expect(h.notices.join('\n')).not.toContain('note(s) updated');
  });

  it.each(['uncertain', false] as const)(
    'a retitle whose write came to %s is read back after it, and the labels are planned from what was read',
    async result => {
      const h = harness(retitled);
      forced.path = `${DIR}/${RENAMED}`;
      forced.result = result;
      forced.landed = true;
      await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
      // After the write: the note read (a not-written check may read it first too), then the
      // labels planned from the text read, the new title, never the one before the write.
      const after = forced.events.slice(forced.events.indexOf('write') + 1);
      const labels = after.findIndex(e => e.startsWith('label'));
      expect(after[labels]).toBe('label WD030 Design 2차');
      expect(after[labels - 1]).toBe('read');
      expect(after).not.toContain('label WD030 Design');
    }
  );

  it('a write that went in is counted with no warning', async () => {
    const h = harness(retitled);
    await syncWorkflowChecklistCommand(h.app, h.host, h.sync, DIR);
    expect(h.notices.filter(n => n.startsWith('warn'))).toEqual([]);
    expect(h.notices.at(-1)).toBe('info Workflow checklist updated: 0 added, 0 removed. 1 note(s) updated.');
  });
});

describe('a workflow added to the README checklist, the README not written or maybe not', () => {
  const files = { [README]: readme([]), [`${DIR}/${REGISTERED}`]: '---\ntitle: WD030 Design\n---\n' };

  it('not written: names the README, the note and the command that lists it', async () => {
    const h = harness(files);
    forced.path = README;
    forced.result = false;
    expect(await addWorkflowFileToChecklist(h.app, h.host, DIR, REGISTERED)).toBe(false);
    expect(h.notices).toEqual([
      `warn ${README} was not written: it was still being saved, or it changed while the entry went in, so ${REGISTERED} was not added to its checklist. Run "Sync workflow checklist with folder" in a moment to add it.`,
    ]);
  });

  it('maybe not written: says so, and is not taken for added', async () => {
    const h = harness(files);
    forced.path = README;
    forced.result = 'uncertain';
    expect(await addWorkflowFileToChecklist(h.app, h.host, DIR, REGISTERED)).toBe(false);
    expect(h.notices).toEqual([UNCERTAIN(README)]);
  });

  it('written: added, with nothing to warn of', async () => {
    const h = harness(files);
    expect(await addWorkflowFileToChecklist(h.app, h.host, DIR, REGISTERED)).toBe(true);
    expect(h.notices).toEqual([]);
    expect(await h.fs.read(README)).toContain(REGISTERED);
  });
});
