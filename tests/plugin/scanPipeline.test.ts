import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { App } from 'obsidian';
import { zipSync, strToU8 } from 'fflate';
import { MarkdownView, TFile, TFolder } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { createTranslator, formatMessage } from '../../packages/labnoteo-core/src/i18n/translator';
import type { Translator } from '../../packages/labnoteo-core/src/i18n/translator';
import obsidianKo from '../../src/l10n.ko';
import { createWorkflowContent } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../../packages/labnoteo-core/src/lib/unitOpTemplate';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { findUnitOpInsertOffset, rebuildUnitOpToc } from '../../packages/labnoteo-core/src/sections/workflowSectionParser';
import { listFiledScans } from '../../packages/labnoteo-core/src/sections/scanInsert';
import { unitOpFingerprint, type PagePayload, type ScanPayload } from '../../packages/labnoteo-core/src/lib/scanPayload';
import { NoteIdService } from '../../src/barcode/noteIdService';
import {
  ScanPipeline,
  embedLinkPath,
  unzipScans,
  type DecodedPage,
  type PageDecoder,
  type ScanInput,
} from '../../src/scan/scanPipeline';
import { isDateInput, listUnmatched } from '../../src/scan/unmatchedModal';
import { undoScanResult } from '../../src/scan/resultModal';
import { OPEN_SAVE_WAIT_MS } from '../../src/openEditorWrite';

// What writing a note answers, forced for a test: else as written.
const forced = vi.hoisted(() => ({ write: undefined as undefined | 'uncertain' }));
vi.mock('../../src/commands', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/commands')>();
  return {
    ...actual,
    processNoteThroughVault: (...args: Parameters<typeof actual.processNoteThroughVault>) =>
      forced.write ?? actual.processNoteThroughVault(...args),
  };
});

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
      getAbstractFileByPath: (p: string) => {
        if (!folders.has(p)) return fileAt(p);
        const children = [...binary.keys()]
          .filter(k => k.slice(0, k.lastIndexOf('/')) === p)
          .map(k => new TFile(k));
        return Object.assign(new TFolder(), { children });
      },
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
      getFirstLinkpathDest: (link: string) => fileAt(link),
      // From the notes as they are now: every page renders the same bytes, so a
      // fixed value would let a linked image pass for a leftover.
      get resolvedLinks() {
        const out: Record<string, Record<string, number>> = {};
        for (const [path, body] of text) {
          out[path] = Object.fromEntries([...body.matchAll(/\[\[([^\]|#]+)/g)].map(m => [m[1].trim(), 1]));
        }
        return out;
      },
    },
    fileManager: {
      generateMarkdownLink: (f: TFile, _source: string, _subpath?: string, alias?: string) =>
        alias ? `[[${f.path}|${alias}]]` : `[[${f.path}]]`,
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

function setup(
  notes: Record<string, string>,
  pages: Record<string, DecodedPage[] | Error>,
  embedWidth = 0,
  t: Translator = (key, ...args) => formatMessage(key, args)
) {
  const v = fakeVault(notes);
  const edits: string[] = [];
  const pipeline = new ScanPipeline({
    app: v.app,
    host: v.host,
    t,
    noteIds: new NoteIdService(v.app, v.host),
    decoder: decoderFor(pages),
    embedWidth: () => embedWidth,
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

  it('keeps a scan queued as unmatched when its saved image cannot be trashed', async () => {
    let rendered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { rendered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const bytes = new Uint8Array([4, 5, 6]).buffer;
    const s = setup({ [NOTE]: note }, {
      'race.jpg': [page(pagePayload({ fingerprint: unitOpFingerprint('Op UHW020', '') }), 'aaaaaaaaaaaa', { render: async () => {
        rendered();
        await paused;
        return bytes;
      } })],
    });
    (s.app.fileManager as unknown as { trashFile: () => Promise<void> }).trashFile = async () => {
      throw new Error('locked');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const running = s.pipeline.run([input('race.jpg')]);
    await started;
    s.text.set(NOTE, buildNote(ID, ['UHW010']));
    resume();
    const [lost] = await running;
    warn.mockRestore();
    expect(lost).toMatchObject({ status: 'unmatched', reason: 'no-unit-op' });
    expect(s.binary.get(lost.unmatchedPath!)).toEqual(bytes);
    expect(lost.imagePath).toBeDefined();
    expect(s.binary.has(lost.imagePath!)).toBe(true);
  });

  it.each(['no-unit-op', 'renamed', 'ambiguous'] as const)('queues a saved image for manual assignment when its block becomes %s during rendering', async reason => {
    let rendered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { rendered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const bytes = new Uint8Array([4, 5, 6]).buffer;
    const s = setup({ [NOTE]: note }, {
      'race.jpg': [page(pagePayload({ fingerprint: unitOpFingerprint('Op UHW020', '') }), 'aaaaaaaaaaaa', { render: async () => {
        rendered();
        await paused;
        return bytes;
      } })],
      'good.jpg': [page(pagePayload({ unitOpIndex: 1, opId: 'UHW010' }), 'bbbbbbbbbbbb')],
    });
    const running = s.pipeline.run([input('race.jpg'), input('good.jpg')]);
    await started;
    const changed = reason === 'no-unit-op'
      ? buildNote(ID, ['UHW010'])
      : reason === 'renamed'
        ? note.replace('### [UHW020 Op UHW020]', '### [UHW020 Op UHW020] changed')
        : buildNote(ID, ['UHW010', 'UHW030', 'UHW020', 'UHW020']);
    s.text.set(NOTE, changed);
    resume();
    const [lost, good] = await running;
    expect(lost).toMatchObject({ status: 'unmatched', reason });
    expect(listFiledScans(s.text.get(NOTE)!).map(f => f.hash)).toEqual(['bbbbbbbbbbbb']);
    expect(good.status).toBe('filed');
    expect(listUnmatched(s.app).map(f => f.path)).toEqual([expect.stringMatching(/^_labnote-scans\/unmatched\//)]);
    expect(s.binary.get(lost.unmatchedPath!)).toEqual(bytes);
    expect([...s.binary.keys()].sort()).toEqual([lost.unmatchedPath!, good.imagePath!].sort());

    const queued = listUnmatched(s.app)[0];
    const assigned = await s.pipeline.fileManually(queued, new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1], 1, { page: 1, pageCount: 1 });
    expect(assigned.status).toBe('filed');
    expect(listUnmatched(s.app)).toEqual([]);
  });

  it('files pages as thumbnails with a full-size link when a width is set', async () => {
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa')] }, 300);
    const results = await s.pipeline.run([input('a.jpg')]);
    expect(results[0].status).toBe('filed');
    const text = s.text.get(NOTE)!;
    expect(listFiledScans(text)[0].embed).toBe(`![[${results[0].imagePath}|300]]`);
    expect(text).toContain(` · [[${results[0].imagePath}|Open full size]]*`);
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
    // #349: the rest of the QR code and the reason stay with the page.
    expect(results.find(r => r.input === 'gone.jpg')!.unmatchedPath).toContain(
      `_${ID}_q5-UHW999-1o2-261015_no-unit-op_h555555555555-jpg_gone.jpg`
    );
    expect(s.writes).toEqual([]);
    expect(s.edits).toEqual([]);
  });

  it('names the block it filed into, and warns when found by fingerprint or printed without one (#304)', async () => {
    const aliases = ['조건 A', '조건 B'];
    const twice = buildNote(ID, ['UHW010', 'UHW010']).replace(/^### \[UHW010 Op UHW010\]$/gm, h => `${h} ${aliases.shift()}`);
    const removedA = twice.replace(/^### \[UHW010 Op UHW010\] 조건 A$[\s\S]*?(?=^### \[UHW010)/m, '');
    const fp = (alias: string) => unitOpFingerprint('Op UHW010', alias);
    const s = setup(
      { [NOTE]: removedA },
      {
        'moved.jpg': [page(pagePayload({ unitOpIndex: 2, opId: 'UHW010', fingerprint: fp('조건 B') }), 'aaaaaaaaaaaa')],
        'gone.jpg': [page(pagePayload({ unitOpIndex: 1, opId: 'UHW010', fingerprint: fp('조건 A') }), 'bbbbbbbbbbbb')],
        'old.jpg': [page(pagePayload({ unitOpIndex: 1, opId: 'UHW010', page: 2 }), 'cccccccccccc')],
      }
    );
    const [moved, gone, old] = await s.pipeline.run(['moved.jpg', 'gone.jpg', 'old.jpg'].map(input));
    expect(moved).toMatchObject({ status: 'filed', block: '[UHW010 Op UHW010] 조건 B', matchedBy: 'fingerprint', legacy: false });
    expect(gone).toMatchObject({ status: 'unmatched', reason: 'renamed' });
    expect(old).toMatchObject({ status: 'filed', matchedBy: 'index', legacy: true });
    expect(listFiledScans(s.text.get(NOTE)!).map(f => [f.unitOpIndex, f.hash])).toEqual([
      [1, 'aaaaaaaaaaaa'],
      [1, 'cccccccccccc'],
    ]);
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

  // #432: an entry whose image was deleted does not make the scan a duplicate.
  it('files a scan again in place of the entry whose image was deleted', async () => {
    const same = page(pagePayload(), 'aaaaaaaaaaaa');
    const s = setup({ [NOTE]: note }, { 'a.jpg': [same] });
    const [first] = await s.pipeline.run([input('a.jpg')]);
    s.binary.delete(first.imagePath!);
    const [again] = await s.pipeline.run([input('a.jpg')]);
    expect(again).toMatchObject({ status: 'filed', replacedMissing: true, previous: [] });
    expect(again.imagePath).toBe(first.imagePath);
    const filed = listFiledScans(s.text.get(NOTE)!);
    expect(filed.map(f => f.hash)).toEqual(['aaaaaaaaaaaa']);
    expect(s.binary.has(again.imagePath!)).toBe(true);
  });

  // #433: a new image must not take the name an earlier entry still links.
  it('keeps the new image when the earlier scan of the page lost its own', async () => {
    const s = setup(
      { [NOTE]: note },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] }
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    s.binary.delete(old.imagePath!);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.imagePath).not.toBe(old.imagePath);
    expect(next.imagePath).toMatch(/_2\.jpg$/);
    expect(await s.pipeline.removePrevious(next)).toEqual({ removed: 1, trashed: 0 });
    expect(s.binary.has(next.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
    expect(listFiledScans(s.text.get(NOTE)!).map(f => f.hash)).toEqual(['bbbbbbbbbbbb']);
  });

  // #483: undoing the entry with Ctrl+Z left the image, and the next import wrote _2.
  describe('an image left behind without its entry', () => {
    const undoEntry = (s: ReturnType<typeof setup>) => s.text.set(NOTE, note);

    it('is used again for the same bytes, without a _2', async () => {
      const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
      const [first] = await s.pipeline.run([input('a.jpg')]);
      undoEntry(s);
      const [again] = await s.pipeline.run([input('a.jpg')]);
      expect(again).toMatchObject({ status: 'filed', imagePath: first.imagePath });
      expect([...s.binary.keys()]).toEqual([first.imagePath]);
      expect(listFiledScans(s.text.get(NOTE)!).map(f => f.embed)).toEqual([`![[${first.imagePath}]]`]);
    });

    it('is left alone for other bytes, or when another note links it', async () => {
      const s = setup(
        { [NOTE]: note },
        {
          'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')],
          'b.jpg': [page(pagePayload(), 'bbbbbbbbbbbb', { render: async () => new Uint8Array([7, 8, 9]).buffer })],
        }
      );
      const [first] = await s.pipeline.run([input('a.jpg')]);
      undoEntry(s);
      const [other] = await s.pipeline.run([input('b.jpg')]);
      expect(other.imagePath).toMatch(/_2\.jpg$/);

      undoEntry(s);
      s.text.set(`${EXP}/notes.md`, `![[${first.imagePath}]]`);
      const [linked] = await s.pipeline.run([input('a.jpg')]);
      expect(linked.imagePath).not.toBe(first.imagePath);
      expect(s.binary.get(first.imagePath!)).toEqual(new Uint8Array([1, 2, 3]).buffer);
    });

    it('is not one written earlier in the same import', async () => {
      const s = setup(
        { [NOTE]: note },
        { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'b.jpg': [page(pagePayload(), 'bbbbbbbbbbbb')] }
      );
      const [a, b] = await s.pipeline.run([input('a.jpg'), input('b.jpg')]);
      expect(b.imagePath).not.toBe(a.imagePath);
      expect(s.binary.size).toBe(2);
    });

    it('is not used for the unmatched queue', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T09:00:00'));
      try {
        const s = setup({ [NOTE]: note }, { 'cat.jpg': [page(undefined, '222222222222')] });
        const [first] = await s.pipeline.run([input('cat.jpg')]);
        const [second] = await s.pipeline.run([input('cat.jpg')]);
        expect(second.unmatchedPath).not.toBe(first.unmatchedPath);
        expect(s.binary.size).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
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

// #234: a page filed by hand has no QR code to tell when it was printed.
describe('ScanPipeline.fileManually', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const file = (p: string) => new TFile(p) as unknown as Parameters<ScanPipeline['fileManually']>[0];

  function manualSetup() {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    return s;
  }

  it('leaves the print date out of the caption when it is not known', async () => {
    const s = manualSetup();
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 1, { page: 1, pageCount: 1 });
    expect(result.status).toBe('filed');
    const text = s.text.get(NOTE)!;
    // #396: the caption names the photo, not the queue's stamped name.
    expect(text).toMatch(/\*Printout 1\/1 · imported \d{4}-\d{2}-\d{2} · photo1\.jpg\*/);
    expect(text).not.toContain('printed');
  });

  // #341: a page filed by hand was always taken for a printout from before 0.123.0.
  it('carries the chosen block, so it is neither an old printout nor moved', async () => {
    const s = manualSetup();
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(result).toMatchObject({ status: 'filed', block: '[UHW020 Op UHW020]', matchedBy: 'index', legacy: false });
  });

  it.each(['before filing', 'during rendering'])('leaves the image in the queue, with no second copy, when the block changes %s', async timing => {
    const s = manualSetup();
    // The block was renamed between choosing and filing.
    const pipeline = s.pipeline as unknown as { filePage: (...args: unknown[]) => Promise<unknown> };
    const filePage = pipeline.filePage.bind(s.pipeline);
    pipeline.filePage = async (...args: unknown[]) => {
      const rename = () => s.text.set(NOTE, s.text.get(NOTE)!.replace('### [UHW020 Op UHW020]', '### [UHW020 Op UHW020] 바뀜'));
      if (timing === 'before filing') rename();
      else {
        const decoded = args[0] as DecodedPage;
        const render = decoded.render;
        decoded.render = async () => {
          rename();
          return render();
        };
      }
      return filePage(...args);
    };
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(result).toMatchObject({ status: 'unmatched', reason: 'renamed', unmatchedPath: QUEUED });
    expect([...s.binary.keys()]).toEqual([QUEUED]);
  });

  // #495: the page filed by hand got the hash of the queue's JPEG, so importing the scan again missed it.
  it('records the hash and the name the scan was imported with, and knows the page when it comes again', async () => {
    // The block was renamed after printing, so the page cannot be placed by its QR code.
    const s = setup(
      { [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) },
      { 'scan_1-1.png': [page(pagePayload({ unitOpIndex: 2, fingerprint: 'ZZZZ' }), '953d461ec519')] }
    );
    const [first] = await s.pipeline.run([input('scan_1-1.png')]);
    expect(first).toMatchObject({ status: 'unmatched', reason: 'renamed' });
    expect(first.unmatchedPath).toContain('_renamed_h953d461ec519-png_scan_1-1.jpg');

    const result = await s.pipeline.fileManually(file(first.unmatchedPath!), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(result).toMatchObject({ status: 'filed', hash: '953d461ec519' });
    expect(s.text.get(NOTE)!).toMatch(/· scan_1-1\.png\*/);

    const again = await s.pipeline.run([input('scan_1-1.png')]);
    expect(again.map(r => r.status)).toEqual(['duplicate']);
  });

  it('trashes the image filing saved when the block changed and the first trash failed', async () => {
    const s = manualSetup();
    const pipeline = s.pipeline as unknown as { filePage: (...args: unknown[]) => Promise<unknown> };
    const filePage = pipeline.filePage.bind(s.pipeline);
    pipeline.filePage = async (...args: unknown[]) => {
      const decoded = args[0] as DecodedPage;
      const render = decoded.render;
      decoded.render = async () => {
        s.text.set(NOTE, s.text.get(NOTE)!.replace('### [UHW020 Op UHW020]', '### [UHW020 Op UHW020] 바뀜'));
        return render();
      };
      return filePage(...args);
    };
    const manager = s.app.fileManager as unknown as { trashFile: (f: TFile) => Promise<void> };
    const trash = manager.trashFile;
    let calls = 0;
    manager.trashFile = async f => {
      if (calls++ === 0) throw new Error('locked');
      return trash(f);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    warn.mockRestore();
    expect(result).toMatchObject({ status: 'unmatched', reason: 'renamed', unmatchedPath: QUEUED });
    expect(result.imagePath).toBeUndefined();
    expect([...s.binary.keys()]).toEqual([QUEUED]);
  });

  it('writes the print date the user gave', async () => {
    const s = manualSetup();
    await s.pipeline.fileManually(file(QUEUED), file(NOTE), 1, { page: 1, pageCount: 1 }, '2026-09-30');
    expect(s.text.get(NOTE)!).toContain('*Printout 1/1 · printed 2026-09-30 · imported ');
  });

  // #267: cancelling the "restore the old ID?" question is not a failure and
  // must not give the note a new ID.
  it('leaves the note and the queued image alone when the ID question is cancelled', async () => {
    const s = manualSetup();
    await s.pipeline.fileManually(file(QUEUED), file(NOTE), 1, { page: 1, pageCount: 1 });
    const lost = s.text.get(NOTE)!.replace(/^labnote_id: .*\n/m, '');
    s.text.set(NOTE, lost);
    const SECOND = '_labnote-scans/unmatched/20261021-021800_unknown_photo2.jpg';
    s.binary.set(SECOND, new Uint8Array([7, 7, 7]).buffer);
    (s.host as unknown as { pick: () => Promise<string> }).pick = async () => 'cancel';

    const result = await s.pipeline.fileManually(file(SECOND), file(NOTE), 1, { page: 1, pageCount: 1 });

    expect(result).toEqual({ source: '20261021-021800_unknown_photo2.jpg', status: 'skipped', reason: 'cancelled' });
    expect(s.text.get(NOTE)).toBe(lost);
    expect(s.binary.has(SECOND)).toBe(true);
  });
});

describe('isDateInput', () => {
  it('takes real YYYY-MM-DD dates only', () => {
    expect(isDateInput('2026-10-15')).toBe(true);
    expect(isDateInput(' 2024-02-29 ')).toBe(true);
    expect(isDateInput('2026-02-30')).toBe(false);
    expect(isDateInput('2026-1-5')).toBe(false);
    expect(isDateInput('')).toBe(false);
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

// Obsidian still saving the open note past the wait: nothing is written into it, so no scan
// counts as filed or undone; a scan not filed is in the unmatched queue, to be assigned again.
describe('scans while a save of the open note does not end in time', () => {
  const T = OPEN_SAVE_WAIT_MS + 10000;
  const stuck = (s: ReturnType<typeof setup>) => {
    const view = { file: { path: NOTE }, savePromise: new Promise(() => {}) };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
  };

  it('an import: failed, the note unchanged, the image in the unmatched queue', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    stuck(s);
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(result).toMatchObject({ status: 'error', message: 'The scans were not written into the note: it was still being saved, or it changed while they went in.' });
    expect(s.text.get(NOTE)).toBe(note);
    expect(result.imagePath).toBeUndefined();
    expect([...s.binary.keys()]).toEqual([result.unmatchedPath]);
    expect(result.unmatchedPath).toMatch(/^_labnote-scans\/unmatched\//);
    expect(listUnmatched(s.app as never).map(f => f.path)).toEqual([result.unmatchedPath]);
    expect(s.edits).toEqual([]);
  }, T);

  it('an import in Korean: the reason in Korean', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] }, 0,
      createTranslator(obsidianKo as Record<string, string>));
    stuck(s);
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(result).toMatchObject({ status: 'error', message: '스캔을 노트에 넣지 못했습니다. 노트를 아직 저장하는 중이었거나 넣는 사이에 노트가 바뀌었습니다.' });
  }, T);

  // A write that throws is the same failure: the scan is queued, not left unlinked in the note folder.
  it('an import whose note write throws: the image in the unmatched queue', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    Object.assign(s.app.vault, { process: async () => { throw new Error('disk full'); } });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(result).toMatchObject({ status: 'error', message: 'Error: disk full' });
    expect([...s.binary.keys()]).toEqual([result.unmatchedPath]);
    expect(listUnmatched(s.app as never).map(f => f.path)).toEqual([result.unmatchedPath]);
  });

  it('filed by hand: failed, the queued image kept', async () => {
    const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    stuck(s);
    const result = await s.pipeline.fileManually(
      new TFile(QUEUED) as unknown as Parameters<ScanPipeline['fileManually']>[0],
      new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1],
      1,
      { page: 1, pageCount: 1 }
    );
    expect(result.status).toBe('error');
    // The queued image stays, the one in the queue; nothing else is left.
    expect([...s.binary.keys()]).toEqual([QUEUED]);
    expect(result.unmatchedPath).toBe(QUEUED);
    expect(s.text.get(NOTE)).toBe(note);
  }, T);

  it('undo: not undone, the entry and its image kept', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    stuck(s);
    expect(await s.pipeline.undo(result)).toBe('notWritten');
    expect(s.text.get(NOTE)).toContain('aaaaaaaaaaaa');
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
  }, T);

  it('the earlier scan of a page: not removed, its entry and image kept', async () => {
    const s = setup(
      { [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb', { render: async () => new Uint8Array([7, 8, 9]).buffer })] }
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.previous?.length).toBe(1);
    stuck(s);
    expect(await s.pipeline.removePrevious(next)).toBe('notWritten');
    expect(listFiledScans(s.text.get(NOTE)!).map(f => f.hash).sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(s.binary.has(old.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
  }, T);
});

// The open note's save failed as another change reached it: the scans may be in the note, or
// kept by its editor for its next save. Their images stay and nothing is queued, which would file
// them twice; the user is told to check the note.
describe('scans written into a note that may or may not have them', () => {
  it('keeps the images, queues nothing and warns once', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {
      'a.jpg': [page(pagePayload({ page: 1 }), 'aaaaaaaaaaaa'), page(pagePayload({ page: 2 }), 'bbbbbbbbbbbb')],
    });
    const warnings: string[] = [];
    (s.host as unknown as { notify: (level: string, msg: string) => void }).notify = (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    };
    forced.write = 'uncertain';
    try {
      const results = await s.pipeline.run([input('a.jpg')]);
      expect(results.map(r => [r.status, r.uncertain])).toEqual([
        ['filed', true],
        ['filed', true],
      ]);
      expect(s.trashed).toEqual([]);
      for (const r of results) expect(s.binary.has(r.imagePath!)).toBe(true);
      expect(listUnmatched(s.app as never)).toEqual([]);
      expect(warnings).toEqual([
        `${NOTE} may or may not have the change: it was being saved when another change reached it. Check the note before trying again.`,
      ]);
    } finally {
      forced.write = undefined;
    }
  });
});

// The same, written into an open note for real: its save fails as another writer changes the
// file. A scan whose unit operation the editor's text no longer has is not in the note either
// way: queued as always, while the others stay filed, to be checked.
describe('scans written into an open note whose save fails as it changes', () => {
  it('queues a scan the note as written has no unit operation for, and keeps the others', async () => {
    const disk = buildNote(ID, ['UHW010', 'UHW020', 'UHW030']);
    const typed = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: disk }, {
      'a.jpg': [page(pagePayload({ unitOpIndex: 2, opId: 'UHW020' }), 'aaaaaaaaaaaa'), page(pagePayload({ unitOpIndex: 3, opId: 'UHW030' }), 'bbbbbbbbbbbb')],
    });
    let text = typed;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = disk;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async () => {
      s.text.set(NOTE, `${disk}\nother\n`);
      throw new Error('disk full');
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const warnings: string[] = [];
    (s.host as unknown as { notify: (level: string, msg: string) => void }).notify = (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    };
    const [kept, gone] = await s.pipeline.run([input('a.jpg')]);
    expect(kept).toMatchObject({ status: 'filed', uncertain: true });
    expect(s.binary.has(kept.imagePath!)).toBe(true);
    expect(gone).toMatchObject({ status: 'unmatched', reason: 'no-unit-op' });
    expect(gone.uncertain).toBeUndefined();
    expect(listUnmatched(s.app as never).map(f => f.path)).toEqual([gone.unmatchedPath]);
    expect(warnings).toHaveLength(1);
  });
});

// The note's save fails as Obsidian 1.15.0's does (the text last saved put back): an undo leaves
// the entry in the editor alone, the disk still pointing at the image. The image stays and the
// undo is said not written, its button kept; once the note is saved, the undo ends as usual.
describe('undo of a scan in an open note whose save fails', () => {
  it('keeps the image until the note on disk no longer has the scan', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    const filed = s.text.get(NOTE)!;
    let text = filed;
    let fails = true;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = filed;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      if (fails) throw new Error('disk full');
      s.text.set(NOTE, t);
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const t = ((key: string, ...args: string[]) => formatMessage(key, args)) as Translator;

    expect(await undoScanResult(t, s.pipeline, result, false)).toEqual({
      done: false,
      message: `${NOTE} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.`,
    });
    expect(s.trashed).toEqual([]);
    expect(s.text.get(NOTE)).toContain('aaaaaaaaaaaa');

    fails = false;
    await view.save();
    expect(s.text.get(NOTE)).not.toContain('aaaaaaaaaaaa');
    expect((await undoScanResult(t, s.pipeline, result, false)).done).toBe(true);
    expect(s.trashed).toEqual([result.imagePath]);
  });
});

// Tried again before the note is saved: the editor no longer has the entries, so the write finds
// nothing to do, while the disk still points at the images. They stay until the disk no longer does.
describe('undo and earlier-scan removal tried again while the open note still cannot be saved', () => {
  function failingView(s: ReturnType<typeof setup>) {
    const filed = s.text.get(NOTE)!;
    let text = filed;
    const state = { fails: true };
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = filed;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      if (state.fails) throw new Error('disk full');
      s.text.set(NOTE, t);
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    return { view, state };
  }

  it('undo: the image stays on the second try too, and goes once the note is saved', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    const { view, state } = failingView(s);
    expect(await s.pipeline.undo(result)).toBe('notWritten');
    expect(await s.pipeline.undo(result)).toBe('notWritten');
    expect(s.text.get(NOTE)).toContain('aaaaaaaaaaaa');
    expect(s.trashed).toEqual([]);
    state.fails = false;
    await view.save();
    expect(await s.pipeline.undo(result)).toBe(true);
    expect(s.trashed).toEqual([result.imagePath]);
  });

  it('earlier scans: their image stays on the second try too, and goes once the note is saved', async () => {
    const s = setup(
      { [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb', { render: async () => new Uint8Array([7, 8, 9]).buffer })] }
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(next.previous?.length).toBe(1);
    const { view, state } = failingView(s);
    expect(await s.pipeline.removePrevious(next)).toBe('notWritten');
    expect(await s.pipeline.removePrevious(next)).toBe('notWritten');
    expect(listFiledScans(s.text.get(NOTE)!).map(f => f.hash).sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(s.binary.has(old.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
    state.fails = false;
    await view.save();
    expect(await s.pipeline.removePrevious(next)).toEqual({ removed: 1, trashed: 1 });
    expect(s.trashed).toEqual([old.imagePath]);
  });

  it('filed by hand: the queued image stays while the disk lacks the scan, and goes once it is saved', async () => {
    const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    const { view, state } = failingView(s);
    const warnings: string[] = [];
    (s.host as unknown as { notify: (level: string, msg: string) => void }).notify = (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    };
    const byHand = () =>
      s.pipeline.fileManually(
        new TFile(QUEUED) as unknown as Parameters<ScanPipeline['fileManually']>[0],
        new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1],
        1,
        { page: 1, pageCount: 1 }
      );
    // Said once, as the result: no warning besides it.
    const first = await byHand();
    expect(first).toMatchObject({
      status: 'error',
      message: `${NOTE} has the scan only in its open editor: the note could not be saved yet, so its image stays in the unmatched queue. Assign it again once the note is saved.`,
    });
    expect(s.binary.has(QUEUED)).toBe(true);
    expect(s.trashed).not.toContain(QUEUED);
    expect(warnings).toEqual([]);
    state.fails = false;
    await view.save();
    expect((await byHand()).status).toBe('duplicate');
    expect(s.trashed).toContain(QUEUED);
  });

  it('imported again: a scan the editor keeps is a duplicate, not filed twice', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    failingView(s);
    const [first] = await s.pipeline.run([input('a.jpg')]);
    expect(first.status).toBe('filed');
    const [again] = await s.pipeline.run([input('a.jpg')]);
    expect(again.status).toBe('duplicate');
  });
});

// The note's save went in, but the disk could not be read back right after: the scan is in the
// note on disk, which links its image. The image stays; the scan is said may be filed.
describe('a scan filed into an open note whose disk cannot be read after its save', () => {
  it('keeps the image the note links, and does not queue the scan', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    let text = note;
    let broken = false;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = note;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      s.text.set(NOTE, t);
      broken = true;
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const read = s.app.vault.read.bind(s.app.vault);
    Object.assign(s.app.vault, {
      read: async (f: TFile) => {
        if (broken && f.path === NOTE) throw new Error('EBUSY');
        return read(f as never);
      },
    });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(s.text.get(NOTE)).toContain('aaaaaaaaaaaa');
    expect(result).toMatchObject({ status: 'filed', uncertain: true });
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
    expect(listUnmatched(s.app as never)).toEqual([]);
  });
});

// A unit operation renamed in the open editor, not saved yet: filed by hand to it, the scan goes
// there, as the picker listed it, rather than being taken for a renamed block.
describe('a scan filed by hand to a unit operation renamed in the open editor', () => {
  it('is filed', async () => {
    const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    let text = note.split('Op UHW010').join('Mixing');
    expect(text).not.toBe(note);
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = note;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      s.text.set(NOTE, t);
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const result = await s.pipeline.fileManually(
      new TFile(QUEUED) as unknown as Parameters<ScanPipeline['fileManually']>[0],
      new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1],
      1,
      { page: 1, pageCount: 1 }
    );
    expect(result.status).toBe('filed');
    expect(text).toContain('Mixing');
  });
});

// The open note's save failed, so the scan is in its editor alone; the disk could not be read
// once right after, then reads without it. The image the editor links stays, and is not queued.
describe('a scan in an open note kept by its editor alone, the disk read failing once', () => {
  it('keeps the image the editor links', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'a.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    let text = note;
    let failOnce = false;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = note;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async () => {
      failOnce = true;
      throw new Error('disk full');
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const read = s.app.vault.read.bind(s.app.vault);
    Object.assign(s.app.vault, {
      read: async (f: TFile) => {
        if (failOnce && f.path === NOTE) {
          failOnce = false;
          throw new Error('EBUSY');
        }
        return read(f as never);
      },
    });
    const [result] = await s.pipeline.run([input('a.jpg')]);
    expect(text).toContain('aaaaaaaaaaaa');
    expect(s.text.get(NOTE)).not.toContain('aaaaaaaaaaaa');
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.trashed).toEqual([]);
    expect(result).toMatchObject({ status: 'filed', uncertain: true });
  });
});

// Separate decisions on one read: an image to keep stays when the note cannot be read; a queued
// image goes only once the note is read and has the scan. And undo and "delete earlier scan" each
// count only the entries they took out.
describe('a note that cannot be read, and two removals on one result', () => {
  function openNote(s: ReturnType<typeof setup>, opts: { failSave: () => boolean; failRead?: () => boolean }) {
    const filed = s.text.get(NOTE)!;
    let text = filed;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = filed;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async (_f: TFile, t: string) => {
      if (opts.failSave()) throw new Error('disk full');
      s.text.set(NOTE, t);
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    if (opts.failRead) {
      const read = s.app.vault.read.bind(s.app.vault);
      Object.assign(s.app.vault, {
        read: async (f: TFile) => {
          if (opts.failRead!() && f.path === NOTE) throw new Error('EBUSY');
          return read(f as never);
        },
      });
    }
    return { view, text: () => text };
  }

  it('filed by hand into a note not saved and not readable: the queued image stays', async () => {
    const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    let saveTried = false;
    openNote(s, { failSave: () => ((saveTried = true), true), failRead: () => saveTried });
    await s.pipeline.fileManually(
      new TFile(QUEUED) as unknown as Parameters<ScanPipeline['fileManually']>[0],
      new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1],
      1,
      { page: 1, pageCount: 1 }
    );
    expect(s.text.get(NOTE)).not.toContain('labnoteo-scan');
    expect(s.binary.has(QUEUED)).toBe(true);
    expect(s.trashed).not.toContain(QUEUED);
  });

  it('an undo kept by the editor is not counted by the earlier-scan removal after the save', async () => {
    const s = setup(
      { [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) },
      { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb', { render: async () => new Uint8Array([7, 8, 9]).buffer })] }
    );
    const [old] = await s.pipeline.run([input('old.jpg')]);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    let fails = true;
    const { view } = openNote(s, { failSave: () => fails });
    expect(await s.pipeline.undo(next)).toBe('notWritten');
    fails = false;
    await view.save();
    expect(await s.pipeline.removePrevious(next)).toEqual({ removed: 1, trashed: 1 });
    expect(s.trashed).toContain(old.imagePath);
  });
});

describe('undo and hand filing that put the note back as it was', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const file = (p: string) => new TFile(p) as unknown as Parameters<ScanPipeline['fileManually']>[0];

  it('an undo leaves a Worksheet scans section the note had before, emptied', async () => {
    const pages = { 'p.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] };
    const first = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, pages);
    await first.pipeline.run([input('p.jpg')]);
    // The note with an empty section of its own: the entry taken out by hand.
    const empty = first.text.get(NOTE)!.replace(/<!-- labnoteo-scan[^\n]*\n[^\n]*\n\*[^\n]*\*\n/, '');
    expect(empty).toContain('#### Worksheet scans');
    expect(empty).not.toContain('labnoteo-scan');
    const s = setup({ [NOTE]: empty }, pages);
    const [r] = await s.pipeline.run([input('p.jpg')]);
    expect(await s.pipeline.undo(r)).toBe(true);
    expect(JSON.stringify(s.text.get(NOTE))).toBe(JSON.stringify(empty));
  });

  it('an undo takes out the section the scan made', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup({ [NOTE]: note }, { 'p.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [r] = await s.pipeline.run([input('p.jpg')]);
    expect(await s.pipeline.undo(r)).toBe(true);
    expect(s.text.get(NOTE)).not.toContain('Worksheet scans');
  });

  it('filed by hand into a note it did not go into: one error, and no unlinked copy left', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    const notices: string[] = [];
    Object.assign(s.host, { notify: (_level: string, message: string) => void notices.push(message) });
    // The write cannot read the note, nor can the check right after it; the next read can.
    let failNextRead = false;
    const read = s.app.vault.read.bind(s.app.vault);
    Object.assign(s.app.vault, {
      process: async () => {
        failNextRead = true;
        throw new Error('EBUSY');
      },
      read: async (f: TFile) => {
        if (f.path === NOTE && failNextRead) {
          failNextRead = false;
          throw new Error('EBUSY');
        }
        return read(f as never);
      },
    });
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(result.status).toBe('error');
    expect(s.text.get(NOTE)).not.toContain('labnoteo-scan');
    expect(s.binary.has(QUEUED)).toBe(true);
    // Only the queued image is left: the copy saved for the note went.
    expect([...s.binary.keys()]).toEqual([QUEUED]);
    expect(notices.filter(m => /may or may not|only in its open editor/.test(m))).toEqual([]);
  });
});

describe('a scan is filed only when the note on disk has its entry and link', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const file = (p: string) => new TFile(p) as unknown as Parameters<ScanPipeline['fileManually']>[0];
  afterEach(() => vi.useRealTimers());

  it('a note that only names the image the scan would get is no proof: the queued image stays', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T09:00:00'));
    const note = `${buildNote(ID, ['UHW010', 'UHW020'])}\nPending file name: ${ID}_u2_p1_20261112.jpg\n`;
    const s = setup({ [NOTE]: note }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    // The write cannot read the note, nor can the check right after it; the next read can.
    let failNextRead = false;
    const read = s.app.vault.read.bind(s.app.vault);
    Object.assign(s.app.vault, {
      process: async () => {
        failNextRead = true;
        throw new Error('EBUSY');
      },
      read: async (f: TFile) => {
        if (f.path === NOTE && failNextRead) {
          failNextRead = false;
          throw new Error('EBUSY');
        }
        return read(f as never);
      },
    });
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(s.text.get(NOTE)).toBe(note);
    expect(result.status).toBe('error');
    expect(s.binary.has(QUEUED)).toBe(true);
    expect(s.trashed).not.toContain(QUEUED);
  });
});

describe('scans judged by what the note links, and undone by the batch they went in with', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const file = (p: string) => new TFile(p) as unknown as Parameters<ScanPipeline['fileManually']>[0];

  it('filed by hand, its section renamed right after the write: the linked copy stays', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    const process = s.app.vault.process.bind(s.app.vault);
    Object.assign(s.app.vault, {
      process: async (f: TFile, fn: (data: string) => string) => {
        const out = await process(f as never, fn);
        // Renamed by the researcher before the check reads the note.
        s.text.set(NOTE, out.replace('#### Worksheet scans', '#### Worksheet scans (paper)'));
        return out;
      },
    });
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(result.status).toBe('filed');
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.text.get(NOTE)).toContain(result.imagePath!.split('/').pop()!);
    expect(s.trashed).toContain(QUEUED);
  });

  it('an undo leaves an image the note still links under a renamed section', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, { 'p.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] });
    const [r] = await s.pipeline.run([input('p.jpg')]);
    s.text.set(NOTE, s.text.get(NOTE)!.replace('#### Worksheet scans', '#### Worksheet scans (paper)'));
    await s.pipeline.undo(r);
    expect(s.trashed).not.toContain(r.imagePath);
  });

  it('two pages filed in one batch into a block without the section: undoing both takes it out', async () => {
    const note = buildNote(ID, ['UHW010', 'UHW020']);
    const s = setup(
      { [NOTE]: note },
      { 'two.jpg': [page(pagePayload({ page: 1, pageCount: 2 }), 'aaaaaaaaaaaa'), page(pagePayload({ page: 2, pageCount: 2 }), 'bbbbbbbbbbbb')] }
    );
    const results = await s.pipeline.run([input('two.jpg')]);
    expect(results.map(r => r.status)).toEqual(['filed', 'filed']);
    for (const r of results) expect(await s.pipeline.undo(r)).toBe(true);
    expect(s.text.get(NOTE)).not.toContain('Worksheet scans');
  });
});

describe('scan images the note links elsewhere, and one message per hand filing', () => {
  const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
  const file = (p: string) => new TFile(p) as unknown as Parameters<ScanPipeline['fileManually']>[0];

  it('deleting an earlier scan keeps its image while the note links it elsewhere, and says both counts', async () => {
    const pages = { 'old.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')], 'new.jpg': [page(pagePayload(), 'bbbbbbbbbbbb', { render: async () => new Uint8Array([7, 8, 9]).buffer })] };
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, pages);
    const [old] = await s.pipeline.run([input('old.jpg')]);
    // The researcher links the earlier page's image from the notes too, with a size.
    const name = old.imagePath!.split('/').pop()!;
    s.text.set(NOTE, `${s.text.get(NOTE)!}\n## Notes\n![[${name}|100]]\n`);
    const [next] = await s.pipeline.run([input('new.jpg')]);
    expect(await s.pipeline.removePrevious(next)).toEqual({ removed: 1, trashed: 0 });
    expect(s.binary.has(old.imagePath!)).toBe(true);
    const t: Translator = (key, ...args) => formatMessage(key, args);
    expect((await undoScanResult(t, { removePrevious: async () => ({ removed: 1, trashed: 0 }), undo: async () => false }, next, true)).message).toBe(
      'Removed 1 earlier scan(s) from the note and moved 0 image(s) to the trash.'
    );
  });

  it('a new scan does not take a name the note still links, though its file is gone', async () => {
    const pages = { 'p.jpg': [page(pagePayload(), 'aaaaaaaaaaaa')] };
    const probe = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, pages);
    const [first] = await probe.pipeline.run([input('p.jpg')]);
    const taken = first.imagePath!.split('/').pop()!;
    const s = setup({ [NOTE]: `${buildNote(ID, ['UHW010', 'UHW020'])}\n## Notes\n![](scans/${encodeURIComponent(taken)})\n` }, pages);
    const [r] = await s.pipeline.run([input('p.jpg')]);
    expect(r.imagePath!.split('/').pop()).not.toBe(taken);
  });

  it('filed by hand into the open editor alone: one message, as the result', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    const notices: string[] = [];
    Object.assign(s.host, { notify: (_l: string, m: string) => void notices.push(m) });
    let text = s.text.get(NOTE)!;
    const view = new MarkdownView();
    view.file = new TFile(NOTE);
    view.lastSavedData = text;
    view.editor = {
      getValue: () => text,
      offsetToPos: (offset: number) => offset,
      replaceRange: (r: string, from: number, to: number) => {
        text = text.slice(0, from) + r + text.slice(to);
      },
    };
    view.getViewData = () => text;
    view.writeData = async () => {
      throw new Error('disk full');
    };
    Object.assign(s.app, { workspace: { getLeavesOfType: () => [{ view }] } });
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(notices).toEqual([]);
    expect(result.status).toBe('error');
    expect(result.message).toContain('only in its open editor');
    // The editor links the copy: it stays, and so does the queued image.
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.binary.has(QUEUED)).toBe(true);
  });

  it('filed by hand into a note that cannot be read to check: one message naming the copy left', async () => {
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    const notices: string[] = [];
    Object.assign(s.host, { notify: (_l: string, m: string) => void notices.push(m) });
    let written = false;
    const process = s.app.vault.process.bind(s.app.vault);
    const read = s.app.vault.read.bind(s.app.vault);
    Object.assign(s.app.vault, {
      process: async (f: TFile, fn: (d: string) => string) => {
        written = true;
        return process(f as never, fn);
      },
      read: async (f: TFile) => {
        if (written && f.path === NOTE) throw new Error('EBUSY');
        return read(f as never);
      },
    });
    const result = await s.pipeline.fileManually(file(QUEUED), file(NOTE), 2, { page: 1, pageCount: 1 });
    expect(notices).toEqual([]);
    expect(result.status).toBe('error');
    expect(result.message).toContain(result.imagePath!);
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.binary.has(QUEUED)).toBe(true);
  });
});

describe('a scan filed by hand whose Markdown link has parentheses in its path', () => {
  it('is filed, and its copy stays', async () => {
    const QUEUED = '_labnote-scans/unmatched/20261021-021738_unknown_photo1.jpg';
    const s = setup({ [NOTE]: buildNote(ID, ['UHW010', 'UHW020']) }, {});
    s.binary.set(QUEUED, new Uint8Array([9, 9, 9]).buffer);
    // Markdown links, as the vault's "Use [[Wikilinks]]" off writes them.
    Object.assign(s.app.fileManager, {
      generateMarkdownLink: (f: TFile, _source: string, _subpath?: string, alias?: string) =>
        `${alias ? `[${alias}]` : '![]'}(labnote/Assay(pilot)/images/${f.path.split('/').pop()})`,
    });
    const result = await s.pipeline.fileManually(
      new TFile(QUEUED) as unknown as Parameters<ScanPipeline['fileManually']>[0],
      new TFile(NOTE) as unknown as Parameters<ScanPipeline['fileManually']>[1],
      2,
      { page: 1, pageCount: 1 }
    );
    expect(result.status).toBe('filed');
    expect(s.binary.has(result.imagePath!)).toBe(true);
    expect(s.text.get(NOTE)).toContain('(labnote/Assay(pilot)/images/');
  });
});
