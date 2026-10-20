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
import { ItemView, Menu, TFile, TFolder, WorkspaceLeaf, type TAbstractFile } from 'obsidian';
import {
  buildExperimentTree,
  buildWorkflowTree,
  filterExperiments,
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
import { parseWorkflowChecklistFromReadme } from '@labnoteo/core/lib/workflowStructure';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from '../main';
import {
  insertUnitOpAndUpdateToc,
  createWorkflowForItem,
  unitOpAliasPrompt,
  changeExperimentStatusCommand,
  toggleDiscussionFlagCommand,
} from '../commands';
import { focusTree, renderTree } from './treeRender';

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
  /** Experiment search; its box sits outside {@link treeEl} so a redraw keeps focus and text (#204). */
  private query = '';
  private searchTimer: number | undefined;
  /** README checklist progress by path, valid while the file's mtime is unchanged. */
  private readonly progress = new Map<string, { mtime: number; done: number; total: number }>();
  private readonly reading = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LabnotePlugin) {
    super(leaf);
  }

  /** Put keyboard focus on the tree (#197); opening the view alone leaves it elsewhere. */
  focusTree(): void {
    if (this.treeEl) focusTree(this.treeEl);
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
    this.buildControls();
    this.treeEl = this.contentEl.createDiv();
    this.expanded.add('experiments');
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.renderTimer !== undefined) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.searchTimer !== undefined) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
  }

  /** Experiment search box and the status/project grouping switch (#204). */
  private buildControls(): void {
    const controls = this.contentEl.createDiv({ cls: 'labnote-workflow-controls' });
    const search = controls.createEl('input', {
      cls: 'labnote-workflow-search',
      attr: { type: 'search', placeholder: this.plugin.t('Search experiments') },
    });
    search.value = this.query;
    this.registerDomEvent(search, 'input', () => {
      this.query = search.value;
      if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = undefined;
        this.render();
      }, 200);
    });
    const groupBy = controls.createEl('select', {
      cls: 'dropdown labnote-workflow-group-by',
      attr: { 'aria-label': this.plugin.t('Group experiments by') },
    });
    groupBy.createEl('option', { value: 'status', text: this.plugin.t('By status') });
    groupBy.createEl('option', { value: 'project', text: this.plugin.t('By project') });
    groupBy.value = this.plugin.settings.workflowViewGroupBy;
    this.registerDomEvent(groupBy, 'change', () => {
      this.plugin.settings.workflowViewGroupBy = groupBy.value === 'project' ? 'project' : 'status';
      void this.plugin.saveSettings();
      this.render();
    });
  }

  /** Coalesce bursts of vault events (a folder rename moves every file) into one render. */
  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 300);
  }

  /**
   * Experiments whose README the metadata cache has read, with its `title`,
   * `status`, `discuss` flag and `last_updated_date`, and the checklist
   * progress read so far (#157).
   */
  private experiments(): ExperimentEntry[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter(f => f.name === README && getExperimentDir(f.path) === posix.dirname(f.path))
      .map(f => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const updated: unknown = fm?.last_updated_date;
        return {
          folder: posix.dirname(f.path),
          title: typeof fm?.title === 'string' ? fm.title : undefined,
          status: typeof fm?.status === 'string' ? fm.status : undefined,
          discuss: fm ? isDiscussFlagged(fm) : false,
          lastUpdated: typeof updated === 'string' && updated.trim() ? updated.trim() : undefined,
          progress: this.checklistProgress(f),
          project:
            typeof fm?.project === 'string' || typeof fm?.project === 'number' ? String(fm.project) : undefined,
        };
      });
  }

  /**
   * The README's "Related Workflows" progress as last read. The metadata
   * cache's list items would count every checkbox in the README, so the
   * checklist parser reads the text; a stale entry is re-read in the
   * background and the tree drawn again once it is in.
   */
  private checklistProgress(file: TFile): { done: number; total: number } | undefined {
    const cached = this.progress.get(file.path);
    if (cached?.mtime !== file.stat.mtime && !this.reading.has(file.path)) {
      this.reading.add(file.path);
      void this.app.vault
        .cachedRead(file)
        .then(text => {
          const items = parseWorkflowChecklistFromReadme(text);
          this.progress.set(file.path, {
            mtime: file.stat.mtime,
            done: items.filter(i => i.done).length,
            total: items.length,
          });
          this.scheduleRender();
        })
        .catch(() => undefined)
        .finally(() => this.reading.delete(file.path));
    }
    return cached ? { done: cached.done, total: cached.total } : undefined;
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
    const experiments = buildExperimentTree(
      filterExperiments(this.experiments(), this.query),
      {
        root: this.plugin.t('Experiments'),
        noStatus: this.plugin.t('(none)'),
        discuss: this.plugin.t('Flagged for discussion'),
        invalidStatus: this.plugin.t('(not an allowed status)'),
        invalidStatusTooltip: this.plugin.t('Validation fails on this status. Allowed statuses: {0}'),
        status: this.plugin.t('Status'),
        workflows: this.plugin.t('Workflows done'),
        lastUpdated: this.plugin.t('Last updated'),
        project: this.plugin.t('Project'),
        noProject: this.plugin.t('(no project)'),
      },
      this.plugin.settings.workflowViewGroupBy
    );
    for (const group of experiments.children ?? []) {
      if (this.seeded.has(group.id)) continue;
      this.seeded.add(group.id);
      this.expanded.add(group.id);
    }
    // While searching, every group with a match is open, whatever was closed before.
    const expanded = this.query.trim()
      ? new Set([...this.expanded, 'experiments', ...(experiments.children ?? []).map(g => g.id)])
      : this.expanded;

    renderTree(
      this.treeEl ?? this.contentEl,
      [experiments, ...this.catalogNodes],
      {
        expanded,
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
