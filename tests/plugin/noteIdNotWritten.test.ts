/**
 * Why a note ID was not written, said as it is: a save of the open note still under way past
 * the wait, or a labnote_id written over several lines, which no write replaces.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { NoteIdService } from '../../src/barcode/noteIdService';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

const P = 'labnote/001_Test/001_WD010_A.labnote.md';
const t = (key: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

async function assign(text: string, saving: boolean | 'endsAtLimit') {
  const started = Date.now();
  const files = new Map([[P, text]]);
  const notices: { level: string; msg: string }[] = [];
  const tf = new TFile(P);
  const view: { file: TFile; savePromise: Promise<unknown> | null } = { file: tf, savePromise: saving ? new Promise(() => {}) : null };
  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      getAbstractFileByPath: () => tf,
      getMarkdownFiles: () => [],
      read: async () => {
        // The save ends just as the write gives up waiting for it.
        if (saving === 'endsAtLimit' && Date.now() - started >= OPEN_SAVE_WAIT_MS) view.savePromise = null;
        return files.get(P)!;
      },
      process: async (_f: TFile, fn: (s: string) => string) => {
        files.set(P, fn(files.get(P)!));
        return files.get(P)!;
      },
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true } as unknown as LabnoteHost;
  const id = await new NoteIdService(app, host).ensureId(tf as never, { reassign: true });
  return { id, notices, text: files.get(P)! };
}

describe('a note ID not written', () => {
  it('while a save of the open note does not end in time: that is the warning', async () => {
    const text = '---\ntitle: A\n---\n# A\n';
    const r = await assign(text, true);
    expect(r.id).toBeUndefined();
    expect(r.text).toBe(text);
    expect(r.notices).toEqual([{ level: 'warn', msg: `${P} was still being saved, so its labnote_id was not written. Try again in a moment.` }]);
  }, OPEN_SAVE_WAIT_MS + 10000);

  // Said from what the write met, not from a look afterwards: the save is over by then.
  it('a save that ends right after the wait gave up: still that warning', async () => {
    const text = '---\ntitle: A\n---\n# A\n';
    const r = await assign(text, 'endsAtLimit');
    expect(r.id).toBeUndefined();
    expect(r.text).toBe(text);
    expect(r.notices).toEqual([{ level: 'warn', msg: `${P} was still being saved, so its labnote_id was not written. Try again in a moment.` }]);
  }, OPEN_SAVE_WAIT_MS + 10000);

  it('a labnote_id over several lines, no save under way: the warning to write it on one line', async () => {
    const text = '---\ntitle: A\nlabnote_id:\n  LN-7K3M9QX2\n---\n# A\n';
    const r = await assign(text, false);
    expect(r.id).toBeUndefined();
    expect(r.text).toBe(text);
    expect(r.notices.map(n => n.msg)).toEqual([
      `The labnote_id of ${P} could not be written, so its value was left as it is: write it on one line (labnote_id: LN-…) and try again.`,
    ]);
  });
});
