import { describe, it, expect } from 'vitest';
import type { App, TFile as ObsidianTFile } from 'obsidian';
import jsQR from 'jsqr';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { parseFrontMatterYaml } from '../../packages/labnoteo-core/src/sections/frontMatter';
import { encodePagePayload, decodeScanPayload } from '../../packages/labnoteo-core/src/lib/scanPayload';
import { qrMatrix, qrSvg, QR_QUIET_ZONE } from '../../src/barcode/qr';
import { NoteIdService, previousNoteIdFromScans } from '../../src/barcode/noteIdService';
import { BarcodeFeature, planScanMoves } from '../../src/barcode/barcodeFeature';
import { printFullNoteCommand } from '../../src/print/fullNotePrint';
import { createPcStore } from '../../src/scan/pcStore';
import {
  isScanOfNote,
  scanFileName,
  unmatchedFileName,
  noteIdFromUnmatchedName,
  sourceNameFromUnmatched,
  unmatchedInfoFromName,
} from '../../src/scan/imageStore';

class MemStorage {
  readonly data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('createPcStore', () => {
  it("keeps each vault's values apart in the shared localStorage of older Obsidian", () => {
    const storage = new MemStorage();
    const vaultA = createPcStore({ appId: 'aaa', vault: { getName: () => 'A' } } as unknown as App, storage as unknown as Storage);
    const vaultB = createPcStore({ appId: 'bbb', vault: { getName: () => 'B' } } as unknown as App, storage as unknown as Storage);
    vaultA.set('scanFolder', { path: 'C:/scans' });
    expect(vaultA.get('scanFolder')).toEqual({ path: 'C:/scans' });
    expect(vaultB.get('scanFolder')).toBeUndefined();
    expect([...storage.data.keys()]).toEqual(['labnoteo:aaa:scanFolder']);
    vaultA.set('scanFolder', undefined);
    expect(storage.data.size).toBe(0);
  });

  it("uses the vault-scoped app.loadLocalStorage when Obsidian has it", () => {
    const saved = new Map<string, unknown>();
    const app = {
      loadLocalStorage: (k: string) => saved.get(k) ?? null,
      saveLocalStorage: (k: string, v: unknown) => saved.set(k, v),
    } as unknown as App;
    const storage = new MemStorage();
    const store = createPcStore(app, storage as unknown as Storage);
    store.set('slack', { token: 'x' });
    expect(store.get('slack')).toEqual({ token: 'x' });
    expect([...saved.keys()]).toEqual(['labnoteo:slack']);
    expect(storage.data.size).toBe(0);
  });

  it('reads a broken value as missing', () => {
    const storage = new MemStorage();
    storage.setItem('labnoteo:aaa:k', '{oops');
    const store = createPcStore({ appId: 'aaa' } as unknown as App, storage as unknown as Storage);
    expect(store.get('k')).toBeUndefined();
  });
});

describe('QR round trip', () => {
  /** Draw the matrix as RGBA pixels, quiet zone included, and read it back. */
  function decode(text: string, scale = 4): string | undefined {
    const matrix = qrMatrix(text);
    const size = (matrix.length + QR_QUIET_ZONE * 2) * scale;
    const px = new Uint8ClampedArray(size * size * 4).fill(255);
    matrix.forEach((row, r) =>
      row.forEach((dark, c) => {
        if (!dark) return;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const i = (((r + QR_QUIET_ZONE) * scale + y) * size + (c + QR_QUIET_ZONE) * scale + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = 0;
          }
        }
      })
    );
    return jsQR(px, size, size)?.data;
  }

  it('reads back the page payload a worksheet prints', () => {
    const text = encodePagePayload({
      noteId: 'LN-7K3M9QX2',
      unitOpIndex: 3,
      opId: 'UHW010',
      page: 2,
      pageCount: 3,
      printedOn: '2026-10-15',
    });
    const read = decode(text);
    expect(read).toBe(text);
    expect(decodeScanPayload(read!)).toMatchObject({ noteId: 'LN-7K3M9QX2', unitOpIndex: 3, page: 2 });
  });

  it('draws an SVG with the quiet zone and an escaped title', () => {
    const svg = qrSvg('LN1:LN-7K3M9QX2', 'a <b> & "c"');
    const size = qrMatrix('LN1:LN-7K3M9QX2').length + QR_QUIET_ZONE * 2;
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(svg).toContain('<title>a &#60;b&#62; &#38; &#34;c&#34;</title>');
  });
});

describe('scan file names', () => {
  it("names a scan after its note, unit operation and page, so moves can find a note's scans", () => {
    const name = scanFileName('LN-7K3M9QX2', 3, 2, '2026-10-15');
    expect(name).toBe('LN-7K3M9QX2_u3_p2_20261015.jpg');
    expect(isScanOfNote(name, 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote('LN-7K3M9QX2_u3_p2_20261015_2.jpg', 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote(name, 'LN-00000000')).toBe(false);
    expect(isScanOfNote('LN-7K3M9QX2_notes.md', 'LN-7K3M9QX2')).toBe(false);
  });

  it('keeps the note ID read from an unmatched page in its queue file name', () => {
    const name = unmatchedFileName('20261016-093012', 'IMG:1234.jpg', 'LN-7K3M9QX2', 2);
    expect(name).toBe('20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg');
    expect(noteIdFromUnmatchedName(name)).toBe('LN-7K3M9QX2');
    expect(noteIdFromUnmatchedName(unmatchedFileName('20261016-093012', 'a.jpg', undefined))).toBeUndefined();
  });

  it('keeps what the QR code said and why the page was not filed (#349)', () => {
    const payload = { noteId: 'LN-7K3M9QX2', unitOpIndex: 2, opId: 'UHW290', page: 1, pageCount: 3, printedOn: '2026-10-25', fingerprint: 'K7QD' };
    const name = unmatchedFileName('20261025-073505', 'IMG_9.jpg', payload.noteId, undefined, { payload, reason: 'renamed' });
    expect(name).toBe('20261025-073505_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_9.jpg');
    const { noteId, ...page } = payload;
    expect(unmatchedInfoFromName(name)).toEqual({ noteId, page, reason: 'renamed' });
    expect(unmatchedInfoFromName('20261016-093012_LN-7K3M9QX2_renamed_x.jpg')).toEqual({ noteId: 'LN-7K3M9QX2', reason: 'renamed' });
    expect(unmatchedInfoFromName('20261016-093012_unknown_no-qr_a.jpg')).toEqual({ reason: 'no-qr' });
    expect(unmatchedInfoFromName('20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg')).toEqual({ noteId: 'LN-7K3M9QX2' });
  });

  // #396
  it('gives back the source name at the end of a queue file name', () => {
    expect(sourceNameFromUnmatched('20261025-073505_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_9.jpg')).toBe('IMG_9.jpg');
    expect(sourceNameFromUnmatched('20261016-093012_unknown_photo1.jpg')).toBe('photo1.jpg');
    expect(sourceNameFromUnmatched('IMG_9.jpg')).toBe('IMG_9.jpg');
  });

  // #495: the page's hash and the scanned file's extension go along.
  it('keeps the hash and the extension of the scanned file', () => {
    const name = unmatchedFileName('20261031-185455', 'scan_1-1.png', 'LN-7K3M9QX2', undefined, {
      reason: 'renamed',
      hash: '953d461ec519',
    });
    expect(name).toBe('20261031-185455_LN-7K3M9QX2_renamed_h953d461ec519-png_scan_1-1.jpg');
    expect(unmatchedInfoFromName(name)).toEqual({
      noteId: 'LN-7K3M9QX2',
      reason: 'renamed',
      hash: '953d461ec519',
      sourceExt: 'png',
    });
    expect(sourceNameFromUnmatched(name)).toBe('scan_1-1.png');
    const pdf = unmatchedFileName('20261031-185455', 'run.pdf', undefined, 2, { hash: 'aaaaaaaaaaaa' });
    expect(sourceNameFromUnmatched(pdf)).toBe('run.pdf p.2');
    expect(sourceNameFromUnmatched(unmatchedFileName('20261031-185455', 'IMG_p2.png', undefined, undefined, { hash: 'aaaaaaaaaaaa' }))).toBe(
      'IMG_p2.png'
    );
  });
});

describe('planScanMoves', () => {
  it("moves the note's own scans and keeps those whose name is taken in the new experiment", () => {
    const names = ['LN-AAAAAAAA_u1_p1_20261015.jpg', 'LN-AAAAAAAA_u2_p1_20261015.jpg', 'LN-BBBBBBBB_u1_p1_20261015.jpg', 'plot.png'];
    expect(planScanMoves(names, 'LN-AAAAAAAA', new Set(['LN-AAAAAAAA_u2_p1_20261015.jpg']))).toEqual({
      move: ['LN-AAAAAAAA_u1_p1_20261015.jpg'],
      keep: ['LN-AAAAAAAA_u2_p1_20261015.jpg'],
    });
  });
});

describe('NoteIdService', () => {
  const note = (id?: string) => `---\ntitle: x\n${id ? `labnote_id: ${id}\n` : ''}---\n\nbody\n`;

  function service(
    notes: Record<string, { text: string; ctime: number }>,
    /** What the restore question is answered with; null closes it. */
    answer: 'restore' | 'new' | 'cancel' | null = 'restore'
  ) {
    const files = new Map(Object.entries(notes));
    const fileOf = (p: string) =>
      Object.assign(new TFile(p), { stat: { ctime: files.get(p)!.ctime } }) as unknown as ObsidianTFile;
    const notices: string[] = [];
    const app = {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(fileOf),
        getAbstractFileByPath: (p: string) => (files.has(p) ? fileOf(p) : null),
        read: async (f: TFile) => files.get(f.path)!.text,
        process: async (f: TFile, fn: (s: string) => string) => {
          files.get(f.path)!.text = fn(files.get(f.path)!.text);
        },
      },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(files.get(f.path)!.text) } }) },
    } as unknown as App;
    const host = {
      notify: (_level: string, msg: string) => notices.push(msg),
      t: (s: string) => s,
      confirm: async () => true,
      pick: async () => answer ?? undefined,
    } as unknown as LabnoteHost;
    return { svc: new NoteIdService(app, host), files, fileOf, notices };
  }

  it('finds notes by ID and gives a note without one a fresh, unused ID', async () => {
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 }, 'b.labnote.md': { text: note(), ctime: 2 } });
    expect(svc.filesWithId('LN-AAAAAAAA').map(f => f.path)).toEqual(['a.labnote.md']);
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-AAAAAAAA');
    const id = await svc.ensureId(fileOf('b.labnote.md'));
    expect(id).toMatch(/^LN-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(id).not.toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('b.labnote.md')!.text)).toBe(id);
  });

  // setNoteId rewrites only a one-line labnote_id; when the write leaves the
  // note without the ID, no ID is given back and the user is told.
  it('gives no ID it could not write over a labnote_id on several lines', async () => {
    const text = '---\ntitle: x\nlabnote_id: >-\n  LN-bad\n---\n\nbody\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'unreadable' });
    expect(files.get('a.labnote.md')!.text).toBe(text);
    expect(notices.some(n => n.includes('could not be written'))).toBe(true);
  });

  // A valid-looking ID continued on the next line is no ID: the note is not
  // printed under it, and the ID that cannot be written is reported.
  it('gives no ID for a labnote_id continued on the next line', async () => {
    const text = '---\nlabnote_id: LN-7K3M9QX2\n  old\n---\nbody\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'unreadable' });
    expect(files.get('a.labnote.md')!.text).toBe(text);
    expect(notices.some(n => n.includes('could not be written'))).toBe(true);
  });

  it('repairs a one-line ID with an indented comment below it', async () => {
    const text = '---\nlabnote_id: ln-7k3m9qx2\n  # barcode\n---\nbody\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ id: 'LN-7K3M9QX2' });
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-7K3M9QX2');
    expect(notices.some(n => n.includes('could not be written'))).toBe(false);
  });

  it.each([['NBSP', '\u00a0'], ['em space', '\u2003'], ['ideographic space', '\u3000']])(
    'gives the ID before a "-%s" key',
    async (_name, sp) => {
      const text = `---\nlabnote_id: LN-7K3M9QX2\n-${sp}other: keep\n---\nbody\n`;
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ id: 'LN-7K3M9QX2' });
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
  );

  it.each([['NBSP', '\u00a0'], ['em space', '\u2003'], ['ideographic space', '\u3000']])(
    'gives the ID before a key indented with %s',
    async (_name, sp) => {
      const text = `---\nlabnote_id: LN-7K3M9QX2\n${sp}other: keep\n---\nbody\n`;
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ id: 'LN-7K3M9QX2' });
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
  );

  it('gives a new ID over a one-line tagged labnote_id', async () => {
    const text = '---\nlabnote_id: !!str LN-7K3M9QX2\n---\nbody\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    const result = await svc.ensureIdResult(fileOf('a.labnote.md'));
    expect(result).toHaveProperty('id');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe((result as { id: string }).id);
    expect(notices.some(n => n.includes('could not be written'))).toBe(false);
  });

  it('leaves a note with broken front matter unchanged', async () => {
    const broken = '---\ntitle: [unclosed\n---\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text: broken, ctime: 1 } });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBeUndefined();
    expect(files.get('a.labnote.md')!.text).toBe(broken);
    expect(notices).toHaveLength(1);
  });

  // #236: printed worksheets carry the old ID.
  const scanned = (embed: string) =>
    `${note()}\n#### Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=056ac8eeaf37 -->\n${embed}\n*caption*\n`;

  it('reads the ID a note was printed under from its filed scans', () => {
    expect(previousNoteIdFromScans(scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg|200]]'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![[images/scans/LN-FK5Q8KV0_u1_p1_20261021_2.jpg]]'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![200](images/scans/LN-FK5Q8KV0_u0_p1_20261021.jpg)'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![[photo.jpg]]'))).toBeUndefined();
    expect(previousNoteIdFromScans(note())).toBeUndefined();
  });

  it('offers the ID back when the labnote_id line was lost', async () => {
    const { svc, files, fileOf } = service({
      'a.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 1 },
    });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-FK5Q8KV0');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-FK5Q8KV0');
  });

  // #267: closing the question must not be read as "give a new ID".
  it('gives a new ID only when that is what was picked, and changes nothing on cancel', async () => {
    const text = scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]');
    for (const answer of ['cancel', null] as const) {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, answer);
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'cancelled' });
      expect(await svc.ensureId(fileOf('a.labnote.md'))).toBeUndefined();
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    const id = await svc.ensureId(fileOf('a.labnote.md'));
    expect(id).toMatch(/^LN-/);
    expect(id).not.toBe('LN-FK5Q8KV0');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe(id);
  });

  // #478: an ID edited out of the format was silently replaced.
  it('restores an ID that only lost its capitals', async () => {
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text: note('ln-r4w7tz04'), ctime: 1 } });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-R4W7TZ04');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-R4W7TZ04');
    expect(notices).toEqual(['The labnote_id of {0} was written as "{1}"; restored it as {2}.']);
  });

  it('asks before replacing any other malformed ID, and changes nothing on cancel', async () => {
    const text = note("'LN-냉동고 정리 1'");
    for (const answer of ['cancel', null] as const) {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, answer);
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'cancelled' });
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    const id = await svc.ensureId(fileOf('a.labnote.md'));
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe(id);
  });

  it('asks about a lower-case ID another note already holds instead of restoring it', async () => {
    const { svc, fileOf } = service(
      {
        'orig.labnote.md': { text: note('LN-R4W7TZ04'), ctime: 1 },
        'copy.labnote.md': { text: note('ln-r4w7tz04'), ctime: 2 },
      },
      'cancel'
    );
    expect(await svc.ensureIdResult(fileOf('copy.labnote.md'))).toEqual({ reason: 'cancelled' });
  });

  it('gives a new ID, with a warning, when another note holds the old one', async () => {
    const { svc, fileOf, notices } = service({
      'orig.labnote.md': { text: note('LN-FK5Q8KV0'), ctime: 1 },
      'copy.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 2 },
    });
    const id = await svc.ensureId(fileOf('copy.labnote.md'));
    expect(id).not.toBe('LN-FK5Q8KV0');
    expect(notices).toHaveLength(1);
  });

  it('does not offer the old ID when a new one is asked for', async () => {
    const { svc, fileOf } = service({
      'a.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 1 },
    });
    expect(await svc.ensureId(fileOf('a.labnote.md'), { reassign: true })).not.toBe('LN-FK5Q8KV0');
  });

  it('reports a copied ID once and re-numbers the newer note', async () => {
    const { svc, files } = service({
      'orig.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'copy.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 5 },
    });
    await svc.offerDuplicateFixes();
    expect(readNoteId(files.get('orig.labnote.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('copy.labnote.md')!.text)).not.toBe('LN-AAAAAAAA');
    files.get('copy.labnote.md')!.text = note('LN-AAAAAAAA');
    expect(svc.unreportedDuplicates()).toEqual([]);
  });

  // #425
  it('asks again about the notes still sharing an ID, and about a note joining them', async () => {
    const { svc, files } = service({
      'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'b.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
      'c.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 3 },
    });
    await svc.offerDuplicateFixes();
    const ids = ['a', 'b', 'c'].map(n => readNoteId(files.get(`${n}.labnote.md`)!.text));
    expect(ids[0]).toBe('LN-AAAAAAAA');
    expect(new Set(ids).size).toBe(3);

    files.set('d.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 4 });
    expect(svc.unreportedDuplicates().map(d => d.newest.path)).toEqual(['d.labnote.md']);
    expect(svc.unreportedDuplicates()).toEqual([]);
  });

  it('does not ask again about notes left sharing an ID after a cancel', async () => {
    const { svc, files } = service({
      'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'b.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
    });
    let asked = 0;
    (svc as unknown as { host: { confirm: () => Promise<boolean> } }).host.confirm = async () => (asked++, false);
    await svc.offerDuplicateFixes();
    await svc.offerDuplicateFixes();
    expect(asked).toBe(1);
    files.set('c.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 3 });
    await svc.offerDuplicateFixes();
    expect(asked).toBe(2);
  });

  // #426
  it('leaves a template carrying an ID out, and warns about it once', async () => {
    const { svc, files, notices } = service({
      'labnote/101/001_WD010.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'labnote/102/001_WT010.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
      'templates/block.md': { text: note('LN-AAAAAAAA'), ctime: 3 },
    });
    expect(svc.filesWithId('LN-AAAAAAAA')).toHaveLength(2);
    await svc.offerDuplicateFixes();
    expect(readNoteId(files.get('templates/block.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('labnote/101/001_WD010.labnote.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('labnote/102/001_WT010.labnote.md')!.text)).not.toBe('LN-AAAAAAAA');
    expect(notices.filter(n => n.includes('not a lab note'))).toHaveLength(1);
    await svc.offerDuplicateFixes();
    expect(notices.filter(n => n.includes('not a lab note'))).toHaveLength(1);
  });

  // #443: merging notes left the kept note with the merged one's ID.
  describe('a changed labnote_id', () => {
    const answering = (svc: NoteIdService, ok: boolean) => {
      const asked: string[] = [];
      (svc as unknown as { host: { confirm: (m: string) => Promise<boolean> } }).host.confirm = async m => (
        asked.push(m), ok
      );
      return asked;
    };

    it('offers the old ID back after a merge, before the duplicate it makes for a moment', async () => {
      const { svc, files, fileOf } = service({
        'kept.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
        'merged.labnote.md': { text: note('LN-BBBBBBBB'), ctime: 2 },
      });
      svc.rememberIds();
      const asked = answering(svc, true);
      files.get('kept.labnote.md')!.text = note('LN-BBBBBBBB');

      expect(await svc.checkIdChange(fileOf('kept.labnote.md'))).toBe(true);

      expect(asked).toEqual([
        'The labnote_id of {0} changed from {1} to {2} (by merging notes, say). Worksheets already printed as {1} will not find this note. Restore {1}?',
      ]);
      expect(readNoteId(files.get('kept.labnote.md')!.text)).toBe('LN-AAAAAAAA');
      expect(await svc.checkIdChange(fileOf('kept.labnote.md'))).toBe(false);
      expect(asked).toHaveLength(1);
    });

    // The restore goes through writeId: when the old ID does not take, the user
    // is told so, not that it is back, and the note's ID stays the one it has.
    it('says so when the old ID could not be written back, and does not ask again', async () => {
      const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 } });
      svc.rememberIds();
      const asked = answering(svc, true);
      files.get('a.labnote.md')!.text = note('LN-CCCCCCCC');
      (svc as unknown as { app: { vault: { process: () => Promise<string> } } }).app.vault.process = async () => '';

      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(true);
      expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-CCCCCCCC');
      expect(notices.some(n => n.includes('could not be written'))).toBe(true);
      expect(notices.some(n => n.includes('has the note ID'))).toBe(false);
      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(false);
      expect(asked).toHaveLength(1);
    });

    it('keeps the new ID when the question is declined, and does not ask again', async () => {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 } });
      svc.rememberIds();
      const asked = answering(svc, false);
      files.get('a.labnote.md')!.text = note('LN-CCCCCCCC');

      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(true);
      expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-CCCCCCCC');
      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(false);
      expect(asked).toHaveLength(1);
    });

    it('does not ask about an ID labnoteo gave, nor one another note holds', async () => {
      const { svc, files, fileOf } = service({
        'orig.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
        'copy.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 5 },
        'b.labnote.md': { text: note('LN-BBBBBBBB'), ctime: 6 },
      });
      svc.rememberIds();
      const asked = answering(svc, true);

      // A re-numbered duplicate, and a copied experiment's renewed ID.
      await svc.offerDuplicateFixes();
      expect(await svc.checkIdChange(fileOf('copy.labnote.md'))).toBe(false);
      await svc.ensureId(fileOf('b.labnote.md'), { reassign: true });
      expect(await svc.checkIdChange(fileOf('b.labnote.md'))).toBe(false);

      // A colleague's fix of a duplicate, pulled: the original still holds the old ID.
      files.set('c.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 7 });
      expect(await svc.checkIdChange(fileOf('c.labnote.md'))).toBe(false);
      files.get('c.labnote.md')!.text = note('LN-DDDDDDDD');
      expect(await svc.checkIdChange(fileOf('c.labnote.md'))).toBe(false);

      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('share the note ID');
    });

    it('follows a renamed note, and compares nothing before the IDs are remembered', async () => {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 } });
      const asked = answering(svc, false);
      files.get('a.labnote.md')!.text = note('LN-CCCCCCCC');
      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(false);

      svc.rememberIds();
      files.set('b.labnote.md', files.get('a.labnote.md')!);
      files.delete('a.labnote.md');
      svc.moveKnown('a.labnote.md', 'b.labnote.md');
      files.get('b.labnote.md')!.text = note('LN-AAAAAAAA');
      expect(await svc.checkIdChange(fileOf('b.labnote.md'))).toBe(true);
      expect(asked).toHaveLength(1);
    });
  });
});

// L2: a copied note whose labnote_id is written over several lines has an ID that can be
// neither read nor written; that is said (the NoteIdService warning), not taken for none.
describe('BarcodeFeature and a labnote_id over several lines', () => {
  function feature(text: string) {
    const files = new Map([['a.labnote.md', text]]);
    const notices: { level: string; msg: string }[] = [];
    const fileOf = (p: string) => new TFile(p) as unknown as ObsidianTFile;
    const app = {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(fileOf),
        getAbstractFileByPath: (p: string) => (files.has(p) ? fileOf(p) : null),
        read: async (f: TFile) => files.get(f.path)!,
        process: async (f: TFile, fn: (s: string) => string) => {
          files.set(f.path, fn(files.get(f.path)!));
        },
      },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(files.get(f.path)!) } }) },
    } as unknown as App;
    const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
    const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true, pick: async () => 'new' } as unknown as LabnoteHost;
    const f = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(f, { plugin: { app, host, t }, noteIds: new NoteIdService(app, host) });
    return { f, files, notices, file: fileOf('a.labnote.md') };
  }
  const note = (nl: string, rest: string) => ['---', 'labnote_id: LN-7K3M9QX2', rest, 'created_date: 2020-01-01', '---', 'body', ''].join(nl);

  it.each([
    ['LF, indented', '\n', '  continued'],
    ['CRLF, indented', '\r\n', '  continued'],
    ['LF, "- " item', '\n', '- continued'],
    ['CRLF, "- " item', '\r\n', '- continued'],
  ])('reassignCopiedId warns and leaves it (%s)', async (_name, nl, rest) => {
    const { f, files, notices, file } = feature(note(nl, rest));
    expect(await f.reassignCopiedId(file)).toBe('refused');
    expect(files.get('a.labnote.md')).toBe(note(nl, rest));
    expect(notices).toEqual([{ level: 'warn', msg: expect.stringContaining('could not be written') }]);
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('reassignCopiedId gives a one-line ID a new one, as before (%s)', async (_name, nl) => {
    const text = ['---', 'labnote_id: LN-7K3M9QX2', '---', 'body', ''].join(nl);
    const { f, files, notices, file } = feature(text);
    expect(await f.reassignCopiedId(file)).toBe('renewed');
    expect(readNoteId(files.get('a.labnote.md')!)).not.toBe('LN-7K3M9QX2');
    expect(notices.map(n => n.level)).toEqual(['info']);
  });

  it('reassignCopiedId says nothing for a note without labnote_id', async () => {
    const { f, notices, file } = feature('---\ntitle: T\n---\nbody\n');
    expect(await f.reassignCopiedId(file)).toBe('none');
    expect(notices).toEqual([]);
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('moveScansWithNote warns instead of leaving the scans silently (%s)', async (_name, nl) => {
    const { f, notices } = feature(note(nl, '  continued'));
    expect(await f.moveScansWithNote('a.labnote.md', 'A/001', 'B/001')).toBe('refused');
    expect(notices).toEqual([{ level: 'warn', msg: expect.stringContaining('could not be written') }]);
  });
});

// L2: an empty first value with the ID on an indented line below (tab or spaces) is a value
// over several lines too: no ID, so printing stops and the scans stay, with a warning.
describe('a labnote_id on the line after an empty first value', () => {
  function setup(text: string) {
    const files = new Map([['a.labnote.md', text]]);
    const notices: { level: string; msg: string }[] = [];
    const fileOf = (p: string) => new TFile(p) as unknown as ObsidianTFile;
    const app = {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(fileOf),
        getAbstractFileByPath: (p: string) => (files.has(p) ? fileOf(p) : null),
        read: async (f: TFile) => files.get(f.path)!,
        process: async (f: TFile, fn: (s: string) => string) => {
          files.set(f.path, fn(files.get(f.path)!));
        },
      },
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: { labnote_id: readNoteId(files.get(f.path)!) } }) },
    } as unknown as App;
    const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
    const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true, pick: async () => 'new' } as unknown as LabnoteHost;
    const noteIds = new NoteIdService(app, host);
    const f = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(f, { plugin: { app, host, t }, noteIds });
    return { f, noteIds, app, host, t, files, notices, file: fileOf('a.labnote.md') };
  }
  const cases = ['\t', '  '].flatMap(ind => ['\n', '\r\n'].map(nl => [JSON.stringify(ind), JSON.stringify(nl), ind, nl]));
  const note = (ind: string, nl: string) => ['---', 'labnote_id:', `${ind}LN-7K3M9QX2`, '---', '### [H01 Test]', '#### Method', '1. Test', ''].join(nl);

  it.each(cases)('reads no ID (%s, %s)', (_a, _b, ind, nl) => {
    expect(readNoteId(note(ind, nl))).toBeUndefined();
  });

  it.each(cases)('stops printing the whole note with a warning (%s, %s)', async (_a, _b, ind, nl) => {
    const { noteIds, app, host, t, files, notices, file } = setup(note(ind, nl));
    // Past the ID the print measures in the DOM, which this test has none of: reaching it throws.
    await printFullNoteCommand(
      { app, host, t, paper: () => 'A4', setPaper: async () => {}, ensureNoteId: (x: ObsidianTFile) => noteIds.ensureId(x) } as unknown as Parameters<typeof printFullNoteCommand>[0],
      file
    );
    expect(files.get('a.labnote.md')).toBe(note(ind, nl));
    expect(notices.some(n => n.level === 'warn')).toBe(true);
  });

  it.each(cases)('moves no scans and says why (%s, %s)', async (_a, _b, ind, nl) => {
    const { f, notices } = setup(note(ind, nl));
    expect(await f.moveScansWithNote('a.labnote.md', 'A/001', 'B/001')).toBe('refused');
    expect(notices).toEqual([{ level: 'warn', msg: expect.stringContaining('could not be written') }]);
  });
});

// Codex v7m: a labnote_id continued on the next line cannot be written, so asking for a new
// ID (or a restore) would only fail. Each call says so once and asks nothing.
describe('a labnote_id that cannot be written, asked about before', () => {
  function setup(nl: string) {
    const text = ['---', 'labnote_id: LN-AAAAAAAA', '  continued', '---', 'body', ''].join(nl);
    const files = new Map([['a.labnote.md', text]]);
    const notices: { level: string; msg: string }[] = [];
    const counts = { asked: 0 };
    const fileOf = (p: string) => new TFile(p) as unknown as ObsidianTFile;
    const app = {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(fileOf),
        getAbstractFileByPath: (p: string) => (files.has(p) ? fileOf(p) : null),
        read: async (f: TFile) => files.get(f.path)!,
        process: async (f: TFile, fn: (s: string) => string) => { files.set(f.path, fn(files.get(f.path)!)); },
      },
      // As Obsidian reads it: the continued value.
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: parseFrontMatterYaml(files.get(f.path)!.replace(/\r\n/g, '\n')).frontMatter }) },
    } as unknown as App;
    const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
    const host = {
      notify: (level: string, msg: string) => notices.push({ level, msg }),
      t,
      confirm: async () => { counts.asked++; return true; },
      pick: async () => { counts.asked++; return 'new'; },
    } as unknown as LabnoteHost;
    const noteIds = new NoteIdService(app, host);
    const warns = () => notices.filter(n => n.level === 'warn').length;
    return { noteIds, app, host, t, files, text, counts, warns, file: fileOf('a.labnote.md') };
  }
  const cases = [['LF', '\n'], ['CRLF', '\r\n']];

  it.each(cases)('ensureIdResult asks nothing and warns once per call (%s)', async (_name, nl) => {
    const { noteIds, files, text, counts, warns, file } = setup(nl);
    const seen: number[][] = [];
    for (let k = 0; k < 3; k++) {
      expect(await noteIds.ensureIdResult(file)).toEqual({ reason: 'unreadable' });
      seen.push([counts.asked, warns()]);
    }
    expect(seen).toEqual([[0, 1], [0, 2], [0, 3]]);
    expect(files.get('a.labnote.md')).toBe(text);
  });

  it.each(cases)('printing the whole note asks nothing and warns once per call (%s)', async (_name, nl) => {
    const { noteIds, app, host, t, files, text, counts, warns, file } = setup(nl);
    const seen: number[][] = [];
    for (let k = 0; k < 3; k++) {
      await printFullNoteCommand(
        { app, host, t, paper: () => 'A4', setPaper: async () => {}, ensureNoteId: (x: ObsidianTFile) => noteIds.ensureId(x) } as unknown as Parameters<typeof printFullNoteCommand>[0],
        file
      );
      seen.push([counts.asked, warns()]);
    }
    expect(seen).toEqual([[0, 1], [0, 2], [0, 3]]);
    expect(files.get('a.labnote.md')).toBe(text);
  });

  // The same before offering an ID back: a changed ID now on the line below asks nothing.
  it.each(cases)('asks nothing about restoring a changed ID it could not write (%s)', async (_name, nl) => {
    const { noteIds, files, counts, warns, file } = setup(nl);
    files.set('a.labnote.md', ['---', 'labnote_id: LN-BBBBBBBB', '---', 'body', ''].join(nl));
    noteIds.rememberIds();
    files.set('a.labnote.md', ['---', 'labnote_id:', '  LN-AAAAAAAA', '---', 'body', ''].join(nl));
    expect(await noteIds.checkIdChange(file)).toBe(true);
    expect([counts.asked, warns()]).toEqual([0, 1]);
  });
});

// A copy whose labnote_id cannot be written (over several lines) still shares the original's
// ID as Obsidian reads it. Re-numbering it would fail, so it is not asked about: it is said
// once per note this session, and the set stays reported as in B6 (the Assign note ID command
// or a reload looks again).
describe('a shared note ID whose re-numbering could not be written', () => {
  function setup(nl: string, answer: boolean, copyText?: string) {
    const text = (id: string, multi: boolean) => ['---', ...(multi ? ['labnote_id:', `  ${id}`] : [`labnote_id: ${id}`]), '---', 'body', ''].join(nl);
    const files = new Map([
      ['orig.labnote.md', { text: text('LN-AAAAAAAA', false), ctime: 1 }],
      ['copy.labnote.md', { text: copyText ?? text('LN-AAAAAAAA', true), ctime: 5 }],
    ]);
    const fileOf = (p: string) => Object.assign(new TFile(p), { stat: { ctime: files.get(p)!.ctime } }) as unknown as ObsidianTFile;
    const notices: { level: string; msg: string }[] = [];
    const counts = { asked: 0 };
    const app = {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(fileOf),
        getAbstractFileByPath: (p: string) => (files.has(p) ? fileOf(p) : null),
        read: async (f: TFile) => files.get(f.path)!.text,
        process: async (f: TFile, fn: (s: string) => string) => { files.get(f.path)!.text = fn(files.get(f.path)!.text); },
      },
      // As Obsidian reads it: the YAML value, here the ID on the line below too. Obsidian knows
      // the timestamp tag the core schema refuses, so it is read without the tag.
      metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: parseFrontMatterYaml(files.get(f.path)!.text.replace(/\r\n/g, '\n').replace(/!!timestamp /g, '')).frontMatter }) },
    } as unknown as App;
    const host = {
      notify: (level: string, msg: string) => notices.push({ level, msg }),
      t: (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.split(`{${i}}`).join(String(a)), s),
      confirm: async (msg: string) => { counts.asked++; asked.push(/Give (\S+) a new ID/.exec(msg)?.[1] ?? msg); return answer; },
      pick: async () => 'new',
    } as unknown as LabnoteHost;
    const asked: string[] = [];
    const svc = new NoteIdService(app, host);
    const copy = fileOf('copy.labnote.md');
    // What barcodeFeature's 'changed' handler does for the copy.
    const changed = async (f: ObsidianTFile = copy) => { if (svc.sharesId(f)) await svc.offerDuplicateFixes(); };
    const warns = () => notices.filter(n => n.level === 'warn').length;
    // The copy flows' re-numbering, from the feature over the same service.
    const feature = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(feature, { plugin: { app, host, t: host.t }, noteIds: svc });
    return { files, text, counts, notices, warns, changed, fileOf, asked, svc, feature, copy };
  }
  const cases = [['LF', '\n'], ['CRLF', '\r\n']];
  it.each(cases)('asks nothing over three changes while the field is as it was, and says so once (%s)', async (_name, nl) => {
    const { counts, warns, changed, files, text } = setup(nl, true);
    const seen: number[] = [];
    for (let k = 0; k < 3; k++) { await changed(); seen.push(counts.asked); }
    expect(seen).toEqual([0, 0, 0]);
    expect(warns()).toBe(1);
    expect(files.get('copy.labnote.md')!.text).toBe(text('LN-AAAAAAAA', true));
  });

  // Codex v7o 1: the newest of three cannot be written. B6 asked about it and stopped when the
  // re-numbering failed; the older copy is not asked about or re-numbered instead.
  it.each(cases)('stops at a newest note it cannot write, as B6 did, re-numbering no other (%s)', async (_name, nl) => {
    const copy2 = ['---', 'labnote_id:', '  LN-AAAAAAAA', 'created_date: !!timestamp 2026-11-03', '---', 'body', ''].join(nl);
    const { notices, warns, changed, files, text, fileOf, asked } = setup(nl, true, copy2);
    files.set('copy1.labnote.md', { text: text('LN-AAAAAAAA', false), ctime: 3 });
    await changed(fileOf('copy1.labnote.md'));
    expect(asked.filter(a => a !== 'copy.labnote.md')).toEqual([]);
    expect(files.get('copy1.labnote.md')!.text).toBe(text('LN-AAAAAAAA', false));
    expect(notices.filter(n => n.level === 'info')).toEqual([]);
    expect(warns()).toBe(1);
  });

  // Codex v7o 2: the copy flow said it, so the shared ID found after says nothing more.
  it.each(cases)('says it once over a copy handled and three changes after (%s)', async (_name, nl) => {
    const { warns, changed, feature, copy, counts } = setup(nl, true);
    expect(await feature.reassignCopiedId(copy)).toBe('refused');
    for (let k = 0; k < 3; k++) await changed();
    expect(warns()).toBe(1);
    expect(counts.asked).toBe(0);
  });

  // Codex v7o 2: an ID changed to one that cannot be written back, then found shared.
  it.each(cases)('says it once over a changed ID not restored and the shared ID after (%s)', async (_name, nl) => {
    const { warns, changed, files, text, svc, copy, counts } = setup(nl, true);
    files.get('copy.labnote.md')!.text = text('LN-CCCCCCCC', false);
    svc.rememberIds();
    files.get('copy.labnote.md')!.text = text('LN-AAAAAAAA', true);
    expect(await svc.checkIdChange(copy)).toBe(true);
    for (let k = 0; k < 2; k++) if (!(await svc.checkIdChange(copy))) await changed();
    expect(warns()).toBe(1);
    expect(counts.asked).toBe(0);
  });

  // Codex v7n: newer notes with the same ID come in one by one, every question said yes to.
  // B6 asked 4 times (copy, then each new note); the copy is not asked about again.
  it.each(cases)('asks only about the newer notes that join, not the copy again (%s)', async (_name, nl) => {
    const { counts, warns, changed, files, text, fileOf, asked } = setup(nl, true);
    await changed();
    for (let k = 0; k < 3; k++) {
      files.set(`third${k}.labnote.md`, { text: text('LN-AAAAAAAA', false), ctime: 10 + k });
      await changed(fileOf(`third${k}.labnote.md`));
    }
    expect(asked).toEqual(['third0.labnote.md', 'third1.labnote.md', 'third2.labnote.md']);
    expect(counts.asked).toBeLessThanOrEqual(4);
    expect(warns()).toBe(1);
  });

  // The copy renamed three times: B6 asked once. Each new path is said once more (allowed).
  it.each(cases)('asks nothing about a copy renamed three times (%s)', async (_name, nl) => {
    const { counts, warns, changed, files, fileOf } = setup(nl, true);
    await changed();
    let path = 'copy.labnote.md';
    for (let k = 0; k < 3; k++) {
      const next = `copy${k}.labnote.md`;
      files.set(next, files.get(path)!);
      files.delete(path);
      path = next;
      await changed(fileOf(path));
    }
    expect(counts.asked).toBeLessThanOrEqual(1);
    expect(counts.asked).toBe(0);
    expect(warns()).toBe(4);
  });

  // Codex v7l 1: another field the core schema refuses as well; the ID put on one line later
  // asks no more than B6 did (once).
  it.each(cases)('asks no more than once when another field fails too and the ID goes on one line (%s)', async (_name, nl) => {
    const copyText = ['---', 'labnote_id:', '  LN-AAAAAAAA', 'created_date: !!timestamp 2026-11-03', '---', 'body', ''].join(nl);
    const { counts, warns, changed, files } = setup(nl, true, copyText);
    await changed();
    const seen = [counts.asked];
    files.get('copy.labnote.md')!.text = ['---', 'labnote_id: LN-AAAAAAAA', 'created_date: !!timestamp 2026-11-03', '---', 'body', ''].join(nl);
    for (let k = 0; k < 3; k++) { await changed(); seen.push(counts.asked); }
    expect(seen).toEqual([0, 0, 0, 0]);
    expect(warns()).toBe(1);
  });

  // B6 asked once and a cancel kept it quiet; now it is not asked about at all, the ID put on
  // one line later included.
  it.each(cases)('keeps quiet, the ID put on one line later included (%s)', async (_name, nl) => {
    const { counts, changed, files, text } = setup(nl, false);
    await changed();
    await changed();
    files.get('copy.labnote.md')!.text = text('LN-AAAAAAAA', false);
    await changed();
    expect(counts.asked).toBe(0);
  });
});
