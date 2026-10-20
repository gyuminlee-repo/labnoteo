/**
 * The one path every scan takes, whatever brought it in (scan folder, drag and
 * drop, Slack): split PDFs and zips into pages, read each page's QR code, find
 * the note and unit operation it was printed from, store the image and file it
 * there. Pages are handled one at a time with pauses for the UI, and each note
 * is written once at the end of a batch.
 */
import { TFile, type App } from 'obsidian';
import { unzipSync } from 'fflate';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import {
  insertScanEntries,
  listFiledScans,
  listScanHashes,
  listUnitOpBlocks,
  removeScanEntry,
  resolveScanTarget,
  type ScanEntry,
} from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isPagePayload, type PagePayload, type ScanPayload } from '@labnoteo/core/lib/scanPayload';
import * as posix from '@labnoteo/core/posix';
import { processNoteThroughVault } from '../commands';
import type { NoteIdService } from '../barcode/noteIdService';
import {
  SCANS_SUBFOLDER,
  UNMATCHED_FOLDER,
  saveBinary,
  scanFileName,
  sha256Hex,
  shortHash,
  timestamp,
  unmatchedFileName,
} from './imageStore';

export interface ScanInput {
  name: string;
  bytes: ArrayBuffer;
}

export type ScanStatus = 'filed' | 'duplicate' | 'unmatched' | 'blank' | 'skipped' | 'unsupported' | 'error';

export type UnmatchedReason = 'no-qr' | 'note-not-found' | 'duplicate-id' | 'note-only' | 'no-unit-op' | 'ambiguous';
export type UnsupportedReason = 'heic' | 'tiff' | 'unknown' | 'zip-limit' | 'pdf-limit';

export interface ScanResult {
  /** The file handed to the pipeline (a zip, for its members). */
  input?: string;
  /** File the page came from. */
  source: string;
  /** Page within a PDF, 1-based. */
  sourcePage?: number;
  status: ScanStatus;
  reason?: UnmatchedReason | UnsupportedReason;
  /** Error message for `error`. */
  message?: string;
  payload?: ScanPayload;
  notePath?: string;
  imagePath?: string;
  hash?: string;
  unmatchedPath?: string;
  /** Scans of the same page filed before this one. */
  previous?: { hash: string; embed: string }[];
}

/** One page image, decoded. */
export interface DecodedPage {
  source: string;
  sourcePage?: number;
  /** Short content hash identifying the page across imports. */
  hash: string;
  blank: boolean;
  payload?: ScanPayload;
  /** The page upright, scaled and compressed for storing. */
  render(): Promise<ArrayBuffer>;
}

/** Turns an input file into pages; the canvas-based one lives in `pageDecoder.ts`. */
export interface PageDecoder {
  /** Calls `onPage` for each page in turn; returns results for inputs that yield no page. */
  expand(input: ScanInput, onPage: (page: DecodedPage) => Promise<void>): Promise<ScanResult[]>;
}

export interface PipelineDeps {
  app: App;
  host: LabnoteHost;
  t: Translator;
  noteIds: NoteIdService;
  decoder: PageDecoder;
  /** Updates `last_updated_date` of a note (and its README) the scan was filed in. */
  markUserEdit(path: string): void;
}

export interface RunOptions {
  /** Shared folders hold other photos too: pass over pages without our QR quietly. */
  skipNoQr?: boolean;
  onProgress?: (done: number, label: string) => void;
}

interface Pending {
  notePath: string;
  payload: PagePayload;
  entry: ScanEntry;
  result: ScanResult;
}

const ZIP_LIMITS = { entries: 200, entryBytes: 100 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 };
const ZIP_MEMBER_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|heic|heif|tiff?)$/i;

/** The page files of a zip, by file name only (folders inside are flattened), within safe limits. */
export function unzipScans(bytes: ArrayBuffer): { files: ScanInput[]; overLimit: boolean } {
  let count = 0;
  let total = 0;
  let overLimit = false;
  const entries = unzipSync(new Uint8Array(bytes), {
    filter: f => {
      const name = f.name.split('/').pop() ?? '';
      if (f.name.startsWith('__MACOSX/') || name.startsWith('.') || !ZIP_MEMBER_RE.test(name)) return false;
      if (count >= ZIP_LIMITS.entries || f.originalSize > ZIP_LIMITS.entryBytes || total + f.originalSize > ZIP_LIMITS.totalBytes) {
        overLimit = true;
        return false;
      }
      count++;
      total += f.originalSize;
      return true;
    },
  });
  const files = Object.entries(entries)
    .map(([path, data]) => ({
      name: path.split('/').pop() ?? path,
      bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { files, overLimit };
}

/** The vault path in an image embed line (`![[a.jpg|300]]`, `![](images/a.jpg)`). */
export function embedLinkPath(embed: string): string | undefined {
  const wiki = /^!\[\[([^\]|#]+)/.exec(embed);
  if (wiki) return wiki[1].trim();
  const md = /^!\[[^\]]*\]\(<?([^)>]+)>?\)/.exec(embed);
  if (!md) return undefined;
  try {
    return decodeURI(md[1].trim());
  } catch {
    return md[1].trim();
  }
}

export class ScanPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(inputs: readonly ScanInput[], opts: RunOptions = {}): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const pending: Pending[] = [];
    const batchHashes = new Set<string>();
    const noteText = new Map<string, string>();
    let done = 0;
    for (const input of inputs) {
      opts.onProgress?.(done, input.name);
      const first = results.length;
      try {
        const rest = await this.deps.decoder.expand(input, async page => {
          results.push(await this.filePage(page, opts, pending, batchHashes, noteText));
          opts.onProgress?.(++done, input.name);
        });
        results.push(...rest);
      } catch (err) {
        console.error('[labnoteo] scan failed:', input.name, err);
        results.push({ source: input.name, status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      for (let i = first; i < results.length; i++) results[i].input = input.name;
    }
    await this.flush(pending);
    return results;
  }

  private async readNote(path: string, cache: Map<string, string>): Promise<string> {
    let text = cache.get(path);
    if (text === undefined) {
      text = await this.deps.host.fs.read(path);
      cache.set(path, text);
    }
    return text;
  }

  private async filePage(
    page: DecodedPage,
    opts: RunOptions,
    pending: Pending[],
    batchHashes: Set<string>,
    noteText: Map<string, string>
  ): Promise<ScanResult> {
    const base: ScanResult = { source: page.source, sourcePage: page.sourcePage, status: 'error', hash: page.hash };
    if (page.blank) return { ...base, status: 'blank' };
    const payload = page.payload;
    if (!payload) {
      if (opts.skipNoQr) return { ...base, status: 'skipped', reason: 'no-qr' };
      return this.unmatched(page, base, 'no-qr');
    }
    base.payload = payload;
    const files = this.deps.noteIds.filesWithId(payload.noteId);
    if (files.length === 0) return this.unmatched(page, base, 'note-not-found');
    if (files.length > 1) return this.unmatched(page, base, 'duplicate-id');
    if (!isPagePayload(payload)) return this.unmatched(page, base, 'note-only');
    const notePath = files[0].path;
    base.notePath = notePath;

    const text = await this.readNote(notePath, noteText);
    const target = resolveScanTarget(listUnitOpBlocks(text), payload.unitOpIndex, payload.opId);
    if (target.kind === 'missing') return this.unmatched(page, base, 'no-unit-op');
    if (target.kind === 'ambiguous') return this.unmatched(page, base, 'ambiguous');
    if (batchHashes.has(page.hash) || listScanHashes(text).has(page.hash)) return { ...base, status: 'duplicate' };
    batchHashes.add(page.hash);

    const unitOpIndex = target.kind === 'block' ? target.block.index : 0;
    const previous = listFiledScans(text)
      .filter(s => s.unitOpIndex === unitOpIndex && s.page === payload.page)
      .map(s => ({ hash: s.hash, embed: s.embed }));
    const stored = await this.store(notePath, payload, unitOpIndex, await page.render());
    const result: ScanResult = { ...base, status: 'filed', imagePath: stored.file.path, previous };
    pending.push({
      notePath,
      payload,
      result,
      entry: {
        page: payload.page,
        pageCount: payload.pageCount,
        hash: page.hash,
        embed: stored.embed,
        caption: this.caption(payload, page),
      },
    });
    return result;
  }

  private async store(notePath: string, payload: PagePayload, unitOpIndex: number, jpeg: ArrayBuffer) {
    const { app } = this.deps;
    const dir = getExperimentDir(notePath) ?? posix.dirname(notePath);
    const name = scanFileName(payload.noteId, unitOpIndex, payload.page, getSeoulDateString());
    const file = await saveBinary(app, posix.join(dir, SCANS_SUBFOLDER), name, jpeg);
    const link = app.fileManager.generateMarkdownLink(file, notePath);
    return { file, embed: link.startsWith('!') ? link : `!${link}` };
  }

  private caption(payload: PagePayload, page: Pick<DecodedPage, 'source' | 'sourcePage'>): string {
    const source = page.sourcePage ? `${page.source} p.${page.sourcePage}` : page.source;
    return this.deps.t(
      'Printout {0}/{1} · printed {2} · imported {3} · {4}',
      String(payload.page),
      String(payload.pageCount),
      payload.printedOn,
      getSeoulDateString(),
      source
    );
  }

  private async unmatched(page: DecodedPage, base: ScanResult, reason: UnmatchedReason): Promise<ScanResult> {
    const name = unmatchedFileName(timestamp(), page.source, base.payload?.noteId, page.sourcePage);
    const file = await saveBinary(this.deps.app, UNMATCHED_FOLDER, name, await page.render());
    return { ...base, status: 'unmatched', reason, unmatchedPath: file.path };
  }

  /** Write every note of the batch once, then date it. */
  private async flush(pending: readonly Pending[]): Promise<void> {
    const byNote = new Map<string, Pending[]>();
    for (const p of pending) byNote.set(p.notePath, [...(byNote.get(p.notePath) ?? []), p]);
    for (const [notePath, items] of byNote) {
      const missed = new Set<Pending>();
      const apply = (content: string): string => {
        missed.clear();
        let out = content;
        for (const item of items) {
          const target = resolveScanTarget(listUnitOpBlocks(out), item.payload.unitOpIndex, item.payload.opId);
          if (target.kind === 'block') out = insertScanEntries(out, target.block, [item.entry]);
          else if (target.kind === 'note') out = insertScanEntries(out, null, [item.entry]);
          else missed.add(item);
        }
        return out;
      };
      try {
        await processNoteThroughVault(this.deps.app, this.deps.host, notePath, apply);
        this.deps.markUserEdit(notePath);
      } catch (err) {
        console.error('[labnoteo] could not file scans in', notePath, err);
        for (const item of items) Object.assign(item.result, { status: 'error', message: String(err) });
        continue;
      }
      // The note changed between reading and writing so that the unit operation is gone.
      for (const item of missed) Object.assign(item.result, { status: 'unmatched', reason: 'no-unit-op' });
    }
  }

  /**
   * File an image from the unmatched queue by hand into `note`'s
   * `unitOpIndex`-th unit operation (0: the note-level section).
   */
  async fileManually(
    image: TFile,
    note: TFile,
    unitOpIndex: number,
    page: { page: number; pageCount: number }
  ): Promise<ScanResult> {
    const { app } = this.deps;
    const noteId = await this.deps.noteIds.ensureId(note);
    if (!noteId) return { source: image.name, status: 'error', message: 'front matter could not be read' };
    const bytes = await app.vault.readBinary(image);
    const hash = shortHash(await sha256Hex(bytes));
    const block = unitOpIndex > 0 ? listUnitOpBlocks(await app.vault.read(note))[unitOpIndex - 1] : undefined;
    const payload: PagePayload = {
      noteId,
      unitOpIndex: block?.index ?? 0,
      opId: block?.opId ?? '',
      ...page,
      printedOn: getSeoulDateString(),
    };
    const decoded: DecodedPage = { source: image.name, hash, blank: false, payload, render: async () => bytes };
    const pending: Pending[] = [];
    const result = await this.filePage(decoded, {}, pending, new Set(), new Map());
    await this.flush(pending);
    if (result.status === 'filed' || result.status === 'duplicate') await app.fileManager.trashFile(image);
    return result;
  }

  /** Take a filed scan out of its note again and trash its image. */
  async undo(result: ScanResult): Promise<boolean> {
    if (result.status !== 'filed' || !result.notePath || !result.hash) return false;
    const hash = result.hash;
    let removed = false;
    await processNoteThroughVault(this.deps.app, this.deps.host, result.notePath, content => {
      const out = removeScanEntry(content, hash);
      removed = out.removed;
      return out.md;
    });
    const image = result.imagePath ? this.deps.app.vault.getAbstractFileByPath(result.imagePath) : null;
    if (image instanceof TFile) await this.deps.app.fileManager.trashFile(image);
    if (removed) this.deps.markUserEdit(result.notePath);
    return removed;
  }

  /** Remove the earlier scans of the page `result` filed (and trash their images). */
  async removePrevious(result: ScanResult): Promise<number> {
    const { app, host } = this.deps;
    if (!result.notePath || !result.previous?.length) return 0;
    const notePath = result.notePath;
    const images = result.previous
      .map(p => embedLinkPath(p.embed))
      .map(link => (link ? app.metadataCache.getFirstLinkpathDest(link, notePath) : null))
      .filter((f): f is TFile => f instanceof TFile);
    let count = 0;
    await processNoteThroughVault(app, host, notePath, content => {
      count = 0;
      let out = content;
      for (const p of result.previous!) {
        const r = removeScanEntry(out, p.hash);
        if (r.removed) count++;
        out = r.md;
      }
      return out;
    });
    for (const image of images) await app.fileManager.trashFile(image);
    if (count > 0) this.deps.markUserEdit(notePath);
    result.previous = [];
    return count;
  }
}
