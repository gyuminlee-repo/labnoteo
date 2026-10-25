/**
 * Labnote Assistant — Obsidian plugin entry point.
 *
 * This is the skeleton: it wires the platform-neutral pieces from
 * `@labnoteo/core` (file-system port, translator) into Obsidian and registers a
 * couple of proof-of-wiring commands. Domain commands, sample suggestions, CM6
 * highlighting, sidebar views, the settings tab and the LLM/MCP layer are added
 * by subsequent modules that all consume the same `LabnoteHost` built here.
 */
import { MarkdownView, Plugin, Notice, TFile, TFolder, editorInfoField, type WorkspaceLeaf } from 'obsidian';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import {
  findSampleReferenceAt,
  isDiscussFlagged,
  rebuildUnitOpToc,
  refreshUnitOpTocEntries,
  minimalReplacement,
  parseFrontMatterYaml,
  reassignIssueMarkerIds,
  removeAllScanEntries,
} from '@labnoteo/core';
import {
  getSeoulDateString,
  getSeoulDateTimeString,
  touchLastUpdatedDate,
} from '@labnoteo/core/lib/dateUtils';
import { getSampleDisplayMeta, isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import { isPathTooLongError, WINDOWS_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import {
  classifyWorkflowMoveOut,
  classifyWorkflowRename,
  createWorkflowFileName,
  isCopiedWorkflowFileName,
  isValidWorkflowPath,
  parseWorkflowFileName,
  parseWorkflowHeading,
  planWorkflowChecklistSync,
  planWorkflowRetitle,
  relinkCopiedExperimentChecklist,
  resetCopiedWorkflowDates,
  rewriteWorkflowTitle,
  suggestCopiedWorkflowFileName,
  suggestLinkableFileName,
  unlinkableNameChars,
  workflowIdMismatch,
  type WorkflowHeading,
} from '@labnoteo/core/lib/workflowStructure';
import {
  saveSamplesFromDocument,
  resolveLocalSampleFolder,
  noteLabsamplesFolder,
  hasReferenceCatalog,
  inventorySampleFolder,
  moveSampleFolder,
  renameSampleSourcesInFolder,
} from '@labnoteo/core/lib/sampleStorage';
import { VaultFileSystem } from './vaultFileSystem';
import { bilingualName, createObsidianTranslator } from './i18n';
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
  workflowNumberClashNotice,
  addWorkflowFileToChecklist,
  moveTableCsvs,
  retitleWorkflowAfterRename,
  insertUnitOperationCommand,
  insertWorkflowLinkCommand,
  syncReadmeOrderOnRename,
  syncReadmeAndSamplesOnDelete,
  offerTableCsvCleanupOnDelete,
  setupResearchAutomationCommand,
  catalogDescription,
  experimentTitleHint,
  workflowAliasHint,
  workflowConcept,
  rebuildExperimentReadmeFile,
  unlinkableWorkflowNotice,
  processNoteThroughVault,
  writeNoteThroughVault,
  type ReadmeSyncControl,
} from './commands';
import { loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import * as posix from '@labnoteo/core/posix';
import {
  copiedExperimentOrigin,
  diagnoseExperimentPath,
  experimentFolderName,
  experimentLosingLabsamples,
  experimentLosingReadme,
  getExperimentDir,
  getNextLabnoteNumber,
  isSampleTrackingOn,
  nextExperimentId,
  resetCopiedExperimentReadme,
  sanitizeTitle,
  setExperimentReadmeId,
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
  insertExperimentSamplesTable,
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
import { SampleIdIndex } from './sampleIdIndex';
import { isLabNotePath, stampNoteAndReadme, writeNoteStamped } from './lastUpdatedStamp';
import { createOutlineDropTidy, type OutlineDropSnapshot } from './outlineDropTidy';
import { WorkflowTreeView, WORKFLOW_VIEW_TYPE } from './views/workflowView';
import { SampleTreeView, SAMPLE_VIEW_TYPE } from './views/sampleView';
import { exportTablesToCsv, exportActiveNoteTablesToCsv } from './exportCsv';
import { openUserGuide } from './userGuide';
import { catalogUpdateNotice, updateCatalogsCommand } from './catalogUpdate';
import { LabnoteSettingTab } from './settingsTab';
import { SETUP_DOC_PATH } from './scaffold/assets';
import { refreshAutomationFiles } from './scaffold/scaffold';
import {
  draftMethodCommand,
  summarizeResultsCommand,
  summarizeExperimentCommand,
  isExperimentReadme,
  extractSamplesCommand,
  askAgentCommand,
} from './llm/commands';
import { LabnoteMcpServer } from './llm/mcpServer';
import { CURRENT_SCHEMA_VERSION, migrateSettings, type LabnoteSettings } from './settings';
import { BarcodeFeature } from './barcode/barcodeFeature';
import { PartbankFeature } from './partbank/partbankFeature';
import { refreshLocationsIn } from './partbank/partbankLocation';
import { downloadPartbankCatalog } from './partbank/partbankCatalog';
import { handleImportUri, IMPORT_ACTION } from './partbank/partbankUri';

export default class LabnotePlugin extends Plugin {
  // `Plugin` already declares `settings?: unknown`; re-type it concretely.
  declare settings: LabnoteSettings;
  fs!: VaultFileSystem;
  t!: Translator;
  host!: LabnoteHost;
  mcpServer!: LabnoteMcpServer;
  barcode!: BarcodeFeature;
  partbank!: PartbankFeature;
  private sampleSuggest?: SampleEditorSuggest;
  private sampleIds?: SampleIdIndex;
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
  // Per experiment: the last queued Local registry rename of note names (#149).
  private readonly sampleSourceRenames = new Map<string, Promise<void>>();
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
  // Experiment folders copied with "Make a copy" whose fix is being offered (#223);
  // the files created along with them are part of that copy, not copies of their own.
  private readonly copiedExperiments = new Set<string>();
  // Of those, the folders whose notes already have their own IDs, and those
  // notes (#265): until then the "same note ID" question would be redundant.
  private readonly copyIdsRenewed = new Map<string, Set<string>>();
  // Pending "moved in but not listed" notices, coalesced per experiment folder.
  private readonly movedInTimers = new Map<string, number>();
  // Pending "moved out but still listed" notices, per experiment folder left (#287).
  private readonly movedAwayTimers = new Map<string, number>();
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

    this.partbank = new PartbankFeature(this);
    // "Send to labnoteo" in partbank. Any web page can open an `obsidian://`
    // URI, so the handler validates everything and confirms before writing.
    this.registerObsidianProtocolHandler(IMPORT_ACTION, params => {
      this.run(() => handleImportUri(this, params as Record<string, string>));
    });
    this.registerCommands();
    this.barcode = new BarcodeFeature(this, key => this.paletteName(key));
    this.barcode.register();
    this.registerSampleFeatures();
    this.registerInlineHighlighting();
    this.registerEditorExtension(
      createMetaDatePickerExtension({
        pick: this.t('Pick date and time'),
        endBeforeStart: (end, start) => this.t('End_date {0} is earlier than Start_date {1}.', end, start),
        implausibleYear: this.t('Only years 1900–2100 are written; the date in the note was kept.'),
      })
    );
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
    this.app.workspace.onLayoutReady(() =>
      this.run(async () => {
        const hash = await catalogUpdateNotice(this.host, this.settings.catalogNoticeHash);
        if (hash === this.settings.catalogNoticeHash) return;
        this.settings.catalogNoticeHash = hash;
        await this.saveSettings();
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
    for (const handle of this.movedAwayTimers.values()) window.clearTimeout(handle);
    this.movedAwayTimers.clear();
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
      if (isPathTooLongError(err)) {
        this.host.notify(
          'error',
          this.t(
            'Command failed: the path is too long for the file system (Windows allows {0} characters including the vault folder). Move the vault to a shorter folder path, or shorten the title or alias.',
            String(WINDOWS_PATH_MAX - 1)
          )
        );
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.host.notify('error', this.t('Command failed: {0}', msg));
    });
  }

  /**
   * The date commands, also listed in reading view (#296), where they only
   * say how to use them: a date has no place to go without a cursor. The
   * active editor, not the active Markdown view, so canvas cards and hover
   * previews keep working.
   */
  private insertDateFromPalette(checking: boolean, now: () => string): boolean {
    const reading = this.app.workspace.getActiveViewOfType(MarkdownView)?.getMode() === 'preview';
    const editor = this.app.workspace.activeEditor?.editor;
    if (!reading && !editor) return false;
    if (checking) return true;
    if (reading || !editor) {
      this.host.notify('info', this.t('Switch to the editing view and put the cursor where the date goes, then run this again.'));
    } else {
      insertDateCommand(editor, this.host, now());
    }
    return true;
  }

  private paletteName(key: string): string {
    return bilingualName(this.t, key);
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'insert-date',
      name: this.paletteName('Insert date'),
      checkCallback: checking => this.insertDateFromPalette(checking, getSeoulDateString),
    });

    this.addCommand({
      id: 'insert-datetime',
      name: this.paletteName('Insert date and time'),
      checkCallback: checking => this.insertDateFromPalette(checking, getSeoulDateTimeString),
    });

    this.addCommand({
      id: 'create-experiment',
      name: this.paletteName('Create experiment'),
      callback: () => this.run(() => createExperimentCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'change-experiment-status',
      name: this.paletteName('Change experiment status'),
      callback: () =>
        this.run(() => changeExperimentStatusCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'insert-issue-marker',
      name: this.paletteName('Insert issue marker'),
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
      name: this.paletteName('Toggle discussion flag'),
      callback: () =>
        this.run(() => toggleDiscussionFlagCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'setup-research-automation',
      name: this.paletteName('Setup research automation'),
      callback: () =>
        this.run(async () => {
          await setupResearchAutomationCommand(this.host, this.manifest.version);
          await this.offerAttachmentFolder();
        }),
    });

    this.addCommand({
      id: 'create-workflow',
      name: this.paletteName('Create workflow'),
      callback: () => this.run(() => createWorkflowCommand(this.app, this.host, this.stampLastUpdated)),
    });

    this.addCommand({
      id: 'renumber-workflows',
      name: this.paletteName('Renumber workflows'),
      callback: () =>
        this.run(() =>
          renumberWorkflowsCommand(this.app, this.host, this.readmeSyncControl(), (dir, renames) =>
            this.queueSampleSourceRenames(dir, renames)
          )
        ),
    });

    this.addCommand({
      id: 'sync-workflow-checklist',
      name: this.paletteName('Sync workflow checklist with folder'),
      callback: () => this.run(() => this.syncWorkflowChecklist()),
    });

    this.addCommand({
      id: 'insert-unit-operation',
      name: this.paletteName('Insert unit operation'),
      callback: () => this.run(() => insertUnitOperationCommand(this.app, this.host)),
    });

    this.addCommand({
      id: 'update-catalogs',
      name: this.paletteName('Update catalogs'),
      callback: () =>
        this.run(async () => {
          if (await updateCatalogsCommand(this.host)) this.refreshWorkflowViews();
        }),
    });

    this.addCommand({
      id: 'open-sample-definition',
      name: this.paletteName('Open sample definition'),
      callback: () => this.run(() => this.openSampleDefinitionCommand()),
    });

    this.addCommand({
      id: 'download-partbank-catalog',
      name: this.paletteName('Download partbank catalog'),
      checkCallback: checking => {
        if (!this.partbank.configured) return false;
        if (!checking) this.run(() => downloadPartbankCatalog(this));
        return true;
      },
    });

    this.addCommand({
      id: 'download-partbank-catalog',
      name: this.paletteName('Download partbank catalog'),
      checkCallback: checking => {
        if (!this.partbank.configured) return false;
        if (!checking) this.run(() => downloadPartbankCatalog(this));
        return true;
      },
    });

    this.addCommand({
      id: 'refresh-partbank-locations',
      name: this.paletteName('Refresh storage locations from partbank'),
      checkCallback: checking => {
        if (!this.partbank.configured) return false;
        if (!checking) {
          this.run(() =>
            refreshLocationsIn(this, [this.localSampleFolder(), this.settings.globalSampleFolder])
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: 'insert-experiment-samples-table',
      name: this.paletteName('Insert sample list of this experiment'),
      callback: () =>
        this.run(async () => {
          await insertExperimentSamplesTable(this.app, this);
        }),
    });

    this.addCommand({
      id: 'export-tables-csv',
      name: this.paletteName('Export tables to CSV'),
      callback: () => this.run(() => exportActiveNoteTablesToCsv(this)),
    });

    // --- AI commands ---
    this.addCommand({
      id: 'ai-draft-method',
      name: this.paletteName('AI: Draft Method section'),
      callback: () => this.run(() => draftMethodCommand(this)),
    });
    this.addCommand({
      id: 'ai-summarize-results',
      name: this.paletteName('AI: Summarize workflow results'),
      checkCallback: checking => {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path && isExperimentReadme(path)) return false;
        if (!checking) this.run(() => summarizeResultsCommand(this));
        return true;
      },
    });
    this.addCommand({
      id: 'ai-summarize-experiment',
      name: this.paletteName('AI: Summarize experiment results'),
      checkCallback: checking => {
        const path = this.app.workspace.getActiveFile()?.path;
        if (!path || !isExperimentReadme(path)) return false;
        if (!checking) this.run(() => summarizeExperimentCommand(this));
        return true;
      },
    });
    this.addCommand({
      id: 'ai-extract-samples',
      name: this.paletteName('AI: Extract sample definitions'),
      callback: () => this.run(() => extractSamplesCommand(this)),
    });
    this.addCommand({
      id: 'ai-ask-agent',
      name: this.paletteName('AI: Ask assistant (uses tools)'),
      callback: () => this.run(() => askAgentCommand(this)),
    });

    this.addCommand({
      id: 'toggle-mcp-server',
      name: this.paletteName('Toggle MCP server'),
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

    // A type with a product catalog is curated: search the read-only catalog
    // first; without one, a generated id is registered instead.
    let referenceText: string | undefined;
    const localFolder = noteLabsamplesFolder(target.path, this.settings.globalSampleFolder);
    const knownTypes = getSampleDisplayMeta(this.settings.customSampleTypes).types;
    if (
      isCatalogSampleType(type) &&
      ((await hasReferenceCatalog(this.fs, localFolder, type, knownTypes)) ||
        (await hasReferenceCatalog(this.fs, this.settings.globalSampleFolder, type, knownTypes)))
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
        const readmeOf = experimentLosingReadme(oldPath, newPath);
        // Not when the experiment folder itself was renamed: the README went
        // along with it and the folder listener handles the name (#67, #166,
        // #259). Then the old folder is no longer there.
        if (readmeOf && this.app.vault.getAbstractFileByPath(readmeOf) instanceof TFolder) {
          this.run(() => this.offerExperimentReadmeBack(file, readmeOf, oldPath));
        }
        this.renameLocalSampleSources(oldPath, newPath);
        // Ahead of the copy branch, which returns early: a copy moved to
        // another experiment needs its samples and CSVs too.
        this.offerLocalSamplesMoved(oldPath, newPath);
        this.moveTableCsvsWithNote(oldPath, newPath);
        if (this.copiedWorkflows.delete(oldPath)) {
          if (posix.dirname(newPath) !== posix.dirname(oldPath)) return;
          if (isValidWorkflowPath(newPath)) this.run(() => this.offerListRenamedCopy(file));
          else if (isCopiedWorkflowFileName(file.name)) this.copiedWorkflows.add(newPath);
          return;
        }
        this.noticeWorkflowMovedIn(oldPath, newPath);
        this.noticeWorkflowMovedOut(oldPath, newPath);
        this.noticeWorkflowMovedAway(oldPath, newPath);
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
              if (unlinkableNameChars(to).length > 0) this.run(() => this.offerLinkableNameFix(file, dir, from, to));
              else this.run(() => this.retitleAfterRename(file, dir, from, to));
            }
            return;
          case 'strayMoved':
            this.strayWorkflows.set(newPath, effect.origin);
            return;
          case 'broken':
            // Recorded synchronously so a follow-up rename finds the origin.
            this.strayWorkflows.set(newPath, effect.origin);
            this.run(() => this.offerWorkflowNameFix(file, effect.suggestion, effect.origin));
            return;
        }
      })
    );

    // Obsidian reports every existing file as created while the vault loads.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on('create', file => {
          if (file instanceof TFolder) {
            this.onExperimentFolderCopied(file);
            return;
          }
          if (!(file instanceof TFile) || !isCopiedWorkflowFileName(file.name)) return;
          const dir = getExperimentDir(file.path);
          if (dir !== posix.dirname(file.path) || this.copiedExperiments.has(dir)) return;
          this.copiedWorkflows.add(file.path);
          this.run(() => this.offerCopiedWorkflowFix(file));
        })
      );
    });

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (!(file instanceof TFile)) return;
        this.copiedWorkflows.delete(file.path);
        if (file.name === 'README.labnote.md') {
          const readmeDir = getExperimentDir(file.path);
          if (readmeDir === posix.dirname(file.path)) this.run(() => this.offerReadmeRebuild(readmeDir));
        }
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
   * A note was renamed within its folder in an experiment: the Local registry
   * lists it under the new name (#149). Renumbering holds the folder and
   * applies all its renames at once when it is done.
   */
  private renameLocalSampleSources(oldPath: string, newPath: string): void {
    if (!newPath.endsWith('.md') || posix.dirname(newPath) !== posix.dirname(oldPath)) return;
    const dir = getExperimentDir(newPath);
    if (!dir || this.readmeSyncHolds.has(dir)) return;
    const from = posix.basename(oldPath);
    const to = posix.basename(newPath);
    if (from !== to) void this.queueSampleSourceRenames(dir, new Map([[from, to]]));
  }

  /**
   * Rename note names in `dir`'s Local registry, one write after another per
   * experiment so quick successive renames apply in event order.
   */
  queueSampleSourceRenames(dir: string, renames: ReadonlyMap<string, string>): Promise<void> {
    const folder = posix.join(dir, 'resources', 'labsamples');
    const types = getSampleDisplayMeta(this.settings.customSampleTypes).types;
    const next = (this.sampleSourceRenames.get(dir) ?? Promise.resolve())
      .then(async () => {
        if ((await renameSampleSourcesInFolder(this.fs, folder, renames, types)) > 0) this.refreshSampleViews();
      })
      .catch(err => console.error('Labnote: renaming sample sources failed', err));
    this.sampleSourceRenames.set(dir, next);
    void next.then(() => {
      if (this.sampleSourceRenames.get(dir) === next) this.sampleSourceRenames.delete(dir);
    });
    return next;
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

    const samplesOf = experimentLosingLabsamples(oldPath, newPath);
    const holdsSamples =
      posix.basename(oldPath) === 'labsamples' || folder.children.some(c => c instanceof TFolder && c.name === 'labsamples');
    if (samplesOf && holdsSamples && this.app.vault.getAbstractFileByPath(samplesOf) instanceof TFolder) {
      this.run(() => this.offerLabsamplesFolderBack(folder, samplesOf, oldPath));
    }

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

  /**
   * An experiment's `README.labnote.md` was renamed or moved away (#226): the
   * experiment drops out of the experiment list without a word. Offer it back.
   */
  private async offerExperimentReadmeBack(file: TFile, dir: string, oldPath: string): Promise<void> {
    const movedPath = file.path;
    const warning = this.t(
      '"{0}" no longer has README.labnote.md: the experiment list and the workflow checklist will not find this experiment.',
      posix.basename(dir)
    );
    const settled = await this.waitForNoModal();
    if (this.unloaded || file.path !== movedPath) return;
    const free = (): boolean =>
      this.app.vault.getAbstractFileByPath(dir) instanceof TFolder && !this.app.vault.getAbstractFileByPath(oldPath);
    // The experiment folder went too (it was renamed), so nothing was lost (#259).
    if (!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) return;
    if (!settled || !free()) {
      this.host.notify('warn', warning);
      return;
    }
    const ok = await this.host.confirm(`${warning} ${this.t('Rename it back to "{0}"?', oldPath)}`, {
      confirmLabel: this.t('Rename back'),
    });
    if (!ok || file.path !== movedPath || !free()) return;
    await this.app.fileManager.renameFile(file, oldPath);
  }

  /**
   * An experiment's `README.labnote.md` was deleted (#340): the experiment
   * drops out of the experiment list and checklist sync without a word. Say
   * so, and offer a new README listing its workflow notes. Not when the whole
   * experiment folder went.
   */
  private async offerReadmeRebuild(dir: string): Promise<void> {
    const readmePath = posix.join(dir, 'README.labnote.md');
    const gone = (): boolean =>
      this.app.vault.getAbstractFileByPath(dir) instanceof TFolder && !this.app.vault.getAbstractFileByPath(readmePath);
    // A deleted folder reports its files first; give it a moment to go too.
    await new Promise(resolve => window.setTimeout(resolve, 500));
    const settled = await this.waitForNoModal();
    if (this.unloaded || !gone()) return;
    const warning = this.t(
      'The README.labnote.md of "{0}" was deleted: the experiment list and the workflow checklist no longer find this experiment. If you can, restore it from the trash (Obsidian\'s .trash folder or the system trash).',
      posix.basename(dir)
    );
    if (!settled) {
      this.host.notify('warn', warning);
      return;
    }
    const ok = await this.host.confirm(
      `${warning} ${this.t('Or create a new README now, listing the workflow notes in the folder? Its status starts at planned, and the objective and summary start empty.')}`,
      { confirmLabel: this.t('Create README') }
    );
    if (!ok || this.unloaded || !gone()) return;
    const listed = await rebuildExperimentReadmeFile(this.host, dir);
    this.host.notify('info', this.t('Created a new README for {0}, listing {1} workflow note(s).', posix.basename(dir), String(listed)));
  }

  /**
   * An experiment's `resources/labsamples` (or its `resources`) was renamed or
   * moved away (#338): every Local sample of the experiment reads as
   * unregistered without a word. Offer the old name back.
   */
  private async offerLabsamplesFolderBack(folder: TFolder, dir: string, oldPath: string): Promise<void> {
    const movedPath = folder.path;
    const warning = this.t(
      '"{0}" no longer has resources/labsamples: its Local samples will show as unregistered, and new ones go to a new, empty registry.',
      posix.basename(dir)
    );
    const settled = await this.waitForNoModal();
    if (this.unloaded || folder.path !== movedPath) return;
    const free = (): boolean =>
      this.app.vault.getAbstractFileByPath(dir) instanceof TFolder &&
      !this.app.vault.getAbstractFileByPath(oldPath) &&
      this.app.vault.getAbstractFileByPath(posix.dirname(oldPath)) instanceof TFolder;
    if (!settled || !free()) {
      this.host.notify('warn', warning);
      return;
    }
    const ok = await this.host.confirm(`${warning} ${this.t('Rename it back to "{0}"?', oldPath)}`, {
      confirmLabel: this.t('Rename back'),
    });
    if (!ok || folder.path !== movedPath || !free()) return;
    await this.app.fileManager.renameFile(folder, oldPath);
    this.refreshSampleViews();
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

  /**
   * A workflow note was renamed to a name no link can reach (#326): its
   * checklist entry is rewritten but does not open. Offer the name without
   * those characters, or the old one back; otherwise retitle as usual.
   */
  private async offerLinkableNameFix(file: TFile, dir: string, from: string, to: string): Promise<void> {
    const path = file.path;
    const suggestion = suggestLinkableFileName(to);
    const back = unlinkableNameChars(from).length === 0 ? from : undefined;
    const name = suggestion ?? back;
    const warning = this.t(
      '"{0}" has {1} in its name, which no link can reach: its README checklist entry will not open.',
      to,
      unlinkableNameChars(to).join(' ')
    );
    const settled = await this.waitForNoModal();
    if (this.unloaded || file.path !== path) return;
    const target = name ? posix.join(dir, name) : undefined;
    if (!settled || !name || !target || this.app.vault.getAbstractFileByPath(target)) {
      this.host.notify('warn', warning);
      await this.retitleAfterRename(file, dir, from, to);
      return;
    }
    const ok = await this.host.confirm(
      `${warning} ${name === suggestion ? this.t('Rename it to "{0}"?', name) : this.t('Rename it back to "{0}"?', name)}`,
      { confirmLabel: this.t(name === suggestion ? 'Fix name' : 'Rename back') }
    );
    if (file.path !== path) return;
    if (!ok || this.app.vault.getAbstractFileByPath(target)) {
      await this.retitleAfterRename(file, dir, from, to);
      return;
    }
    await this.app.fileManager.renameFile(file, target);
  }

  /** A workflow note was renamed by hand: its table CSVs follow it (#60). */
  private async moveTableCsvsAfterRename(dir: string, from: string, to: string): Promise<void> {
    const { skipped } = await moveTableCsvs(
      this.app,
      { from: dir, to: dir },
      { from, to },
      new Set(await this.fs.list(dir))
    );
    if (skipped > 0) {
      this.host.notify(
        'warn',
        this.t('{0} table CSV file(s) kept their old name: the new name was taken or the rename failed.', String(skipped))
      );
    }
  }

  /**
   * A note moved to another folder takes its `_tableN.csv` exports along, as a
   * rename in place does, then says so (#206); its worksheet scans follow it to
   * the new experiment's `images/scans` the same way. A CSV whose name is already
   * taken there stays behind with a warning. Skipped for a move into the trash
   * or a hidden folder, and when a whole experiment folder moved (its CSVs
   * moved with it; the old folder is gone by then).
   */
  private moveTableCsvsWithNote(oldPath: string, newPath: string): void {
    if (!/\.md$/i.test(newPath)) return;
    const fromDir = posix.dirname(oldPath);
    const toDir = posix.dirname(newPath);
    if (fromDir === toDir) return;
    if (toDir.split('/').some(segment => segment.startsWith('.'))) return;
    if (!this.app.vault.getAbstractFileByPath(fromDir)) return;
    this.run(() => this.barcode.moveScansWithNote(newPath, fromDir, toDir));
    this.run(async () => {
      const names = new Set(await this.fs.list(fromDir));
      const { moved, skipped } = await moveTableCsvs(
        this.app,
        { from: fromDir, to: toDir },
        { from: posix.basename(oldPath), to: posix.basename(newPath) },
        names,
        new Set(await this.fs.list(toDir))
      );
      if (moved > 0) {
        this.host.notify('info', this.t('Moved {0} table CSV file(s) to {1} with the note.', String(moved), toDir));
      }
      if (skipped > 0) {
        this.host.notify(
          'warn',
          this.t(
            '{0} table CSV file(s) stayed in {1}: a file with the same name is already in {2}, or the move failed.',
            String(skipped),
            fromDir,
            toDir
          )
        );
      }
    });
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
    const mismatch = workflowIdMismatch(to, await this.app.vault.read(file));
    if (mismatch) {
      await this.offerWorkflowIdFix(file, from, mismatch.fileId, mismatch.noteId);
      return;
    }
    await retitleWorkflowAfterRename(this.app, this.host, dir, from, to);
  }

  /**
   * A workflow note's file name now carries another catalog ID than its
   * `## [ID name]` heading (#240): the checklist label mixes the new ID with
   * the old name, and nothing else follows. Say so, and offer the old name
   * back when it still had the note's ID and is free.
   */
  private async offerWorkflowIdFix(file: TFile, from: string, fileId: string, noteId: string): Promise<void> {
    const path = file.path;
    let known = true;
    try {
      known = (await loadWorkflows(this.fs, '.')).workflows.some(w => w.id === fileId);
    } catch {
      known = true;
    }
    const warning = [
      this.t(
        'The file name "{0}" says {1}, but the note is the workflow {2}: the README checklist shows {1} with the note\'s name, and the title and heading stay {2}. To use another workflow, create a new note with "{3}" instead.',
        file.name,
        fileId,
        noteId,
        this.t('Create workflow')
      ),
      ...(known ? [] : [this.t('{0} is not in the workflow catalog.', fileId)]),
    ].join(' ');
    const target = posix.join(posix.dirname(path), from);
    if (parseWorkflowFileName(from)?.id !== noteId || this.app.vault.getAbstractFileByPath(target)) {
      this.host.notify('warn', warning);
      return;
    }
    const ok = await this.host.confirm(`${warning} ${this.t('Rename it back to "{0}"?', from)}`, {
      confirmLabel: this.t('Rename back'),
    });
    if (!ok) {
      // A later rename may still leave the title behind (#268); say how to bring it back in step.
      this.host.notify(
        'info',
        this.t(
          'Kept the name "{0}". If the title or the README checklist no longer match the file name later, run "{1}".',
          file.name,
          this.t('Sync workflow checklist with folder')
        )
      );
      return;
    }
    if (file.path !== path || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(file, target);
  }

  /**
   * Tell the user a workflow note fell out of the naming format and, when a
   * fix is known and its name is free, offer to rename it; otherwise offer its
   * original name `origin` back (#307), e.g. after the number lost a digit.
   * The prompt waits for open modals to close: a file-explorer rename opens
   * Obsidian's "update links" prompt at the same time, and answering ours
   * first would make that one rewrite links for the stale rename.
   */
  private async offerWorkflowNameFix(file: TFile, suggestion: string | undefined, origin: string): Promise<void> {
    const brokenPath = file.path;
    const name = file.name;
    const dir = posix.dirname(brokenPath);
    const fixed = suggestion ? posix.join(dir, suggestion) : undefined;
    const target = fixed && !this.app.vault.getAbstractFileByPath(fixed) ? fixed : posix.join(dir, origin);
    const warn = (): void =>
      this.host.notify(
        'warn',
        this.t(
          '"{0}" is no longer a workflow note: its name must start with ###_ and end in .labnote.md, so the README checklist stopped following it.',
          name
        )
      );
    if (this.app.vault.getAbstractFileByPath(target)) {
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

    const ok =
      target === fixed
        ? await this.host.confirm(
            this.t(
              '"{0}" is no longer a workflow note: its name must end in .labnote.md, so the README checklist stopped following it. Rename it to "{1}"?',
              name,
              suggestion!
            ),
            { confirmLabel: this.t('Fix name') }
          )
        : await this.host.confirm(
            `${this.t(
              '"{0}" is no longer a workflow note: its name must start with ###_ and end in .labnote.md, so the README checklist stopped following it.',
              name
            )} ${this.t('Rename it back to "{0}"?', origin)}`,
            { confirmLabel: this.t('Rename back') }
          );
    if (file.path !== brokenPath || this.app.vault.getAbstractFileByPath(target)) return;
    if (!ok) {
      if (target !== fixed) warn();
      return;
    }
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
    // Same for the note ID, or scans of either note could be filed in the other.
    await this.barcode.reassignCopiedId(file);
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
    await this.resetCopyDates(file);
    await this.app.fileManager.renameFile(file, target);
    if (await addWorkflowFileToChecklist(this.app, this.host, dir, suggestion)) {
      this.host.notify('info', this.t('Added "{0}" to the README checklist.', suggestion));
    }
  }

  /**
   * An experiment folder was copied (`001_GFP 1` next to `001_GFP`): the copy
   * has the original's number, title and discussion flag, so the workflow view
   * shows two identical experiments (#223). Ask for its title and make it the
   * next experiment.
   */
  private onExperimentFolderCopied(folder: TFolder): void {
    const copyPath = folder.path;
    if (getExperimentDir(copyPath) !== copyPath) return;
    const origin = copiedExperimentOrigin(folder.name);
    if (!origin || !(this.app.vault.getAbstractFileByPath(posix.join(posix.dirname(copyPath), origin)) instanceof TFolder)) {
      return;
    }
    this.copiedExperiments.add(copyPath);
    this.run(async () => {
      try {
        await this.offerCopiedExperimentFix(folder, origin);
      } finally {
        this.copiedExperiments.delete(copyPath);
        this.copyIdsRenewed.delete(copyPath);
      }
    });
  }

  /**
   * Whether the note at `path` is in a copied experiment folder whose IDs are
   * about to be renewed, or was just given its own: asking about the shared
   * note ID then would issue a second one. A note copied in only after the
   * renewal is not covered, so the question still catches it (#265).
   */
  isRenewingCopiedNoteId(path: string): boolean {
    const dir = getExperimentDir(path);
    if (dir && this.copiedExperiments.has(dir) && !this.copyIdsRenewed.has(dir)) return true;
    return [...this.copyIdsRenewed.values()].some(notes => notes.has(path));
  }

  /**
   * Wait until the copy holds as many notes as the original. Obsidian creates
   * the folder first and copies the files into it one by one, so right after
   * the folder appears some notes may not be there yet. Gives up after 10s.
   */
  private async waitForCopiedNotes(folder: TFolder, originPath: string): Promise<void> {
    const original = this.app.vault.getAbstractFileByPath(originPath);
    if (!(original instanceof TFolder)) return;
    const expected = markdownFilesIn(original).length;
    const deadline = Date.now() + 10_000;
    while (!this.unloaded && markdownFilesIn(folder).length < expected && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
  }

  private async offerCopiedExperimentFix(folder: TFolder, origin: string): Promise<void> {
    const copyPath = folder.path;
    const labnoteDir = posix.dirname(copyPath);
    const warn = (): void =>
      this.host.notify(
        'warn',
        this.t(
          '"{0}" is a copy of the experiment {1} with its number, title and discussion flag, so the workflow view lists the two alike. Rename the folder to a new number and change its README title to tell them apart.',
          folder.name,
          origin
        )
      );
    const settled = await this.waitForNoModal();
    if (this.unloaded || folder.path !== copyPath) return;
    // Before any prompt or check, as for a copied workflow note: cancelling the
    // title, another open dialog or a missing README must not leave the copy
    // sharing issue IDs and note IDs with the original (#265).
    await this.waitForCopiedNotes(folder, posix.join(labnoteDir, origin));
    if (this.unloaded || folder.path !== copyPath) return;
    const renewed = new Set<string>();
    let markers = 0;
    for (const note of markdownFilesIn(folder)) {
      const reassigned = reassignIssueMarkerIds(await this.app.vault.read(note));
      if (reassigned.count > 0) {
        markers += reassigned.count;
        await this.app.vault.process(note, data => reassignIssueMarkerIds(data).content);
      }
      renewed.add(note.path);
      await this.barcode.reassignCopiedId(note);
    }
    this.copyIdsRenewed.set(copyPath, renewed);
    if (markers > 0) {
      this.host.notify(
        'info',
        this.t('Gave the {0} issue marker(s) of the copy new IDs, so they do not merge with the original\'s issues.', String(markers))
      );
    }

    const readme = this.app.vault.getAbstractFileByPath(posix.join(copyPath, 'README.labnote.md'));
    if (!(readme instanceof TFile)) {
      warn();
      return;
    }
    let title: unknown;
    let discussed = false;
    let status: string | undefined;
    let id: string | undefined;
    try {
      const { frontMatter } = parseFrontMatterYaml((await this.app.vault.read(readme)).replace(/\r\n/g, '\n'));
      title = frontMatter.title;
      discussed = isDiscussFlagged(frontMatter);
      if (typeof frontMatter.status === 'string') status = frontMatter.status.trim();
      if (typeof frontMatter.id === 'string' || typeof frontMatter.id === 'number') id = String(frontMatter.id).trim() || undefined;
    } catch {
      title = undefined;
    }
    // Like the note IDs above, before any prompt: a copy keeping the
    // original's `id` fails the automation's validate as a duplicate (#353).
    if (id) {
      const taken = this.app.vault
        .getMarkdownFiles()
        .filter(f => f.name === 'README.labnote.md' && f.path !== readme.path)
        .map(f => this.app.metadataCache.getFileCache(f)?.frontmatter?.id)
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map(String);
      const nextId = nextExperimentId(id, taken);
      await this.app.vault.process(readme, data => setExperimentReadmeId(data, nextId));
      this.host.notify(
        'info',
        nextId
          ? this.t('Changed the copy\'s id from {0} to {1}, so the automation does not take it for the original.', id, nextId)
          : this.t('Removed the copy\'s id {0}, so the automation does not take it for the original; its folder name serves as its ID.', id)
      );
    }
    if (!settled) {
      warn();
      return;
    }
    const newTitle = (
      await this.host.prompt({
        title: this.t('Name this copy of the experiment'),
        prompt: this.t(
          '"{0}" is a copy of the experiment {1}. Give the copy its own title: it becomes the next experiment, dated today, planned, without the discussion flag.',
          folder.name,
          origin
        ),
        value: typeof title === 'string' ? title : '',
        validate: v => {
          if (!v.trim()) return this.t('Title is required.');
          if (!sanitizeTitle(v.trim())) {
            return this.t('The title has no characters usable in a folder name. Add letters or numbers.');
          }
          return null;
        },
        hint: experimentTitleHint(this.host),
      })
    )?.trim();
    if (this.unloaded || folder.path !== copyPath) return;
    const siblings = (await this.fs.list(labnoteDir)).filter(n => n !== folder.name);
    const target = newTitle ? posix.join(labnoteDir, experimentFolderName(getNextLabnoteNumber(siblings), newTitle)) : '';
    if (!newTitle || this.app.vault.getAbstractFileByPath(target)) {
      warn();
      await this.relinkCopiedChecklist(copyPath);
      return;
    }

    await this.app.vault.process(readme, data => resetCopiedExperimentReadme(data, newTitle, getSeoulDateString()));
    await this.app.fileManager.renameFile(folder, target);
    const done = [
      this.t('Made the copy the experiment {0}, created today.', posix.basename(target)),
      ...(status && status !== 'planned' ? [this.t('Its status went from {0} back to planned.', status)] : []),
      ...(discussed
        ? [this.t('The discussion flag was turned off; run "{0}" if the copy needs its own discussion.', this.t('Toggle discussion flag'))]
        : []),
    ];
    this.host.notify('info', done.join(' '));
    await this.relinkCopiedChecklist(target);
  }

  /**
   * After renaming a copied experiment, Obsidian may have rewritten its
   * checklist links to the original's notes of the same names (#320). Wait
   * for its link-update dialog, then point them back at the copy's own notes.
   */
  private async relinkCopiedChecklist(dir: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!(folder instanceof TFolder)) return;
    if (!(await this.settleModals())) {
      this.host.notify(
        'warn',
        this.t(
          'Check that the checklist of {0} links to its own notes, not the original\'s; run "{1}" to fix it.',
          folder.name,
          this.t('Sync workflow checklist with folder')
        )
      );
      return;
    }
    if (this.unloaded) return;
    const readmePath = posix.join(dir, 'README.labnote.md');
    if (!(this.app.vault.getAbstractFileByPath(readmePath) instanceof TFile)) return;
    const names = folder.children.filter((c): c is TFile => c instanceof TFile).map(c => c.name);
    let count = 0;
    await processNoteThroughVault(this.app, this.host, readmePath, content => {
      const r = relinkCopiedExperimentChecklist(content, dir, names);
      count = r.count;
      return r.content;
    });
    if (count > 0) {
      this.host.notify(
        'info',
        this.t('Pointed {0} checklist link(s) of {1} back at its own notes instead of the original\'s.', String(count), folder.name)
      );
    }
  }

  /**
   * With Obsidian's default attachment location (the vault root), images
   * pasted into lab notes pile up outside the experiment folders (#154).
   * Offer `./images`, the experiment's images folder for a lab note. The
   * vault config API is not public, so nothing is asked without it.
   */
  private async offerAttachmentFolder(): Promise<void> {
    const vault = this.app.vault as unknown as {
      getConfig?: (key: string) => unknown;
      setConfig?: (key: string, value: unknown) => void;
    };
    if (typeof vault.getConfig !== 'function' || typeof vault.setConfig !== 'function') return;
    const current = vault.getConfig('attachmentFolderPath');
    if (current !== undefined && current !== null && current !== '' && current !== '/') return;
    const ok = await this.host.confirm(
      this.t(
        'With the current setting, a pasted image is saved at the top of the vault. Save them in an images folder next to the note instead (for a lab note, the experiment\'s images folder)? This changes Settings → Files and links → Default location for new attachments to "./images".'
      ),
      { confirmLabel: this.t('Use ./images') }
    );
    if (!ok) return;
    vault.setConfig('attachmentFolderPath', './images');
    this.host.notify('info', this.t('New attachments now go to the images folder next to each note.'));
  }

  /**
   * Date a copy that is becoming a workflow of its own from today, with its
   * end and unit-op dates emptied (#160), and drop the original's filed
   * worksheet scans (#350), and say so.
   */
  private async resetCopyDates(file: TFile): Promise<void> {
    const today = getSeoulDateString();
    let changed = false;
    let scans = 0;
    await this.app.vault.process(file, data => {
      const dated = resetCopiedWorkflowDates(data, today);
      changed = dated !== data;
      const stripped = removeAllScanEntries(dated);
      scans = stripped.count;
      return stripped.md;
    });
    if (changed) {
      this.host.notify(
        'info',
        this.t(
          'Reset the dates of the copy {0}: created today, with the end date and the unit operations\' Start_date/End_date emptied.',
          file.name
        )
      );
    }
    if (scans > 0) {
      this.host.notify(
        'info',
        this.t(
          'Removed the {0} worksheet scan(s) of the original from the copy {1}; the scan images stay for the original.',
          String(scans),
          file.name
        )
      );
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

    let description: string | undefined;
    try {
      const wf = (await loadWorkflows(this.fs, '.')).workflows.find(w => w.id === heading.id);
      if (wf?.description) description = catalogDescription(wf.id, wf.description);
    } catch {
      description = undefined;
    }
    const alias = await workflowAliasModal(this.app, {
      id: heading.id,
      catalogName: heading.name,
      title: this.t('Name this copy of the workflow'),
      placeholder: this.t('Enter a name for this workflow'),
      value: originalAlias,
      about: workflowConcept(this.host),
      description,
      hint: workflowAliasHint(this.host, heading.id, heading.name, await this.fs.list(posix.dirname(copyPath))),
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
    await this.resetCopyDates(file);
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
    // Before asking (#194): the title and heading follow the new name even if the copy is not listed.
    await this.app.vault.process(file, data => planWorkflowRetitle(data, file.name)?.content ?? data);
    const ok = await this.host.confirm(this.t('Add "{0}" to the README checklist?', file.name), {
      confirmLabel: this.t('Add to checklist'),
    });
    if (!ok || file.path !== path) return;
    await this.resetCopyDates(file);
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
   * A workflow note moved to another experiment folder leaves its entry in the
   * README checklist of the one it left (#287). Point the user at the sync
   * command there, once per folder for a batch of moves, if an entry is left.
   * Entries are not removed automatically: the move may be undone.
   */
  private noticeWorkflowMovedAway(oldPath: string, newPath: string): void {
    if (!isValidWorkflowPath(oldPath) || !isValidWorkflowPath(newPath)) return;
    const oldDir = posix.dirname(oldPath);
    // Renaming or moving a whole experiment folder renames every note in it;
    // by then its old folder no longer exists.
    if (oldDir === posix.dirname(newPath) || !this.app.vault.getAbstractFileByPath(oldDir)) return;

    const pending = this.movedAwayTimers.get(oldDir);
    if (pending !== undefined) window.clearTimeout(pending);
    this.movedAwayTimers.set(
      oldDir,
      window.setTimeout(() => {
        this.movedAwayTimers.delete(oldDir);
        this.run(async () => {
          const readmePath = posix.join(oldDir, 'README.labnote.md');
          if (this.unloaded || !(await this.fs.exists(readmePath))) return;
          const plan = planWorkflowChecklistSync(
            await this.fs.read(readmePath),
            await this.fs.list(oldDir),
            undefined,
            undefined,
            oldDir
          );
          if (!plan.stale.some(s => s.reason !== 'subfolder')) return;
          this.host.notify(
            'warn',
            this.t(
              'Workflow notes moved out of {0} are still in its README checklist. Run "{1}" in {0} to remove them.',
              posix.basename(oldDir),
              this.t('Sync workflow checklist with folder')
            )
          );
        });
      }, 1000)
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
          // Even a note the checklist already lists can take a number another note has (#288).
          if (plan.numberClashes.length > 0) {
            this.host.notify('warn', workflowNumberClashNotice(this.host, plan.numberClashes));
          }
          if (plan.unlinkable.length > 0) this.host.notify('warn', unlinkableWorkflowNotice(this.host, plan.unlinkable));
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
   *
   * With the setting off the order is left as the researcher arranged it, but
   * the entries are still matched to their headings so a renamed unit
   * operation does not leave a wrong name and a dead link behind (#258).
   */
  private registerUnitOpTocAutoSync(): void {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, info) => {
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
          const after = this.settings.autoSyncUnitOpToc
            ? rebuildUnitOpToc(before)
            : refreshUnitOpTocEntries(before);
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

  /** Forget hand-set dates and pending edits, so toggling the setting resumes stamping (#202). */
  resetLastUpdatedTracking(): void {
    this.lastUpdatedTracker.clear();
  }

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
      const decision = this.lastUpdatedTracker.consume(path);
      if (!this.settings.autoUpdateLastUpdated) return;
      if (decision === 'handSet') {
        this.host.notify(
          'info',
          this.t(
            'Kept the last_updated_date you set by hand in {0}. It updates automatically again from tomorrow.',
            posix.basename(path)
          )
        );
        return;
      }
      if (decision !== 'stamp') return;
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
      name: this.paletteName('Open workflow view'),
      callback: () => void this.activateView(WORKFLOW_VIEW_TYPE),
    });
    this.addCommand({
      id: 'open-sample-view',
      name: this.paletteName('Open sample view'),
      callback: () => void this.activateView(SAMPLE_VIEW_TYPE),
    });
    this.addCommand({
      id: 'open-user-guide',
      name: this.paletteName('Open user guide'),
      callback: () =>
        void openUserGuide(this.host, this.manifest.version, (path, content) =>
          writeNoteThroughVault(this.app, this.host, path, content)
        ),
    });
  }

  /** Reveal (or create) a sidebar leaf hosting the given view type. */
  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: viewType, active: true });
    }
    await workspace.revealLeaf(leaf);
    // Arrow keys should move in the tree right away, not in the editor (#197).
    const view = leaf.view;
    if (view instanceof WorkflowTreeView || view instanceof SampleTreeView) view.focusTree();
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
    const sampleIds = new SampleIdIndex(this.fs, {
      globalFolder: () => this.settings.globalSampleFolder,
      types: () => getSampleDisplayMeta(this.settings.customSampleTypes).types,
      onChange: () => this.redrawSampleHighlights(),
    });
    this.sampleIds = sampleIds;
    const missingTitle = this.t('Not in the sample registry');
    const staleAliasTitle = (alias: string): string => this.t('The registry calls this sample {0}', alias);
    const discardedTitle = (date: string): string => this.t('Marked discarded on {0}', date);
    const getState = (path: string | undefined): HighlightState => {
      const tracked = this.sampleTrackingFor(path);
      const base: HighlightState = tracked
        ? getSampleDisplayMeta(this.settings.customSampleTypes)
        : { types: [], colors: {} };
      const known = tracked ? sampleIds.knownFor(path) : undefined;
      const samples: HighlightState = known
        ? {
            ...base,
            knownIds: known.ids,
            sampleVersion: known.version,
            missingTitle,
            knownAliases: known.aliases,
            staleAliasTitle,
            discardedIds: known.discarded,
            discardedTitle,
          }
        : base;
      const others = markers.othersFor(path);
      return others
        ? { ...samples, otherMarkerIds: others.ids, markerVersion: others.version, duplicateTitle }
        : samples;
    };
    this.registerIssueMarkerIndex(markers);
    // Sample JSON written by the plugin arrives through `refreshSampleViews`;
    // these catch registries changed outside it, such as by a git pull.
    const jsonChanged = (path: string): void => sampleIds.fileChanged(path);
    this.registerEvent(this.app.vault.on('modify', file => jsonChanged(file.path)));
    this.registerEvent(this.app.vault.on('create', file => jsonChanged(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => jsonChanged(file.path)));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        jsonChanged(oldPath);
        jsonChanged(file.path);
      })
    );
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
    this.sampleIds?.invalidate();
  }

  /**
   * The sample registry changed on disk: drop the autocomplete cache so the
   * new records show up at once, and redraw the sidebar.
   */
  samplesChanged(): void {
    this.sampleSuggest?.clearCache();
    this.refreshSampleViews();
  }

  /** Refresh any open workflow view(s), which read the catalogs only when refreshed. */
  refreshWorkflowViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WORKFLOW_VIEW_TYPE)) {
      if (leaf.view instanceof WorkflowTreeView) void leaf.view.refresh();
    }
  }

  /**
   * Redraw sample highlighting after the registries were read (#210). Editors
   * redraw on `updateOptions`; reading view renders once, so lab notes shown
   * there are rendered again.
   */
  private redrawSampleHighlights(): void {
    this.app.workspace.updateOptions();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.getMode() === 'preview' && view.file?.path.endsWith('.labnote.md')) {
        view.previewMode.rerender(true);
      }
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

function markdownFilesIn(folder: TFolder): TFile[] {
  return folder.children.flatMap(child =>
    child instanceof TFolder ? markdownFilesIn(child) : child instanceof TFile && child.extension === 'md' ? [child] : []
  );
}
