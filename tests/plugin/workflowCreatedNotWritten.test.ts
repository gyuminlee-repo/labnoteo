/**
 * A workflow created while Obsidian is still saving the open README past the wait: the
 * workflow file is made, the checklist entry is not written, and a warning says so.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { createWorkflowForItem } from '../../src/commands';
import { workflowAliasModal } from '../../src/modals';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

vi.mock('../../src/modals', () => ({ workflowAliasModal: vi.fn(async () => '') }));

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const START = ['---', 'title: x', '---', '# Test', '', '## Related Workflows', ''].join('\n');
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

async function create(saving: boolean) {
  const fs = new MemFileSystem({ [README]: START });
  const notices: { level: string; msg: string }[] = [];
  const readme = new TFile(README);
  const view = { file: readme, savePromise: saving ? new Promise(() => {}) : null };
  const app = {
    workspace: { getActiveFile: () => readme, getLeavesOfType: () => [{ view }] },
    vault: {
      adapter: {},
      getFileByPath: (p: string) => (p === README ? readme : null),
      getAbstractFileByPath: (p: string) => (p === README ? readme : null),
      read: async () => fs.read(README),
      process: async (_f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(README));
        await fs.write(README, next);
        return next;
      },
    },
  } as unknown as App;
  const host = {
    fs,
    t,
    notify: (level: string, msg: string) => notices.push({ level, msg }),
    openFile: async () => {},
  } as unknown as LabnoteHost;
  await createWorkflowForItem(app, host, { id: 'WD020', name: 'New', description: '' } as never);
  return { notices, readme: await fs.read(README), files: await fs.list(DIR) };
}

describe('a workflow created while the open README is still being saved', () => {
  it('is made, not listed, and the warning says so once', async () => {
    const { notices, readme, files } = await create(true);
    expect(vi.mocked(workflowAliasModal)).toHaveBeenCalled();
    expect(files).toContain('001_WD020_New.labnote.md');
    expect(readme).toBe(START);
    expect(notices.filter(n => n.level === 'warn')).toEqual([
      {
        level: 'warn',
        msg: 'README.labnote.md was not written: it was still being saved, or it changed while the entry went in, so 001_WD020_New.labnote.md was not added to its checklist. Run "Sync workflow checklist with folder" in a moment to add it.',
      },
    ]);
    expect(notices.filter(n => n.level === 'info')).toEqual([{ level: 'info', msg: 'Workflow created: 001_WD020_New.labnote.md' }]);
  }, OPEN_SAVE_WAIT_MS + 10000);

  it('with no save under way, is listed with no warning', async () => {
    const { notices, readme } = await create(false);
    expect(readme).toContain('001_WD020_New.labnote.md');
    expect(notices.filter(n => n.level === 'warn')).toEqual([]);
  });
});
