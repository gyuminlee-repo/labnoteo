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
  locateInsertedUnitOpHeading,
  findUnitOpInsertOffset,
  minimalReplacement,
  computeUnitOpSyncEdits,
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
  type SectionEditResult,
  type SectionMatch,
} from './sections/sectionEdit';

// Where an AI-written block goes: a unit operation's Method body, or its own
// block after the cursor's line (#48).
export {
  findUnitOpMethodAt,
  findUnitOpMethodByIndex,
  extractMethodBody,
  planBlockInsert,
  type UnitOpMethodLocation,
  type BlockInsert,
} from './sections/blockInsert';

// Front-matter primitives (YAML parse + per-entry serialize). Shared by plugin
// commands that read/rewrite README frontmatter (e.g. the status command).
export { parseFrontMatterYaml, serializeFrontMatterEntry } from './sections/frontMatter';

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
  generateIssueMarkerId,
  resetIssueMarkerIdCounter,
  renderIssueMarker,
  planIssueMarkerInsertion,
  issueSentenceRange,
  reassignIssueMarkerIds,
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
  type JsonSchema,
} from './tools';

// === Host abstraction (platform services for command logic) ===
export type {
  LabnoteHost,
  EditTarget,
  PickItem,
  PromptOpts,
  NotifyKind,
} from './host';

// === Shared command logic (host-driven; consumed by both platforms) ===
export {
  insertUnitOperation,
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

// === Platform-neutral tree model (VS Code providers + Obsidian ItemViews) ===
export {
  buildWorkflowTree,
  buildSampleTree,
  filterSampleTree,
  type TreeNode,
  type TreeNodeKind,
  type WorkflowTreeData,
  type SampleScope,
  type SampleTreeRoots,
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
export type {
  WorkflowItem,
  WorkflowJson,
  UnitOperationItem,
  UnitOperationJson,
} from './catalog';
