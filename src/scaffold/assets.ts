/**
 * Scaffold asset registry — the single list of files the "연구노트 자동화 설정"
 * command provisions into the current vault.
 *
 * Each asset's `content` is imported as a string via esbuild's `text` loader
 * (see `esbuild.config.mjs`), so the built automation `.mjs` and the static
 * templates are embedded directly into `main.js`. That is what makes a 3-file
 * install (main.js / manifest.json / styles.css) self-sufficient: no separate
 * `.mjs` assets need to ship to the plugin folder.
 *
 * Extending is intentionally trivial: author the source under `automation/`
 * (add script entry points to `AUTOMATION_ENTRYPOINTS` in the esbuild config),
 * import the built string here, and append a `ScaffoldAsset`.
 */
// Stage-1 build output (dist-automation) — embedded as text.
import checkLargeFilesScript from '../../dist-automation/check-large-files.mjs';
import validateScript from '../../dist-automation/validate.mjs';
import issueSyncScript from '../../dist-automation/issue-sync.mjs';
// Static templates — embedded as text.
import gitignoreSnippet from '../../automation/templates/gitignore.snippet';
import preCommitHook from '../../automation/templates/pre-commit.sh';
import setupReadme from '../../automation/templates/SETUP.md';
import quickstartDoc from '../../automation/templates/QUICKSTART.md';
// AI agent rules (single source for the local-agent AI workflow) — installed as
// a managed block inside the vault's AGENTS.md so user rules are preserved.
import agentsRules from '../../automation/templates/AGENTS.md';
// Workflow templates (Phase 3–5).
import validateWorkflow from '../../automation/templates/validate.yml';
import experimentIssuesWorkflow from '../../automation/templates/experiment-issues.yml';
import wikiSyncWorkflow from '../../automation/templates/wiki-sync.yml';
// Issue template (Phase 4a).
import experimentIssueTemplate from '../../automation/templates/experiment.md';
// Living Manuscript Wiki skeleton (Phase 5) — staged proposals live here.
import wikiHome from '../../automation/templates/wiki/Home.md';
import wikiAbstract from '../../automation/templates/wiki/Abstract.md';
import wikiIntroduction from '../../automation/templates/wiki/Introduction.md';
import wikiResearchQuestions from '../../automation/templates/wiki/Research-Questions.md';
import wikiMethods from '../../automation/templates/wiki/Methods.md';
import wikiResults from '../../automation/templates/wiki/Results.md';
import wikiDiscussion from '../../automation/templates/wiki/Discussion.md';
import wikiLimitations from '../../automation/templates/wiki/Limitations.md';
import wikiFutureWork from '../../automation/templates/wiki/Future-Work.md';
import wikiEvidenceIndex from '../../automation/templates/wiki/Evidence-Index.md';
import wikiReferences from '../../automation/templates/wiki/References.md';

/**
 * How to reconcile an asset with a pre-existing vault file:
 *  - `overwrite` (default): replace, but only after the user confirms.
 *  - `append-missing`: keep the file, append only lines it does not already
 *    contain (used for `.gitignore` so user patterns are preserved).
 *  - `managed-block`: keep the file, insert/refresh only the labnoteo-managed
 *    marker block (used for `AGENTS.md` so user rules outside the markers are
 *    preserved and re-runs stay idempotent).
 */
export type ScaffoldMergeStrategy = 'overwrite' | 'append-missing' | 'managed-block';

/** Markers delimiting the labnoteo-managed block inside shared files (AGENTS.md). */
export const MANAGED_BLOCK_BEGIN = '<!-- BEGIN labnoteo (managed) -->';
export const MANAGED_BLOCK_END = '<!-- END labnoteo (managed) -->';

/** A single file the scaffold command writes into the vault. */
export interface ScaffoldAsset {
  /** Vault-relative POSIX path (VaultFileSystem creates parent dirs). */
  vaultPath: string;
  /** File contents (embedded string). */
  content: string;
  /** Reconciliation strategy when the file already exists. Default `overwrite`. */
  merge?: ScaffoldMergeStrategy;
}

/**
 * Container for everything the researcher never needs to open. The dot prefix
 * hides it from Obsidian's file explorer, search and graph, which is the point:
 * the vault root stays notes (`labnote/`), manuscript (`wiki-staging/`) and the
 * two docs people actually read (`QUICKSTART.md`, `AGENTS.md`).
 */
export const LABNOTEO_DIR = '.labnoteo';

/** Hook directory, used verbatim as the `git config core.hooksPath` argument. */
export const HOOKS_DIR_PATH = `${LABNOTEO_DIR}/hooks`;

/** Vault path of the admin/developer setup guide, surfaced in the completion notice. */
export const SETUP_DOC_PATH = `${LABNOTEO_DIR}/SETUP.md`;

/** Vault path of the researcher-facing quick-start guide, surfaced in the notice. */
export const QUICKSTART_DOC_PATH = 'QUICKSTART.md';

/**
 * The quick-start guide's embedded text. Exported on its own so "Open user
 * guide" can provide it without installing the Git automation.
 */
export const QUICKSTART_DOC_CONTENT: string = quickstartDoc;

/**
 * Vault path of the workflow that opens Issues from `@issue` markers and the
 * `discuss` flag; its presence is how the commands tell automation is set up.
 */
export const ISSUE_SYNC_WORKFLOW_PATH = '.github/workflows/experiment-issues.yml';

/**
 * Files earlier versions scaffolded at paths we no longer use. The setup command
 * offers to delete them once, so a vault upgraded from <=0.82.0 does not keep a
 * second, stale copy of every script.
 *
 * Two generations are covered: the pre-`.labnoteo/` layout (root `scripts/`,
 * `.githooks/`, `SETUP.md`) and the server-side AI gate assets dropped in
 * 0.81.0, which linger in vaults set up before then.
 */
export const LEGACY_ASSET_PATHS: string[] = [
  'scripts/check-large-files.mjs',
  'scripts/validate.mjs',
  'scripts/issue-sync.mjs',
  '.githooks/pre-commit',
  'SETUP.md',
  'scripts/issue-gate.mjs',
  'scripts/wiki-propose.mjs',
  'ai/prompts/issue-gate.md',
  'ai/prompts/wiki-propose.md',
  'ai/schemas/issue-gate.schema.json',
  'ai/schemas/wiki-propose.schema.json',
];

/**
 * Directories to drop after removing the files above, deepest first so a parent
 * is only considered once its children are gone. Removal is skipped for any
 * directory the user put something else into.
 */
export const LEGACY_DIRS: string[] = [
  'scripts',
  '.githooks',
  'ai/prompts',
  'ai/schemas',
  'ai',
];

/**
 * Blanket ignore lines that silently defeat the `!.../skills/` negations below:
 * once a directory itself is excluded Git never descends into it, so the
 * re-include cannot apply no matter the ordering. `append-missing` can only add
 * lines, so an upgraded vault keeps these until the user deletes them — the
 * setup command detects and warns about exactly these.
 */
export const STALE_IGNORE_LINES: string[] = ['.claude/', '.agents/'];

/**
 * Assets installed by the current phase (Phase 2c: large-file protection).
 * Append new entries here in later phases.
 */
export const SCAFFOLD_ASSETS: ScaffoldAsset[] = [
  // Phase 2c — large-file protection.
  { vaultPath: `${LABNOTEO_DIR}/scripts/check-large-files.mjs`, content: checkLargeFilesScript },
  { vaultPath: `${HOOKS_DIR_PATH}/pre-commit`, content: preCommitHook },
  { vaultPath: SETUP_DOC_PATH, content: setupReadme },
  { vaultPath: QUICKSTART_DOC_PATH, content: QUICKSTART_DOC_CONTENT },
  { vaultPath: '.gitignore', content: gitignoreSnippet, merge: 'append-missing' },

  // Phase 3 — deterministic validation.
  { vaultPath: `${LABNOTEO_DIR}/scripts/validate.mjs`, content: validateScript },
  { vaultPath: '.github/workflows/validate.yml', content: validateWorkflow },

  // Phase 4a — deterministic Experiment ↔ Issue.
  { vaultPath: `${LABNOTEO_DIR}/scripts/issue-sync.mjs`, content: issueSyncScript },
  { vaultPath: ISSUE_SYNC_WORKFLOW_PATH, content: experimentIssuesWorkflow },
  { vaultPath: '.github/ISSUE_TEMPLATE/experiment.md', content: experimentIssueTemplate },

  // AI agent rules — the local agent replaces the former self-hosted AI jobs:
  // it judges free-text discussion context (sets `discuss: true`) and drafts
  // facts into wiki-staging/, while issue-sync / wiki-sync stay the only
  // creators/publishers. AGENTS.md is the single source of those AI criteria.
  { vaultPath: 'AGENTS.md', content: agentsRules, merge: 'managed-block' },
  // Claude Code reads CLAUDE.md (not AGENTS.md); a one-line import keeps
  // AGENTS.md the single source without duplicating content.
  { vaultPath: 'CLAUDE.md', content: '@AGENTS.md\n', merge: 'append-missing' },

  // Phase 5 — Living Manuscript Wiki.
  { vaultPath: '.github/workflows/wiki-sync.yml', content: wikiSyncWorkflow },
  { vaultPath: 'wiki-staging/Home.md', content: wikiHome },
  { vaultPath: 'wiki-staging/Abstract.md', content: wikiAbstract },
  { vaultPath: 'wiki-staging/Introduction.md', content: wikiIntroduction },
  { vaultPath: 'wiki-staging/Research-Questions.md', content: wikiResearchQuestions },
  { vaultPath: 'wiki-staging/Methods.md', content: wikiMethods },
  { vaultPath: 'wiki-staging/Results.md', content: wikiResults },
  { vaultPath: 'wiki-staging/Discussion.md', content: wikiDiscussion },
  { vaultPath: 'wiki-staging/Limitations.md', content: wikiLimitations },
  { vaultPath: 'wiki-staging/Future-Work.md', content: wikiFutureWork },
  { vaultPath: 'wiki-staging/Evidence-Index.md', content: wikiEvidenceIndex },
  { vaultPath: 'wiki-staging/References.md', content: wikiReferences },
];
