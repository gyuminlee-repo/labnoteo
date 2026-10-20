/**
 * The `discuss` flag is the one signal that turns a note into a GitHub Issue,
 * and it is read in two places (the plugin's toggle command, the automation's
 * `shouldPromote`). A disagreement between them is invisible in Obsidian and
 * only shows up as an issue that never gets opened — hence the exhaustive
 * coverage of the shapes a note's front matter can actually carry.
 */
import { describe, it, expect } from 'vitest';
import { DISCUSS_FLAG_KEY, isDiscussFlagged, setDiscussFlag, unrecognizedDiscussValue } from '../lib/discussFlag';

describe('isDiscussFlagged', () => {
  it('accepts the boolean written by the toggle command', () => {
    expect(isDiscussFlagged({ discuss: true })).toBe(true);
  });

  it('accepts the quoted string a hand edit or YAML writer can produce', () => {
    expect(isDiscussFlagged({ discuss: 'true' })).toBe(true);
    expect(isDiscussFlagged({ discuss: 'TRUE' })).toBe(true);
    expect(isDiscussFlagged({ discuss: ' true ' })).toBe(true);
  });

  // Changed expectation (#208): `yes` used to read as not flagged, like the
  // same README's `sample_tracking: yes` suggests it should not.
  it('accepts yes, y, on, 1, 예 and 네', () => {
    for (const v of ['yes', 'Yes', 'y', 'on', '1', '예', ' 네 ']) {
      expect(isDiscussFlagged({ discuss: v })).toBe(true);
    }
    expect(isDiscussFlagged({ discuss: 1 })).toBe(true);
  });

  it('is false when absent, false, or any other value', () => {
    expect(isDiscussFlagged({})).toBe(false);
    expect(isDiscussFlagged({ discuss: false })).toBe(false);
    expect(isDiscussFlagged({ discuss: 'false' })).toBe(false);
    expect(isDiscussFlagged({ discuss: 'no' })).toBe(false);
    expect(isDiscussFlagged({ discuss: 'maybe' })).toBe(false);
    expect(isDiscussFlagged({ discuss: null })).toBe(false);
    expect(isDiscussFlagged({ status: 'in-progress' })).toBe(false);
  });
});

describe('unrecognizedDiscussValue (#208)', () => {
  it('returns a value that reads as neither on nor off', () => {
    expect(unrecognizedDiscussValue({ discuss: 'maybe' })).toBe('maybe');
    expect(unrecognizedDiscussValue({ discuss: '논의' })).toBe('논의');
  });

  it('is undefined for on, off, empty or absent values', () => {
    for (const v of [true, false, null, 'yes', 'no', '예', '아니오', '', 'TRUE', 0]) {
      expect(unrecognizedDiscussValue({ discuss: v })).toBeUndefined();
    }
    expect(unrecognizedDiscussValue({})).toBeUndefined();
  });
});

describe('setDiscussFlag', () => {
  it('appends the flag to a note that predates the field', () => {
    expect(setDiscussFlag({ status: 'in-progress' }, true)).toEqual({
      status: 'in-progress',
      discuss: true,
    });
  });

  it('deletes the key when clearing rather than writing `discuss: false`', () => {
    const cleared = setDiscussFlag({ status: 'in-progress', discuss: true }, false);
    expect(DISCUSS_FLAG_KEY in cleared).toBe(false);
    expect(cleared).toEqual({ status: 'in-progress' });
  });

  it('leaves the other keys and their order untouched', () => {
    const before = { id: 'EXP-001', status: 'in-progress', project: 'P' };
    expect(Object.keys(setDiscussFlag(before, true))).toEqual([
      'id',
      'status',
      'project',
      'discuss',
    ]);
  });

  it('does not mutate the input', () => {
    const before = { status: 'in-progress' };
    setDiscussFlag(before, true);
    expect(before).toEqual({ status: 'in-progress' });
  });

  it('round-trips through isDiscussFlagged in both directions', () => {
    const on = setDiscussFlag({}, true);
    expect(isDiscussFlagged(on)).toBe(true);
    expect(isDiscussFlagged(setDiscussFlag(on, false))).toBe(false);
  });
});
