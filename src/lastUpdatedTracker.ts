/**
 * Decides, per note, whether the debounced `last_updated_date` stamp should
 * run after a burst of editor changes. Fed by the reorder filter's
 * `onDocChange`; kept free of Obsidian so the rules are unit-tested.
 */
import type { DocChangeKind } from './unitOpReorderFilter';

export interface DocChange extends DocChangeKind {
  fromHistory: boolean;
}

interface Pending {
  userEdit: boolean;
  lastFromHistory: boolean;
}

export class LastUpdatedTracker {
  private readonly pending = new Map<string, Pending>();
  /** Notes whose date the user set by hand; left alone until the plugin reloads. */
  private readonly manual = new Set<string>();

  record(path: string, change: DocChange): void {
    if (change.dateEdited) this.manual.add(path);
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
  consume(path: string): boolean {
    const p = this.pending.get(path);
    this.pending.delete(path);
    if (!p || !p.userEdit || p.lastFromHistory) return false;
    return !this.manual.has(path);
  }

  clear(): void {
    this.pending.clear();
    this.manual.clear();
  }
}
