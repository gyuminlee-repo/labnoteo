/**
 * @labnoteo/core — platform-neutral core entry (browser + node safe).
 *
 * This entry MUST NOT import Node-only APIs (fs, path, child_process): the
 * Obsidian plugin bundles it for a renderer process that also has to run on
 * mobile, where none of those exist. Anything platform-specific belongs behind
 * a port (`LabnoteFs`, `LabnoteHost`) that the host implements.
 */

// === Surgical unit-op TOC edits (whitespace-preserving; used by the Obsidian
// insert-unit-operation flow) ===
export {
  buildUnitOpTocLine,
  appendUnitOpToWorkflowToc,
  rebuildUnitOpToc,
  refreshUnitOpTocEntries,
  locateInsertedUnitOpHeading,
  findUnitOpInsertOffset,
  findUnitOpInsertPointAt,
  type UnitOpInsertPoint,
  minimalReplacement,
  computeUnitOpSyncEdits,
  pruneUnitOpTocEntries,
  isUnitOpSectionTitle,
  applyTextEdits,
  type TextEdit,
} from './sections/workflowSectionParser';

// Obsidian Outline drag: reproduce its splice and undo the nesting it causes.
export {
  simulateOutlineHeadingMove,
  fixOutlineDropNesting,
  type OutlineHeading,
} from './sections/outlineMove';

// Re-exported from the dependency-free heading module so browser consumers
// (webview) get the normalizer without pulling js-yaml into their bundle.
export { normalizeWorkflowUnitSectionHeading } from './sections/unitOpHeading';

// Non-lossy single-section edit (LLM tools + edit-adjacent commands).
export {
  replaceSectionBody,
  replaceSectionBodyAt,
  findSectionMatches,
  diffBodyLines,
  type SectionEditResult,
  type SectionMatch,
} from './sections/sectionEdit';

// Where an AI-written block goes: a unit operation's Method body, or its own
// block after the cursor's line (#48).
export {
  findUnitOpMethodAt,
  findUnitOpMethodByIndex,
  listUnitOpMethods,
  cleanMethodDraft,
  extractMethodBody,
  planBlockInsert,
  type UnitOpMethodLocation,
  type BlockInsert,
} from './sections/blockInsert';

// Whether a note holds results, so the AI summary stops instead of inventing
// them (#257).
export {
  extractResultSections,
  hasRecordedResults,
  shareBudget,
  stripAiCallouts,
  maskAiCallouts,
  stripTemplatePlaceholders,
  dropEchoedLines,
} from './lib/noteResults';
export {
  findAiCalloutInSection,
  locateSummary,
  planSectionAppend,
  sectionText,
  type SummaryPlace,
} from './sections/summaryInsert';

// Scanned worksheet pages filed under each unit operation.
export {
  WORKSHEET_SCANS_HEADING,
  listUnitOpBlocks,
  findSameAliasUnitOp,
  resolveScanTarget,
  insertScanEntries,
  removeScanEntry,
  removeAllScanEntries,
  listScanHashes,
  listFiledScans,
  renderScanEntry,
  type FiledScan,
  type UnitOpBlock,
  type ScanEntry,
  type ScanTarget,
} from './sections/scanInsert';

// Front-matter primitives (YAML parse + per-entry serialize). Shared by plugin
// commands that read/rewrite README frontmatter (e.g. the status command).
export {
  copyFrontMatterKeys,
  frontMatterNames,
  parseFrontMatterYaml,
  serializeFrontMatterEntry,
  setFrontMatterKeys,
  stripFrontMatter,
  planDateInsertion,
  type DateInsertion,
} from './sections/frontMatter';
export { isInFrontMatter, isOffsetBeforeBody } from './sections/documentHead';

// === Experiment status vocabulary + validation ===============================
// Single source of the controlled `status` terms; consumed by the plugin status
// picker and (once published) the vault-repo validate/issue-sync automation.
export {
  EXPERIMENT_STATUSES,
  isValidStatus,
  type ExperimentStatus,
} from './lib/experimentStatus';

// === `discuss` flag ==========================================================
// Single source of the "needs team discussion" signal, shared by the plugin's
// toggle command and the automation that promotes flagged notes to Issues.
export { DISCUSS_FLAG_KEY, isDiscussFlagged, setDiscussFlag } from './lib/discussFlag';

// === `@issue` markers ========================================================
// Point-level discussion signal. Shared by the plugin insert command, the
// automation that promotes markers to Issues, and the validator that reports
// broken ones — one grammar, three callers.
export {
  ISSUE_MARKER_KEYWORD,
  ISSUE_MARKER_ID_PREFIX,
  parseIssueMarkers,
  findIssueMarkerRanges,
  markerSpanAcrossRuns,
  type InlineRun,
  fencedCodeRanges,
  codeBlockRanges,
  commentRanges,
  codeSpanRanges,
  markerHiddenRanges,
  generateIssueMarkerId,
  resetIssueMarkerIdCounter,
  renderIssueMarker,
  planIssueMarkerInsertion,
  issueSentenceRange,
  lineHasSampleReference,
  reassignIssueMarkerIds,
  stripIssueMarkers,
  neutralizeIssueMarkers,
  findEnclosingHeading,
  type IssueMarkerInsertion,
  type IssueMarker,
  type MalformedIssueMarker,
  type IssueMarkerScan,
  type IssueMarkerRange,
} from './lib/issueMarker';

// === Transport-agnostic domain tool set (MCP server + built-in AI commands) ===
export {
  createLabnoteTools,
  runTool,
  type ToolDef,
  type ToolContext,
  type ToolResult,
  type ToolPreview,
  type SectionEditPreview,
  type SampleCreatePreview,
  type WorkflowCreatePreview,
  type JsonSchema,
} from './tools';

// === Host abstraction (platform services for command logic) ===
export type {
  LabnoteHost,
  EditTarget,
  PickItem,
  PromptOpts,
  PromptHint,
  NotifyKind,
} from './host';

// === Shared command logic (host-driven; consumed by both platforms) ===
export {
  insertUnitOperation,
  unitOpInsertPointAtCursor,
  workflowPathProblem,
  type InsertUnitOperationInput,
} from './commands/insertUnitOperation';

// === i18n (shared translator; Obsidian t() shim, VS Code keeps native l10n) ===
export {
  createTranslator,
  formatMessage,
  type Translator,
} from './i18n/translator';

// === Sample autocomplete + highlighting (VS Code provider + Obsidian suggest) ===
export {
  parseSampleTrigger,
  buildSampleCompletionEntries,
  buildSampleCompletionLabel,
  buildSampleInsertText,
  findSampleIdRanges,
  findSampleReferenceAt,
  staleSampleAliasEnd,
  type SampleTrigger,
  type SampleCandidate,
  type SampleCompletionEntry,
  type SampleIdRange,
  type SampleReferenceAt,
} from './sample/sampleSuggest';

// === Sample reference insertion placement (Obsidian sidebar/right-click) ===
export {
  planReferenceInsert,
  type ReferenceInsert,
} from './sample/referenceInsert';

// === Sample storage-location provider seam (local now; partbank-ready) ===
export {
  LocalSampleLocationProvider,
  type SampleLocationProvider,
  type SampleLocationQuery,
} from './sample/sampleLocationProvider';

// === partbank link model (which external item a sample stands for) ===
export {
  PARTBANK_TYPES,
  isPartbankType,
  normalizeOrigin,
  isDesktopOrigin,
  normalizeSampleSource,
  isSameSampleSource,
  type PartbankType,
  type PartbankConnection,
  type SampleSource,
} from './partbank/types';
export {
  STRAIN_SAMPLE_TYPE,
  resourceSegment,
  webAppPath,
  desktopAppLink,
  typeFromSearchEntity,
  searchEntityForType,
  searchEntitiesForSampleType,
  searchScopeLabel,
  searchScopeHint,
  sampleTypeForItem,
  aliasForItem,
  descriptionForItem,
  sourceForItem,
  formatStockLocation,
  findLinkedSample,
  type PartbankSearchEntity,
  type PartbankItem,
  type PartbankStock,
  type LinkedSample,
} from './partbank/mapping';

// === Platform-neutral tree model (VS Code providers + Obsidian ItemViews) ===
export {
  buildExperimentTree,
  buildWorkflowTree,
  buildSampleTree,
  filterSampleTree,
  filterExperiments,
  linkRetries,
  type ExperimentGrouping,
  type TreeNode,
  type TreeNodeKind,
  type ExperimentEntry,
  type ExperimentTreeLabels,
  type WorkflowTreeData,
  type WorkflowTreeLabels,
  type SampleScope,
  type SampleTreeRoots,
  type SampleTreeLabels,
} from './tree/treeModel';

// === File-system port (platform-neutral interface; implementations are per-host) ===
export type { LabnoteFs } from './fs/labnoteFs';
// In-memory implementation for tests (browser + node safe; no fs import).
export { MemFileSystem } from './fs/memFileSystem';

// === Bundled default catalogs (browser-safe pure data; tree-shaken from webview) ===
export {
  WORKFLOWS_CATALOG,
  UNIT_OPERATIONS_HW_CATALOG,
  UNIT_OPERATIONS_SW_CATALOG,
  CATALOG_FILE_NAMES,
} from './catalog';
export {
  CATALOG_KO,
  CATALOG_KO_RETIRED,
  catalogDescriptionFor,
  catalogKoEntry,
  type CatalogKoEntry,
} from './catalog/catalogKo';
export { CATALOG_KO_DESCRIPTIONS } from './catalog/catalogKoDescriptions';
export { EARLIER_BUNDLED, RETIRED_BUNDLED, ADDED_BUNDLED_IDS } from './catalog/earlierBundled';
export {
  CATALOG_FILE_SPECS,
  BUNDLED_CATALOG_HISTORY,
  parseCatalogFile,
  planCatalogUpdate,
  applyCatalogUpdate,
  isCatalogPlanEmpty,
  type CatalogField,
  type CatalogListKey,
  type CatalogFileSpec,
  type CatalogHistory,
  type CatalogUpdatePlan,
  type BundledCatalogItem,
  type ParsedCatalogFile,
} from './catalog/catalogUpdate';
export type {
  WorkflowItem,
  WorkflowJson,
  UnitOperationItem,
  UnitOperationJson,
} from './catalog';
