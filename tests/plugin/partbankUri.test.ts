/**
 * Any web page can open an `obsidian://` URI, so these parameters are the one
 * untrusted entry point into the plugin. Everything that is not exactly what
 * it claims to be is refused before anything is fetched or written.
 */
import { describe, it, expect } from 'vitest';
import { parseImportRequest, IMPORT_ACTION } from '../../src/partbank/partbankUri';

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
