import {
  decodeScanPayload,
  encodeNotePayload,
  encodePagePayload,
  isPagePayload,
  payloadLabel,
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

  it('rejects other QR codes and inconsistent pages', () => {
    for (const text of [
      'https://example.com',
      'LN1:LN-7K3M9QXI',
      'LN2:LN-7K3M9QX2',
      'LN1:LN-7K3M9QX2:3:UHW010:4/3:261015',
      'LN1:LN-7K3M9QX2:0:UHW010:1/3:261015',
      'LN1:LN-7K3M9QX2:3:-:1/3:261015',
    ]) {
      expect(decodeScanPayload(text)).toBeUndefined();
    }
  });
});
