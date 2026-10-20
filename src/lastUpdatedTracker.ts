/**
 * Decides, per note, whether the debounced `last_updated_date` stamp should
 * run after a burst of editor changes. Fed by the reorder filter's
 * `onDocChange`; kept free of Obsidian so the rules are unit-tested.
 */
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import type { DocChangeKind } from './unitOpReorderFilter';

export interface DocChange extends DocChangeKind {
  fromHistory: boolean;
}

interface Pending {
  userEdit: boolean;
  lastFromHistory: boolean;
}

/**
 * - `stamp`: write today's date.
 * - `handSet`: skipped because the user set the date by hand today; reported
 *   once per hand-set date so the caller can say so (#202).
 * - `skip`: nothing to do.
 */
export type StampDecision = 'stamp' | 'handSet' | 'skip';

export class LastUpdatedTracker {
  private readonly pending = new Map<string, Pending>();
  /**
   * Notes whose date the user set by hand, with the (Seoul) day it was set.
   * Left alone for that day only, so the automatic date resumes the next day.
   */
  private readonly manual = new Map<string, { day: string; reported: boolean }>();

  constructor(private readonly today: () => string = getSeoulDateString) {}

  record(path: string, change: DocChange): void {
    if (change.dateEdited) this.manual.set(path, { day: this.today(), reported: false });
    const prev = this.pending.get(path);
    this.pending.set(path, {
      userEdit: (prev?.userEdit ?? false) || change.userEdit,
      lastFromHistory: change.fromHistory,
    });
  }

  /**
   * Whether to stamp `path` now, clearing what was recorded for it. Stamps only
   * after a user edit, and never right after undo/redo: a fresh edit there
   * would discard the redo stack.
   */
  consume(path: string): StampDecision {
    const p = this.pending.get(path);
    this.pending.delete(path);
    if (!p || !p.userEdit || p.lastFromHistory) return 'skip';
    const hand = this.manual.get(path);
    if (!hand) return 'stamp';
    if (hand.day !== this.today()) {
      this.manual.delete(path);
      return 'stamp';
    }
    if (hand.reported) return 'skip';
    hand.reported = true;
    return 'handSet';
  }

  clear(): void {
    this.pending.clear();
    this.manual.clear();
  }
}
