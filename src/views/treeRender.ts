/**
 * Renders a platform-neutral {@link TreeNode}[] (from `@labnoteo/core`) into an
 * Obsidian sidebar using only `createEl`/`setIcon` — no innerHTML. Collapse
 * state is caller-owned (a `Set<string>` of expanded node ids) so it survives
 * re-renders.
 *
 * The tree is an ARIA tree with one tab stop (roving tabindex): arrow keys
 * move between rows and open/close groups, Enter acts like a click and
 * Shift+F10 or the menu key opens the context menu (#197). The focused row is
 * remembered per container, so a redraw (any README save) does not drop it.
 */
import { setIcon, type Component } from 'obsidian';
import type { TreeNode } from '@labnoteo/core';
import { treeKeyAction, type KeyRow } from './treeKeys';

/** Map the core (VS Code codicon) icon names to Obsidian's Lucide set. */
const ICON_MAP: Record<string, string> = {
  'symbol-class': 'box',
  folder: 'folder',
  file: 'file-text',
  'comment-discussion': 'message-circle',
  warning: 'alert-triangle',
  'symbol-method': 'wrench',
  'symbol-function': 'square-function',
  beaker: 'flask-conical',
};

export interface TreeRenderCtx {
  expanded: Set<string>;
  onClick?: (node: TreeNode, evt: MouseEvent) => void;
  onContext?: (node: TreeNode, evt: MouseEvent) => void;
}

interface RowEntry {
  /** Ids from the root down: node ids are unique only among siblings. */
  key: string;
  node: TreeNode;
  row: HTMLElement;
  twistie: HTMLElement;
  childrenEl: HTMLElement;
  hasChildren: boolean;
  /** Index of the parent entry, or -1 at the top level. */
  parent: number;
}

interface TreeState {
  entries: RowEntry[];
  ctx: TreeRenderCtx;
  focusedKey?: string;
}

const states = new WeakMap<HTMLElement, TreeState>();
let labelIds = 0;

export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  ctx: TreeRenderCtx,
  component: Component
): void {
  const hadFocus = container.contains(container.ownerDocument.activeElement);
  const previous = states.get(container);
  const state: TreeState = { entries: [], ctx, focusedKey: previous?.focusedKey };
  states.set(container, state);

  container.empty();
  container.addClass('labnote-tree');
  container.setAttr('role', 'tree');
  for (const node of nodes) renderNode(container, node, state, 0, -1, '', component);
  if (!previous) {
    component.registerDomEvent(container, 'keydown', evt => onKeyDown(container, evt));
  }

  const visible = visibleEntries(state);
  const target = visible.find(i => state.entries[i].key === state.focusedKey) ?? visible[0];
  if (target !== undefined) setTabStop(state, target, hadFocus);
}

/** Move keyboard focus into the tree, onto the row that last had it. */
export function focusTree(container: HTMLElement): void {
  const state = states.get(container);
  if (!state) return;
  const visible = visibleEntries(state);
  const target = visible.find(i => state.entries[i].key === state.focusedKey) ?? visible[0];
  if (target !== undefined) setTabStop(state, target, true);
}

function renderNode(
  parent: HTMLElement,
  node: TreeNode,
  state: TreeState,
  depth: number,
  parentIndex: number,
  parentKey: string,
  component: Component
): void {
  const { ctx } = state;
  const hasChildren = !!node.children && node.children.length > 0;
  const row = parent.createDiv({ cls: 'labnote-tree-row' });
  // Indentation is data-driven, so it is passed as a CSS variable the stylesheet
  // turns into padding — no styling is hardcoded in JS.
  row.style.setProperty('--labnote-tree-depth', String(depth));
  if (node.dimmed) row.addClass('is-dimmed');

  const twistie = row.createSpan({ cls: 'labnote-tree-twistie' });
  const expanded = ctx.expanded.has(node.id);
  if (hasChildren) setIcon(twistie, expanded ? 'chevron-down' : 'chevron-right');

  if (node.color) {
    const dot = row.createSpan({ cls: 'labnote-tree-dot' });
    dot.style.setProperty('--labnote-tree-dot-color', node.color);
  } else if (node.icon && ICON_MAP[node.icon]) {
    const iconEl = row.createSpan({ cls: 'labnote-tree-icon' });
    setIcon(iconEl, ICON_MAP[node.icon]);
  }

  const labelId = `labnote-tree-label-${++labelIds}`;
  row.createSpan({ cls: 'labnote-tree-label', text: node.label, attr: { id: labelId } });
  row.setAttrs({ role: 'treeitem', tabindex: '-1', 'aria-level': String(depth + 1), 'aria-labelledby': labelId });
  if (hasChildren) row.setAttr('aria-expanded', String(expanded));
  if (node.tooltip) {
    // `aria-label` is what Obsidian shows on hover; `aria-labelledby` keeps it
    // from replacing the row's name for a screen reader, which reads it as the
    // description instead.
    row.setAttrs({ 'aria-label': node.tooltip, 'aria-description': node.tooltip });
  }

  const childrenEl = parent.createDiv({ cls: 'labnote-tree-children', attr: { role: 'group' } });
  childrenEl.toggleClass('is-collapsed', !expanded);

  const index = state.entries.length;
  const key = `${parentKey}/${node.id}`;
  state.entries.push({ key, node, row, twistie, childrenEl, hasChildren, parent: parentIndex });

  if (hasChildren) {
    for (const child of node.children!) renderNode(childrenEl, child, state, depth + 1, index, key, component);
  }

  component.registerDomEvent(row, 'click', evt => {
    setTabStop(state, index, false);
    activate(state, index, evt);
  });

  component.registerDomEvent(row, 'contextmenu', evt => {
    evt.preventDefault();
    setTabStop(state, index, false);
    ctx.onContext?.(node, evt);
  });
}

function setExpanded(state: TreeState, index: number, expanded: boolean): void {
  const entry = state.entries[index];
  entry.childrenEl.toggleClass('is-collapsed', !expanded);
  if (expanded) state.ctx.expanded.add(entry.node.id);
  else state.ctx.expanded.delete(entry.node.id);
  setIcon(entry.twistie, expanded ? 'chevron-down' : 'chevron-right');
  entry.row.setAttr('aria-expanded', String(expanded));
}

/** A click, or Enter on the row: open/close a group, then the caller's action. */
function activate(state: TreeState, index: number, evt: MouseEvent): void {
  const entry = state.entries[index];
  if (entry.hasChildren) setExpanded(state, index, entry.childrenEl.hasClass('is-collapsed'));
  state.ctx.onClick?.(entry.node, evt);
}

/** Make `index` the tree's only tab stop, and focus it when asked. */
function setTabStop(state: TreeState, index: number, focus: boolean): void {
  for (const [i, entry] of state.entries.entries()) entry.row.setAttr('tabindex', i === index ? '0' : '-1');
  state.focusedKey = state.entries[index].key;
  if (focus) state.entries[index].row.focus();
}

/** Indices of the entries not inside a closed group, in display order. */
function visibleEntries(state: TreeState): number[] {
  const shown: boolean[] = [];
  const out: number[] = [];
  state.entries.forEach((entry, i) => {
    const p = entry.parent;
    shown[i] = p < 0 || (shown[p] && !state.entries[p].childrenEl.hasClass('is-collapsed'));
    if (shown[i]) out.push(i);
  });
  return out;
}

function onKeyDown(container: HTMLElement, evt: KeyboardEvent): void {
  const state = states.get(container);
  if (!state) return;
  const visible = visibleEntries(state);
  const position = new Map(visible.map((entryIndex, i) => [entryIndex, i]));
  const rows: KeyRow[] = visible.map(i => {
    const entry = state.entries[i];
    return {
      hasChildren: entry.hasChildren,
      expanded: !entry.childrenEl.hasClass('is-collapsed'),
      parent: entry.parent < 0 ? -1 : (position.get(entry.parent) ?? -1),
    };
  });
  const current = visible.findIndex(i => state.entries[i].row === evt.target);
  const action = treeKeyAction(rows, current, evt);
  if (!action) return;
  evt.preventDefault();
  evt.stopPropagation();

  if (action.kind === 'focus') {
    setTabStop(state, visible[action.index], true);
    return;
  }
  const index = visible[current];
  if (index === undefined) return;
  const { row, node } = state.entries[index];
  const rect = row.getBoundingClientRect();
  const View = row.ownerDocument.defaultView ?? window;
  if (action.kind === 'expand' || action.kind === 'collapse') {
    setExpanded(state, index, action.kind === 'expand');
  } else if (action.kind === 'activate') {
    activate(state, index, new View.MouseEvent('click', { clientX: rect.left, clientY: rect.bottom }));
  } else {
    state.ctx.onContext?.(node, new View.MouseEvent('contextmenu', { clientX: rect.left, clientY: rect.bottom }));
  }
}
