/**
 * Samples sidebar (Local + Global scopes).
 *
 * Consumes the core {@link buildSampleTree} model. The Local scope is resolved
 * from the active note's experiment root (`labnote/###_*`) via
 * {@link LabnotePlugin.localSampleFolder}, so switching notes within the same
 * experiment keeps the tree stable (re-rendered on `active-leaf-change`). A note
 * outside any experiment shows its own folder (a vault-root note's is Global);
 * only non-note files (images, PDFs) keep the last experiment.
 */
import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import { buildSampleTree, filterSampleTree, type TreeNode } from '@labnoteo/core';
import {
  getSampleDisplayMeta,
  buildSampleReferenceText,
} from '@labnoteo/core/lib/sampleUtils';
import { type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import type LabnotePlugin from '../main';
import { renderTree } from './treeRender';
import {
  createSampleInteractive,
  editSampleInteractive,
  deleteSampleInteractive,
  moveSampleInteractive,
  changeSampleTypeInteractive,
  insertSampleReference,
  type SampleScope,
} from '../sampleActions';

export const SAMPLE_VIEW_TYPE = 'labnote-sample-view';

interface TypePayload {
  scope: SampleScope;
  type: string;
}

interface SamplePayload {
  scope: SampleScope;
  type: string;
  id: string;
  record: SampleRecord;
}

export class SampleTreeView extends ItemView {
  private readonly expanded = new Set<string>();
  private refreshQueued = false;
  private refreshTimer?: number;
  // Free-text filter applied over the loaded tree (id/alias/description/location).
  private searchQuery = '';
  private searchTimer?: number;
  // Dedicated container the tree renders into; kept separate from the search
  // box above it so `renderTree`'s `container.empty()` never wipes the input.
  private treeEl?: HTMLElement;
  // Last tree loaded from disk, re-filtered in place when the query changes so
  // typing in the search box never re-reads every `{Type}.json`.
  private lastNodes: TreeNode[] = [];
  // The Local folder used by the most recent render. Context-menu actions
  // (Add/Edit/Delete/Move) write here so they always target the folder the user
  // is looking at, even if the active file changed after the tree was drawn.
  private lastRenderedLocal = '';
  // Auto-expand runs once per view lifetime; afterwards the user's collapse
  // choices are respected.
  private seededExpand = false;

  /** Resolve a scope to the folder the currently-rendered tree is showing. */
  private scopeFolder(scope: SampleScope): string {
    return scope === 'global' ? this.plugin.settings.globalSampleFolder : this.lastRenderedLocal;
  }

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LabnotePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SAMPLE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.t('Samples');
  }

  getIcon(): string {
    return 'test-tube';
  }

  async onOpen(): Promise<void> {
    // Re-scope Local when the active note changes.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh())
    );
    // Reflect on-disk {Type}.json writes.
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (file.path.endsWith('.json') || file.path.endsWith('.labnote.md')) {
          this.scheduleRefresh();
        }
      })
    );
    this.buildChrome();
    await this.refresh();
  }

  /** Build the persistent chrome (search box + tree container) once per open. */
  private buildChrome(): void {
    this.contentEl.empty();
    const search = this.contentEl.createEl('input', {
      cls: 'labnote-sample-search',
      attr: { type: 'search', placeholder: this.plugin.t('Search samples') },
    });
    search.value = this.searchQuery;
    this.registerDomEvent(search, 'input', () => {
      this.searchQuery = search.value;
      if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = undefined;
        this.renderCurrent();
      }, 200);
    });
    this.contentEl.createDiv({
      cls: 'labnote-view-hint',
      text: this.plugin.t(
        'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.',
        this.plugin.t('Add sample')
      ),
    });
    this.treeEl = this.contentEl.createDiv({ cls: 'labnote-sample-tree-container' });
  }

  /** Coalesce bursts of events into a single debounced refresh. */
  private scheduleRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    // Keep the handle so onClose() can cancel a pending refresh; otherwise the
    // timer fires after the view is torn down and touches a dead contentEl.
    this.refreshTimer = window.setTimeout(() => {
      this.refreshQueued = false;
      this.refreshTimer = undefined;
      void this.refresh();
    }, 300);
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.searchTimer !== undefined) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.refreshQueued = false;
  }

  async refresh(): Promise<void> {
    const global = this.plugin.settings.globalSampleFolder;
    const local = this.plugin.localSampleFolder();
    this.lastRenderedLocal = local;
    const types = getSampleDisplayMeta(this.plugin.settings.customSampleTypes).types;

    this.lastNodes = (await buildSampleTree(this.plugin.fs, { local, global }, types)).map(root =>
      (root.payload as { sameFolder?: boolean } | undefined)?.sameFolder ? this.sameFolderNotice(root) : root
    );
    this.seedInitialExpansion(this.lastNodes);
    this.renderCurrent();
  }

  /**
   * The Local root of a note outside any experiment, whose Local folder is the
   * Global one: one line saying so instead of empty type nodes, whose "Add
   * sample" would write to Global anyway (#111). No click or menu.
   */
  private sameFolderNotice(root: TreeNode): TreeNode {
    return {
      ...root,
      children: [
        {
          id: `${root.id}:sameFolder`,
          label: this.plugin.t(
            'Notes outside an experiment use the Global samples below. Open an experiment note to see its samples.'
          ),
          kind: 'sampleDetail',
        },
      ],
    };
  }

  /**
   * Render the loaded tree through the active search filter. A non-empty query
   * forces every surviving node open (so matches are visible without clicking),
   * using a throwaway expanded set so the user's manual collapse state is
   * untouched once the search is cleared.
   */
  private renderCurrent(): void {
    if (!this.treeEl) return;
    const nodes = filterSampleTree(this.lastNodes, this.searchQuery);
    const searching = this.searchQuery.trim().length > 0;
    const expanded = searching ? collectNodeIds(nodes) : this.expanded;
    renderTree(
      this.treeEl,
      nodes,
      {
        expanded,
        onContext: (node, evt) => this.onContext(node, evt),
      },
      this
    );
  }

  /**
   * On the first render, open both scope roots (so Global samples are visible
   * without a click) and any type node that actually holds samples. Type nodes
   * whose only child is the synthetic "No samples" placeholder stay collapsed —
   * hence the `kind === 'sample'` check rather than `children.length`.
   */
  private seedInitialExpansion(nodes: TreeNode[]): void {
    if (this.seededExpand) return;
    this.seededExpand = true;
    for (const root of nodes) {
      this.expanded.add(root.id);
      for (const typeNode of root.children ?? []) {
        if (typeNode.children?.some(c => c.kind === 'sample')) {
          this.expanded.add(typeNode.id);
        }
      }
    }
  }

  private onContext(node: TreeNode, evt: MouseEvent): void {
    if (node.kind === 'sampleType') {
      this.onTypeContext(node.payload as TypePayload, evt);
      return;
    }
    if (node.kind === 'sample') {
      this.onSampleContext(node.payload as SamplePayload, evt);
    }
  }

  /** Type node: create a new sample in that scope's folder. */
  private onTypeContext(payload: TypePayload, evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Add sample'))
        .setIcon('plus')
        .onClick(() => {
          // Local writes need a resolvable experiment folder; without one the
          // sample would land in an unexpected place (or the Global fallback).
          if (payload.scope === 'local' && !this.plugin.hasLocalScope()) {
            new Notice(this.plugin.t('Open a note first to add a local sample.'));
            return;
          }
          void createSampleInteractive(this.app, this.plugin, {
            type: payload.type,
            folder: this.scopeFolder(payload.scope),
            mode: 'generate',
            scope: payload.scope,
          });
        })
    );
    menu.showAtMouseEvent(evt);
  }

  /** Sample node: copy / insert reference / edit / delete. */
  private onSampleContext(sample: SamplePayload, evt: MouseEvent): void {
    const folder = this.scopeFolder(sample.scope);
    const menu = new Menu();

    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Copy sample ID'))
        .setIcon('copy')
        .onClick(() => {
          void navigator.clipboard.writeText(sample.id);
          new Notice(this.plugin.t('Copied: {0}', sample.id));
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Insert reference'))
        .setIcon('plus')
        .onClick(() => {
          const target = this.plugin.host.editTarget();
          if (!target) {
            new Notice(this.plugin.t('Open a note to insert into.'));
            return;
          }
          void insertSampleReference(
            this.plugin,
            target,
            buildSampleReferenceText(sample.id, sample.record.alias)
          );
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Edit sample'))
        .setIcon('pencil')
        .onClick(() => {
          void editSampleInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
            record: sample.record,
          });
        })
    );
    menu.addItem(item =>
      item
        .setTitle(
          sample.scope === 'local'
            ? this.plugin.t('Move to Global')
            : this.plugin.t('Move to Local')
        )
        .setIcon('arrow-right-left')
        .onClick(() => {
          // Hand the move the exact folders this tree rendered with, so it can
          // never re-derive Local from a since-changed active file and land in
          // a different experiment than the one shown.
          const toScope: SampleScope = sample.scope === 'local' ? 'global' : 'local';
          void moveSampleInteractive(this.app, this.plugin, {
            fromScope: sample.scope,
            fromFolder: this.scopeFolder(sample.scope),
            toFolder: this.scopeFolder(toScope),
            type: sample.type,
            id: sample.id,
          });
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Change type'))
        .setIcon('replace')
        .onClick(() => {
          void changeSampleTypeInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
          });
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Delete sample'))
        .setIcon('trash')
        .onClick(() => {
          void deleteSampleInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
          });
        })
    );

    menu.showAtMouseEvent(evt);
  }
}

/** Collect every node id in a tree (used to force-expand search results). */
function collectNodeIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      ids.add(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}
