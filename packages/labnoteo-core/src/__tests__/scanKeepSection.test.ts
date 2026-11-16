import { describe, it, expect } from 'vitest';
import { hasScanSection, insertScanEntries, removeScanEntry } from '../sections/scanInsert';

// A note whose Worksheet scans section was there, empty, before a scan went in: an undo puts it back.
describe('an emptied Worksheet scans section the note had before', () => {
  const before = '---\nlabnote_id: LN-YE3P5MH2\n---\n## [WB030 DNA Assembly] fmempty\n\n## Worksheet scans\n\n## Notes\nEmpty front matter fixture.\n';
  const entry = { page: 1, pageCount: 1, hash: '2d6815adc8b3', embed: '![[LN-YE3P5MH2_u0_p1_20261111.jpg|200]]', caption: 'cap' };

  it('is found before the scan goes in', () => {
    expect(hasScanSection(before, null)).toBe(true);
    expect(hasScanSection('## [WB030 X]\n\n## Notes\n', null)).toBe(false);
  });

  it('keeps its heading when told to, and goes otherwise', () => {
    const filed = insertScanEntries(before, null, [entry]);
    expect(removeScanEntry(filed, entry.hash, { keepSection: true })).toEqual({ md: before, removed: true });
    expect(removeScanEntry(filed, entry.hash).md).not.toContain('Worksheet scans');
  });
});
