/**
 * A leaf switches from note A (LF, saved or with text typed) to CRLF note B, and a write to B
 * comes while B is being read. The view follows Obsidian 1.15.0's TextFileView: it takes B's
 * file first, keeps A's text until B is read, and saves only what differs from what it last
 * read or saved. B keeps its own text, and what the write returns is what it returns with no
 * editor open.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { processNoteThroughVault } from '../../src/commands';
import { NoteIdService } from '../../src/barcode/noteIdService';

const PA = 'labnote/001_Test/001_WD010_A.labnote.md';
const PB = 'labnote/001_Test/002_WD020_B.labnote.md';
const A0 = '---\ntitle: A\n---\n# A\n\nA body.\n';
const B0 = ['---', 'title: B', '---', '# B', '', 'B body must stay.', ''].join('\r\n');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function run(op: 'noteId' | 'title', readFirst: boolean, typedInA: boolean) {
  const disk: Record<string, string> = { [PA]: A0, [PB]: B0 };
  const files: Record<string, TFile> = {};
  const tf = (p: string) => (files[p] ??= new TFile(p));
  let hold: Promise<string> | null = null;
  const vault = {
    getFileByPath: (p: string) => (p in disk ? tf(p) : null),
    getAbstractFileByPath: (p: string) => (p in disk ? tf(p) : null),
    getMarkdownFiles: () => [],
    read: async (f: TFile) => {
      await tick();
      return disk[f.path];
    },
    process: async (f: TFile, fn: (data: string) => string) => (disk[f.path] = fn(disk[f.path])),
  };
  let text = '';
  const view = new MarkdownView();
  view.editor = {
    getValue: () => text,
    offsetToPos: (offset: number) => offset,
    replaceRange: (t: string, from: number, to: number) => {
      text = text.slice(0, from) + t + text.slice(to);
    },
  };
  view.getViewData = () => text;
  view.writeData = async (f: TFile, t: string) => {
    await tick();
    disk[f.path] = t;
  };
  // FileView.loadFile and TextFileView.loadFileInternal/setData: the file first, its text after.
  const loadText = view.loadText.bind(view);
  view.loadText = (t: string) => {
    loadText(t);
    text = t.replace(/\r\n?/g, '\n');
  };
  const loadFile = async (f: TFile) => {
    if (view.file) await view.save(true);
    view.file = f;
    view.loadText(await (hold ?? vault.read(f)));
  };
  await loadFile(tf(PA));
  if (typedInA) text += 'typed\n';
  let release!: (t: string) => void;
  hold = new Promise(resolve => (release = resolve));
  const loading = loadFile(tf(PB));
  await tick();
  await tick();
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault, metadataCache: { getFileCache: () => null } } as unknown as App;
  const host = { fs: { exists: async (p: string) => p in disk, read: async (p: string) => disk[p], write: async () => {} }, notify: () => {}, t: (s: string) => s } as unknown as LabnoteHost;
  const snapshot = disk[PB];
  const write =
    op === 'noteId'
      ? new NoteIdService(app, host).ensureId(tf(PB) as never, { reassign: true }).then(id => (id ? 'ID' : 'none'))
      : processNoteThroughVault(app, host, PB, c => c.replace('title: B', 'title: B2'));
  if (readFirst) {
    release(snapshot);
    hold = null;
  }
  const result = await write;
  if (!readFirst) {
    release(disk[PB]);
    hold = null;
  }
  await loading;
  // Leaving B later: Obsidian saves the buffer when it differs from what it read.
  await view.save(true);
  return { result, b: disk[PB] };
}

describe('a write to a CRLF note while its leaf switches to it from another note', () => {
  const cases = (['noteId', 'title'] as const).flatMap(op =>
    [false, true].flatMap(readFirst => [false, true].map(typed => [op, readFirst ? 'B read first' : 'the write first', typed ? 'A with text typed' : 'A saved', readFirst, typed] as const))
  );
  it.each(cases)('%s, %s, %s', async (op, _o, _a, readFirst, typed) => {
    const { result, b } = await run(op, readFirst, typed);
    expect(b).toContain('B body must stay.');
    expect(b).not.toContain('A body.');
    expect(result).toBe(op === 'noteId' ? 'ID' : true);
  });
});
