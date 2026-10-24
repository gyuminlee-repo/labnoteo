/**
 * Any web page can open an `obsidian://` URI, so these parameters are the one
 * untrusted entry point into the plugin. Everything that is not exactly what
 * it claims to be is refused before anything is fetched or written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from '../stubs/obsidian';
import { parseImportRequest, IMPORT_ACTION, deliverReference } from '../../src/partbank/partbankUri';
import { confirmModal } from '../../src/modals';
import { insertSampleReference } from '../../src/sampleActions';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/modals', () => ({ confirmModal: vi.fn(), pickModal: vi.fn() }));
vi.mock('../../src/sampleActions', () => ({ insertSampleReference: vi.fn() }));

const OBJECT_ID = '507f1f77bcf86cd799439011';
const WEB = 'https://partbank.kbiofoundry.kr';

describe('parseImportRequest', () => {
  it('reads a well-formed link', () => {
    expect(parseImportRequest({ server: ` ${WEB} `, type: 'part', id: ` ${OBJECT_ID} ` })).toEqual({
      server: WEB,
      type: 'part',
      id: OBJECT_ID,
    });
  });

  it('accepts the six partbank types, in any case', () => {
    for (const type of ['part', 'device', 'plasmid', 'primer', 'molecule', 'strain']) {
      expect(parseImportRequest({ server: WEB, type: type.toUpperCase(), id: OBJECT_ID })?.type).toBe(
        type
      );
    }
    expect(parseImportRequest({ server: WEB, type: 'storage', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'vector', id: OBJECT_ID })).toBeUndefined();
  });

  // Only a Mongo ObjectId can name an item; a KID or a path cannot.
  it('refuses an id that is not a 24-character hex string', () => {
    expect(parseImportRequest({ server: WEB, type: 'part', id: 'KBp_aa0001' })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: OBJECT_ID.slice(1) })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: `${OBJECT_ID}/..` })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: '' })).toBeUndefined();
  });

  it('refuses a server that is not an http(s) address', () => {
    expect(parseImportRequest({ server: '', type: 'part', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: 'partbank.kr', type: 'part', id: OBJECT_ID })).toBeUndefined();
    expect(
      parseImportRequest({ server: 'file:///etc/passwd', type: 'part', id: OBJECT_ID })
    ).toBeUndefined();
    expect(
      parseImportRequest({ server: 'javascript:alert(1)', type: 'part', id: OBJECT_ID })
    ).toBeUndefined();
  });

  it('refuses a link with parameters missing', () => {
    expect(parseImportRequest({})).toBeUndefined();
    expect(parseImportRequest({ server: WEB })).toBeUndefined();
    expect(parseImportRequest({ type: 'part', id: OBJECT_ID })).toBeUndefined();
  });

  // Renaming this would silently break the button in partbank.
  it('answers the action partbank links to', () => {
    expect(IMPORT_ACTION).toBe('labnoteo-import');
  });
});

// #284: declining the insert still put the reference on the clipboard.
describe('deliverReference', () => {
  const writeText = vi.fn();
  const target = { path: 'labnote/001_A/001_WD010_A.labnote.md' };
  const plugin = (open: boolean, tracked = true) =>
    ({
      app: {},
      t: (key: string, ...args: string[]) => args.reduce((s, a, i) => s.replace(`{${i}}`, a), key),
      host: { editTarget: () => (open ? target : undefined) },
      sampleTrackingFor: () => tracked,
    }) as unknown as LabnotePlugin;

  beforeEach(() => {
    vi.mocked(confirmModal).mockReset();
    vi.mocked(insertSampleReference).mockReset();
    writeText.mockReset();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    Notice.reset();
  });

  it('inserts into the open note when confirmed', async () => {
    vi.mocked(confirmModal).mockResolvedValue(true);
    await deliverReference(plugin(true), 'DNA-1;pX');
    expect(insertSampleReference).toHaveBeenCalledWith(expect.anything(), target, 'DNA-1;pX');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does nothing when the insert is declined', async () => {
    vi.mocked(confirmModal).mockResolvedValue(false);
    await deliverReference(plugin(true), 'DNA-1;pX');
    expect(insertSampleReference).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
  });

  it('copies without asking when no tracked note is open', async () => {
    for (const p of [plugin(false), plugin(true, false)]) {
      await deliverReference(p, 'DNA-1;pX');
    }
    expect(confirmModal).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(Notice.shown).toEqual(['Copied DNA-1;pX to the clipboard.', 'Copied DNA-1;pX to the clipboard.']);
  });
});
