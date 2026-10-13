// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  getSeoulDateString,
  findDateFieldsInDocument,
  findMetaDateFieldInLine,
  fromDateTimeLocalValue,
  readLastUpdatedDate,
  toDateTimeLocalValue,
  touchLastUpdatedDate,
  updateAllDateFields,
} from '../lib/dateUtils';

describe('getSeoulDateString', () => {
  it('formats an explicit date as YYYY-MM-DD', () => {
    // 2024-01-02T00:00:00Z is still 2024-01-02 in Asia/Seoul (UTC+9).
    expect(getSeoulDateString(new Date('2024-01-02T00:00:00Z'))).toBe('2024-01-02');
  });
});

describe('findDateFieldsInDocument', () => {
  it('does not double-match a field due to case-insensitive duplicates', () => {
    // Previously `end_date` and `End_date` were both listed with an `i` flag, so
    // one `end_date:` line produced two matches.
    const content = ['---', "end_date: '2024-01-01'", '---'].join('\n');
    const matches = findDateFieldsInDocument(content);
    expect(matches).toHaveLength(1);
    expect(matches[0].field.toLowerCase()).toBe('end_date');
  });

  it('finds each distinct front-matter date field once', () => {
    const content = [
      '---',
      "created_date: '2024-01-01'",
      "last_updated_date: '2024-01-02'",
      "end_date: '2024-01-03'",
      '---',
    ].join('\n');
    const fields = findDateFieldsInDocument(content).map(m => m.field.toLowerCase());
    expect(fields.sort()).toEqual(['created_date', 'end_date', 'last_updated_date']);
  });
});

describe('updateAllDateFields', () => {
  it('rewrites the field only inside the front matter block', () => {
    const content = [
      '---',
      "last_updated_date: '2024-01-01'",
      '---',
      '',
      '# Body',
      '',
      '```yaml',
      "last_updated_date: '2024-01-01'",
      '```',
    ].join('\n');
    const out = updateAllDateFields(content, 'last_updated_date', '2025-05-05');
    // Front matter updated…
    expect(out).toContain("last_updated_date: '2025-05-05'");
    // …but the code-block occurrence is untouched.
    expect(out).toContain("```yaml\nlast_updated_date: '2024-01-01'\n```");
  });

  it('leaves content unchanged when there is no front matter', () => {
    const content = ['# Body', '', "last_updated_date: '2024-01-01'"].join('\n');
    expect(updateAllDateFields(content, 'last_updated_date', '2025-05-05')).toBe(content);
  });
});

describe('findMetaDateFieldInLine', () => {
  it('locates the value inside the quotes', () => {
    const line = "- Start_date: '2026-09-06 23:31'";
    const m = findMetaDateFieldInLine(line);
    expect(m).not.toBeNull();
    expect(m!.field).toBe('Start_date');
    expect(m!.value).toBe('2026-09-06 23:31');
    expect(m!.quote).toBe("'");
    expect(line.slice(m!.valueStart, m!.valueEnd)).toBe('2026-09-06 23:31');
  });

  it('returns an empty range between the quotes of an unset field', () => {
    const line = "- End_date: ''";
    const m = findMetaDateFieldInLine(line)!;
    expect(m.field).toBe('End_date');
    expect(m.value).toBe('');
    expect(m.valueStart).toBe(m.valueEnd);
    expect(line.slice(0, m.valueStart)).toBe("- End_date: '");
  });

  it('handles an unquoted value and trailing whitespace', () => {
    const m = findMetaDateFieldInLine('  - end_date: 2026-09-06   ')!;
    expect(m.field).toBe('End_date');
    expect(m.value).toBe('2026-09-06');
    expect(m.quote).toBeNull();
  });

  it('ignores lines that are not Meta date bullets', () => {
    expect(findMetaDateFieldInLine('- Experimenter: Haseong')).toBeNull();
    expect(findMetaDateFieldInLine("start_date: '2026-09-06'")).toBeNull();
    expect(findMetaDateFieldInLine('The Start_date: is set later')).toBeNull();
  });
});

describe('datetime-local conversions', () => {
  it('round-trips a stored value', () => {
    expect(toDateTimeLocalValue('2026-09-06 23:31')).toBe('2026-09-06T23:31');
    expect(fromDateTimeLocalValue('2026-09-06T23:31')).toBe('2026-09-06 23:31');
  });

  it('defaults a date-only value to midnight', () => {
    expect(toDateTimeLocalValue('2026-09-06')).toBe('2026-09-06T00:00');
  });

  it('returns an empty string for unusable input', () => {
    expect(toDateTimeLocalValue('')).toBe('');
    expect(toDateTimeLocalValue('not a date')).toBe('');
    expect(fromDateTimeLocalValue('2026-09-06')).toBe('');
  });
});

describe('touchLastUpdatedDate', () => {
  const TODAY = '2026-10-13';

  it('updates an unquoted value', () => {
    const md = '---\ncreated_date: 2026-10-01\nlast_updated_date: 2026-10-01\n---\n# Body\n';
    expect(touchLastUpdatedDate(md, TODAY)).toBe(
      '---\ncreated_date: 2026-10-01\nlast_updated_date: 2026-10-13\n---\n# Body\n'
    );
  });

  it('keeps single or double quotes', () => {
    expect(touchLastUpdatedDate("---\nlast_updated_date: '2026-10-01'\n---\n", TODAY)).toBe(
      "---\nlast_updated_date: '2026-10-13'\n---\n"
    );
    expect(touchLastUpdatedDate('---\nlast_updated_date: "2026-10-01"\n---\n', TODAY)).toBe(
      '---\nlast_updated_date: "2026-10-13"\n---\n'
    );
  });

  it('returns the input untouched when already today', () => {
    const md = '---\nlast_updated_date: 2026-10-13\n---\n';
    expect(touchLastUpdatedDate(md, TODAY)).toBe(md);
  });

  it('never adds the field or front matter', () => {
    const noField = '---\ncreated_date: 2026-10-01\n---\n';
    const noFm = '# Note\nlast_updated_date: 2026-10-01\n';
    expect(touchLastUpdatedDate(noField, TODAY)).toBe(noField);
    expect(touchLastUpdatedDate(noFm, TODAY)).toBe(noFm);
  });

  it('leaves the body and code blocks alone', () => {
    const md =
      '---\nlast_updated_date: 2026-10-01\n---\nlast_updated_date: 2026-01-01\n```yaml\nlast_updated_date: 2026-01-01\n```\n';
    expect(touchLastUpdatedDate(md, TODAY)).toBe(
      '---\nlast_updated_date: 2026-10-13\n---\nlast_updated_date: 2026-01-01\n```yaml\nlast_updated_date: 2026-01-01\n```\n'
    );
  });

  it('ignores nested keys of the same name', () => {
    const md = '---\nmeta:\n  last_updated_date: 2026-10-01\n---\n';
    expect(touchLastUpdatedDate(md, TODAY)).toBe(md);
  });

  it('preserves CRLF line endings', () => {
    const md = '---\r\nlast_updated_date: 2026-10-01\r\nstatus: active\r\n---\r\n';
    expect(touchLastUpdatedDate(md, TODAY)).toBe(
      '---\r\nlast_updated_date: 2026-10-13\r\nstatus: active\r\n---\r\n'
    );
  });

  it('fills an empty value', () => {
    expect(touchLastUpdatedDate('---\nlast_updated_date:\n---\n', TODAY)).toBe(
      '---\nlast_updated_date: 2026-10-13\n---\n'
    );
  });
});

describe('readLastUpdatedDate', () => {
  it('reads the value with or without quotes', () => {
    expect(readLastUpdatedDate('---\nlast_updated_date: 2026-10-01\n---\n')).toBe('2026-10-01');
    expect(readLastUpdatedDate("---\nlast_updated_date: '2026-10-01'\n---\n")).toBe('2026-10-01');
    expect(readLastUpdatedDate('---\r\nlast_updated_date: "2026-10-01"\r\n---\r\n')).toBe('2026-10-01');
  });

  it('is undefined without the field', () => {
    expect(readLastUpdatedDate('---\nstatus: active\n---\n')).toBeUndefined();
    expect(readLastUpdatedDate('no front matter')).toBeUndefined();
  });
});
