/**
 * A change put into the editor of an open CRLF note reaches the file exactly once, however the
 * editor's save goes: it writes what the editor holds, writes that plus more (a filter, text
 * typed meanwhile), or lands late, after the plugin looked at the file again or after it wrote
 * through the vault. A note written whole with a lone CR in it is written once too.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault, registerWorkflowInReadme, writeNoteThroughVault } from '../../src/commands';

const README = 'labnote/001_Test/README.labnote.md';
const readme = (nl: string) => ['---', 'status: ongoing', 'last_updated_date: 2026-01-01', '---', '# Test', '', '## Related Workflows', ''].join(nl);
type Save = 'normal' | 'extra' | 'typed' | 'lateBeforeProcess' | 'lateAfterProcess';

function setup(disk: string, save: Save) {
  const lf = (s: string) => s.replace(/\r\n?/g, '\n');
  const state = { disk, editor: lf(disk), writes: [] as string[], reads: 0, pending: undefined as 'beforeProcess' | 'afterProcess' | undefined };
  const land = () => {
    state.disk = state.editor;
    state.writes.push('late save');
  };
  const view = new MarkdownView();
  view.file = new TFile(README);
  view.editor = {
    getValue: () => state.editor,
    offsetToPos: (offset: number) => offset,
    replaceRange: (text: string, from: number, to: number) => {
      state.editor = lf(state.editor.slice(0, from) + text + state.editor.slice(to));
    },
  };
  view.save = async () => {
    if (save === 'extra') state.editor += 'X\n';
    if (save === 'typed') state.editor += 'typed';
    if (save === 'lateBeforeProcess') state.pending = 'beforeProcess';
    else if (save === 'lateAfterProcess') state.pending = 'afterProcess';
    else {
      state.disk = state.editor;
      state.writes.push('save');
    }
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: () => new TFile(README),
      read: async () => {
        state.reads++;
        // Lands right after the plugin looked at the file again, before it writes.
        if (state.pending === 'beforeProcess' && state.reads === 2) {
          state.pending = undefined;
          const seen = state.disk;
          land();
          return seen;
        }
        return state.disk;
      },
      process: async (_file: TFile, fn: (data: string) => string) => {
        const next = fn(state.disk);
        if (next !== state.disk) state.writes.push('process');
        state.disk = next;
        if (state.pending === 'afterProcess') {
          state.pending = undefined;
          land();
        }
        return next;
      },
    },
  } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => state.disk, write: async () => {} }, notify: () => {}, t: (s: string) => s } as unknown as LabnoteHost;
  return { app, host, state };
}

const saves: Save[] = ['normal', 'extra', 'typed', 'lateBeforeProcess', 'lateAfterProcess'];
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('a change to an open CRLF note reaches the file once, however its save goes', () => {
  it.each(saves)('a new workflow entry (save: %s)', async save => {
    const { app, host, state } = setup(readme('\r\n'), save);
    expect(await registerWorkflowInReadme(app, host, README, { title: 'WD020 New', fileName: '002_WD020_New.labnote.md' })).toBe('registered');
    expect(count(state.disk, /WD020 New/g)).toBe(1);
  });

  // A change that is not the same when made twice: made twice, the date would get two marks.
  it.each(saves)('a change made once (save: %s)', async save => {
    const { app, host, state } = setup(readme('\r\n'), save);
    expect(await processNoteThroughVault(app, host, README, c => c.replace(/last_updated_date: .*/, m => `${m}Z`))).toBe(true);
    expect(count(state.disk, /Z/g)).toBe(1);
  });

  it.each([
    ['CRLF', readme('\r\n')],
    ['mixed', readme('\r\n').replace('# Test\r\n', '# Test\n')],
    ['a lone CR', readme('\r')],
  ])('a note written whole with a lone CR in it is written once (file: %s)', async (_name, disk) => {
    const { app, host, state } = setup(disk, 'normal');
    await writeNoteThroughVault(app, host, README, '# T\rbody\r\n');
    expect(state.disk).toBe('# T\nbody\n');
    expect(state.writes).toEqual(['save']);
  });
});
