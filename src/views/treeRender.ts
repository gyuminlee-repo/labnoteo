/**
 * Renders a platform-neutral {@link TreeNode}[] (from `@labnoteo/core`) into an
 * Obsidian sidebar using only `createEl`/`setIcon` — no innerHTML. Collapse
 * state is caller-owned (a `Set<string>` of expanded node ids) so it survives
 * re-renders.
 */
import { setIcon, type Component } from 'obsidian';
import type { TreeNode } from '@labnoteo/core';

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

export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  ctx: TreeRenderCtx,
  component: Component
): void {
  container.empty();
  container.addClass('labnote-tree');
  for (const node of nodes) renderNode(container, node, ctx, 0, component);
}

function renderNode(
  parent: HTMLElement,
  node: TreeNode,
  ctx: TreeRenderCtx,
  depth: number,
  component: Component
): void {
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

  row.createSpan({ cls: 'labnote-tree-label', text: node.label });
  if (node.tooltip) row.setAttr('aria-label', node.tooltip);

  const childrenEl = parent.createDiv({ cls: 'labnote-tree-children' });
  childrenEl.toggleClass('is-collapsed', !expanded);
  if (hasChildren) {
    for (const child of node.children!) renderNode(childrenEl, child, ctx, depth + 1, component);
  }

  component.registerDomEvent(row, 'click', evt => {
    if (hasChildren) {
      const nowExpanded = childrenEl.hasClass('is-collapsed');
      childrenEl.toggleClass('is-collapsed', !nowExpanded);
      if (nowExpanded) ctx.expanded.add(node.id);
      else ctx.expanded.delete(node.id);
      setIcon(twistie, nowExpanded ? 'chevron-down' : 'chevron-right');
    }
    ctx.onClick?.(node, evt);
  });

  component.registerDomEvent(row, 'contextmenu', evt => {
    evt.preventDefault();
    ctx.onContext?.(node, evt);
  });
}
