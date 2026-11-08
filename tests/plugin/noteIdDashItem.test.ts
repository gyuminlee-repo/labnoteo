// R1: a `- ` line at column 0 continues `labnote_id` only under an empty first value (a block
// sequence, L2). Under a key with a value it is a YAML error, not more of the value: the ID
// reads, prints and takes its scans along as B7 did.
// E1: the L2 warning for a scan move is given only when there are scans to look through.
import { describe, it, expect } from 'vitest';
import type { App, TFile as ObsidianTFile } from 'obsidian';
import { TFile, TFolder } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { NoteIdService } from '../../src/barcode/noteIdService';
import { BarcodeFeature } from '../../src/barcode/barcodeFeature';

const ID = 'LN-7K3M9QX2';
const SCAN = `${ID}_u1_p1_20261015.jpg`;
const FROM = 'labnote/001_A';
const TO = 'labnote/002_B';

function setup(path: string, text: string, scanDirs: string[] = []) {
  const files = new Map([[path, text]]);
  const folders = new Map<string, TFolder>();
  for (const dir of scanDirs) {
    folders.set(dir, Object.assign(new TFolder(), { path: dir, name: 'scans', children: [new TFile(`${dir}/${SCAN}`)] }));
  }
  const notices: { level: string; msg: string }[] = [];
  const moved: string[] = [];
  const fileOf = (p: string) => Object.assign(new TFile(p), { stat: { ctime: 1 } }) as unknown as ObsidianTFile;
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.keys()].map(fileOf),
      getAbstractFileByPath: (p: string) =>
        files.has(p)
          ? fileOf(p)
          : (folders.get(p) ?? [...folders.values()].flatMap(d => d.children).find(c => c.path === p) ?? null),
      read: async (f: TFile) => files.get(f.path)!,
      process: async (f: TFile, fn: (s: string) => string) => {
        files.set(f.path, fn(files.get(f.path)!));
      },
      createFolder: async (p: string) => {
        folders.set(p, Object.assign(new TFolder(), { path: p, name: 'scans', children: [] }));
      },
    },
    fileManager: {
      renameFile: async (f: TFile, to: string) => {
        moved.push(to);
      },
    },
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(files.get(f.path)!) } }) },
  } as unknown as App;
  const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
  const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true, pick: async () => 'new' } as unknown as LabnoteHost;
  const noteIds = new NoteIdService(app, host);
  const f = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
  Object.assign(f, { plugin: { app, host, t }, noteIds });
  return { f, noteIds, files, notices, moved, file: fileOf(path) };
}

const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
/** The front matter with `key` (the `labnote_id` line) and `next` (the line below it). */
const note = (nl: string, key: string, next: string) => ['---', 'title: T', key, next, '---', 'body', ''].join(nl);

describe('R1: a "- " line under a labnote_id with a value, as B7 read it', () => {
  it.each(endings)('readNoteId reads the one-line ID (%s)', (_n, nl) => {
    expect(readNoteId(note(nl, `labnote_id: ${ID}`, '- a'))).toBe(ID);
  });

  it.each(endings)('ensureIdResult gives that ID and writes nothing (%s)', async (_n, nl) => {
    const text = note(nl, `labnote_id: ${ID}`, '- a');
    const { noteIds, files, notices, file } = setup(`${TO}/a.labnote.md`, text);
    expect(await noteIds.ensureIdResult(file)).toEqual({ id: ID });
    expect(files.get(`${TO}/a.labnote.md`)).toBe(text);
    expect(notices).toEqual([]);
  });

  it.each(endings)('moveScansWithNote takes its scan along, without a warning (%s)', async (_n, nl) => {
    const { f, notices, moved } = setup(`${TO}/a.labnote.md`, note(nl, `labnote_id: ${ID}`, '- a'), [`${FROM}/images/scans`]);
    expect(await f.moveScansWithNote(`${TO}/a.labnote.md`, FROM, TO)).toBeUndefined();
    expect(moved).toEqual([`${TO}/images/scans/${SCAN}`]);
    expect(notices.filter(n => n.level === 'warn')).toEqual([]);
  });
});

describe('R1: a "- " line under an empty labnote_id stays a value over several lines (L2)', () => {
  const keys = ['labnote_id:', 'labnote_id: # the barcode'];
  const cases = keys.flatMap(key => endings.map(([n, nl]) => [n, JSON.stringify(key), nl, key] as const));

  it.each(cases)('readNoteId reads no ID (%s, %s)', (_n, _k, nl, key) => {
    expect(readNoteId(note(nl, key, `- ${ID}`))).toBeUndefined();
  });

  it.each(cases)('ensureIdResult is unreadable and says so (%s, %s)', async (_n, _k, nl, key) => {
    const text = note(nl, key, `- ${ID}`);
    const { noteIds, files, notices, file } = setup(`${TO}/a.labnote.md`, text);
    expect(await noteIds.ensureIdResult(file)).toEqual({ reason: 'unreadable' });
    expect(files.get(`${TO}/a.labnote.md`)).toBe(text);
    expect(notices.some(n => n.level === 'warn' && n.msg.includes('could not be written'))).toBe(true);
  });

  it.each(cases)('moveScansWithNote refuses with the warning when there are scans (%s, %s)', async (_n, _k, nl, key) => {
    const { f, notices, moved } = setup(`${TO}/a.labnote.md`, note(nl, key, `- ${ID}`), [`${FROM}/images/scans`]);
    expect(await f.moveScansWithNote(`${TO}/a.labnote.md`, FROM, TO)).toBe('refused');
    expect(moved).toEqual([]);
    expect(notices).toEqual([{ level: 'warn', msg: expect.stringContaining('could not be written') }]);
  });
});

describe('E1: no L2 warning for a move with no scans to look through', () => {
  const unwritable = (nl: string) => note(nl, `labnote_id: ${ID}`, '  continued');

  it.each(endings)('a move to a subfolder of the same experiment (%s)', async (_n, nl) => {
    const { f, notices, moved } = setup(`${FROM}/sub/a.labnote.md`, unwritable(nl), [`${FROM}/images/scans`]);
    expect(await f.moveScansWithNote(`${FROM}/sub/a.labnote.md`, FROM, `${FROM}/sub`)).toBeUndefined();
    expect(moved).toEqual([]);
    expect(notices).toEqual([]);
  });

  it.each(endings)('a move from an experiment without a scans folder (%s)', async (_n, nl) => {
    const { f, notices, moved } = setup(`${TO}/a.labnote.md`, unwritable(nl));
    expect(await f.moveScansWithNote(`${TO}/a.labnote.md`, FROM, TO)).toBeUndefined();
    expect(moved).toEqual([]);
    expect(notices).toEqual([]);
  });
});
