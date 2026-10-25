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
    expect(t.consume(P)).toBe('stamp');
    expect(t.consume(P)).toBe('skip');
  });

  it('does not stamp without a user edit or without any record', () => {
    const t = new LastUpdatedTracker();
    t.record(P, reload);
    expect(t.consume(P)).toBe('skip');
    expect(t.consume('labnote/001_Exp/README.labnote.md')).toBe('skip');
  });

  it('does not stamp when the last change was undo/redo', () => {
    const t = new LastUpdatedTracker();
    t.record(P, typed);
    t.record(P, undo);
    expect(t.consume(P)).toBe('skip');
  });

  // #202
  it('keeps a hand-set date for that day, reports it once, and stamps again the next day', () => {
    let day = '2026-10-20';
    const t = new LastUpdatedTracker(() => day);
    t.record(P, dateTyped);
    expect(t.consume(P)).toBe('handSet');
    t.record(P, typed);
    expect(t.consume(P)).toBe('skip');
    day = '2026-10-21';
    t.record(P, typed);
    expect(t.consume(P)).toBe('stamp');
    t.record(P, typed);
    expect(t.consume(P)).toBe('stamp');
  });

  it('forgets hand-set dates on clear (the setting was toggled)', () => {
    const t = new LastUpdatedTracker(() => '2026-10-20');
    t.record(P, dateTyped);
    expect(t.consume(P)).toBe('handSet');
    t.clear();
    t.record(P, typed);
    expect(t.consume(P)).toBe('stamp');
  });

  it('tracks notes independently', () => {
    const t = new LastUpdatedTracker();
    const other = 'labnote/002_Other/README.labnote.md';
    t.record(P, dateTyped);
    t.record(other, typed);
    expect(t.consume(other)).toBe('stamp');
  });

  // #363: a workflow note's edit stamps its README too, unless set by hand today.
  it('says a note set by hand today keeps its date, until the next day', () => {
    let day = '2026-10-25';
    const t = new LastUpdatedTracker(() => day);
    const readme = 'labnote/001_Exp/README.labnote.md';
    expect(t.keepsHandSet(readme)).toBe(false);
    t.record(readme, dateTyped);
    expect(t.keepsHandSet(readme)).toBe(true);
    expect(t.keepsHandSet(P)).toBe(false);
    day = '2026-10-26';
    expect(t.keepsHandSet(readme)).toBe(false);
  });
});
