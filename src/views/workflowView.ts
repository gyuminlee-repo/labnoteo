/**
 * Workflow / unit-operation catalog sidebar (read-only).
 *
 * Consumes the core {@link buildWorkflowTree} model and renders it with
 * {@link renderTree}. The only interactive affordance is a context-menu action
 * on a unit-operation node that inserts its block at the cursor (reusing the
 * shared command helper, so behaviour matches the command palette exactly).
 */
import { ItemView, Menu, WorkspaceLeaf } from 'obsidian';
import {
  buildWorkflowTree,
  type TreeNode,
  type UnitOperationItem,
  type WorkflowItem,
} from '@labnoteo/core';
import {
  ensureWorkflowResources,
  loadWorkflows,
  loadUnitOperations,
} from '@labnoteo/core/lib/workflowDataLoader';
import type LabnotePlugin from '../main';
import { insertUnitOpAndUpdateToc, createWorkflowForItem } from '../commands';
import { renderTree } from './treeRender';

export const WORKFLOW_VIEW_TYPE = 'labnote-workflow-view';

export class WorkflowTreeView extends ItemView {
  private readonly expanded = new Set<string>();
  /** Tree container; `renderTree` empties it, so the hint above survives. */
  private treeEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LabnotePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return WORKFLOW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.t('Workflows');
  }

  getIcon(): string {
    return 'box';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: 'labnote-view-hint',
      text: this.plugin.t(
        'Right-click an item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.',
        this.plugin.t('Create experiment')
      ),
    });
    this.treeEl = this.contentEl.createDiv();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // '.' (not '') so core loaders don't treat it as "no workspace"; it
    // normalises away to clean vault-relative resource paths.
    const root = '.';
    const { fs } = this.plugin;
    await ensureWorkflowResources(fs, root);
    const [catalog, hw, sw] = await Promise.all([
      loadWorkflows(fs, root),
      loadUnitOperations(fs, root, 'hw'),
      loadUnitOperations(fs, root, 'sw'),
    ]);

    const nodes = buildWorkflowTree({
      workflows: catalog.workflows,
      hwUnitOps: hw.unitOperations,
      swUnitOps: sw.unitOperations,
    });

    renderTree(
      this.treeEl ?? this.contentEl,
      nodes,
      {
        expanded: this.expanded,
        onContext: (node, evt) => this.onContext(node, evt),
      },
      this
    );
  }

  private onContext(node: TreeNode, evt: MouseEvent): void {
    if (node.kind === 'workflow') {
      const wf = node.payload as WorkflowItem;
      const menu = new Menu();
      menu.addItem(item =>
        item
          .setTitle(this.plugin.t('Create workflow'))
          .setIcon('plus')
          .onClick(() => {
            const { app, host, stampLastUpdated } = this.plugin;
            void createWorkflowForItem(app, host, wf, stampLastUpdated);
          })
      );
      menu.showAtMouseEvent(evt);
      return;
    }

    if (node.kind !== 'unitOperation') return;
    const op = node.payload as UnitOperationItem & { opType: 'hw' | 'sw' };

    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Insert unit operation'))
        .setIcon('plus')
        .onClick(() =>
          void insertUnitOpAndUpdateToc(this.plugin.host, {
            opId: op.id,
            opName: op.name,
            opDescription: op.description,
            opType: op.opType,
            equipment: op.equipment,
            software: op.software,
          })
        )
    );
    menu.showAtMouseEvent(evt);
  }
}
