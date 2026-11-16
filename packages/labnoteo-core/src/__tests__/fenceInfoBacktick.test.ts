/**
 * A backtick run with a backtick in its info (```` ```a``` ````) is inline code, not a
 * fence (CommonMark), for every fence reader a call goes through, not stepFence alone. Each
 * reader gives on such a note what it gives on the same note with that line as plain text of
 * the same length, the line put back in the result.
 */
import { describe, it, expect } from 'vitest';
import { extractResultSections, hasRecordedResults } from '../lib/noteResults';
import { unitOpSectionLine } from '../sections/workflowSectionParser';
import { parseIssueMarkers, stripIssueMarkers } from '../lib/issueMarker';
import { extractMethodBody } from '../sections/blockInsert';
import { extractMarkdownTables } from '../lib/exportTablesCsv';
import { maskSampleListTables } from '../lib/sampleUtils';

const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
const RUN = '```a```';
const PLAIN = 'QQQQQQQ';

/** `read` on `md` equals `read` on `md` with every RUN as PLAIN, PLAIN put back after. */
function asPlainText<T>(read: (md: string) => T, md: string): void {
  const plain = JSON.stringify(read(md.split(RUN).join(PLAIN)) ?? null).split(PLAIN).join(RUN);
  expect(JSON.stringify(read(md) ?? null)).toBe(plain);
}

describe('a backtick run with a backtick in its info reads as text', () => {
  const template = (x: string, nl: string) =>
    ['## [WD010 Design]', x, '## 공정', '- [UHW010 Spin](#uhw010-spin)', '### [UHW010 Spin]', '#### Input', '- (samples from the previous step)', ''].join(nl);

  it.each(endings)('a template note has no recorded results (%s)', (_n, nl) => {
    const md = template(RUN, nl);
    expect(hasRecordedResults(md)).toBe(false);
    expect(extractResultSections(md)).toBe('');
    expect(unitOpSectionLine(md)).toBe(2);
    expect([hasRecordedResults(md), extractResultSections(md), unitOpSectionLine(md)]).toEqual([
      hasRecordedResults(template('plain text', nl)),
      extractResultSections(template('plain text', nl)),
      unitOpSectionLine(template('plain text', nl)),
    ]);
  });

  it.each(endings)('an issue marker below it is a marker (%s)', (_n, nl) => {
    const md = ['## Results', 'note @issue;topic', '', RUN, '', '@issue: check this', '### Step', '```', ''].join(nl);
    asPlainText(stripIssueMarkers, md);
    asPlainText(parseIssueMarkers, md);
    asPlainText(extractResultSections, md);
  });

  it.each(endings)('a method draft starting with it is not unwrapped (%s)', (_n, nl) => {
    asPlainText(extractMethodBody, [RUN, '- item', '## Method', 'step 1', '```'].join(nl));
  });

  it.each(endings)('a table row starting with it is a row (%s)', (_n, nl) => {
    // The row reads as the one with a one-backtick code span does: three rows, not one.
    const rows = (first: string) => extractMarkdownTables(['| a | b |', '|---|---|', `${first} | b |`, '| 1 | 2 |', ''].join(nl)).map(t => t.rows);
    expect(rows(RUN)).toEqual(rows('`a`'));
    expect(rows(RUN)[0]).toHaveLength(3);
  });

  it.each(endings)('a sample list table below it is masked (%s)', (_n, nl) => {
    asPlainText(md => maskSampleListTables(md, [['a', 'b']]), [RUN, '| a | b |', '|---|---|', '| Plasmid-1 | b |', '', 'used Plasmid-1', ''].join(nl));
  });
});
