/**
 * #118: the same unit operation run twice needs a name for each run, and the
 * alias is asked only where the insert will go ahead.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EditTarget, LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import type { App } from 'obsidian';
import { insertUnitOpAndUpdateToc, insertUnitOperationCommand } from '../../src/commands';

const WORKFLOW = [
  '## [WD010 Design]',
  '',
  '## Related Unit Operations',
  '',
  '## Conclusions and Discussion',
  '',
].join('\n');

function makeHost(path: string) {
  let doc = WORKFLOW;
  const notes: string[] = [];
  const target: EditTarget = {
    path,
    getText: async () => doc,
    insertAtCursor: async () => {},
    replaceRange: async (start, end, text) => {
      doc = doc.slice(0, start) + text + doc.slice(end);
    },
  };
  const host = {
    fs: new MemFileSystem(),
    t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s),
    notify: (_kind: string, message: string) => notes.push(message),
    editTarget: () => target,
  } as unknown as LabnoteHost;
  return { host, doc: () => doc, notes };
}

const OP = { opId: 'UHW180', opName: 'Incubation', opType: 'hw' as const };

describe('insertUnitOpAndUpdateToc with an alias prompt', () => {
  it('puts the alias in the heading and the TOC', async () => {
    const { host, doc } = makeHost('labnote/001_E/001_WD010_Design.labnote.md');
    const ask = vi.fn(async () => '1차 37도');

    expect(await insertUnitOpAndUpdateToc(host, OP, ask)).toBe(true);

    expect(ask).toHaveBeenCalledWith(OP);
    expect(doc()).toContain('### [UHW180 Incubation] 1차 37도');
    expect(doc()).toContain('- [UHW180 Incubation | 1차 37도](#uhw180-incubation-1차-37도)');
  });

  it('inserts nothing when the prompt is dismissed', async () => {
    const { host, doc } = makeHost('labnote/001_E/001_WD010_Design.labnote.md');

    expect(await insertUnitOpAndUpdateToc(host, OP, async () => undefined)).toBe(false);

    expect(doc()).toBe(WORKFLOW);
  });

  it('does not ask on a note that is no workflow', async () => {
    const { host, doc, notes } = makeHost('labnote/001_E/README.labnote.md');
    const ask = vi.fn(async () => 'x');

    expect(await insertUnitOpAndUpdateToc(host, OP, ask)).toBe(false);

    expect(ask).not.toHaveBeenCalled();
    expect(doc()).toBe(WORKFLOW);
    expect(notes).toEqual([
      'README.labnote.md is the experiment overview and holds no unit operations. Open one of its workflow notes (###_….labnote.md), or make one with "Create workflow".',
    ]);
  });
});

describe('insertUnitOperationCommand on a note that is no workflow (#201, #166)', () => {
  it.each([
    ['labnote/001_E/README.labnote.md', 'README.labnote.md is the experiment overview'],
    ['labnote/Group/001_E/001_W.labnote.md', '"001_E" is not recognized as an experiment'],
    ['labnote/001_E/notes.md', '"notes.md" is not a workflow note'],
  ])('warns about %s before the picker opens', async (path, message) => {
    const { host, notes } = makeHost(path);
    const pick = vi.fn();
    Object.assign(host, { pick });

    await insertUnitOperationCommand({} as App, host);

    expect(pick).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(message);
  });
});
