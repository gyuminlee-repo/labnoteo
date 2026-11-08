/**
 * A note copied in Obsidian, then both notes' barcodes, Assign note ID on the copy and the
 * copy moved to another experiment, for the six labnote_id values written over several lines
 * (LF and CRLF) and a one-line original whose copy has a line below its ID. The copy never keeps
 * the original's ID and never takes the original's scans along: it gets an ID of its own, or
 * (a value that writing would break) it is left as it is with the L2 warning.
 */
import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from '../stubs/obsidian';
import { parseFrontMatterYaml } from '../../packages/labnoteo-core/src/sections/frontMatter';
import { BarcodeFeature } from '../../src/barcode/barcodeFeature';
import { NoteIdService } from '../../src/barcode/noteIdService';

const ID = 'labnote_id: LN-7K3M9QX2';
const shapes: Record<string, string[]> = {
  plainCont: [ID, '  more'],
  literal: ['labnote_id: |', '  LN-7K3M9QX2'],
  quotedCont: ['labnote_id: "LN-7K3M9QX2', '  more"'],
  emptyThenTwo: ['labnote_id:', '  LN-7K3M9QX2', '  more'],
  folded: ['labnote_id: >-', '  LN-7K3M9QX2'],
  emptyThenId: ['labnote_id:', '  LN-7K3M9QX2'],
};
// [name, the original's labnote_id lines, the copy's]
const cases: [string, string[], string[]][] = [
  ...Object.entries(shapes).map(([k, v]) => [k, v, v] as [string, string[], string[]]),
  ['one-line original, plainCont copy', [ID], shapes.plainCont],
];
// Values that YAML reads as an ID: the copy shares it, so it is refused with the warning.
const REFUSED = new Set(['folded', 'emptyThenId']);
// Values that writing would break, which YAML reads as no ID: the copy is handled as one without.
const LEFT = new Set(['literal', 'quotedCont', 'emptyThenTwo']);

const O = 'labnote/001_A/001_WD010_O.labnote.md';
const C = 'labnote/001_A/002_WD010_C.labnote.md';
const C2 = 'labnote/002_B/002_WD010_C.labnote.md';
const SCANS = 'labnote/001_A/images/scans';
const IMG = `${SCANS}/LN-7K3M9QX2_u1_p1_2026-01-01.jpg`;

async function run(original: string, copy: string) {
  const files = new Map<string, string>([[O, original], [C, copy]]);
  const img = new TFile(IMG);
  const scans = Object.assign(new TFolder(), { path: SCANS, name: 'scans', children: [img] });
  const renames: string[] = [];
  const notices: string[] = [];
  let asked = 0;
  const app = {
    vault: {
      read: async (f: TFile) => files.get(f.path)!,
      process: async (f: TFile, fn: (s: string) => string) => { files.set(f.path, fn(files.get(f.path)!)); },
      getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : p === SCANS ? scans : p === IMG ? img : null),
      getMarkdownFiles: () => [...files.keys()].map(p => new TFile(p)),
      createFolder: async () => {},
    },
    fileManager: { renameFile: async (f: TFile, to: string) => { renames.push(`${f.path}->${to}`); } },
    // As Obsidian reads the front matter.
    metadataCache: {
      getFileCache: (f: TFile) => {
        const text = files.get(f.path);
        if (text === undefined) return null;
        const read = parseFrontMatterYaml(text.replace(/\r\n/g, '\n'));
        return read.parseError ? null : { frontmatter: read.frontMatter };
      },
    },
  };
  const t = (s: string, ...a: unknown[]) => a.reduce<string>((o, x, i) => o.replace(`{${i}}`, String(x)), s);
  const host = {
    notify: (level: string, msg: string) => notices.push(`${level}:${msg.slice(0, 50)}`),
    t,
    confirm: async () => { asked++; return true; },
    pick: async () => { asked++; return 'new'; },
    fs: { exists: async () => false },
  };
  const feat = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
  Object.assign(feat, { plugin: { app, host, t }, noteIds: new NoteIdService(app as never, host as never) });
  const step = <T>(value: T) => ({ value, notices: notices.splice(0), asked: [asked, (asked = 0)][0] });
  const copied = step((await feat.reassignCopiedId(new TFile(C) as never)) ?? null);
  const copyAfter = files.get(C)!;
  const barcodes = step([await feat.noteIds.ensureId(new TFile(O) as never), await feat.noteIds.ensureId(new TFile(C) as never)]);
  const assigned = step((await (feat as unknown as { assignId(f: TFile): Promise<void> }).assignId(new TFile(C))) ?? null);
  files.set(C2, files.get(C)!);
  files.delete(C);
  const moved = step((await feat.moveScansWithNote(C2, 'labnote/001_A', 'labnote/002_B')) ?? null);
  return { copied, copyChanged: copyAfter !== copy, barcodes, assigned, moved, renames: renames.length };
}

const cells = cases.flatMap(([name, o, c]) =>
  [['LF', '\n'], ['CRLF', '\r\n']].map(([n, nl]) => {
    const note = (id: string[]) => ['---', 'title: x', ...id, '---', 'body', ''].join(nl);
    return [name, n, note(o), note(c)] as const;
  })
);

describe('a copied note, its barcode, Assign note ID and a move, for a labnote_id over several lines', () => {
  it.each(cells)('%s (%s)', async (name, _n, original, copy) => {
    const r = await run(original, copy);
    // The original's scan never goes along with the copy.
    expect(r.renames).toBe(0);
    const [idO, idC] = r.barcodes.value;
    if (REFUSED.has(name) || LEFT.has(name)) {
      expect(r.copied.value).toBe(REFUSED.has(name) ? 'refused' : 'none');
      expect(r.copied.notices.filter(x => x.startsWith('warn:'))).toHaveLength(REFUSED.has(name) ? 1 : 0);
      expect(r.copyChanged).toBe(false);
      expect([idO, idC]).toEqual([undefined, undefined]);
      expect(r.barcodes.notices.filter(x => x.startsWith('warn:'))).toHaveLength(2);
    } else {
      // A new ID on the copy's key line, as 0.140.2 gives it: the two barcodes differ.
      expect(r.copied.value).toBe('renewed');
      expect(r.copyChanged).toBe(true);
      expect(idO).toBe('LN-7K3M9QX2');
      expect(idC).toMatch(/^LN-[0-9A-Z]{8}$/);
      expect(idC).not.toBe(idO);
    }
  });
  // Assign note ID on the copy alone, while the original still shares the ID: asked once,
  // then a new ID on the copy's key line, as 0.140.2 does.
  it.each([['LF', '\n'], ['CRLF', '\r\n']])('Assign note ID on a plainCont copy sharing the ID (%s)', async (_n, nl) => {
    const note = (id: string[]) => ['---', 'title: x', ...id, '---', 'body', ''].join(nl);
    const files = new Map<string, string>([[O, note([ID])], [C, note(shapes.plainCont)]]);
    const notices: string[] = [];
    let asked = 0;
    const app = {
      vault: {
        read: async (f: TFile) => files.get(f.path)!,
        process: async (f: TFile, fn: (s: string) => string) => { files.set(f.path, fn(files.get(f.path)!)); },
        getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
        getMarkdownFiles: () => [...files.keys()].map(p => new TFile(p)),
      },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: parseFrontMatterYaml(files.get(f.path)!.replace(/\r\n/g, '\n')).frontMatter }) },
    };
    const t = (s: string, ...a: unknown[]) => a.reduce<string>((o, x, i) => o.replace(`{${i}}`, String(x)), s);
    const host = { notify: (level: string, msg: string) => notices.push(`${level}:${msg.slice(0, 50)}`), t, confirm: async () => { asked++; return true; }, pick: async () => { asked++; return 'new'; } };
    const feat = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(feat, { plugin: { app, host, t }, noteIds: new NoteIdService(app as never, host as never) });
    await (feat as unknown as { assignId(f: TFile): Promise<void> }).assignId(new TFile(C));
    const lines = files.get(C)!.split(nl);
    expect(asked).toBe(1);
    expect(lines[2]).toMatch(/^labnote_id: LN-(?!7K3M9QX2)[0-9A-Z]{8}$/);
    expect(lines[3]).toBe('  more');
    expect(notices.map(x => x.slice(0, 5))).toEqual(['info:']);
  });
});
