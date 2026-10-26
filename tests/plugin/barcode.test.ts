import { describe, it, expect } from 'vitest';
import type { App, TFile as ObsidianTFile } from 'obsidian';
import jsQR from 'jsqr';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '../../packages/labnoteo-core/src';
import { readNoteId } from '../../packages/labnoteo-core/src/lib/noteId';
import { encodePagePayload, decodeScanPayload } from '../../packages/labnoteo-core/src/lib/scanPayload';
import { qrMatrix, qrSvg, QR_QUIET_ZONE } from '../../src/barcode/qr';
import { NoteIdService, previousNoteIdFromScans } from '../../src/barcode/noteIdService';
import { planScanMoves } from '../../src/barcode/barcodeFeature';
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
});
