import { describe, it, expect } from 'vitest';
import { capPathSegment, fullPathLength, isPathTooLongError } from '../lib/regexUtils';

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
    const longName = `C:\\vault\\labnote\\${'가'.repeat(250)}.labnote.md`;
    expect(
      isPathTooLongError(Object.assign(new Error(`ENOENT: no such file or directory, open '${longName}'`), { code: 'ENOENT' }))
    ).toBe(true);
    const longPath = `C:\\${'a'.repeat(100)}\\labnote\\${'b'.repeat(64)}\\${'c'.repeat(95)}.labnote.md`;
    expect(isPathTooLongError(Object.assign(new Error('x'), { code: 'ENOENT', path: longPath }))).toBe(true);
  });

  it('judges by the file-system limits, not the caps names are made with', () => {
    // A 0.101.0 name of 100+ characters that is merely missing is not "too long".
    const old = `C:\\vault\\labnote\\${'가'.repeat(120)}.labnote.md`;
    expect(
      isPathTooLongError(Object.assign(new Error(`ENOENT: no such file or directory, open '${old}'`), { code: 'ENOENT' }))
    ).toBe(false);
  });

  it('leaves other errors alone', () => {
    expect(
      isPathTooLongError(Object.assign(new Error("ENOENT: no such file or directory, open 'a/b.md'"), { code: 'ENOENT' }))
    ).toBe(false);
    expect(isPathTooLongError(new Error('boom'))).toBe(false);
    expect(isPathTooLongError('ENAMETOOLONG')).toBe(false);
  });
});

describe('fullPathLength', () => {
  it('counts the vault folder, one separator and the vault path', () => {
    expect(fullPathLength('C:\\Users\\me\\vault', 'labnote/001_A/README.labnote.md')).toBe(17 + 1 + 31);
    expect(fullPathLength('C:\\Users\\me\\vault\\', 'a.md')).toBe(17 + 1 + 4);
    expect(fullPathLength('', 'a.md')).toBe(4);
  });
});
