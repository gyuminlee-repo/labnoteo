/** The canvas-based {@link PageDecoder}: photos, scanner PDFs and zips of either. */
import { IMAGE_KINDS, findQr, isBlankPage, loadBitmap, renderJpeg, sniffFileKind, type Rotation } from './decode';
import { forEachPdfPage } from './pdfPages';
import { sha256Hex, shortHash } from './imageStore';
import { unzipScans, type DecodedPage, type PageDecoder, type ScanInput, type ScanResult } from './scanPipeline';

export interface ImageOutput {
  maxEdge: number;
  quality: number;
}

export function createPageDecoder(output: () => ImageOutput): PageDecoder {
  async function decodeBitmap(
    bitmap: ImageBitmap,
    source: string,
    hash: string,
    sourcePage: number | undefined
  ): Promise<DecodedPage> {
    const blank = isBlankPage(bitmap);
    const qr = blank ? null : (await findQr(bitmap)).hit;
    const rotation: Rotation = qr?.rotation ?? 0;
    return {
      source,
      sourcePage,
      hash,
      blank,
      payload: qr?.payload,
      render: () => renderJpeg(bitmap, rotation, output().maxEdge, output().quality),
    };
  }

  async function expand(
    input: ScanInput,
    onPage: (page: DecodedPage) => Promise<void>,
    inZip = false
  ): Promise<ScanResult[]> {
    const kind = sniffFileKind(new Uint8Array(input.bytes, 0, Math.min(16, input.bytes.byteLength)));
    const fileHash = shortHash(await sha256Hex(input.bytes));
    if (IMAGE_KINDS.has(kind)) {
      const bitmap = await loadBitmap(input.bytes);
      try {
        await onPage(await decodeBitmap(bitmap, input.name, fileHash, undefined));
      } finally {
        bitmap.close();
      }
      return [];
    }
    if (kind === 'pdf') {
      const { skipped } = await forEachPdfPage(input.bytes, async page => {
        try {
          const hash = shortHash(await sha256Hex(new TextEncoder().encode(`${fileHash}:${page.page}`)));
          await onPage(await decodeBitmap(page.bitmap, input.name, hash, page.page));
        } finally {
          page.bitmap.close();
        }
      });
      return skipped > 0 ? [{ source: input.name, status: 'unsupported', reason: 'pdf-limit' }] : [];
    }
    if (kind === 'zip' && !inZip) {
      const { files, overLimit } = unzipScans(input.bytes);
      const results: ScanResult[] = [];
      for (const file of files) results.push(...(await expand(file, onPage, true)));
      if (overLimit) results.push({ source: input.name, status: 'unsupported', reason: 'zip-limit' });
      return results;
    }
    const reason = kind === 'heic' ? 'heic' : kind === 'tiff' ? 'tiff' : 'unknown';
    return [{ source: input.name, status: 'unsupported', reason }];
  }

  return { expand: (input, onPage) => expand(input, onPage) };
}
