/**
 * Labnote Assistant — Obsidian plugin entry point.
 *
 * This is the skeleton: it wires the platform-neutral pieces from
 * `@labnoteo/core` (file-system port, translator) into Obsidian and registers a
 * couple of proof-of-wiring commands. Domain commands, sample suggestions, CM6
 * highlighting, sidebar views, the settings tab and the LLM/MCP layer are added
 * by subsequent modules that all consume the same `LabnoteHost` built here.
 */
import { Plugin, Notice, TFile, editorInfoField } from 'obsidian';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import { findSampleReferenceAt, rebuildUnitOpToc, minimalReplacement } from '@labnoteo/core';
import {
  getSeoulDateString,
  getSeoulDateTimeString,
  touchLastUpdatedDate,
} from '@labnoteo/core/lib/dateUtils';
import { getSampleDisplayMeta, isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import { classifyWorkflowRename, isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { saveSamplesFromDocument, getLabsamplesFolder } from '@labnoteo/core/lib/sampleStorage';
import { VaultFileSystem } from './vaultFileSystem';
import { createObsidianTranslator } from './i18n';
import { createObsidianHost } from './obsidianHost';
import {
  createExperimentCommand,
  changeExperimentStatusCommand,
  insertIssueMarkerCommand,
  isIssueAutomationInstalled,
  toggleDiscussionFlagCommand,
  createWorkflowCommand,
  renumberWorkflowsCommand,
  insertUnitOperationCommand,
  insertWorkflowLinkCommand,
  syncReadmeOrderOnRename,
  syncReadmeAndSamplesOnDelete,
  setupResearchAutomationCommand,
  type ReadmeSyncControl,
} from './commands';
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { SampleEditorSuggest } from './sampleSuggest';
import { openSampleDefinition } from './sampleDefinitionModal';
import { pickModal } from './modals';
import { createSampleInteractive, pickCatalogReference, insertSampleReference } from './sampleActions';
import {
  createSampleHighlightPlugin,
  createSampleReadingHighlighter,
  type HighlightState,
} from './sampleHighlight';
import { createMetaDatePickerExtension } from './dateFieldPicker';
import { createUnitOpReorderFilter } from './unitOpReorderFilter';
import { LastUpdatedTracker } from './lastUpdatedTracker';
import { isLabNotePath, stampNoteAndReadme, writeNoteStamped } from './lastUpdatedStamp';
import { createOutlineDropTidy, type OutlineDropSnapshot } from './outlineDropTidy';
import { WorkflowTreeView, WORKFLOW_VIEW_TYPE } from './views/workflowView';
import { SampleTreeView, SAMPLE_VIEW_TYPE } from './views/sampleView';
import { exportTablesToCsv, exportActiveNoteTablesToCsv } from './exportCsv';
import { openUserGuide } from './userGuide';
import { LabnoteSettingTab } from './settingsTab';
import {
  draftMethodCommand,
  summarizeResultsCommand,
  extractSamplesCommand,
  askAgentCommand,
} from './llm/commands';
import { LabnoteMcpServer } from './llm/mcpServer';
import { CURRENT_SCHEMA_VERSION, migrateSettings, type LabnoteSettings } from './settings';

export default class LabnotePlugin extends Plugin {
  // `Plugin` already declares `settings?: unknown`; re-type it concretely.
  declare settings: LabnoteSettings;
  fs!: VaultFileSystem;
  t!: Translator;
  host!: LabnoteHost;
  mcpServer!: LabnoteMcpServer;
  private sampleSuggest?: SampleEditorSuggest;
  // Last experiment folder (`labnote/###_*`) resolved from an active note, kept
  // in memory so the Samples sidebar's Local scope stays pinned to that
  // experiment even when focus moves to a file outside it. Reset on reload.
  private lastExperimentDir?: string;
  // Users who run the plugin without automation would otherwise be told on
  // every marker that it opens no issue; once per session is enough.
  private issueAutomationHintShown = false;
  private readonly sampleSyncTimers = new Map<string, number>();
  // Pending README auto-sync events, coalesced per experiment folder.
  private readonly readmeSyncQueue = new Map<
    string,
    { renames: { from: string; to: string }[]; deletes: string[] }
  >();
  private readonly readmeSyncTimers = new Map<string, number>();
  // Folders whose README sync is paused (renumbering): events queue, no timer.
  private readonly readmeSyncHolds = new Set<string>();
  // The latest README flush per folder, so a new one runs after it, never beside it.
  private readonly readmeSyncInFlight = new Map<string, Promise<void>>();
  // Set on unload: a flush still waiting for a modal to close must not write.
  private unloaded = false;
  // Workflow notes renamed out of the `###_*.labnote.md` format: current path →
  // original file name, so fixing the name later relinks the README entry.
  // Memory only — after a restart such a note is no longer followed.
  private readonly strayWorkflows = new Map<string, string>();
  // Pending unit-op TOC auto-sync flushes, coalesced per workflow-note path.
  private readonly unitOpTocTimers = new Map<string, number>();
  // Whether each note's latest editor change was an undo/redo, so the TOC sync
  // does not record a fresh edit that would block undoing further back.
  private readonly lastChangeFromHistory = new Map<string, boolean>();
  // Pending `last_updated_date` stamps after editor edits, per lab-note path.
  private readonly lastUpdatedTimers = new Map<string, number>();
  private readonly lastUpdatedTracker = new LastUpdatedTracker();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.fs = new VaultFileSystem(this.app.vault.adapter);
    this.t = createObsidianTranslator();
    this.host = createObsidianHost(this.app, this.fs, this.t);
    this.mcpServer = new LabnoteMcpServer(this);

    this.registerCommands();
    this.registerSampleFeatures();
    this.registerInlineHighlighting();
    this.registerEditorExtension(createMetaDatePickerExtension(this.t('Pick date and time')));
    this.registerViews();
    this.registerFileMenu();
    this.registerEditorMenu();
    this.registerWorkflowReadmeSync();
    this.registerUnitOpTocAutoSync();
    this.registerLastUpdatedAutoSync();
    this.registerOutlineDropTidy();
    this.registerEditorExtension(
      createUnitOpReorderFilter({
        isEnabled: () => this.settings.autoSyncUnitOpToc,
        getFilePath: s => s.field(editorInfoField, false)?.file?.path ?? null,
        onDocChange: (path, fromHistory, kind) => {
          this.lastChangeFromHistory.set(path, fromHistory);
          if (isLabNotePath(path)) this.lastUpdatedTracker.record(path, { ...kind, fromHistory });
        },
      })
    );
    this.addSettingTab(new LabnoteSettingTab(this.app, this));

    if (this.settings.mcpEnabled) {
      // Defer to layout-ready so we don't block plugin init on the listener.
      this.app.workspace.onLayoutReady(() => this.mcpServer.start());
    }
  }

  onunload(): void {
    this.mcpServer?.stop();
    // Cancel any pending debounced sample-sync writes. registerInterval only
    // covers setInterval, so these setTimeout handles must be cleared by hand —
    // otherwise an unloaded instance still writes to the vault ~800ms later.
    for (const handle of this.sampleSyncTimers.values()) {
      window.clearTimeout(handle);
    }
    this.sampleSyncTimers.clear();
    // Same for pending README auto-sync flushes.
    for (const handle of this.readmeSyncTimers.values()) {
      window.clearTimeout(handle);
    }
    this.readmeSyncTimers.clear();
    this.readmeSyncQueue.clear();
    this.readmeSyncHolds.clear();
    this.readmeSyncInFlight.clear();
    this.unloaded = true;
    // Also drops any name-fix prompt still waiting for a modal to close.
    this.strayWorkflows.clear();
    // Same for pending unit-op TOC auto-sync flushes.
    for (const handle of this.unitOpTocTimers.values()) {
      window.clearTimeout(handle);
    }
    this.unitOpTocTimers.clear();
    for (const handle of this.lastUpdatedTimers.values()) {
      window.clearTimeout(handle);
    }
    this.lastUpdatedTimers.clear();
    this.lastUpdatedTracker.clear();
    // Views/events registered via this.register*() are auto-cleaned by Obsidian.
  }

  /**
   * Run an async command body, surfacing any failure as an error Notice instead
   * of letting the rejected promise vanish (which left commands failing
   * silently with nothing shown to the user).
   */
  private run(fn: () => Promise<void>): void {
    fn().catch((err: unknown) => {
      console.error('[labnoteo] command failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.host.notify('error', this.t('Command failed: {0}', msg));
    });
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'insert-date',
      name: this.t('Insert date'),
      editorCallback: editor => {
        editor.replaceSelection(getSeoulDateString());
      },
    });

    this.addCommand({
      id: 'insert-datetime',
      name: this.t('Insert date and time'),
      editorCallback: editor => {
        editor.replaceSelection(getSeoulDateTimeString());
      },
    });

    this.addCommand({
      id: 'create-experiment',
      name: this.t('Create experiment'),
      callback: () => this.run(() => createExperimentCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'change-experiment-status',
      name: this.t('Change experiment status'),
      callback: () =>
        this.run(() => changeExperimentStatusCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'insert-issue-marker',
      name: this.t('Insert issue marker'),
      editorCallback: editor => {
        if (!insertIssueMarkerCommand(editor, this.host) || this.issueAutomationHintShown) return;
        this.run(async () => {
          if (await isIssueAutomationInstalled(this.host)) return;
          this.issueAutomationHintShown = true;
          this.host.notify(
            'info',
            this.t('Issue marker inserted. To open it as an issue, run "Setup research automation" first.')
          );
        });
      },
    });

    this.addCommand({
      id: 'toggle-discussion-flag',
      name: this.t('Toggle discussion flag'),
      callback: () =>
        this.run(() => toggleDiscussionFlagCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'setup-research-automation',
      name: this.t('Setup research automation'),
      callback: () => this.run(() => setupResearchAutomationCommand(this.host)),
    });

    this.addCommand({
      id: 'create-workflow',
      name: this.t('Create workflow'),
      callback: () => this.run(() => createWorkflowCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'renumber-workflows',
      name: this.t('Renumber workflows'),
      callback: () =>
        this.run(() => renumberWorkflowsCommand(this.app, this.host, this.readmeSyncControl())),
    });

    this.addCommand({
      id: 'insert-unit-operation',
      name: this.t('Insert unit operation'),
      callback: () => this.run(() => insertUnitOperationCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'export-tables-csv',
      name: this.t('Export tables to CSV'),
      callback: () => this.run(() => exportActiveNoteTablesToCsv(this)),
    });

    // --- AI commands ---
    this.addCommand({
      id: 'ai-draft-method',
      name: this.t('AI: Draft Method section'),
      callback: () => this.run(() => draftMethodCommand(this)),
    });
    this.addCommand({
      id: 'ai-summarize-results',
      name: this.t('AI: Summarize results'),
      callback: () => this.run(() => summarizeResultsCommand(this)),
    });
    this.addCommand({
      id: 'ai-extract-samples',
      name: this.t('AI: Extract sample definitions'),
      callback: () => this.run(() => extractSamplesCommand(this)),
    });
    this.addCommand({
      id: 'ai-ask-agent',
      name: this.t('AI: Ask assistant (uses tools)'),
      callback: () => this.run(() => askAgentCommand(this)),
    });

    this.addCommand({
      id: 'toggle-mcp-server',
      name: this.t('Toggle MCP server'),
      callback: () =>
        this.run(async () => {
          // Keep the persisted `mcpEnabled` in lock-step with the live server so
          // the command and the settings toggle can't drift out of sync.
          if (this.mcpServer.running) {
            this.mcpServer.stop();
            this.settings.mcpEnabled = false;
          } else {
            this.mcpServer.start();
            this.settings.mcpEnabled = true;
          }
          await this.saveSettings();
        }),
    });
  }

  /**
   * Sample-tree cleanup context passed to the delete auto-sync so it can prune
   * `{Type}.json` records and refresh the sample UI/autocomplete cache.
   */
  private sampleCleanupOpts() {
    return {
      globalSampleFolder: this.settings.globalSampleFolder,
      customTypes: this.settings.customSampleTypes,
      onSamplesChanged: () => {
        this.sampleSuggest?.clearCache();
        this.refreshSampleViews();
      },
    };
  }

  /**
   * Right-click a markdown note in the file explorer → export its tables to CSV.
   * Workflow rename/delete are no longer custom actions: renaming or deleting a
   * workflow file in the explorer auto-syncs the README (see
   * {@link registerWorkflowReadmeSync}).
   */
  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem(item =>
          item
            .setTitle(this.t('Export tables to CSV'))
            .setIcon('table')
            .onClick(() => void exportTablesToCsv(this, file))
        );
      })
    );
  }

  /** Right-click in a lab-note editor → create a workflow + insert a link at the cursor. */
  private registerEditorMenu(): void {
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const file = info.file;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        // Go to definition works in ANY markdown note (references may appear
        // outside `.labnote.md`), so add it before the workflow-file gate below.
        if (this.settings.sampleTracking) {
          const cur = editor.getCursor();
          const types = getSampleDisplayMeta(this.settings.customSampleTypes).types;
          const hit = findSampleReferenceAt(editor.getLine(cur.line), cur.ch, types);
          if (hit) {
            menu.addItem(item =>
              item
                .setTitle(this.t('Go to definition'))
                .setIcon('search')
                .onClick(() =>
                  this.run(() =>
                    openSampleDefinition(this.app, this, {
                      type: hit.type,
                      id: hit.id,
                      docPath: file.path,
                    })
                  )
                )
            );
          }

          // Always offer adding a sample from the editor (not just when the
          // cursor sits on an existing reference), so a sample can be created
          // and referenced without leaving the note for the sidebar.
          menu.addItem(item =>
            item
              .setTitle(this.t('Add sample'))
              .setIcon('plus')
              .onClick(() => this.run(() => this.addSampleFromEditor()))
          );
        }

        // Workflow-specific items depend on the file kind:
        //  - a workflow file (NNN_WX###_*.labnote.md) → insert a unit operation,
        //  - the experiment README (README.labnote.md) → insert a workflow link.
        // Everything else (plain notes) gets no workflow item.
        if (isValidWorkflowPath(file.path)) {
          menu.addItem(item =>
            item
              .setTitle(this.t('Insert unit operation'))
              .setIcon('plus')
              .onClick(() => this.run(() => insertUnitOperationCommand(this.app, this.host)))
          );
        } else if (file.name.toLowerCase() === 'readme.labnote.md') {
          menu.addItem(item =>
            item
              .setTitle(this.t('Insert workflow'))
              .setIcon('git-branch-plus')
              .onClick(() => this.run(() => insertWorkflowLinkCommand(this.app, this.host, editor)))
          );
        }
      })
    );
  }

  /**
   * Editor context-menu "Add sample": pick a type, then create (authored types)
   * or search the product catalog (Reagent/Labware/Equip), and insert the
   * resulting reference at the cursor. Mirrors the autocomplete create flow so
   * the two entry points behave identically.
   */
  private async addSampleFromEditor(): Promise<void> {
    const target = this.host.editTarget();
    if (!target) {
      new Notice(this.t('Open a note to insert into.'));
      return;
    }
    if (!this.hasLocalScope()) {
      new Notice(this.t('Open a note first to add a local sample.'));
      return;
    }

    const types = getSampleDisplayMeta(this.settings.customSampleTypes).types;
    const type = await pickModal(
      this.app,
      types.map(t => ({ label: t, value: t })),
      { title: this.t('Select sample type'), placeholder: this.t('Select sample type') }
    );
    if (!type) return;

    // Catalog types (Reagent/Labware/Equip) are curated: search the read-only
    // product catalog first; without one, a generated id is registered instead.
    let referenceText: string | undefined;
    if (isCatalogSampleType(type)) {
      referenceText = await pickCatalogReference(this.app, this, {
        type,
        docPath: target.path,
      });
    } else {
      const created = await createSampleInteractive(this.app, this, {
        type,
        folder: this.localSampleFolder(),
        mode: 'generate',
      });
      referenceText = created?.referenceText;
    }
    if (!referenceText) return;
    await insertSampleReference(this, target, referenceText);
  }

  /**
   * Keep the experiment README (and, on delete, the sample tree) in sync with
   * the file explorer:
   *  - renaming a workflow file inside its folder reorders the README checklist
   *    to the new `NNN` order (and relinks the entry),
   *  - deleting one removes its checklist entry and prunes samples it defined,
   *  - renaming one out of the `###_*.labnote.md` format warns and offers the
   *    likely intended name; once the format is back (via the prompt or by
   *    hand) the README entry is relinked from the original name.
   *
   * Events are coalesced per experiment folder (~400ms) so bulk operations
   * settle into a single README write, and that write waits until no modal is
   * open: with "Automatically update internal links" off, Obsidian asks before
   * relinking and then edits the README at offsets it computed before asking,
   * so writing first shifts those offsets and its edit eats the text after the
   * link (#41). Our writes go through `vault.process` (a 'modify', never
   * rename/delete), so they cannot re-enter these listeners. Cross-folder moves
   * are intentionally not auto-listed in the destination README (documented
   * limitation — use "Insert workflow").
   */
  private registerWorkflowReadmeSync(): void {
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const newPath = file.path;
        const strayOrigin = this.strayWorkflows.get(oldPath);
        this.strayWorkflows.delete(oldPath);
        // Only same-folder workflow-file renames touch the README.
        const effect = classifyWorkflowRename(oldPath, newPath, strayOrigin);
        if (!effect) return;
        switch (effect.kind) {
          case 'renamed':
          case 'restored':
            this.queueReadmeSync(effect.dir).renames.push({ from: effect.from, to: effect.to });
            this.scheduleReadmeSync(effect.dir);
            return;
          case 'strayMoved':
            this.strayWorkflows.set(newPath, effect.origin);
            return;
          case 'broken':
            // Recorded synchronously so a follow-up rename finds the origin.
            this.strayWorkflows.set(newPath, effect.origin);
            this.run(() => this.offerWorkflowNameFix(file, effect.suggestion));
            return;
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (!(file instanceof TFile)) return;
        // A stray note's README entry and sample sources still use its original name.
        const origin = this.strayWorkflows.get(file.path);
        this.strayWorkflows.delete(file.path);
        const path = origin ? posix.join(posix.dirname(file.path), origin) : file.path;
        if (!isValidWorkflowPath(path)) return;
        const dir = getExperimentDir(path);
        if (!dir) return;
        this.queueReadmeSync(dir).deletes.push(path);
        this.scheduleReadmeSync(dir);
      })
    );
  }

  /**
   * Tell the user a workflow note fell out of the naming format and, when a
   * fix is known and its name is free, offer to rename it. The prompt waits for
   * open modals to close: a file-explorer rename opens Obsidian's "update
   * links" prompt at the same time, and answering ours first would make that
   * one rewrite links for the stale rename.
   */
  private async offerWorkflowNameFix(file: TFile, suggestion: string | undefined): Promise<void> {
    const brokenPath = file.path;
    const name = file.name;
    const target = suggestion ? posix.join(posix.dirname(brokenPath), suggestion) : undefined;
    const warn = (): void =>
      this.host.notify(
        'warn',
        this.t(
          '"{0}" is no longer a workflow note: its name must start with ###_ and end in .labnote.md, so the README checklist stopped following it.',
          name
        )
      );
    if (!suggestion || !target || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }

    const settled = await this.waitForNoModal();
    // Renamed again, deleted, or the plugin unloaded while waiting.
    if (!this.strayWorkflows.has(brokenPath) || file.path !== brokenPath) return;
    if (!settled || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }

    const ok = await this.host.confirm(
      this.t(
        '"{0}" is no longer a workflow note: its name must end in .labnote.md, so the README checklist stopped following it. Rename it to "{1}"?',
        name,
        suggestion
      ),
      { confirmLabel: this.t('Fix name') }
    );
    if (!ok || file.path !== brokenPath || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(file, target);
  }

  /** Resolve true once no modal is open (checked every 250ms), false after 30s. */
  private waitForNoModal(): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    return new Promise(resolve => {
      const check = (): void => {
        if (!document.querySelector('.modal-container')) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else window.setTimeout(check, 250);
      };
      // Obsidian opens its own rename prompt right after the event; let it appear.
      window.setTimeout(check, 250);
    });
  }

  /**
   * Keep a workflow note's `## Related Unit Operations` TOC ordered to match the
   * document order of its `### [..]` headings (added, removed or renamed unit
   * ops). Fires on editor edits, debounced per note. Block moves are tidied
   * immediately, separators included, by `createUnitOpReorderFilter` (editor
   * moves) and `registerOutlineDropTidy` (Outline drags). Skipped right after
   * an undo/redo so the history can still be walked back.
   *
   * Only the changed span is rewritten (via {@link minimalReplacement}) so the
   * caret stays put; a full-document replace would reset it. The rewrite is
   * idempotent, so our own edit settles on the next pass without looping.
   */
  private registerUnitOpTocAutoSync(): void {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
        if (!this.settings.autoSyncUnitOpToc) return;
        const file = info.file;
        if (!(file instanceof TFile) || !isValidWorkflowPath(file.path)) return;

        const path = file.path;
        const prev = this.unitOpTocTimers.get(path);
        if (prev !== undefined) window.clearTimeout(prev);
        const handle = window.setTimeout(() => {
          this.unitOpTocTimers.delete(path);
          // The editor may have switched to another note since the edit.
          if (info.file?.path !== path) return;
          if (this.lastChangeFromHistory.get(path)) return;
          const before = editor.getValue();
          const after = rebuildUnitOpToc(before);
          const edit = minimalReplacement(before, after);
          if (!edit) return;
          editor.replaceRange(
            edit.text,
            editor.offsetToPos(edit.start),
            editor.offsetToPos(edit.end)
          );
        }, 1500);
        this.unitOpTocTimers.set(path, handle);
      })
    );
  }

  /** Set `last_updated_date` to today (#42); identity when the setting is off. */
  readonly stampLastUpdated = (content: string): string =>
    this.settings.autoUpdateLastUpdated
      ? touchLastUpdatedDate(content, getSeoulDateString())
      : content;

  /** `writeNote` hook for AI tools: writes through the vault, stamping lab notes. */
  writeNoteStamped(path: string, content: string): Promise<void> {
    return writeNoteStamped(this.app, this.host, path, content, this.stampLastUpdated);
  }

  /**
   * Stamp a lab note's `last_updated_date` (and, for a workflow note, its
   * experiment README) once the user stops editing it. Only typed, pasted,
   * dropped or deleted text counts — see `LastUpdatedTracker` — so notes
   * reloaded by a git pull keep their date. The stamp is idempotent within a
   * day, so our own edit settles on the next pass.
   */
  private registerLastUpdatedAutoSync(): void {
    this.registerEvent(
      this.app.workspace.on('editor-change', (_editor, info) => {
        if (!this.settings.autoUpdateLastUpdated) return;
        const file = info.file;
        if (!(file instanceof TFile) || !isLabNotePath(file.path)) return;
        this.scheduleLastUpdatedStamp(file.path);
      })
    );
  }

  /**
   * Debounced stamp of a lab note's `last_updated_date` (and, for a workflow
   * note, its experiment README) 2s after the last change. Shared by editor
   * edits (via `editor-change`) and programmatic inserts (via {@link markUserEdit})
   * so the stamp does not depend on whether Obsidian emits `editor-change` for a
   * code-driven edit. `consume` only stamps after a recorded user edit.
   */
  private scheduleLastUpdatedStamp(path: string): void {
    const prev = this.lastUpdatedTimers.get(path);
    if (prev !== undefined) window.clearTimeout(prev);
    const handle = window.setTimeout(() => {
      this.lastUpdatedTimers.delete(path);
      if (!this.lastUpdatedTracker.consume(path)) return;
      if (!this.settings.autoUpdateLastUpdated) return;
      stampNoteAndReadme(this.app, this.host, path, this.stampLastUpdated).catch(err =>
        console.warn('[labnoteo] last_updated_date update failed:', err)
      );
    }, 2000);
    this.lastUpdatedTimers.set(path, handle);
  }

  /**
   * Record a code-driven, user-intent edit to a lab note (e.g. inserting a
   * sample reference from the Samples sidebar) and schedule its
   * `last_updated_date` stamp. The CodeMirror reorder filter does not tag such
   * edits as user input, so we record the intent here explicitly.
   */
  markUserEdit(path: string): void {
    if (!this.settings.autoUpdateLastUpdated || !isLabNotePath(path)) return;
    this.lastUpdatedTracker.record(path, {
      userEdit: true,
      dateEdited: false,
      fromHistory: false,
    });
    this.scheduleLastUpdatedStamp(path);
  }

  /**
   * Tidy a workflow note's TOC and separators after an Outline drag. The drag
   * rewrites the file directly, so the cleanup is written to the file too (see
   * `outlineDropTidy`); the drop listener runs in the capture phase, before the
   * Outline's own read-and-write, to arm the path first.
   */
  private registerOutlineDropTidy(): void {
    const { vault, workspace } = this.app;
    const tidy = createOutlineDropTidy({
      isEnabled: () => this.settings.autoSyncUnitOpToc,
      now: () => Date.now(),
      process: async (path, fn) => {
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.process(file, fn);
      },
    });

    this.registerDomEvent(
      document,
      'drop',
      evt => {
        const target = evt.target;
        if (!(target instanceof Element)) return;
        const pane = target.closest('.workspace-leaf-content[data-type="outline"]');
        if (!pane) return;
        const leaf = workspace.getLeavesOfType('outline').find(l => l.view.containerEl === pane);
        const viewFile = (leaf?.view as { file?: unknown } | undefined)?.file;
        const file = viewFile instanceof TFile ? viewFile : workspace.getActiveFile();
        if (file) tidy.arm(file.path, this.snapshotOutlineDrag(file));
      },
      { capture: true }
    );
    this.registerEvent(vault.on('modify', file => void tidy.onModify(file.path)));
  }

  /**
   * The heading being dragged in the Outline, read while the drop is still in
   * flight. `dragManager` is not public API, so anything unexpected yields no
   * snapshot and the drop is only tidied, as before.
   */
  private snapshotOutlineDrag(file: TFile): OutlineDropSnapshot | undefined {
    const dragManager = (this.app as unknown as { dragManager?: { draggable?: unknown } }).dragManager;
    const drag = dragManager?.draggable as
      | { source?: unknown; type?: unknown; file?: unknown; heading?: unknown }
      | null
      | undefined;
    if (!drag || drag.source !== 'outline' || drag.type !== 'heading') return undefined;
    if (!(drag.file instanceof TFile) || drag.file.path !== file.path) return undefined;
    const headings = this.app.metadataCache.getFileCache(file)?.headings;
    if (!headings) return undefined;
    const movedIdx = headings.findIndex(h => h === drag.heading);
    if (movedIdx === -1) return undefined;
    return {
      before: this.app.vault.cachedRead(file),
      headings: headings.map(h => ({ level: h.level, start: h.position.start.offset })),
      movedIdx,
    };
  }

  /** Get (or create) the pending-event queue for an experiment folder. */
  private queueReadmeSync(dir: string): { renames: { from: string; to: string }[]; deletes: string[] } {
    let q = this.readmeSyncQueue.get(dir);
    if (!q) {
      q = { renames: [], deletes: [] };
      this.readmeSyncQueue.set(dir, q);
    }
    return q;
  }

  /** (Re)arm the per-folder debounce that flushes queued README-sync events. */
  private scheduleReadmeSync(dir: string): void {
    this.cancelReadmeSyncTimer(dir);
    // A held folder keeps queueing; `release` flushes it.
    if (this.readmeSyncHolds.has(dir)) return;
    const handle = window.setTimeout(() => {
      this.readmeSyncTimers.delete(dir);
      void this.startReadmeFlush(dir);
    }, 400);
    this.readmeSyncTimers.set(dir, handle);
  }

  private cancelReadmeSyncTimer(dir: string): void {
    const prev = this.readmeSyncTimers.get(dir);
    if (prev !== undefined) window.clearTimeout(prev);
    this.readmeSyncTimers.delete(dir);
  }

  /**
   * Flush the folder's queue once any earlier flush of it has finished. The
   * queue is taken only then, so events an earlier flush put back stay in order.
   */
  private startReadmeFlush(dir: string): Promise<void> {
    const prev = this.readmeSyncInFlight.get(dir) ?? Promise.resolve();
    const run = prev.then(async () => {
      const q = this.readmeSyncQueue.get(dir);
      this.readmeSyncQueue.delete(dir);
      if (q) await this.flushReadmeSync(dir, q);
    });
    this.readmeSyncInFlight.set(dir, run);
    void run.finally(() => {
      if (this.readmeSyncInFlight.get(dir) === run) this.readmeSyncInFlight.delete(dir);
    });
    return run;
  }

  /** Put taken events back in front of anything queued since, keeping hop order. */
  private requeueReadmeSync(
    dir: string,
    q: { renames: { from: string; to: string }[]; deletes: string[] }
  ): void {
    const later = this.readmeSyncQueue.get(dir);
    this.readmeSyncQueue.set(dir, {
      renames: [...q.renames, ...(later?.renames ?? [])],
      deletes: [...q.deletes, ...(later?.deletes ?? [])],
    });
  }

  /**
   * Resolve true once no modal is open and Obsidian has had a moment to apply
   * the link edits the user just confirmed; false if a modal is still (or
   * again) open.
   */
  private async settleModals(): Promise<boolean> {
    if (!(await this.waitForNoModal())) return false;
    await new Promise(resolve => window.setTimeout(resolve, 300));
    return !document.querySelector('.modal-container');
  }

  /** README-sync hooks for commands that rename workflow files in bulk. */
  private readmeSyncControl(): ReadmeSyncControl {
    return {
      flushNow: async dir => {
        this.cancelReadmeSyncTimer(dir);
        await this.startReadmeFlush(dir);
      },
      hold: dir => {
        this.readmeSyncHolds.add(dir);
        this.cancelReadmeSyncTimer(dir);
      },
      settle: async () => {
        await this.settleModals();
      },
      release: async (dir, opts = {}) => {
        this.readmeSyncHolds.delete(dir);
        const q = this.readmeSyncQueue.get(dir);
        if (q && opts.dropRenames) q.renames = [];
        if (q && (q.renames.length > 0 || q.deletes.length > 0)) {
          await this.startReadmeFlush(dir);
        } else {
          this.readmeSyncQueue.delete(dir);
        }
      },
    };
  }

  /** Apply all queued deletes (prune + sample cleanup) then renames (reorder). */
  private async flushReadmeSync(
    dir: string,
    q: { renames: { from: string; to: string }[]; deletes: string[] }
  ): Promise<void> {
    const settled = await this.settleModals();
    if (this.unloaded) return;
    if (!settled || this.readmeSyncHolds.has(dir)) {
      this.requeueReadmeSync(dir, q);
      this.scheduleReadmeSync(dir);
      return;
    }
    try {
      if (q.deletes.length > 0) {
        await syncReadmeAndSamplesOnDelete(
          this.app,
          this.host,
          dir,
          q.deletes,
          this.sampleCleanupOpts()
        );
        // Samples kept, but their `sources` may have changed — refresh so the
        // sidebar/autocomplete reflect the updated usage.
        this.sampleSuggest?.clearCache();
        this.refreshSampleViews();
      }
      if (q.renames.length > 0) {
        await syncReadmeOrderOnRename(this.app, this.host, dir, q.renames);
      }
    } catch (err) {
      console.warn('[labnoteo] README auto-sync failed:', err);
    }
  }

  /** Register the two sidebar views + commands/ribbon to open them. */
  private registerViews(): void {
    this.registerView(WORKFLOW_VIEW_TYPE, leaf => new WorkflowTreeView(leaf, this));
    this.registerView(SAMPLE_VIEW_TYPE, leaf => new SampleTreeView(leaf, this));

    this.addRibbonIcon('box', this.t('Workflows'), () => void this.activateView(WORKFLOW_VIEW_TYPE));
    this.addRibbonIcon('test-tube', this.t('Samples'), () => void this.activateView(SAMPLE_VIEW_TYPE));

    this.addCommand({
      id: 'open-workflow-view',
      name: this.t('Open workflow view'),
      callback: () => void this.activateView(WORKFLOW_VIEW_TYPE),
    });
    this.addCommand({
      id: 'open-sample-view',
      name: this.t('Open sample view'),
      callback: () => void this.activateView(SAMPLE_VIEW_TYPE),
    });
    this.addCommand({
      id: 'open-user-guide',
      name: this.t('Open user guide'),
      callback: () => void openUserGuide(this.host),
    });
  }

  /** Reveal (or create) a sidebar leaf hosting the given view type. */
  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: viewType, active: true });
      await workspace.revealLeaf(leaf);
    }
  }

  /** Sample autocomplete, live/reading-mode highlighting, and save-time sync. */
  private registerSampleFeatures(): void {
    if (!this.settings.sampleTracking) return;

    // Autocomplete (@type;… → sample IDs).
    this.sampleSuggest = new SampleEditorSuggest(this.app, {
      fs: this.fs,
      customTypes: () => this.settings.customSampleTypes,
      globalFolder: () => this.settings.globalSampleFolder,
      plugin: this,
    });
    this.registerEditorSuggest(this.sampleSuggest);

    // Persist sample definitions to {Type}.json when a lab note is edited.
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (file instanceof TFile) this.scheduleSampleSync(file);
      })
    );
  }

  /**
   * Highlighting of inline tokens on both surfaces, from one live getter.
   *
   * Registered outside `registerSampleFeatures` because `@issue` markers belong
   * to the research-automation flow, not to sample tracking: turning sample
   * tracking off must not stop a marker from showing that it is well formed.
   * Handing the scanner an empty type list is what disables the sample half.
   */
  private registerInlineHighlighting(): void {
    const getState = (): HighlightState =>
      this.settings.sampleTracking
        ? getSampleDisplayMeta(this.settings.customSampleTypes)
        : { types: [], colors: {} };
    this.registerEditorExtension(createSampleHighlightPlugin(getState));
    this.registerMarkdownPostProcessor(createSampleReadingHighlighter(getState));
  }

  /** Debounced write-through of a lab note's sample definitions. */
  private scheduleSampleSync(file: TFile): void {
    if (!file.path.endsWith('.labnote.md')) return;
    const prev = this.sampleSyncTimers.get(file.path);
    if (prev !== undefined) window.clearTimeout(prev);
    const handle = window.setTimeout(() => {
      this.sampleSyncTimers.delete(file.path);
      void this.syncSamples(file);
    }, 800);
    this.sampleSyncTimers.set(file.path, handle);
  }

  private async syncSamples(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      await saveSamplesFromDocument(
        this.fs,
        file.path,
        content,
        this.settings.globalSampleFolder,
        this.settings.customSampleTypes
      );
      // Freshly-written definitions should show up in autocomplete right away.
      this.sampleSuggest?.clearCache();
      this.refreshSampleViews();
    } catch (err) {
      console.warn('[labnoteo] sample sync failed:', err);
    }
  }

  /**
   * Refresh any open Samples sidebar(s). Called explicitly after sample JSON
   * writes because those go through the low-level `adapter.write`
   * ([VaultFileSystem](./vaultFileSystem.ts)), which bypasses the Vault event
   * pipeline — so `vault.on('modify')` cannot be relied on for `{Type}.json`.
   */
  refreshSampleViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SAMPLE_VIEW_TYPE)) {
      if (leaf.view instanceof SampleTreeView) void leaf.view.refresh();
    }
  }

  /**
   * The path of the most recently active file, if any (vault-relative).
   *
   * Uses `getActiveFile()` rather than `getActiveViewOfType(MarkdownView)` so it
   * keeps returning the last note when focus moves to a sidebar (e.g. the sample
   * view itself). The old approach returned undefined on sidebar focus, which
   * collapsed the sample tree's Local scope to Global and made samples vanish.
   */
  activeNotePath(): string | undefined {
    return this.app.workspace.getActiveFile()?.path;
  }

  /**
   * The Local-scope `resources/labsamples` folder for the sample sidebar and
   * autocomplete.
   *
   * Resolved from the active note's experiment root (`labnote/###_*`), NOT its
   * immediate folder, so any file inside an experiment (a subfolder image, a
   * workflow note, …) maps to the same experiment samples. The last resolved
   * experiment is remembered so opening a file OUTSIDE any experiment keeps the
   * tree pinned to that experiment instead of collapsing to Global. Falls back
   * to the active file's own folder (legacy behaviour), then Global, only when
   * no experiment has ever been opened this session.
   */
  localSampleFolder(): string {
    const active = this.activeNotePath();
    const dir = active ? getExperimentDir(active) : undefined;
    if (dir) this.lastExperimentDir = dir;
    if (this.lastExperimentDir) {
      return posix.join(this.lastExperimentDir, 'resources', 'labsamples');
    }
    return active ? getLabsamplesFolder(active) : this.settings.globalSampleFolder;
  }

  /** Whether a Local sample scope can be resolved (an experiment is known). */
  hasLocalScope(): boolean {
    return this.activeNotePath() !== undefined || this.lastExperimentDir !== undefined;
  }

  notify(message: string): void {
    new Notice(message);
  }

  async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    this.settings = migrateSettings(raw);
    // Persist the upgraded shape once so old `data.json` files converge (and the
    // legacy `llmEndpoint` migration isn't re-run every load).
    const rawVersion =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>).schemaVersion
        : undefined;
    if (rawVersion !== CURRENT_SCHEMA_VERSION) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
