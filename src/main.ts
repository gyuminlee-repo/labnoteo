/**
 * Labnote Assistant — Obsidian plugin entry point.
 *
 * This is the skeleton: it wires the platform-neutral pieces from
 * `@labnoteo/core` (file-system port, translator) into Obsidian and registers a
 * couple of proof-of-wiring commands. Domain commands, sample suggestions, CM6
 * highlighting, sidebar views, the settings tab and the LLM/MCP layer are added
 * by subsequent modules that all consume the same `LabnoteHost` built here.
 */
import { MarkdownView, Plugin, Notice, TFile, TFolder, editorInfoField } from 'obsidian';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import {
  findSampleReferenceAt,
  rebuildUnitOpToc,
  minimalReplacement,
  parseFrontMatterYaml,
  reassignIssueMarkerIds,
} from '@labnoteo/core';
import {
  getSeoulDateString,
  getSeoulDateTimeString,
  touchLastUpdatedDate,
} from '@labnoteo/core/lib/dateUtils';
import { getSampleDisplayMeta, isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import {
  classifyWorkflowMoveOut,
  classifyWorkflowRename,
  createWorkflowFileName,
  isCopiedWorkflowFileName,
  isValidWorkflowPath,
  parseWorkflowFileName,
  parseWorkflowHeading,
  planWorkflowChecklistSync,
  rewriteWorkflowTitle,
  suggestCopiedWorkflowFileName,
  type WorkflowHeading,
} from '@labnoteo/core/lib/workflowStructure';
import {
  saveSamplesFromDocument,
  resolveLocalSampleFolder,
  noteLabsamplesFolder,
  hasReferenceCatalog,
  inventorySampleFolder,
  moveSampleFolder,
} from '@labnoteo/core/lib/sampleStorage';
import { VaultFileSystem } from './vaultFileSystem';
import { createObsidianTranslator } from './i18n';
import { createObsidianHost } from './obsidianHost';
import {
  createExperimentCommand,
  changeExperimentStatusCommand,
  insertIssueMarkerCommand,
  insertDateCommand,
  issueAutomationState,
  toggleDiscussionFlagCommand,
  createWorkflowCommand,
  renumberWorkflowsCommand,
  syncWorkflowChecklistCommand,
  addWorkflowFileToChecklist,
  moveTableCsvs,
  retitleWorkflowAfterRename,
  insertUnitOperationCommand,
  insertWorkflowLinkCommand,
  syncReadmeOrderOnRename,
  syncReadmeAndSamplesOnDelete,
  offerTableCsvCleanupOnDelete,
  setupResearchAutomationCommand,
  type ReadmeSyncControl,
} from './commands';
import * as posix from '@labnoteo/core/posix';
import {
  diagnoseExperimentPath,
  getExperimentDir,
  isSampleTrackingOn,
  suggestExperimentFolderName,
} from '@labnoteo/core/lib/labnoteStructure';
import { SampleEditorSuggest } from './sampleSuggest';
import { openSampleDefinition } from './sampleDefinitionModal';
import { confirmModal, pickModal, workflowAliasModal } from './modals';
import {
  createSampleInteractive,
  pickCatalogReference,
  insertSampleReference,
  listSampleDefinitions,
} from './sampleActions';
import {
  offerSamplesAfterMove,
  offerSamplesLeftBehind,
  type RelocatedNote,
  type SampleRelocationDeps,
} from './sampleRelocation';
import {
  createSampleHighlightPlugin,
  createSampleReadingHighlighter,
  type HighlightState,
} from './sampleHighlight';
import { createMetaDatePickerExtension } from './dateFieldPicker';
import { createUnitOpReorderFilter } from './unitOpReorderFilter';
import { LastUpdatedTracker } from './lastUpdatedTracker';
import { IssueMarkerIndex } from './issueMarkerIndex';
import { isLabNotePath, stampNoteAndReadme, writeNoteStamped } from './lastUpdatedStamp';
import { createOutlineDropTidy, type OutlineDropSnapshot } from './outlineDropTidy';
import { WorkflowTreeView, WORKFLOW_VIEW_TYPE } from './views/workflowView';
import { SampleTreeView, SAMPLE_VIEW_TYPE } from './views/sampleView';
import { exportTablesToCsv, exportActiveNoteTablesToCsv } from './exportCsv';
import { openUserGuide } from './userGuide';
import { LabnoteSettingTab } from './settingsTab';
import { SETUP_DOC_PATH } from './scaffold/assets';
import { refreshAutomationFiles } from './scaffold/scaffold';
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
  // Copies of workflow notes ("Make a copy", OS file manager) not yet given a
  // workflow name, so naming one by hand still offers to list it (#44).
  private readonly copiedWorkflows = new Set<string>();
  // Pending "moved in but not listed" notices, coalesced per experiment folder.
  private readonly movedInTimers = new Map<string, number>();
  // Notes moved between experiments whose Local samples may need bringing
  // along (#97), coalesced per (old experiment, new experiment) pair.
  private readonly samplesMoved = new Map<
    string,
    { fromDir: string; toDir: string; notes: RelocatedNote[]; timer: number }
  >();
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

    this.app.workspace.onLayoutReady(() =>
      this.run(async () => {
        await refreshAutomationFiles(this.host, this.manifest.version);
      })
    );

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
    this.copiedWorkflows.clear();
    for (const handle of this.movedInTimers.values()) {
      window.clearTimeout(handle);
    }
    this.movedInTimers.clear();
    for (const pending of this.samplesMoved.values()) {
      window.clearTimeout(pending.timer);
    }
    this.samplesMoved.clear();
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
        insertDateCommand(editor, this.host, getSeoulDateString());
      },
    });

    this.addCommand({
      id: 'insert-datetime',
      name: this.t('Insert date and time'),
      editorCallback: editor => {
        insertDateCommand(editor, this.host, getSeoulDateTimeString());
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
      editorCallback: editor =>
        this.run(async () => {
          if (!(await insertIssueMarkerCommand(editor, this.host)) || this.issueAutomationHintShown) return;
          const state = await issueAutomationState(this.host);
          if (state === 'ready') return;
          this.issueAutomationHintShown = true;
          this.host.notify(
            'info',
            state === 'no-git'
              ? this.t(
                  'Issue marker inserted. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.',
                  SETUP_DOC_PATH
                )
              : this.t('Issue marker inserted. To open it as an issue, run "Setup research automation" first.')
          );
        }),
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
      callback: () => this.run(() => setupResearchAutomationCommand(this.host, this.manifest.version)),
    });

    this.addCommand({
      id: 'create-workflow',
      name: this.t('Create workflow'),
      callback: () => this.run(() => createWorkflowCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'renumber-workflows',
      name: this.t('Renumber workflows'),
      callback: () =>
        this.run(() => renumberWorkflowsCommand(this.app, this.host, this.readmeSyncControl())),
    });

    this.addCommand({
      id: 'sync-workflow-checklist',
      name: this.t('Sync workflow checklist with folder'),
      callback: () => this.run(() => this.syncWorkflowChecklist()),
    });

    this.addCommand({
      id: 'insert-unit-operation',
      name: this.t('Insert unit operation'),
      callback: () => this.run(() => insertUnitOperationCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'open-sample-definition',
      name: this.t('Open sample definition'),
      callback: () => this.run(() => this.openSampleDefinitionCommand()),
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
        const experimentDir =
          file instanceof TFolder
            ? getExperimentDir(file.path) === file.path
              ? file.path
              : undefined
            : file.name.toLowerCase() === 'readme.labnote.md'
              ? getExperimentDir(file.path)
              : undefined;
        if (experimentDir) {
          menu.addItem(item =>
            item
              .setTitle(this.t('Sync workflow checklist with folder'))
              .setIcon('list-checks')
              .onClick(() => this.run(() => this.syncWorkflowChecklist(experimentDir)))
          );
        }
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

  private syncWorkflowChecklist(dir?: string): Promise<void> {
    const adoptSamples = this.settings.sampleTracking
      ? async (experimentDir: string, names: string[]) =>
          this.sampleTrackingFor(posix.join(experimentDir, 'README.labnote.md'))
            ? offerSamplesLeftBehind(this.sampleRelocationDeps(), experimentDir, names)
            : 0
      : undefined;
    return syncWorkflowChecklistCommand(this.app, this.host, this.readmeSyncControl(), dir, adoptSamples);
  }

  private sampleRelocationDeps(): SampleRelocationDeps {
    return { app: this.app, host: this.host, ...this.sampleCleanupOpts() };
  }

  /** Right-click in a lab-note editor → create a workflow + insert a link at the cursor. */
  private registerEditorMenu(): void {
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const file = info.file;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        // Go to definition works in ANY markdown note (references may appear
        // outside `.labnote.md`), so add it before the workflow-file gate below.
        if (this.sampleTrackingFor(file.path)) {
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
              .onClick(() =>
                this.run(() => insertWorkflowLinkCommand(this.app, this.host, editor, this.stampLastUpdated))
              )
          );
          menu.addItem(item =>
            item
              .setTitle(this.t('Sync workflow checklist with folder'))
              .setIcon('list-checks')
              .onClick(() => this.run(() => this.syncWorkflowChecklist(getExperimentDir(file.path))))
          );
        }
      })
    );
  }

  /**
   * The definition window from the command palette (#121), which the editor's
   * context menu and the Samples sidebar only offered to the mouse: the
   * reference under the cursor, else a sample picked from the Local and Global
   * ones.
   */
  private async openSampleDefinitionCommand(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const path = view?.file?.path ?? this.app.workspace.getActiveFile()?.path;
    if (!this.sampleTrackingFor(path)) {
      new Notice(this.t('Sample tracking is off for this note.'));
      return;
    }
    const types = getSampleDisplayMeta(this.settings.customSampleTypes).types;
    if (view?.file) {
      const cur = view.editor.getCursor();
      const hit = findSampleReferenceAt(view.editor.getLine(cur.line), cur.ch, types);
      if (hit) {
        await openSampleDefinition(this.app, this, { type: hit.type, id: hit.id, docPath: view.file.path });
        return;
      }
    }

    const items = await listSampleDefinitions(this, path);
    if (items.length === 0) {
      new Notice(this.t('No samples are registered yet.'));
      return;
    }
    const chosen = await pickModal(this.app, items, {
      title: this.t('Open sample definition'),
      placeholder: this.t('Search by ID or alias'),
    });
    if (!chosen) return;
    await openSampleDefinition(this.app, this, { ...chosen, docPath: path ?? '' });
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
    const localFolder = noteLabsamplesFolder(target.path, this.settings.globalSampleFolder);
    if (
      isCatalogSampleType(type) &&
      ((await hasReferenceCatalog(this.fs, localFolder, type)) ||
        (await hasReferenceCatalog(this.fs, this.settings.globalSampleFolder, type)))
    ) {
      referenceText = await pickCatalogReference(this.app, this, {
        type,
        docPath: target.path,
      });
    } else {
      const created = await createSampleInteractive(this.app, this, {
        type,
        folder: this.localSampleFolder(),
        mode: 'generate',
        scope: 'local',
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
   * and copies are not listed automatically: a move only points the user at
   * "Sync workflow checklist with folder", and a copy offers a workflow name
   * and asks before listing it.
   */
  private registerWorkflowReadmeSync(): void {
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFolder) {
          this.onFolderRenamed(file, oldPath);
          return;
        }
        if (!(file instanceof TFile)) return;
        const newPath = file.path;
        // Ahead of the copy branch, which returns early: a copy moved to
        // another experiment needs its samples too.
        this.offerLocalSamplesMoved(oldPath, newPath);
        if (this.copiedWorkflows.delete(oldPath)) {
          if (posix.dirname(newPath) !== posix.dirname(oldPath)) return;
          if (isValidWorkflowPath(newPath)) this.run(() => this.offerListRenamedCopy(file));
          else if (isCopiedWorkflowFileName(file.name)) this.copiedWorkflows.add(newPath);
          return;
        }
        this.noticeWorkflowMovedIn(oldPath, newPath);
        this.noticeWorkflowMovedOut(oldPath, newPath);
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
            // Renumbering holds the folder and moves the CSVs itself (#60);
            // it keeps the names after the number, so titles stay as they are.
            if (!this.readmeSyncHolds.has(effect.dir)) {
              const { dir, from, to } = effect;
              this.run(() => this.moveTableCsvsAfterRename(dir, from, to));
              this.run(() => this.retitleAfterRename(file, dir, from, to));
            }
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

    // Obsidian reports every existing file as created while the vault loads.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on('create', file => {
          if (!(file instanceof TFile) || !isCopiedWorkflowFileName(file.name)) return;
          if (getExperimentDir(file.path) !== posix.dirname(file.path)) return;
          this.copiedWorkflows.add(file.path);
          this.run(() => this.offerCopiedWorkflowFix(file));
        })
      );
    });

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (!(file instanceof TFile)) return;
        this.copiedWorkflows.delete(file.path);
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
   * A folder was renamed. Keep the remembered experiment (Local samples) on
   * the new path, or forget it when the new path is no experiment; and when
   * an experiment folder lost its `###_` number, say what that breaks and
   * offer the numbered name back (#67).
   */
  private onFolderRenamed(folder: TFolder, oldPath: string): void {
    const newPath = folder.path;
    const under = (p: string): boolean => p === oldPath || p.startsWith(`${oldPath}/`);
    if (this.lastExperimentDir && under(this.lastExperimentDir)) {
      this.lastExperimentDir = getExperimentDir(newPath + this.lastExperimentDir.slice(oldPath.length));
    }
    for (const p of [...this.strayWorkflows.keys()]) if (under(p)) this.strayWorkflows.delete(p);
    for (const p of [...this.copiedWorkflows]) if (under(p)) this.copiedWorkflows.delete(p);

    const before = diagnoseExperimentPath(oldPath, { isFolder: true });
    const after = diagnoseExperimentPath(newPath, { isFolder: true });
    if (before.kind !== 'ok' || before.folder !== oldPath) return;
    if (after.kind === 'nested' && after.folder === newPath) {
      this.run(() => this.offerExperimentFolderMoveBack(folder, posix.dirname(oldPath)));
      return;
    }
    if (after.kind !== 'noPrefix' || after.folder !== newPath) return;
    this.run(() => this.offerExperimentFolderNameFix(folder, posix.basename(oldPath)));
  }

  /**
   * An experiment folder was moved into a grouping folder under `labnote/`,
   * where nothing recognises it as an experiment (#166): offer it back.
   */
  private async offerExperimentFolderMoveBack(folder: TFolder, labnoteDir: string): Promise<void> {
    const movedPath = folder.path;
    const target = posix.join(labnoteDir, folder.name);
    const warning = this.t(
      '"{0}" is no longer recognized as an experiment: experiment folders must be directly under labnote/. Workflow commands, the experiment list and Local samples will not find it.',
      folder.name
    );
    const settled = await this.waitForNoModal();
    if (this.unloaded || folder.path !== movedPath) return;
    if (!settled || this.app.vault.getAbstractFileByPath(target)) {
      this.host.notify('warn', warning);
      return;
    }
    const ok = await this.host.confirm(`${warning} ${this.t('Move it back to {0}?', `${labnoteDir}/`)}`, {
      confirmLabel: this.t('Move back'),
    });
    if (!ok || folder.path !== movedPath || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(folder, target);
  }

  private async offerExperimentFolderNameFix(folder: TFolder, oldName: string): Promise<void> {
    const renamedPath = folder.path;
    const suggestion = suggestExperimentFolderName(oldName, folder.name);
    const target = suggestion ? posix.join(posix.dirname(renamedPath), suggestion) : undefined;
    const warn = (): void =>
      this.host.notify(
        'warn',
        this.t(
          '"{0}" is no longer an experiment folder: its name must start with ###_ (e.g. 001_Name). Workflow commands and Local samples will not find it.',
          folder.name
        )
      );
    if (!suggestion || !target || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }
    // Obsidian may be asking whether to update links for this rename.
    const settled = await this.waitForNoModal();
    if (this.unloaded || folder.path !== renamedPath) return;
    if (!settled || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }
    const ok = await this.host.confirm(
      this.t(
        '"{0}" is no longer an experiment folder: its name must start with ###_ (e.g. 001_Name). Workflow commands and Local samples will not find it. Rename it to "{1}"?',
        folder.name,
        suggestion
      ),
      { confirmLabel: this.t('Fix name') }
    );
    if (!ok || folder.path !== renamedPath || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(folder, target);
  }

  /** A workflow note was renamed by hand: its table CSVs follow it (#60). */
  private async moveTableCsvsAfterRename(dir: string, from: string, to: string): Promise<void> {
    const skipped = await moveTableCsvs(this.app, dir, { from, to }, new Set(await this.fs.list(dir)));
    if (skipped > 0) {
      this.host.notify(
        'warn',
        this.t('{0} table CSV file(s) kept their old name: the new name was taken or the rename failed.', String(skipped))
      );
    }
  }

  /**
   * A workflow note was renamed by hand: its title and heading follow the new
   * name (#71). Waits for open modals first: with "Automatically update
   * internal links" off, Obsidian edits notes at offsets computed before its
   * prompt, so changing the note's title line first could corrupt a link to it
   * in the note (see #41). Skipped when the note moved again meanwhile or the
   * prompt never closed; "Sync workflow checklist with folder" fixes it then.
   */
  private async retitleAfterRename(file: TFile, dir: string, from: string, to: string): Promise<void> {
    const path = file.path;
    const settled = await this.waitForNoModal();
    if (this.unloaded || !settled || file.path !== path) return;
    await retitleWorkflowAfterRename(this.app, this.host, dir, from, to);
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

  /**
   * A workflow note was copied into its experiment folder under a name that is
   * not a workflow name (`001_X.labnote 1.md`). Offer the next free workflow
   * name and list the renamed note in the README checklist (#44). Waits for
   * open modals like {@link offerWorkflowNameFix}.
   */
  private async offerCopiedWorkflowFix(file: TFile): Promise<void> {
    const copyPath = file.path;
    const dir = posix.dirname(copyPath);
    const warn = (): void =>
      this.host.notify(
        'warn',
        this.t(
          '"{0}" is not a workflow note until its name starts with ###_ and ends in .labnote.md. Once it does, run "{1}" to add it to the README checklist.',
          file.name,
          this.t('Sync workflow checklist with folder')
        )
      );

    const settled = await this.waitForNoModal();
    if (this.unloaded || !this.copiedWorkflows.has(copyPath) || file.path !== copyPath) return;
    // Before any prompt, so cancelling one still leaves no shared issue ID (#89).
    const markers = reassignIssueMarkerIds(await this.app.vault.read(file)).count;
    if (markers > 0) {
      await this.app.vault.process(file, data => reassignIssueMarkerIds(data).content);
      this.host.notify(
        'info',
        this.t(
          'Gave the {0} issue marker(s) of the copy new IDs, so they do not merge with the original\'s issues.',
          String(markers)
        )
      );
    }
    const suggestion = suggestCopiedWorkflowFileName(file.name, await this.fs.list(dir));
    const target = suggestion ? posix.join(dir, suggestion) : undefined;
    if (!settled || !suggestion || !target || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }

    // A copy under the original's name and label is indistinguishable from it
    // in the checklist (#65): ask for the copy's own alias when the note has
    // its `## [ID name]` heading to rebuild the name from.
    const content = await this.app.vault.read(file);
    const heading = parseWorkflowHeading(content);
    const parts = parseWorkflowFileName(suggestion);
    if (heading && parts && heading.id === parts.id) {
      await this.renameCopiedWorkflow(file, copyPath, heading, parts.sequence, content, warn);
      return;
    }

    const ok = await this.host.confirm(
      this.t(
        '"{0}" looks like a copy of a workflow note, but its name does not end in .labnote.md, so it is not a workflow note yet. Rename it to "{1}" and add it to the README checklist?',
        file.name,
        suggestion
      ),
      { confirmLabel: this.t('Rename and add') }
    );
    if (!this.copiedWorkflows.has(copyPath) || file.path !== copyPath) return;
    if (!ok || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }
    // Dropped first so the rename below is not taken for a rename by hand.
    this.copiedWorkflows.delete(copyPath);
    await this.app.fileManager.renameFile(file, target);
    if (await addWorkflowFileToChecklist(this.app, this.host, dir, suggestion)) {
      this.host.notify('info', this.t('Added "{0}" to the README checklist.', suggestion));
    }
  }

  /**
   * Ask for the copied note's alias (prefilled with the original's, selected),
   * then give the note that alias in its title and `## [ID name]` heading,
   * rename it `NNN_ID_name_alias.labnote.md`, and list it — in that order, so
   * the checklist label comes from the new title. Cancelling leaves the name,
   * title and checklist as they are (only the issue marker IDs were already
   * renewed); the copy stays tracked so naming it by hand later still offers
   * to list it.
   */
  private async renameCopiedWorkflow(
    file: TFile,
    copyPath: string,
    heading: WorkflowHeading,
    sequence: string,
    content: string,
    warn: () => void
  ): Promise<void> {
    const prefix = `${heading.id} ${heading.name}`;
    let title: unknown;
    try {
      title = parseFrontMatterYaml(content.replace(/\r\n/g, '\n')).frontMatter.title;
    } catch {
      title = undefined;
    }
    const originalAlias =
      typeof title === 'string' && title.trim().startsWith(prefix)
        ? title.trim().slice(prefix.length).trim()
        : heading.alias;

    const alias = await workflowAliasModal(this.app, {
      id: heading.id,
      catalogName: heading.name,
      title: this.t('Name this copy of the workflow'),
      placeholder: this.t('Enter a name for this workflow'),
      value: originalAlias,
    });
    if (alias === undefined || this.unloaded) return;
    if (!this.copiedWorkflows.has(copyPath) || file.path !== copyPath) return;

    const dir = posix.dirname(copyPath);
    const fileName = createWorkflowFileName(sequence, { id: heading.id, name: heading.name, description: '' }, alias);
    const target = posix.join(dir, fileName);
    if (this.app.vault.getAbstractFileByPath(target)) {
      warn();
      return;
    }
    // Dropped first so the rename below is not taken for a rename by hand.
    this.copiedWorkflows.delete(copyPath);
    await this.app.vault.process(file, data => rewriteWorkflowTitle(data, heading.id, heading.name, alias));
    await this.app.fileManager.renameFile(file, target);
    if (await addWorkflowFileToChecklist(this.app, this.host, dir, fileName)) {
      this.host.notify('info', this.t('Added "{0}" to the README checklist.', fileName));
    }
  }

  /** A copied workflow note was given a workflow name by hand: offer to list it. */
  private async offerListRenamedCopy(file: TFile): Promise<void> {
    const path = file.path;
    // Obsidian may be asking whether to update links for this rename.
    const settled = await this.waitForNoModal();
    if (this.unloaded || !settled || file.path !== path) return;
    const ok = await this.host.confirm(this.t('Add "{0}" to the README checklist?', file.name), {
      confirmLabel: this.t('Add to checklist'),
    });
    if (!ok || file.path !== path) return;
    if (await addWorkflowFileToChecklist(this.app, this.host, posix.dirname(path), file.name)) {
      this.host.notify('info', this.t('Added "{0}" to the README checklist.', file.name));
    }
  }

  /**
   * A workflow note dragged into a subfolder such as `images/` or out of the
   * experiment is no longer a workflow step (#94). Say so, since the README
   * entry may still point at it.
   */
  private noticeWorkflowMovedOut(oldPath: string, newPath: string): void {
    const moved = classifyWorkflowMoveOut(oldPath, newPath);
    // Renaming or moving a whole experiment folder renames every note in it.
    if (!moved || !this.app.vault.getAbstractFileByPath(moved.dir)) return;
    this.host.notify(
      'warn',
      this.t(
        '{0} was moved to {1} and is no longer recognised as a workflow step. If that was a mistake, move it back directly under the experiment folder or run "{2}".',
        posix.basename(newPath),
        moved.location,
        this.t('Sync workflow checklist with folder')
      )
    );
  }

  /**
   * A workflow note moved into an experiment folder from elsewhere is not
   * listed in that folder's README. Point the user at the sync command, once
   * per folder for a batch of moves, and only if something is unlisted.
   */
  private noticeWorkflowMovedIn(oldPath: string, newPath: string): void {
    if (!isValidWorkflowPath(newPath)) return;
    const dir = posix.dirname(newPath);
    const oldDir = posix.dirname(oldPath);
    // Renaming or moving a whole experiment folder renames every note in it;
    // by then its old folder no longer exists.
    if (dir === oldDir || !this.app.vault.getAbstractFileByPath(oldDir)) return;

    const pending = this.movedInTimers.get(dir);
    if (pending !== undefined) window.clearTimeout(pending);
    this.movedInTimers.set(
      dir,
      window.setTimeout(() => {
        this.movedInTimers.delete(dir);
        this.run(async () => {
          const readmePath = posix.join(dir, 'README.labnote.md');
          if (this.unloaded || !(await this.fs.exists(readmePath))) return;
          const plan = planWorkflowChecklistSync(
            await this.fs.read(readmePath),
            await this.fs.list(dir),
            undefined,
            undefined,
            dir
          );
          if (plan.added.length === 0) return;
          this.host.notify(
            'warn',
            this.t(
              'Workflow notes moved into {0} are not in its README checklist yet. Run "{1}" to add them.',
              posix.basename(dir),
              this.t('Sync workflow checklist with folder')
            )
          );
        });
      }, 1000)
    );
  }

  /**
   * A note moved into another experiment leaves the Local samples it used in
   * the old experiment's registry, where it can no longer find them (#97).
   * Once Obsidian's link-update prompt is gone, offer to bring them along,
   * once per (old, new) experiment pair for a batch of moves.
   */
  private offerLocalSamplesMoved(oldPath: string, newPath: string): void {
    if (!this.sampleTrackingFor(newPath) || !/\.md$/i.test(newPath)) return;
    if (posix.basename(newPath) === 'README.labnote.md') return;
    const fromDir = getExperimentDir(oldPath);
    const toDir = getExperimentDir(newPath);
    if (!fromDir || !toDir || fromDir === toDir) return;
    // Renaming or moving a whole experiment folder renames every note in it;
    // by then its old folder no longer exists.
    if (!this.app.vault.getAbstractFileByPath(fromDir)) return;

    const key = `${fromDir}\u0000${toDir}`;
    const pending = this.samplesMoved.get(key);
    if (pending) window.clearTimeout(pending.timer);
    const notes = (pending?.notes ?? []).filter(n => n.path !== oldPath);
    notes.push({ path: newPath, oldName: posix.basename(oldPath) });
    const timer = window.setTimeout(() => {
      this.samplesMoved.delete(key);
      this.run(async () => {
        const ready = await this.waitForNoModal();
        if (this.unloaded) return;
        await offerSamplesAfterMove(this.sampleRelocationDeps(), fromDir, toDir, notes, ready);
      });
    }, 1000);
    this.samplesMoved.set(key, { fromDir, toDir, notes, timer });
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
        await offerTableCsvCleanupOnDelete(this.app, this.host, q.deletes);
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
      callback: () => void openUserGuide(this.host, this.manifest.version),
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
    const markers = new IssueMarkerIndex(this.fs, () => this.app.workspace.updateOptions());
    const duplicateTitle = (owner: string | undefined): string =>
      owner === undefined
        ? this.t('This marker ID appears more than once in this note.')
        : this.t('This marker ID is already used in {0}.', owner);
    const getState = (path: string | undefined): HighlightState => {
      const base = this.sampleTrackingFor(path)
        ? getSampleDisplayMeta(this.settings.customSampleTypes)
        : { types: [], colors: {} };
      const others = markers.othersFor(path);
      return others
        ? { ...base, otherMarkerIds: others.ids, markerVersion: others.version, duplicateTitle }
        : base;
    };
    this.registerIssueMarkerIndex(markers);
    this.registerEditorExtension(createSampleHighlightPlugin(getState));
    this.registerMarkdownPostProcessor(createSampleReadingHighlighter(getState));
    // An experiment's `sample_tracking` lives in its README (#105); editors
    // re-check their state on the update this sends.
    this.registerEvent(
      this.app.metadataCache.on('changed', file => {
        if (file.name === 'README.labnote.md') this.app.workspace.updateOptions();
      })
    );
  }

  /**
   * Keep the marker ID index current, and say once, after a save, when a note
   * now shares a marker ID: `issue-sync` would merge the two questions (#119).
   */
  private registerIssueMarkerIndex(markers: IssueMarkerIndex): void {
    const timers = new Map<string, number>();
    const schedule = (file: TFile): void => {
      if (!markers.tracks(file.path)) return;
      const prev = timers.get(file.path);
      if (prev !== undefined) window.clearTimeout(prev);
      timers.set(
        file.path,
        window.setTimeout(() => {
          timers.delete(file.path);
          this.run(async () => {
            const fresh = markers.update(file.path, await this.app.vault.cachedRead(file));
            for (const { id, owner } of fresh) {
              new Notice(
                owner === undefined
                  ? this.t(
                      'Marker ID {0} appears twice in this note, so the two questions merge into one issue. Delete one of these markers and insert it again with "Insert issue marker".',
                      id
                    )
                  : this.t(
                      'Marker ID {0} is also used in {1}, so the two questions merge into one issue. Delete the marker in this note (underlined) and insert it again with "Insert issue marker".',
                      id,
                      owner
                    ),
                12000
              );
            }
          });
        }, 800)
      );
    };
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (file instanceof TFile) schedule(file);
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        markers.remove(oldPath);
        if (file instanceof TFile) schedule(file);
      })
    );
    this.registerEvent(this.app.vault.on('delete', file => markers.remove(file.path)));
  }

  /** Debounced write-through of a lab note's sample definitions. */
  private scheduleSampleSync(file: TFile): void {
    if (!file.path.endsWith('.labnote.md') || !this.sampleTrackingFor(file.path)) return;
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
   * The Global sample folder setting went from `from` to `to`: offer to bring
   * the samples and catalogs left in `from` along, which no longer show (#101).
   */
  offerGlobalSampleFolderMove(from: string, to: string): void {
    this.run(async () => {
      const types = getSampleDisplayMeta(this.settings.customSampleTypes).types;
      const left = await inventorySampleFolder(this.fs, from, types);
      if (left.records === 0 && left.catalogs.length === 0) return;
      const message = [
        this.t(
          'The old Global sample folder {0} still has {1} sample(s). Move them to the new folder {2}?',
          from,
          String(left.records),
          to
        ),
      ];
      if (left.catalogs.length > 0) {
        message.push(this.t('Product catalog files move too: {0}', left.catalogs.join(', ')));
      }
      if (!(await confirmModal(this.app, message.join('\n\n'), this.t('Move samples')))) {
        new Notice(this.t('Samples in the old folder are not shown. Set the folder back to see them again.'), 8000);
        return;
      }
      const moved = await moveSampleFolder(this.fs, from, to, types);
      const parts = [this.t('Moved {0} sample(s) to {1}.', String(moved.moved), to)];
      if (moved.catalogsMoved > 0) parts.push(this.t('{0} catalog file(s) moved.', String(moved.catalogsMoved)));
      if (moved.skipped.length > 0) {
        parts.push(this.t('Not moved, {0} already has the same ID: {1}', to, moved.skipped.join(', ')));
      }
      if (moved.catalogsSkipped.length > 0) {
        parts.push(
          this.t('Catalog files not moved, {0} already has them: {1}', to, moved.catalogsSkipped.join(', '))
        );
      }
      new Notice(parts.join(' '), 10000);
      this.sampleSuggest?.clearCache();
      this.refreshSampleViews();
    });
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
   * workflow note, …) maps to the same experiment samples. A note outside any
   * experiment uses its own folder (a vault-root note's is the global one, #70),
   * so samples created there land where its references resolve. The last
   * resolved experiment is remembered only for non-note files (an image, a PDF),
   * which keep the tree on that experiment instead of collapsing to Global.
   */
  localSampleFolder(): string {
    const { folder, lastExperimentDir } = resolveLocalSampleFolder(
      this.activeNotePath(),
      this.lastExperimentDir,
      this.settings.globalSampleFolder
    );
    this.lastExperimentDir = lastExperimentDir;
    return folder;
  }

  /** Whether a Local sample scope can be resolved (an experiment is known). */
  hasLocalScope(): boolean {
    return this.activeNotePath() !== undefined || this.lastExperimentDir !== undefined;
  }

  /**
   * Whether sample autocomplete, highlighting and registry sync run for `path`:
   * the global setting, narrowed by the experiment README's `sample_tracking`
   * (#105). Notes outside an experiment follow the setting alone, and so does
   * an experiment whose README Obsidian has not indexed yet.
   */
  sampleTrackingFor(path: string | undefined): boolean {
    return isSampleTrackingOn(this.settings.sampleTracking, path, readmePath => {
      const readme = this.app.vault.getFileByPath(readmePath);
      return readme ? this.app.metadataCache.getFileCache(readme)?.frontmatter : undefined;
    });
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
