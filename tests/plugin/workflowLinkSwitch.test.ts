/**
 * "Insert workflow" puts the new workflow's link in the note it started from. When the
 * editor's view shows another note by the time the link would go in, the link is not inserted
 * there: the workflow is made and said, and the link is said not inserted.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App, Editor } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { insertWorkflowLinkCommand } from '../../src/commands';

vi.mock('../../src/modals', () => ({ workflowAliasModal: vi.fn(async () => '') }));

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const A = `${DIR}/001_WD010_A.labnote.md`;
const B = `${DIR}/002_WD030_B.labnote.md`;
const START = ['---', 'title: x', '---', '# Test', '', '## Related Workflows', ''].join('\n');
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

/** `when`: the view goes from A to B as the command starts, or while the workflow is picked. */
async function run(when: 'start' | 'pick') {
  const fs = new MemFileSystem({ [README]: START, [A]: 'a\n', [B]: 'a\n' });
  const notices: { level: string; msg: string }[] = [];
  let shown = A;
  let text = 'a\n';
  const editor = {
    getValue: () => text,
    getCursor: () => ({ line: 0, ch: 0 }),
    posToOffset: () => 0,
    offsetToPos: (offset: number) => offset,
    replaceRange: (r: string, from: number, to: number) => {
      text = text.slice(0, from) + r + text.slice(to);
    },
    setCursor: () => undefined,
  } as unknown as Editor;
  let first = true;
  const app = {
    workspace: {
      getActiveFile: () => {
        const file = new TFile(shown);
        // The view goes to B right after the command looked: before its first wait ends.
        if (when === 'start' && first) {
          first = false;
          queueMicrotask(() => (shown = B));
        }
        return file;
      },
      getLeavesOfType: () => [],
    },
    vault: {
      adapter: {},
      getFileByPath: () => null,
      getAbstractFileByPath: () => null,
      read: async (f: TFile) => fs.read(f.path),
      process: async (f: TFile, fn: (s: string) => string) => {
        const next = fn(await fs.read(f.path));
        await fs.write(f.path, next);
        return next;
      },
    },
  } as unknown as App;
  const host = {
    fs,
    t,
    notify: (level: string, msg: string) => notices.push({ level, msg }),
    openFile: async () => {},
    pick: async () => {
      if (when === 'pick') shown = B;
      return { id: 'WD020', name: 'New', description: '' };
    },
  } as unknown as LabnoteHost;
  await insertWorkflowLinkCommand(app, host, editor, c => c, () => shown);
  return { notices, text, files: await fs.list(DIR) };
}

describe('a workflow link when the view goes to another note', () => {
  it.each(['start', 'pick'] as const)('is not inserted, the workflow made and said (switched at %s)', async when => {
    const { notices, text, files } = await run(when);
    expect(files).toContain('003_WD020_New.labnote.md');
    expect(text).toBe('a\n');
    expect(notices).toEqual([
      { level: 'info', msg: 'Workflow created: 003_WD020_New.labnote.md' },
      { level: 'warn', msg: 'The note was switched to another while the workflow was made, so the link to it was not inserted.' },
    ]);
  });
});
