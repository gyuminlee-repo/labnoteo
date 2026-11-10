/**
 * A tool writing a whole note that is open with typing not saved yet: the typing stays wherever
 * it does not touch what the tool changed, above it, below it or both, and with the
 * last_updated_date stamp on, which is put on the note as written, not on the tool's content.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import { createLabnoteTools, MemFileSystem, type LabnoteHost } from '@labnoteo/core';
import { writeNoteStamped } from '../../src/lastUpdatedStamp';
import { overUnsaved } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const NOTE = ['---', 'title: T', 'last_updated_date: 2026-11-01', '---', '## A', 'body a', '', '## B', 'body b', '', '## C', 'body c', ''].join('\n');
const stamp = (c: string) => c.replace(/last_updated_date: .*/, 'last_updated_date: 2026-11-10');

async function write(type: (text: string) => string, stamped: boolean) {
  const disk = { text: NOTE };
  const tf = new TFile(P);
  const view = new MarkdownView();
  let text = type(NOTE);
  view.file = tf;
  view.lastSavedData = NOTE;
  view.editor = {
    getValue: () => text,
    offsetToPos: (o: number) => o,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
    },
  };
  view.getViewData = () => text;
  view.writeData = async (_f: TFile, t: string) => {
    disk.text = t;
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getFileByPath: () => tf,
      read: async () => disk.text,
      process: async (_f: TFile, fn: (s: string) => string) => (disk.text = fn(disk.text)),
    },
  } as unknown as App;
  const host = { fs: { exists: async () => true, read: async () => disk.text, write: async () => {} } } as unknown as LabnoteHost;
  // As the update_section tool: the note read, one section rewritten, the whole note written.
  await writeNoteStamped(app, host, P, NOTE.replace('body b', 'NEW B'), stamped ? stamp : c => c, NOTE);
  return disk.text;
}

describe('a whole note written by a tool over typing not saved yet', () => {
  it.each([
    ['above, stamp on', (t: string) => t.replace('body a', 'body a typed'), true, ['body a typed']],
    ['above, stamp off', (t: string) => t.replace('body a', 'body a typed'), false, ['body a typed']],
    ['below, stamp on', (t: string) => t.replace('body c', 'body c typed'), true, ['body c typed']],
    ['above and below, stamp off', (t: string) => t.replace('body a', 'body a typed').replace('body c', 'body c typed'), false, ['body a typed', 'body c typed']],
    ['above and below, stamp on', (t: string) => t.replace('body a', 'body a typed').replace('body c', 'body c typed'), true, ['body a typed', 'body c typed']],
  ] as const)('typing %s: kept, with the change', async (_name, type, stamped, kept) => {
    const file = await write(type, stamped);
    for (const k of kept) expect(file).toContain(k);
    expect(file).toContain('NEW B');
    expect(file.includes('2026-11-10')).toBe(stamped);
  });
});

describe('overUnsaved, pieces of typing apart', () => {
  const base = 'a\nb\nc\nd\ne\n';
  it('keeps typing on both sides of a change', () => {
    expect(overUnsaved('a1\nb\nc\nd\ne1\n', base, 'a\nb\nC\nd\ne\n')).toBe('a1\nb\nC\nd\ne1\n');
  });
  it('keeps typing apart from changes on both sides of it', () => {
    expect(overUnsaved('a\nb\nc1\nd\ne\n', base, 'A\nb\nc\nd\nE\n')).toBe('A\nb\nc1\nd\nE\n');
  });
  it('keeps typing at the end of the note, a change at its start', () => {
    expect(overUnsaved('a\nb\nc\nd\nend typed\n', 'a\nb\nc\nd\nend\n', 'A\nb\nc\nd\nend\n')).toBe('A\nb\nc\nd\nend typed\n');
  });
  it('keeps typing on the line a change is on, apart from it', () => {
    expect(overUnsaved('title: T typed, date: 01\n', 'title: T, date: 01\n', 'title: T, date: 10\n')).toBe('title: T typed, date: 10\n');
  });
  // Letters typed close together in one word are one piece of typing, put by the context around
  // the word; taken letter by letter, each had too little context and went to the wrong copy.
  it('keeps typing close together in a word as one piece, by the context of the word', () => {
    const base = 'x\nx\n- [ ] item\n- [ ] item\ntext a b\n';
    const content = 'x\nx\ntext a\n## Notes\nResult: ok\n- [ ] item\n- [ ] item\ntext a b\n';
    expect(overUnsaved('x\nx\n- [ ] i\ntem\n- [ ] item\nt\n\next a b\n', base, content)).toBe(
      'x\nx\ntext a\n## Notes\nResult: ok\n- [ ] i\ntem\n- [ ] item\nt\n\next a b\n'
    );
  });
  // Text replaced on a line is one piece, not an insertion here and a deletion of the same text
  // further on: split, the deletion went with the far copy and the change landed inside it.
  it('keeps a replacement on one line as one piece', () => {
    const base = '\n### [UHW010 Op]\n\n### [UHW010 Op]\n';
    const content = '\n### [UHW010 Op]\n\nx\nNEW 1\n### [UHW010 Op]\n';
    expect(overUnsaved('\n### [UHW01p]\n\n### [UHW010 \n\nOp]\n', base, content)).toBe(
      '\n### [UHW01p]\n\nx\nNEW 1\n### [UHW010 \n\nOp]\n'
    );
  });
});

// update_section appending to Notes while the user types at the end of Notes: the note as saved
// ends partway through a word, the editor has typed on past it. The typing goes on from where it
// was, the appended text after it; the tool's own layout (a blank line under the heading) stays.
describe('a section appended to where the user is typing', () => {
  const head = '---\nstatus: ongoing\nlast_updated_date: 2026-11-01\n---\n# 841_UpdIn_LF\n\n## Plan\nPlan v0.\n\n## Notes\nKeep notes.\n\n';
  const saved = head + 'k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 k10 k11 k12 k';
  const typed = head + 'k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 k10 k11 k12 k13 k14 k15 ';
  const P2 = 'labnote/841_UpdIn_LF/README.labnote.md';

  async function appendNotes(): Promise<{ content: string; base?: string }> {
    const fs = new MemFileSystem();
    await fs.write(P2, saved);
    let got: { content: string; base?: string } | undefined;
    const ctx = { fs, workspaceRoot: '.', globalSampleFolder: 'resources/labsamples',
      writeNote: async (_p: string, content: string, base?: string) => void (got = { content, base }) };
    const t = createLabnoteTools().find(x => x.name === 'update_section')!;
    const res = await t.handler(ctx, { documentPath: P2, heading: 'Notes', content: 'Appended by tool.', mode: 'append' });
    expect(res.ok).toBe(true);
    return got!;
  }

  it('keeps the typed word whole and puts the appended text after the typing', async () => {
    const { content, base } = await appendNotes();
    expect(base).toBe(saved);
    // The blank line under "## Notes" is the tool's: its content has it with no typing at all.
    expect(content).toContain('## Notes\n\nKeep notes.\n');
    expect(overUnsaved(typed, saved, content)).toBe(
      content.replace('k12 k\n\nAppended by tool.\n', 'k12 k13 k14 k15 \n\nAppended by tool.\n')
    );
  });
});
