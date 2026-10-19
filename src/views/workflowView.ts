/**
 * Workflow sidebar: the vault's experiments by status, then the workflow /
 * unit-operation catalog.
 *
 * Consumes the core {@link buildExperimentTree} and {@link buildWorkflowTree}
 * models and renders them with {@link renderTree}. Clicking an experiment opens
 * its README and its context menu changes that experiment's status; catalog
 * items create a workflow or insert a unit operation at the cursor (reusing the
 * shared command helpers, so behaviour matches the command palette exactly).
 */
import { ItemView, Menu, TFolder, WorkspaceLeaf, type TAbstractFile } from 'obsidian';
import {
  buildExperimentTree,
  buildWorkflowTree,
  isDiscussFlagged,
  type ExperimentEntry,
  type TreeNode,
  type UnitOperationItem,
  type WorkflowItem,
} from '@labnoteo/core';
import {
  ensureWorkflowResources,
  loadWorkflows,
  loadUnitOperations,
} from '@labnoteo/core/lib/workflowDataLoader';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from '../main';
import {
  insertUnitOpAndUpdateToc,
  createWorkflowForItem,
  unitOpAliasPrompt,
  changeExperimentStatusCommand,
  toggleDiscussionFlagCommand,
} from '../commands';
import { renderTree } from './treeRender';

const README = 'README.labnote.md';

export const WORKFLOW_VIEW_TYPE = 'labnote-workflow-view';

export class WorkflowTreeView extends ItemView {
  private readonly expanded = new Set<string>();
  /** Status groups expanded once already, so a refresh does not reopen one the user closed. */
  private readonly seeded = new Set<string>();
  /** Tree container; `renderTree` empties it, so the hint above survives. */
  private treeEl: HTMLElement | null = null;
  private catalogNodes: TreeNode[] = [];
  private renderTimer: number | undefined;

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
    this.registerEvent(
      this.app.metadataCache.on('changed', file => {
        if (file.name === README) this.scheduleRender();
      })
    );
    const onTree = (file: TAbstractFile, oldPath?: string): void => {
      if (file instanceof TFolder || file.name === README || oldPath?.endsWith(`/${README}`)) {
        this.scheduleRender();
      }
    };
    this.registerEvent(this.app.vault.on('create', file => onTree(file)));
    this.registerEvent(this.app.vault.on('delete', file => onTree(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => onTree(file, oldPath)));

    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: 'labnote-view-hint',
      text: this.plugin.t(
        'Click an experiment to open its README, or right-click it to change its status or toggle its discussion flag. Right-click a catalog item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.',
        this.plugin.t('Create experiment')
      ),
    });
    this.treeEl = this.contentEl.createDiv();
    this.expanded.add('experiments');
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.renderTimer !== undefined) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
  }

  /** Coalesce bursts of vault events (a folder rename moves every file) into one render. */
  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 300);
  }

  /** Experiments whose README the metadata cache has read, with its `title`, `status` and `discuss` flag. */
  private experiments(): ExperimentEntry[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter(f => f.name === README && getExperimentDir(f.path) === posix.dirname(f.path))
      .map(f => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return {
          folder: posix.dirname(f.path),
          title: typeof fm?.title === 'string' ? fm.title : undefined,
          status: typeof fm?.status === 'string' ? fm.status : undefined,
          discuss: fm ? isDiscussFlagged(fm) : false,
        };
      });
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

    this.catalogNodes = buildWorkflowTree({
      workflows: catalog.workflows,
      hwUnitOps: hw.unitOperations,
      swUnitOps: sw.unitOperations,
    });
    this.render();
  }

  /** Re-read the experiments (cheap: metadata cache only) and draw both sections. */
  private render(): void {
    const experiments = buildExperimentTree(this.experiments(), {
      root: this.plugin.t('Experiments'),
      noStatus: this.plugin.t('(none)'),
      discuss: this.plugin.t('Flagged for discussion'),
    });
    for (const group of experiments.children ?? []) {
      if (this.seeded.has(group.id)) continue;
      this.seeded.add(group.id);
      this.expanded.add(group.id);
    }

    renderTree(
      this.treeEl ?? this.contentEl,
      [experiments, ...this.catalogNodes],
      {
        expanded: this.expanded,
        onClick: node => this.onClick(node),
        onContext: (node, evt) => this.onContext(node, evt),
      },
      this
    );
  }

  private onClick(node: TreeNode): void {
    if (node.kind !== 'experiment') return;
    const { readmePath } = node.payload as { readmePath: string };
    void this.plugin.host.openFile(readmePath);
  }

  private onContext(node: TreeNode, evt: MouseEvent): void {
    if (node.kind === 'experiment') {
      const { folder } = node.payload as { folder: string };
      const menu = new Menu();
      menu.addItem(item =>
        item
          .setTitle(this.plugin.t('Change experiment status'))
          .setIcon('list-checks')
          .onClick(() => {
            const { app, host, stampLastUpdated } = this.plugin;
            void changeExperimentStatusCommand(app, host, stampLastUpdated, folder);
          })
      );
      menu.addItem(item =>
        item
          .setTitle(this.plugin.t('Toggle discussion flag'))
          .setIcon('message-circle')
          .onClick(() => {
            const { app, host, stampLastUpdated } = this.plugin;
            void toggleDiscussionFlagCommand(app, host, stampLastUpdated, folder);
          })
      );
      menu.showAtMouseEvent(evt);
      return;
    }

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
          void insertUnitOpAndUpdateToc(
            this.plugin.host,
            {
              opId: op.id,
              opName: op.name,
              opDescription: op.description,
              opType: op.opType,
              equipment: op.equipment,
              software: op.software,
            },
            unitOpAliasPrompt(this.app, this.plugin.host)
          )
        )
    );
    menu.showAtMouseEvent(evt);
  }
}
