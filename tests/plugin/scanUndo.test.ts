/**
 * Undoing a filed scan, or deleting the earlier scan of its page, from the results window: a
 * note not written, or that may not have been, is said so and keeps the button to try again;
 * a scan no longer in the note is said so and the button goes.
 */
import { describe, it, expect } from 'vitest';
import { formatMessage, type Translator } from '../../packages/labnoteo-core/src/i18n/translator';
import { undoScanResult } from '../../src/scan/resultModal';
import type { ScanResult } from '../../src/scan/scanPipeline';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const t = ((key: string, ...args: string[]) => formatMessage(key, args)) as Translator;
const result = { status: 'filed', source: 'a.jpg', notePath: NOTE, hash: 'aaaaaaaaaaaa', previous: [] } as unknown as ScanResult;
type Earlier = { removed: number; trashed: number };
const answering = (out: boolean | Earlier | 'notWritten' | 'uncertain') => ({
  undo: async () => out as boolean | 'notWritten' | 'uncertain',
  removePrevious: async () => out as Earlier | 'notWritten' | 'uncertain',
});

describe('undo from the scan results', () => {
  it.each([false, true] as const)('a note not written keeps the button (earlier scan: %s)', async earlier => {
    expect(await undoScanResult(t, answering('notWritten'), result, earlier)).toEqual({
      done: false,
      message: `${NOTE} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.`,
    });
  });

  it.each([false, true] as const)('a note that may not have it keeps the button (earlier scan: %s)', async earlier => {
    expect(await undoScanResult(t, answering('uncertain'), result, earlier)).toEqual({
      done: false,
      message: `${NOTE} may or may not have the change: it was being saved when another change reached it. Check the note before trying again.`,
    });
  });

  it('a scan no longer in the note is said so, and done', async () => {
    expect(await undoScanResult(t, answering(false), result, false)).toEqual({ done: true, message: 'The scan was no longer in the note.' });
  });

  it('an earlier scan removed is counted, and done', async () => {
    expect(await undoScanResult(t, answering({ removed: 1, trashed: 1 }), result, true)).toEqual({ done: true, message: 'Removed 1 earlier scan(s).' });
  });

  // The entries and the images counted apart when they differ, as done.
  it('says both counts when the images moved are not as many as the entries removed', async () => {
    expect(await undoScanResult(t, answering({ removed: 0, trashed: 1 }), result, true)).toEqual({
      done: true,
      message: 'Removed 0 earlier scan(s) from the note and moved 1 image(s) to the trash.',
    });
  });
});
