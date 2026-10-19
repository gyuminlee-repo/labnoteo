import { describe, it, expect } from 'vitest';
import { capPathSegment, isPathTooLongError } from '../lib/regexUtils';

// #148
describe('capPathSegment', () => {
  it('keeps a short segment and cuts a long one by code points', () => {
    expect(capPathSegment('abc', 5)).toBe('abc');
    expect(capPathSegment('abcdef', 5)).toBe('abcde');
    expect(capPathSegment('🧪🧪🧪', 2)).toBe('🧪🧪');
  });

  it('drops separators the cut leaves at the end', () => {
    expect(capPathSegment('abcd_efg', 5)).toBe('abcd');
    expect(capPathSegment('ab-_.cdef', 5)).toBe('ab');
  });
});

describe('isPathTooLongError', () => {
  it('recognises ENAMETOOLONG and an ENOENT on a too-long path', () => {
    expect(isPathTooLongError(Object.assign(new Error('x'), { code: 'ENAMETOOLONG' }))).toBe(true);
    const long = `C:\\vault\\labnote\\${'가'.repeat(120)}.labnote.md`;
    expect(
      isPathTooLongError(Object.assign(new Error(`ENOENT: no such file or directory, open '${long}'`), { code: 'ENOENT' }))
    ).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(
      isPathTooLongError(Object.assign(new Error("ENOENT: no such file or directory, open 'a/b.md'"), { code: 'ENOENT' }))
    ).toBe(false);
    expect(isPathTooLongError(new Error('boom'))).toBe(false);
    expect(isPathTooLongError('ENAMETOOLONG')).toBe(false);
  });
});
