/**
 * A fence-like line in the front matter opens no code block: Obsidian reads the block as
 * properties. The unit operation section and the result sections read such a note as the
 * same note with those lines as plain text of the same length, the lines put back after.
 */
import { describe, it, expect } from 'vitest';
import { appendUnitOpToWorkflowToc, rebuildUnitOpToc, unitOpSectionLine } from '../sections/workflowSectionParser';
import { extractResultSections, hasRecordedResults } from '../lib/noteResults';

const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
const FENCES = ['  ```inline```', '  ```'];

/** `read` on `md` equals `read` on `md` with each fence-like front matter line as Q's, put back after. */
function asPlainText<T>(read: (md: string) => T, md: string): void {
  let plain = md;
  FENCES.forEach((l, i) => { plain = plain.split(l).join(`  Q${i}`.padEnd(l.length, 'q')); });
  let want = JSON.stringify(read(plain) ?? null);
  FENCES.forEach((l, i) => { want = want.split(`  Q${i}`.padEnd(l.length, 'q')).join(l); });
  expect(JSON.stringify(read(md) ?? null)).toBe(want);
}

describe('fence-like lines in the front matter', () => {
  const note = (nl: string, rest: string[]) => ['---', 'description: |', ...FENCES, '---', ...rest, ''].join(nl);

  it.each(endings)('a unit operation toc entry is appended as before (%s)', (_n, nl) => {
    const md = note(nl, ['## Related Unit Operations', '', '- [UHW010 A](#uhw010-a)', '', '---', '### [UHW010 A]']);
    expect(appendUnitOpToWorkflowToc(md, 'UHW020', 'B')).toBe(
      note(nl, ['## Related Unit Operations', '', '- [UHW010 A](#uhw010-a)', '- [UHW020 B](#uhw020-b)', '', '---', '### [UHW010 A]'])
    );
    expect(unitOpSectionLine(md)).toBe(5);
    asPlainText(rebuildUnitOpToc, md);
  });

  it.each(endings)('a template note has no recorded results, a written one has them (%s)', (_n, nl) => {
    const unitOps = ['## [WD010 Design]', '## 공정', '- [UHW010 Spin](#uhw010-spin)', '### [UHW010 Spin]', '#### Input', '- (samples from the previous step)'];
    const template = note(nl, unitOps);
    expect(hasRecordedResults(template)).toBe(false);
    expect(extractResultSections(template)).toBe('');
    const written = note(nl, [...unitOps, '#### Results', 'OD 0.42', '```', 'raw', '```']);
    asPlainText(hasRecordedResults, written);
    asPlainText(extractResultSections, written);
    expect(extractResultSections(written)).toContain('OD 0.42');
  });
});
