/**
 * A note re-numbered for sharing an ID, the new ID kept by its open editor alone (its save
 * failed): its file and the metadata cache still say the old ID. When a third note with the old
 * ID joins, the note already re-numbered is no longer in the set and is not given yet another ID,
 * which would cut it off from a worksheet printed with the one it has.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { MarkdownView, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { NoteIdService } from '../../src/barcode/noteIdService';

const note = (id: string) => `---\ntitle: x\nlabnote_id: ${id}\n---\n\nbody\n`;
const OLD = 'LN-AAAAAAAA';
const GIVEN = 'LN-BBBBBBBB';

describe('a duplicate ID set a note re-numbered in its editor alone is still in on disk', () => {
  it('asks only about the notes still carrying it, and leaves the re-numbered one as it is', async () => {
    const files = new Map([
      ['a.labnote.md', { text: note(OLD), ctime: 1 }],
      ['b.labnote.md', { text: note(OLD), ctime: 2 }],
      ['c.labnote.md', { text: note(OLD), ctime: 3 }],
    ]);
    const tfiles = new Map([...files.keys()].map(p => [p, Object.assign(new TFile(p), { stat: { ctime: files.get(p)!.ctime } })]));
    // b is open, its editor holding the ID it was given, which its save could not write.
    let editorText = note(GIVEN);
    const view = new MarkdownView();
    view.file = tfiles.get('b.labnote.md')!;
    view.lastSavedData = note(OLD);
    view.editor = {
      getValue: () => editorText,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        editorText = editorText.slice(0, from) + r + editorText.slice(to);
      },
    };
    view.getViewData = () => editorText;
    view.writeData = async () => {
      throw new Error('disk full');
    };
    const app = {
      workspace: { getLeavesOfType: () => [{ view }] },
      vault: {
        getMarkdownFiles: () => [...tfiles.values()],
        getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
        getFileByPath: (p: string) => tfiles.get(p) ?? null,
        read: async (f: TFile) => files.get(f.path)!.text,
        process: async (f: TFile, fn: (s: string) => string) => (files.get(f.path)!.text = fn(files.get(f.path)!.text)),
      },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(files.get(f.path)!.text) } }) },
    } as unknown as App;
    const asked: string[] = [];
    const host = {
      notify: () => undefined,
      t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.split(`{${i}}`).join(a), s),
      confirm: async (m: string) => (asked.push(m), true),
    } as unknown as LabnoteHost;
    const svc = new NoteIdService(app, host);
    await svc.offerDuplicateFixes();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('a.labnote.md, c.labnote.md');
    expect(readNoteId(editorText)).toBe(GIVEN);
    expect(readNoteId(files.get('b.labnote.md')!.text)).toBe(OLD);
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe(OLD);
    expect(readNoteId(files.get('c.labnote.md')!.text)).not.toBe(OLD);
  });
});
