import {
  decodeScanPayload,
  encodeNotePayload,
  encodePagePayload,
  isPagePayload,
  payloadLabel,
  unitOpFingerprint,
  type PagePayload,
} from '../lib/scanPayload';

const page: PagePayload = {
  noteId: 'LN-7K3M9QX2',
  unitOpIndex: 3,
  opId: 'UHW010',
  page: 2,
  pageCount: 3,
  printedOn: '2026-10-15',
};

describe('scan payload', () => {
  it('round-trips a worksheet page', () => {
    const text = encodePagePayload(page);
    expect(text).toBe('LN1:LN-7K3M9QX2:3:UHW010:2/3:261015');
    expect(decodeScanPayload(text)).toEqual(page);
    expect(payloadLabel(page)).toBe('LN-7K3M9QX2 · UHW010 · 2/3');
  });

  it('round-trips a note-only payload and a page before any unit operation', () => {
    const note = decodeScanPayload(encodeNotePayload('LN-7K3M9QX2'));
    expect(note).toEqual({ noteId: 'LN-7K3M9QX2' });
    expect(isPagePayload(note!)).toBe(false);
    const head = { ...page, unitOpIndex: 0, opId: '' };
    expect(encodePagePayload(head)).toBe('LN1:LN-7K3M9QX2:0:-:2/3:261015');
    expect(decodeScanPayload(encodePagePayload(head))).toEqual(head);
  });

  it('carries the block fingerprint on unit-operation pages only (#304)', () => {
    const withFp = { ...page, fingerprint: unitOpFingerprint('Liquid Handling', '2차 정제') };
    const text = encodePagePayload(withFp);
    expect(text).toBe(`LN1:LN-7K3M9QX2:3:UHW010:2/3:261015:${withFp.fingerprint}`);
    expect(decodeScanPayload(text)).toEqual(withFp);
    expect(encodePagePayload({ ...withFp, unitOpIndex: 0, opId: '' })).toBe('LN1:LN-7K3M9QX2:0:-:2/3:261015');
    expect(decodeScanPayload('LN1:LN-7K3M9QX2:0:-:2/3:261015:ABCD')).not.toHaveProperty('fingerprint');
  });

  it('fits the longest page payload in a version 4 QR at level Q (46 bytes)', () => {
    const longest = encodePagePayload({ ...page, unitOpIndex: 12, opId: 'UHW290', page: 12, pageCount: 12, fingerprint: 'ZZZZ' });
    expect(longest.length).toBeLessThanOrEqual(46);
  });

  it('fingerprints a name and alias the same way in Markdown and as rendered', () => {
    const fp = unitOpFingerprint('Liquid Handling', '2차 정제');
    expect(fp).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(unitOpFingerprint('liquid  handling', ' 2차 정제 ')).toBe(fp);
    expect(unitOpFingerprint('Liquid Handling', '**2차** 정제')).toBe(fp);
    expect(unitOpFingerprint('Liquid Handling', '`2차` 정제')).toBe(fp);
    expect(unitOpFingerprint('Liquid Handling', '1차 정제')).not.toBe(fp);
    expect(unitOpFingerprint('Liquid Handling', 'a\\*b')).toBe(unitOpFingerprint('Liquid Handling', 'a*b'));
  });

  it('rejects other QR codes and inconsistent pages', () => {
    for (const text of [
      'https://example.com',
      'LN1:LN-7K3M9QXI',
      'LN2:LN-7K3M9QX2',
      'LN1:LN-7K3M9QX2:3:UHW010:4/3:261015',
      'LN1:LN-7K3M9QX2:0:UHW010:1/3:261015',
      'LN1:LN-7K3M9QX2:3:-:1/3:261015',
      'LN1:LN-7K3M9QX2:3:UHW010:2/3:261015:ABC',
      'LN1:LN-7K3M9QX2:3:UHW010:2/3:261015:ABCI',
    ]) {
      expect(decodeScanPayload(text)).toBeUndefined();
    }
  });
});
