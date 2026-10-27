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
import { isSameSampleFolder, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import type LabnotePlugin from '../main';
import { focusTree, renderTree } from './treeRender';
import { addPartbankMenuItems } from '../partbank/partbankActions';
import {
  createSampleInteractive,
  editSampleInteractive,
  deleteSampleInteractive,
  moveSampleInteractive,
  changeSampleTypeInteractive,
  setSampleDiscardedInteractive,
  insertSampleReference,
  sampleUsageSpots,
  usageSpotLabel,
  type SampleScope,
} from '../sampleActions';
import { pickModal } from '../modals';
import { openSampleDefinition } from '../sampleDefinitionModal';

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

  /** Put keyboard focus on the tree (#197); opening the view alone leaves it elsewhere. */
  focusTree(): void {
    if (this.treeEl) focusTree(this.treeEl);
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

    const labels = { discarded: this.plugin.t('(discarded)') };
    this.lastNodes = (await buildSampleTree(this.plugin.fs, { local, global }, types, labels)).map(root =>
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
          this.plugin.run(() => createSampleInteractive(this.app, this.plugin, {
            type: payload.type,
            folder: this.scopeFolder(payload.scope),
            mode: 'generate',
            scope: payload.scope,
          }));
        })
    );
    menu.showAtMouseEvent(evt);
  }

  /** The places that use a sample, picked from a list to open at the reference (#130, #291). */
  private async showUsages(folder: string, sample: SamplePayload): Promise<void> {
    const spots = await sampleUsageSpots(this.app, this.plugin, folder, sample.type, sample.id);
    if (spots.length === 0) {
      new Notice(this.plugin.t('{0} is not used in any note.', sample.id));
      return;
    }
    const notes = new Set(spots.map(s => s.path)).size;
    const spot = await pickModal(
      this.app,
      spots.map(s => ({ label: s.path, description: usageSpotLabel(this.plugin.t, s), value: s })),
      { title: this.plugin.t('Notes using {0} ({1})', sample.id, String(notes)) }
    );
    if (spot) await this.plugin.host.openFile(spot.path, { line: spot.line, ch: spot.ch });
  }

  /** Sample node: copy / insert reference / view usages / edit / delete. */
  private onSampleContext(sample: SamplePayload, evt: MouseEvent): void {
    const folder = this.scopeFolder(sample.scope);
    const menu = new Menu();

    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Show sample definition'))
        .setIcon('info')
        .onClick(() => {
          this.plugin.run(() => openSampleDefinition(this.app, this.plugin, {
            type: sample.type,
            id: sample.id,
            docPath: '',
            resolved: { scope: sample.scope, folder, record: sample.record },
            localFolder: this.lastRenderedLocal,
          }));
        })
    );
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
          this.plugin.run(() => insertSampleReference(
            this.plugin,
            target,
            buildSampleReferenceText(sample.id, sample.record.alias)
          ));
          if (sample.record.discarded) {
            new Notice(this.plugin.t('{0} was marked discarded on {1}.', sample.id, sample.record.discarded));
          }
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('View usages'))
        .setIcon('search')
        .onClick(() => this.plugin.run(() => this.showUsages(folder, sample)))
    );
    addPartbankMenuItems(menu, this.plugin, {
      type: sample.type,
      id: sample.id,
      folder,
      record: sample.record,
    });
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Edit sample'))
        .setIcon('pencil')
        .onClick(() => {
          this.plugin.run(() => editSampleInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
            record: sample.record,
          }));
        })
    );
    // Outside an experiment Local is the Global folder: there is no Local to move to (#159).
    const noLocal = isSameSampleFolder(this.lastRenderedLocal, this.plugin.settings.globalSampleFolder);
    if (sample.scope === 'local' || !noLocal) {
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
            this.plugin.run(() => moveSampleInteractive(this.app, this.plugin, {
              fromScope: sample.scope,
              fromFolder: this.scopeFolder(sample.scope),
              toFolder: this.scopeFolder(toScope),
              type: sample.type,
              id: sample.id,
            }));
          })
      );
    }
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Change type'))
        .setIcon('replace')
        .onClick(() => {
          this.plugin.run(() => changeSampleTypeInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
          }));
        })
    );
    const discarded = Boolean(sample.record.discarded);
    menu.addItem(item =>
      item
        .setTitle(discarded ? this.plugin.t('Unmark discarded') : this.plugin.t('Mark as discarded'))
        .setIcon(discarded ? 'archive-restore' : 'archive')
        .onClick(() => {
          this.plugin.run(() => setSampleDiscardedInteractive(this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
            discarded: !discarded,
          }));
        })
    );
    menu.addItem(item =>
      item
        .setTitle(this.plugin.t('Delete sample'))
        .setIcon('trash')
        .onClick(() => {
          this.plugin.run(() => deleteSampleInteractive(this.app, this.plugin, {
            folder,
            type: sample.type,
            id: sample.id,
          }));
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
