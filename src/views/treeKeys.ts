/**
 * Keyboard handling for the sidebar trees (#197), following the WAI-ARIA tree
 * pattern. Pure — it sees only the rows currently shown — so it is tested
 * without a DOM; {@link renderTree} applies the result.
 */

/** A row the user can see, in display order. */
export interface KeyRow {
  hasChildren: boolean;
  expanded: boolean;
  /** Index of the parent row in the same list, or -1 at the top level. */
  parent: number;
}

export type TreeKeyAction =
  | { kind: 'focus'; index: number }
  | { kind: 'expand' }
  | { kind: 'collapse' }
  /** Same as a click: toggles a group and runs the row's action. */
  | { kind: 'activate' }
  /** Open the row's context menu. */
  | { kind: 'menu' };

/** What a key press on row `current` does, or undefined to leave the key alone. */
export function treeKeyAction(
  rows: readonly KeyRow[],
  current: number,
  key: { key: string; shiftKey?: boolean }
): TreeKeyAction | undefined {
  const row = rows[current];
  if (!row) {
    const moves = ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key);
    return moves && rows.length > 0 ? { kind: 'focus', index: 0 } : undefined;
  }
  switch (key.key) {
    case 'ArrowDown':
      return current + 1 < rows.length ? { kind: 'focus', index: current + 1 } : undefined;
    case 'ArrowUp':
      return current > 0 ? { kind: 'focus', index: current - 1 } : undefined;
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: rows.length - 1 };
    case 'ArrowRight':
      if (!row.hasChildren) return undefined;
      return row.expanded ? { kind: 'focus', index: current + 1 } : { kind: 'expand' };
    case 'ArrowLeft':
      if (row.hasChildren && row.expanded) return { kind: 'collapse' };
      return row.parent >= 0 ? { kind: 'focus', index: row.parent } : undefined;
    case 'Enter':
    case ' ':
      return { kind: 'activate' };
    case 'ContextMenu':
      return { kind: 'menu' };
    case 'F10':
      return key.shiftKey ? { kind: 'menu' } : undefined;
    default:
      return undefined;
  }
}

/** Every rendered row, shown or not, in render order, for {@link resolveFocusRow}. */
export interface FocusRow {
  /** Ids from the root down. */
  key: string;
  id: string;
  /** Index of the parent row, or -1 at the top level. */
  parent: number;
  shown: boolean;
}

/**
 * Which row gets the tab stop after a redraw: the row that had it, by path;
 * else the row with the same node id somewhere else — a status change moves
 * an experiment to another group (#227) — with its closed ancestors to open;
 * else the nearest shown ancestor of the old row; else the first shown row.
 */
export function resolveFocusRow(
  rows: readonly FocusRow[],
  focusedKey: string | undefined,
  focusedId: string | undefined
): { index: number; expand: number[] } | undefined {
  const firstShown = rows.findIndex(r => r.shown);
  if (firstShown === -1) return undefined;
  const byKey = focusedKey === undefined ? -1 : rows.findIndex(r => r.key === focusedKey);
  if (byKey !== -1 && rows[byKey].shown) return { index: byKey, expand: [] };
  if (byKey === -1 && focusedId !== undefined) {
    const byId = rows.findIndex(r => r.id === focusedId);
    if (byId !== -1) {
      const expand: number[] = [];
      if (!rows[byId].shown) for (let p = rows[byId].parent; p >= 0; p = rows[p].parent) expand.unshift(p);
      return { index: byId, expand };
    }
  }
  if (byKey !== -1) {
    for (let p = rows[byKey].parent; p >= 0; p = rows[p].parent) if (rows[p].shown) return { index: p, expand: [] };
  }
  return { index: firstShown, expand: [] };
}
