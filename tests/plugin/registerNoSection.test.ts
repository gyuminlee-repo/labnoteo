/**
 * A README whose Related Workflows section is still on disk but was deleted in its open editor
 * (not saved yet): a workflow registered there goes nowhere, and says the README has no section,
 * not that it was registered.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { registerWorkflowInReadme } from '../../src/commands';

const README = 'labnote/001_Test/README.labnote.md';
const DISK = ['---', 'title: x', '---', '# Test', '', '## Related Workflows', '', '## Summary', ''].join('\n');
const TYPED = ['---', 'title: x', '---', '# Test', '', '## Summary', ''].join('\n');

describe('a workflow registered in a README whose section its open editor deleted', () => {
  it('is not registered, and says there is no section', async () => {
    const fs = new MemFileSystem({ [README]: DISK });
    const tf = new TFile(README);
    let text = TYPED;
    const view = new MarkdownView();
    view.file = tf;
    view.lastSavedData = DISK;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, data: string) => fs.write(README, data);
    const app = {
      workspace: { getLeavesOfType: () => [{ view }] },
      vault: {
        getFileByPath: () => tf,
        getAbstractFileByPath: () => tf,
        read: async () => fs.read(README),
        process: async (_f: TFile, fn: (s: string) => string) => {
          const next = fn(await fs.read(README));
          await fs.write(README, next);
          return next;
        },
      },
    } as unknown as App;
    const host = { fs, t: (s: string) => s, notify: () => undefined } as unknown as LabnoteHost;
    expect(await registerWorkflowInReadme(app, host, README, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })).toBe('noSection');
    expect(text).not.toContain('002_WD020_New');
  });
});
