import { describe, it, expect } from 'vitest';
import { LastUpdatedTracker, type DocChange } from '../../src/lastUpdatedTracker';

const P = 'labnote/001_Exp/001_WD010_Design.labnote.md';
const typed: DocChange = { userEdit: true, dateEdited: false, fromHistory: false };
const reload: DocChange = { userEdit: false, dateEdited: false, fromHistory: false };
const undo: DocChange = { userEdit: false, dateEdited: false, fromHistory: true };
const dateTyped: DocChange = { userEdit: true, dateEdited: true, fromHistory: false };

describe('LastUpdatedTracker', () => {
  it('stamps after a user edit, once per burst', () => {
    const t = new LastUpdatedTracker();
    t.record(P, typed);
    t.record(P, reload);
    expect(t.consume(P)).toBe(true);
    expect(t.consume(P)).toBe(false);
  });

  it('does not stamp without a user edit or without any record', () => {
    const t = new LastUpdatedTracker();
    t.record(P, reload);
    expect(t.consume(P)).toBe(false);
    expect(t.consume('labnote/001_Exp/README.labnote.md')).toBe(false);
  });

  it('does not stamp when the last change was undo/redo', () => {
    const t = new LastUpdatedTracker();
    t.record(P, typed);
    t.record(P, undo);
    expect(t.consume(P)).toBe(false);
  });

  it('leaves a hand-set date alone for later edits too', () => {
    const t = new LastUpdatedTracker();
    t.record(P, dateTyped);
    expect(t.consume(P)).toBe(false);
    t.record(P, typed);
    expect(t.consume(P)).toBe(false);
    t.clear();
    t.record(P, typed);
    expect(t.consume(P)).toBe(true);
  });

  it('tracks notes independently', () => {
    const t = new LastUpdatedTracker();
    const other = 'labnote/002_Other/README.labnote.md';
    t.record(P, dateTyped);
    t.record(other, typed);
    expect(t.consume(other)).toBe(true);
  });
});
