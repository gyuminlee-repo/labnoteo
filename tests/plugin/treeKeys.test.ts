/**
 * #197: the sidebar trees follow the WAI-ARIA tree keys.
 */
import { describe, it, expect } from 'vitest';
import { treeKeyAction, type KeyRow } from '../../src/views/treeKeys';

// Experiments (open) > planned (open) > 001; Workflows (closed)
const rows: KeyRow[] = [
  { hasChildren: true, expanded: true, parent: -1 },
  { hasChildren: true, expanded: true, parent: 0 },
  { hasChildren: false, expanded: false, parent: 1 },
  { hasChildren: true, expanded: false, parent: -1 },
];
const press = (current: number, key: string, shiftKey = false) => treeKeyAction(rows, current, { key, shiftKey });

describe('treeKeyAction', () => {
  it('moves up and down through the rows shown, and to either end', () => {
    expect(press(0, 'ArrowDown')).toEqual({ kind: 'focus', index: 1 });
    expect(press(3, 'ArrowDown')).toBeUndefined();
    expect(press(2, 'ArrowUp')).toEqual({ kind: 'focus', index: 1 });
    expect(press(0, 'ArrowUp')).toBeUndefined();
    expect(press(2, 'Home')).toEqual({ kind: 'focus', index: 0 });
    expect(press(0, 'End')).toEqual({ kind: 'focus', index: 3 });
  });

  it('opens a closed group, then steps into it', () => {
    expect(press(3, 'ArrowRight')).toEqual({ kind: 'expand' });
    expect(press(1, 'ArrowRight')).toEqual({ kind: 'focus', index: 2 });
    expect(press(2, 'ArrowRight')).toBeUndefined();
  });

  it('closes an open group, else goes to the parent', () => {
    expect(press(1, 'ArrowLeft')).toEqual({ kind: 'collapse' });
    expect(press(2, 'ArrowLeft')).toEqual({ kind: 'focus', index: 1 });
    expect(press(3, 'ArrowLeft')).toBeUndefined();
  });

  it('acts on Enter or Space and opens the menu on Shift+F10 or the menu key', () => {
    expect(press(2, 'Enter')).toEqual({ kind: 'activate' });
    expect(press(2, ' ')).toEqual({ kind: 'activate' });
    expect(press(2, 'F10', true)).toEqual({ kind: 'menu' });
    expect(press(2, 'F10')).toBeUndefined();
    expect(press(2, 'ContextMenu')).toEqual({ kind: 'menu' });
    expect(press(2, 'a')).toBeUndefined();
  });

  it('lands on the first row when no row has focus yet', () => {
    expect(press(-1, 'ArrowDown')).toEqual({ kind: 'focus', index: 0 });
    expect(press(-1, 'a')).toBeUndefined();
    expect(treeKeyAction([], -1, { key: 'ArrowDown' })).toBeUndefined();
  });
});
