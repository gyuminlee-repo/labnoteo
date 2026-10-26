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
  linkRetries,
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
import { getExperimentDir, retryOfLinkpath } from '@labnoteo/core/lib/labnoteStructure';
import { parseWorkflowChecklistFromReadme } from '@labnoteo/core/lib/workflowStructure';
import * as posix from '@labnoteo/core/posix';
import type LabnotePlugin from '../main';
import {
  insertUnitOpAndUpdateToc,
  createWorkflowForItem,
  unitOpAliasPrompt,
  changeExperimentStatusCommand,
  toggleDiscussionFlagCommand,
  retryExperimentCommand,
  catalogDescription,
  statusNames,
} from '../commands';
import { experimentMarkerSpots, noteMarkerIds } from '../issueMarkerIndex';
import { focusTree, renderTree } from './treeRender';

const README = 'README.labnote.md';

/** A front-matter value as text: a list (`author: [이서연, 김민준]`) joined, blank as undefined. */
function frontMatterText(value: unknown): string | undefined {
  const parts = (Array.isArray(value) ? value : [value])
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(v => String(v).trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

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
  /**
   * Experiments changed from this view since the search last changed: they
   * stay listed though they no longer match, so the change can be undone
   * by right-clicking them again (#356).
   */
  private readonly kept = new Set<string>();
  private searchTimer: number | undefined;
  /** README checklist progress by path, valid while the file's mtime is unchanged. */
  private readonly progress = new Map<string, { mtime: number; items: { done: boolean; fileName: string }[] }>();
  private readonly reading = new Set<string>();
  /** `@issue` markers of each note by path, valid while the file's mtime is unchanged (#337). */
  private readonly markers = new Map<string, { mtime: number; count: number }>();
  private readonly readingMarkers = new Set<string>();

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
      this.app.metadataCache.on('changed', (file, data) => {
        const counted = this.markers.has(file.path) && this.countMarkers(file, data);
        if (file.name === README || counted) this.scheduleRender();
      })
    );
    const onTree = (file: TAbstractFile, oldPath?: string): void => {
      // A workflow note coming or going changes its experiment's progress (#287).
      const isNote = (path: string | undefined): boolean => !!path && /\.labnote\.md$/i.test(path);
      if (
        file instanceof TFolder ||
        file.name === README ||
        oldPath?.endsWith(`/${README}`) ||
        isNote(file.path) ||
        isNote(oldPath)
      ) {
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
      this.kept.clear();
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
    groupBy.createEl('option', { value: 'author', text: this.plugin.t('By author') });
    groupBy.createEl('option', { value: 'discuss', text: this.plugin.t('By discussion') });
    groupBy.value = this.plugin.settings.workflowViewGroupBy;
    this.registerDomEvent(groupBy, 'change', () => {
      this.plugin.settings.workflowViewGroupBy =
        groupBy.value === 'project' || groupBy.value === 'author' || groupBy.value === 'discuss'
          ? groupBy.value
          : 'status';
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
    const entries = this.app.vault
      .getMarkdownFiles()
      .filter(f => f.name === README && getExperimentDir(f.path) === posix.dirname(f.path))
      .map(f => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const updated: unknown = fm?.last_updated_date;
        const folder = posix.dirname(f.path);
        return {
          folder,
          title: typeof fm?.title === 'string' ? fm.title : undefined,
          status: typeof fm?.status === 'string' ? fm.status : undefined,
          discuss: fm ? isDiscussFlagged(fm) : false,
          lastUpdated: typeof updated === 'string' && updated.trim() ? updated.trim() : undefined,
          progress: this.checklistProgress(f),
          project:
            typeof fm?.project === 'string' || typeof fm?.project === 'number' ? String(fm.project) : undefined,
          author: frontMatterText(fm?.author),
          markers: this.markerCount(folder),
          retryOf: this.retryOf(f, fm?.retry_of),
        };
      });
    return linkRetries(entries);
  }

  /** The experiment folder a README's `retry_of` link resolves to (#327). */
  private retryOf(readme: TFile, value: unknown): string | undefined {
    const linkpath = retryOfLinkpath(value);
    if (!linkpath) return undefined;
    const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, readme.path);
    const folder = target?.parent?.path;
    return folder && folder !== posix.dirname(readme.path) ? folder : undefined;
  }

  /**
   * The `@issue` markers of the notes directly in `folder`, the ones
   * `validate` reads, as counted so far (#337); a note not counted yet, or
   * changed since, is read in the background and the tree drawn again.
   */
  private markerCount(folder: string): number {
    const dir = this.app.vault.getAbstractFileByPath(folder);
    if (!(dir instanceof TFolder)) return 0;
    let total = 0;
    for (const file of dir.children) {
      if (!(file instanceof TFile) || !/\.labnote\.md$/i.test(file.name)) continue;
      const cached = this.markers.get(file.path);
      if (cached?.mtime !== file.stat.mtime && !this.readingMarkers.has(file.path)) {
        this.readingMarkers.add(file.path);
        void this.app.vault
          .cachedRead(file)
          .then(text => {
            if (this.countMarkers(file, text)) this.scheduleRender();
          })
          .catch(() => undefined)
          .finally(() => this.readingMarkers.delete(file.path));
      }
      total += cached?.count ?? 0;
    }
    return total;
  }

  /** Record `file`'s marker count from `text`; true when it changed. */
  private countMarkers(file: TFile, text: string): boolean {
    const count = noteMarkerIds(text).length;
    const before = this.markers.get(file.path);
    this.markers.set(file.path, { mtime: file.stat.mtime, count });
    return before?.count !== count;
  }

  /**
   * The README's "Related Workflows" progress as last read. The metadata
   * cache's list items would count every checkbox in the README, so the
   * checklist parser reads the text; a stale entry is re-read in the
   * background and the tree drawn again once it is in. Only entries whose
   * note is there count, checked on every draw: a note moved to another
   * experiment leaves its entry behind (#287).
   */
  private checklistProgress(file: TFile): { done: number; total: number } | undefined {
    const cached = this.progress.get(file.path);
    if (cached?.mtime !== file.stat.mtime && !this.reading.has(file.path)) {
      this.reading.add(file.path);
      void this.app.vault
        .cachedRead(file)
        .then(text => {
          this.progress.set(file.path, { mtime: file.stat.mtime, items: parseWorkflowChecklistFromReadme(text) });
          this.scheduleRender();
        })
        .catch(() => undefined)
        .finally(() => this.reading.delete(file.path));
    }
    if (!cached) return undefined;
    const folder = posix.dirname(file.path);
    const present = cached.items.filter(item => {
      const link = item.fileName;
      return [posix.join(folder, link), link].some(p => this.app.vault.getAbstractFileByPath(p) instanceof TFile);
    });
    return { done: present.filter(i => i.done).length, total: present.length };
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

    this.catalogNodes = buildWorkflowTree(
      {
        workflows: catalog.workflows,
        hwUnitOps: hw.unitOperations,
        swUnitOps: sw.unitOperations,
      },
      {
        describe: catalogDescription,
        equipment: this.plugin.t('Equipment'),
        software: this.plugin.t('Software'),
      }
    );
    this.render();
  }

  /** Re-read the experiments (cheap: metadata cache only) and draw both sections. */
  private render(): void {
    const discuss = this.plugin.t('Flagged for discussion');
    const discussGroup = this.plugin.t('Something to discuss');
    const all = this.experiments();
    const found = filterExperiments(all, this.query, `${discuss} ${discussGroup}`, statusNames(this.plugin.host));
    const experiments = buildExperimentTree(
      found.length === all.length ? found : all.filter(e => found.includes(e) || this.kept.has(e.folder)),
      {
        root: this.plugin.t('Experiments'),
        noStatus: this.plugin.t('(none)'),
        discuss,
        discussGroup,
        noDiscuss: this.plugin.t('Nothing to discuss'),
        markers: this.plugin.t('@issue markers'),
        retryOf: this.plugin.t('Retry of'),
        retriedBy: this.plugin.t('Retried in'),
        invalidStatus: this.plugin.t('(not an allowed status)'),
        invalidStatusTooltip: this.plugin.t('Validation fails on this status. Allowed statuses: {0}'),
        status: this.plugin.t('Status'),
        workflows: this.plugin.t('Workflows done'),
        lastUpdated: this.plugin.t('Last updated'),
        project: this.plugin.t('Project'),
        noProject: this.plugin.t('(no project)'),
        author: this.plugin.t('Author'),
        noAuthor: this.plugin.t('(no author)'),
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

  /** Pick one of the experiment's `@issue` markers and open its note at that line (#379). */
  private async showMarkers(folder: string): Promise<void> {
    const { host } = this.plugin;
    const spots = await experimentMarkerSpots(host.fs, folder);
    if (spots.length === 0) {
      host.notify('info', this.plugin.t('This experiment has no @issue markers.'));
      return;
    }
    const spot = await host.pick(
      spots.map(s => ({ label: s.title, description: `${posix.basename(s.path)}:${s.line}`, value: s })),
      { title: this.plugin.t('@issue markers of {0} ({1})', posix.basename(folder), String(spots.length)) }
    );
    if (spot) await host.openFile(spot.path, { line: spot.line - 1 });
  }

  private onContext(node: TreeNode, evt: MouseEvent): void {
    if (node.kind === 'experiment') {
      const { folder, status } = node.payload as { folder: string; status?: string };
      const menu = new Menu();
      menu.addItem(item =>
        item
          .setTitle(this.plugin.t('Change experiment status'))
          .setIcon('list-checks')
          .onClick(() => {
            const { app, host, stampLastUpdated } = this.plugin;
            this.kept.add(folder);
            void changeExperimentStatusCommand(app, host, stampLastUpdated, folder);
          })
      );
      menu.addItem(item =>
        item
          .setTitle(this.plugin.t('Toggle discussion flag'))
          .setIcon('message-circle')
          .onClick(() => {
            const { app, host, stampLastUpdated } = this.plugin;
            this.kept.add(folder);
            void toggleDiscussionFlagCommand(app, host, stampLastUpdated, folder);
          })
      );
      if (this.markerCount(folder) > 0) {
        menu.addItem(item =>
          item
            .setTitle(this.plugin.t('Show @issue markers'))
            .setIcon('message-square-quote')
            .onClick(() => void this.showMarkers(folder))
        );
      }
      if (status === 'failed' || status === 'needs-repeat') {
        menu.addItem(item =>
          item
            .setTitle(this.plugin.t('Retry this experiment'))
            .setIcon('rotate-ccw')
            .onClick(() => this.plugin.run(() => retryExperimentCommand(this.app, this.plugin.host, folder)))
        );
      }
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
