// Globals convention (no `import ... from 'vitest'`) — matches the core tests.
//
// Pins the deterministic promotion signal (Phase 4a): only `discuss: true` or
// `status: needs-review` promote; no free-text scanning.
import { shouldPromote, selectPromotable, experimentIssueOptions } from './issue-sync';
import type { ExperimentNote } from './lib/experiments';

const note = (fm: Record<string, unknown>): ExperimentNote => ({
  dir: 'labnote/001_X',
  folderName: '001_X',
  frontMatter: fm,
  body: '',
});

describe('shouldPromote', () => {
  it('promotes on discuss: true (boolean or string)', () => {
    expect(shouldPromote({ discuss: true })).toBe(true);
    expect(shouldPromote({ discuss: 'true' })).toBe(true);
  });
  it('promotes on discuss: yes or 예, as the plugin reads them (#208)', () => {
    expect(shouldPromote({ discuss: 'yes' })).toBe(true);
    expect(shouldPromote({ discuss: '예' })).toBe(true);
  });
  it('promotes on status: needs-review', () => {
    expect(shouldPromote({ status: 'needs-review' })).toBe(true);
  });
  it('does not promote without an explicit signal', () => {
    expect(shouldPromote({ status: 'completed' })).toBe(false);
    expect(shouldPromote({ discuss: false })).toBe(false);
    expect(shouldPromote({})).toBe(false);
  });
});

describe('selectPromotable', () => {
  it('keeps only experiments with a signal', () => {
    const notes = [
      note({ status: 'needs-review' }),
      note({ status: 'completed' }),
      note({ discuss: true }),
    ];
    expect(selectPromotable(notes)).toHaveLength(2);
  });
});

describe('experimentIssueOptions', () => {
  it('reopens a closed thread on a push, and says which commit re-raised it', () => {
    const options = experimentIssueOptions(false, 'abc1234def');
    expect(options.reopenClosed).toBe(true);
    expect(options.reopenComment).toContain('abc1234');
  });

  // A backfill visits every note at once, including ones whose discussion ended
  // with the flag left behind. Reopening there would undo settled decisions.
  it('does not reopen during a backfill', () => {
    expect(experimentIssueOptions(true, 'abc1234def').reopenClosed).toBe(false);
  });

  it('omits the commit reference when the sha is unknown', () => {
    expect(experimentIssueOptions(false, undefined).reopenComment).not.toContain('커밋');
  });
});
