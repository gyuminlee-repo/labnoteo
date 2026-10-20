import { describe, it, expect, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { zipSync, strToU8 } from 'fflate';
import { TFile, TFolder } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { formatMessage } from '../../packages/labnoteo-core/src/i18n/translator';
import { createWorkflowContent } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../../packages/labnoteo-core/src/lib/unitOpTemplate';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '../../packages/labnoteo-core/src/sections/workflowSectionParser';
import { listFiledScans } from '../../packages/labnoteo-core/src/sections/scanInsert';
import type { PagePayload, ScanPayload } from '../../packages/labnoteo-core/src/lib/scanPayload';
import { NoteIdService } from '../../src/barcode/noteIdService';
import {
  ScanPipeline,
  embedLinkPath,
  unzipScans,
  type DecodedPage,
  type PageDecoder,
  type ScanInput,
} from '../../src/scan/scanPipeline';

const EXP = 'labnote/001_Assay';
const NOTE = `${EXP}/001_WD010_Design.labnote.md`;
const ID = 'LN-7K3M9QX2';

function buildNote(noteId: string, ops: string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, { noteId });
  for (const opId of ops) {
    const block = buildHwUnitOpMarkdown(
      { opId, opName: `Op ${opId}`, opDescription: 'step' },
      { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

/** An in-memory vault with just the surface the pipeline and NoteIdService use. */
function fakeVault(notes: Record<string, string>) {
  const text = new Map(Object.entries(notes));
  const binary = new Map<string, ArrayBuffer>();
  const folders = new Set<string>();
  const writes: string[] = [];
  const trashed: string[] = [];
  const exists = (p: string) => text.has(p) || binary.has(p) || folders.has(p);
  const fileAt = (p: string) => (text.has(p) || binary.has(p) ? new TFile(p) : null);
  const app = {
    vault: {
      getMarkdownFiles: () => [...text.keys()].filter(p => p.endsWith('.md')).map(p => new TFile(p)),
      getFileByPath: fileAt,
      getAbstractFileByPath: (p: string) => fileAt(p) ?? (folders.has(p) ? new TFolder() : null),
      createFolder: async (p: string) => {
        if (exists(p)) throw new Error('exists');
        folders.add(p);
      },
      createBinary: async (p: string, bytes: ArrayBuffer) => {
        if (exists(p)) throw new Error('exists');
        binary.set(p, bytes);
        return new TFile(p);
      },
      read: async (f: TFile) => text.get(f.path) ?? '',
      readBinary: async (f: TFile) => binary.get(f.path)!,
      process: async (f: TFile, fn: (data: string) => string) => {
        const next = fn(text.get(f.path) ?? '');
        text.set(f.path, next);
        writes.push(f.path);
        return next;
      },
    },
    metadataCache: {
      getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(text.get(f.path) ?? '') } }),
    },
    fileManager: {
      generateMarkdownLink: (f: TFile) => `[[${f.path}]]`,
      trashFile: async (f: TFile) => {
        trashed.push(f.path);
        binary.delete(f.path);
        text.delete(f.path);
      },
    },
  } as unknown as App;
  const host = {
    fs: { read: async (p: string) => text.get(p) ?? '', write: async (p: string, s: string) => void text.set(p, s) },
    notify: () => undefined,
    t: (s: string) => s,
  } as unknown as LabnoteHost;
  return { app, host, text, binary, writes, trashed };
}

const page = (p: ScanPayload | undefined, hash: string, extra: Partial<DecodedPage> = {}): DecodedPage => ({
  source: 'IMG.jpg',
  hash,
  blank: false,
  payload: p,
  render: async () => new Uint8Array([1, 2, 3]).buffer,
  ...extra,
});

const pagePayload = (over: Partial<PagePayload> = {}): PagePayload => ({
  noteId: ID,
  unitOpIndex: 2,
  opId: 'UHW020',
  page: 1,
  pageCount: 2,
  printedOn: '2026-10-15',
  ...over,
});

/** Each input name maps to the pages it decodes to. */
function decoderFor(pages: Record<string, DecodedPage[] | Error>): PageDecoder {
  return {
    async expand(input, onPage) {
      const out = pages[input.name];
      if (out instanceof Error) throw out;
      for (const p of out ?? []) await onPage({ ...p, source: input.name });
      return [];
    },
  };
}

const input = (name: string): ScanInput => ({ name, bytes: new ArrayBuffer(0) });

function setup(notes: Record<string, string>, pages: Record<string, DecodedPage[] | Error>) {
  const v = fakeVault(notes);
  const edits: string[] = [];
  const pipeline = new ScanPipeline({
    app: v.app,
    host: v.host,
    t: (key, ...args) => formatMessage(key, args),
    noteIds: new NoteIdService(v.app, v.host),
    decoder: decoderFor(pages),
    markUserEdit: path => edits.push(path),
  });
  return { ...v, pipeline, edits };
}

describe('ScanPipeline.run', () => {
  let note: string;
  beforeEach(() => {
    note = buildNote(ID, ['UHW010', 'UHW020']);
  });

  it('files pages into their unit operation, writing and dating the note once', async () => {
    const s = setup(
      { [NOTE]: note },
      {
        'a.jpg': [page(pagePayload({ page: 2 }), 'bbbbbbbbbbbb')],
        'b.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa')],
      }
    );
    const results = await s.pipeline.run([input('a.jpg'), input('b.jpg')]);
    expect(results.map(r => [r.input, r.status])).toEqual([
      ['a.jpg', 'filed'],
      ['b.jpg', 'filed'],
    ]);
    expect(results[0].imagePath).toMatch(new RegExp(`^${EXP}/images/scans/${ID}_u2_p2_\\d{8}\\.jpg$`));
    expect(s.binary.has(results[0].imagePath!)).toBe(true);
    expect(s.writes).toEqual([NOTE]);
    expect(s.edits).toEqual([NOTE]);
    const filed = listFiledScans(s.text.get(NOTE)!);
    expect(filed.map(f => [f.unitOpIndex, f.page, f.hash])).toEqual([
      [2, 1, 'aaaaaaaaaaaa'],
      [2, 2, 'bbbbbbbbbbbb'],
    ]);
    expect(filed[0].embed).toBe(`![[${results[1].imagePath}]]`);
  });

  it('counts blank, unreadable and unknown pages without touching any note', async () => {
    const s = setup(
      { [NOTE]: note },
      {
        'blank.jpg': [page(undefined, '111111111111', { blank: true })],
        'noqr.jpg': [page(undefined, '222222222222')],
        'other.jpg': [page(pagePayload({ noteId: 'LN-ZZZZZZZZ' }), '333333333333')],
        'noteonly.jpg': [page({ noteId: ID }, '444444444444')],
        'gone.jpg': [page(pagePayload({ unitOpIndex: 5, opId: 'UHW999' }), '555555555555')],
        'broken.pdf': new Error('bad pdf'),
      }
    );
    const results = await s.pipeline.run(
      ['blank.jpg', 'noqr.jpg', 'other.jpg', 'noteonly.jpg', 'gone.jpg', 'broken.pdf'].map(input)
    );
    expect(results.map(r => [r.input, r.status, r.reason ?? r.message])).toEqual([
      ['blank.jpg', 'blank', undefined],
      ['noqr.jpg', 'unmatched', 'no-qr'],
      ['other.jpg', 'unmatched', 'note-not-found'],
      ['noteonly.jpg', 'unmatched', 'note-only'],
      ['gone.jpg', 'unmatched', 'no-unit-op'],
      ['broken.pdf', 'error', 'bad pdf'],
    ]);
    for (const r of results.filter(r => r.status === 'unmatched')) {
      expect(r.unmatchedPath).toMatch(/^_labnote-scans\/unmatched\//);
      expect(s.binary.has(r.unmatchedPath!)).toBe(true);
    }
    expect(results.find(r => r.input === 'other.jpg')!.unmatchedPath).toContain('_LN-ZZZZZZZZ_');
    expect(s.writes).toEqual([]);
    expect(s.edits).toEqual([]);
  });

  it('passes over pages without a QR in a shared folder', async () => {
    const s = setup({ [NOTE]: note }, { 'cat.jpg': [page(undefined, '222222222222')] });
    const results = await s.pipeline.run([input('cat.jpg')], { skipNoQr: true });
    expect(results.map(r => r.status)).toEqual(['skipped']);
    expect(s.binary.size).toBe(0);
  });

  it('sends a page to the queue when two notes carry its ID', async () => {
    const s = setup(
      { [NOTE]: note, [`${EXP}/002_WD010_Copy.labnote.md`]: note },
      { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] }
    );
    const results = await s.pipeline.run([input('a.jpg')]);
    expect(results.map(r => [r.status, r.reason])).toEqual([['unmatched', 'duplicate-id']]);
  });

  it('skips the same photo arriving twice, in one batch or in a later one', async () => {
    const same = page(pagePayload(), 'aaaaaaaaaaaa');
    const s = setup({ [NOTE]: note }, { 'a.jpg': [same], 'a-copy.jpg': [same] });
    const first = await s.pipeline.run([input('a.jpg'), input('a-copy.jpg')]);
    expect(first.map(r => r.status)).toEqual(['filed', 'duplicate']);
    const again = await s.pipeline.run([input('a-copy.jpg')]);
    expect(again.map(r => r.status)).toEqual(['duplicate']);
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(1);
  });

  it('keeps an earlier scan of the same page and offers to remove it', async () => {
    const s = setup(
      { [NOTE]: note },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] }
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.previous).toEqual([{ hash: 'aaaaaaaaaaaa', embed: `![[${old.imagePath}]]` }]);
    expect(listFiledScans(s.text.get(NOTE)!)).toHaveLength(2);
  });

  it('undoes a filed scan: removes its lines and trashes its image', async () => {
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    s.edits.length = 0;
    expect(await s.pipeline.undo(result)).toBe(true);
    expect(s.text.get(NOTE)).not.toContain('aaaaaaaaaaaa');
    expect(s.trashed).toEqual([result.imagePath]);
    expect(s.edits).toEqual([NOTE]);
  });
});

describe('unzipScans', () => {
  it('takes images and PDFs by file name, skipping folders, dotfiles and other files', () => {
    const zip = zipSync({
      'b/IMG_2.jpg': strToU8('two'),
      'IMG_10.jpg': strToU8('ten'),
      'IMG_1.JPG': strToU8('one'),
      'scan.pdf': strToU8('pdf'),
      'notes.txt': strToU8('x'),
      '__MACOSX/._IMG_1.JPG': strToU8('meta'),
      '.hidden.jpg': strToU8('h'),
    });
    const { files, overLimit } = unzipScans(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
    expect(overLimit).toBe(false);
    expect(files.map(f => f.name)).toEqual(['IMG_1.JPG', 'IMG_2.jpg', 'IMG_10.jpg', 'scan.pdf']);
    expect(new TextDecoder().decode(files[1].bytes)).toBe('two');
  });
});

describe('embedLinkPath', () => {
  it('reads the path of wiki and markdown image embeds', () => {
    expect(embedLinkPath('![[images/scans/a.jpg|300]]')).toBe('images/scans/a.jpg');
    expect(embedLinkPath('![](images/scans/my%20scan.jpg)')).toBe('images/scans/my scan.jpg');
    expect(embedLinkPath('![](<images/scans/a b.jpg>)')).toBe('images/scans/a b.jpg');
    expect(embedLinkPath('plain text')).toBeUndefined();
  });
});
