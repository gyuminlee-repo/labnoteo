/**
 * "연구노트 자동화 설정" command — provisions the embedded automation assets
 * into the current vault via {@link LabnoteFs}.
 *
 * Thin Obsidian wiring over the {@link SCAFFOLD_ASSETS} registry: for each asset
 * it appends missing lines (merge `append-missing`, e.g. `.gitignore`), upserts
 * the labnoteo marker block (merge `managed-block`, e.g. `AGENTS.md`), or
 * writes the file, asking `host.confirm` before overwriting an existing file.
 * After writing it points researchers to `QUICKSTART.md` and admins to
 * `.labnoteo/SETUP.md` (with the one-time hook-enable step). The scaffold never
 * runs Git; the only paths it touches outside the registry are the known
 * leftovers in `LEGACY_ASSET_PATHS`, and only after the user confirms.
 */
import type { LabnoteHost } from '@labnoteo/core';
import {
  HOOKS_DIR_PATH,
  LEGACY_ASSET_PATHS,
  LEGACY_DIRS,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  QUICKSTART_DOC_PATH,
  SCAFFOLD_ASSETS,
  SETUP_DOC_PATH,
  STALE_IGNORE_LINES,
  type ScaffoldAsset,
} from './assets';

/**
 * Merge `snippet` into `existing`, appending only the (trimmed) lines that are
 * not already present. Pure so the reconciliation is predictable and testable;
 * comparison is whitespace-insensitive per line and blank lines are ignored.
 * Returns `existing` unchanged when nothing is missing.
 */
export function appendMissingLines(existing: string, snippet: string): string {
  const have = new Set(
    existing
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  );
  const missing = snippet.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return trimmed !== '' && !have.has(trimmed);
  });
  if (missing.length === 0) return existing;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}\n${missing.join('\n')}\n`;
}

/** Escape a literal string for use inside a RegExp (markers contain `(`,`)`,`-`). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert or refresh the labnoteo-managed marker block inside `existing`.
 * Pure so the reconciliation is predictable and testable:
 *  - block present → replace only the marker span (everything else preserved);
 *  - block absent → append it at the end;
 *  - empty file → the block becomes the whole content.
 * Applying the same `inner` twice yields the same output (idempotent).
 */
export function upsertManagedBlock(
  existing: string,
  inner: string,
  markers: { begin: string; end: string } = { begin: MANAGED_BLOCK_BEGIN, end: MANAGED_BLOCK_END }
): string {
  const wrapped = `${markers.begin}\n${inner.trim()}\n${markers.end}`;
  const span = new RegExp(`${escapeRegExp(markers.begin)}[\\s\\S]*?${escapeRegExp(markers.end)}`);
  if (span.test(existing)) return existing.replace(span, wrapped);
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${wrapped}\n`;
}

/**
 * Lines in `existing` that exactly match one of `stale` (compared trimmed).
 * Exact matching is the point: a substring test would also flag the `.claude/*`
 * and `!.claude/skills/` lines we just installed and warn on every single run.
 */
export function findStaleIgnoreLines(existing: string, stale: string[]): string[] {
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  );
  return stale.filter(line => present.has(line));
}

/** Outcome tallies for the completion notice. */
interface ScaffoldResult {
  written: number;
  merged: number;
  skipped: number;
  removed: number;
}

/** Same text, ignoring CRLF vs LF (Git may check templates out either way). */
function sameContent(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** Apply a single asset, returning which tally to bump. */
export async function applyAsset(
  host: LabnoteHost,
  asset: ScaffoldAsset
): Promise<keyof ScaffoldResult | undefined> {
  const exists = await host.fs.exists(asset.vaultPath);

  if (asset.merge === 'managed-block') {
    const current = exists ? await host.fs.read(asset.vaultPath) : '';
    const updated = upsertManagedBlock(current, asset.content);
    if (updated === current) return undefined; // block already up to date
    await host.fs.write(asset.vaultPath, updated);
    return exists ? 'merged' : 'written';
  }

  if (asset.merge === 'append-missing' && exists) {
    const current = await host.fs.read(asset.vaultPath);
    const updated = appendMissingLines(current, asset.content);
    if (updated === current) return undefined; // already complete
    await host.fs.write(asset.vaultPath, updated);
    return 'merged';
  }

  if (exists) {
    // Already up to date (e.g. QUICKSTART.md written by "Open user guide"):
    // nothing to overwrite, so do not ask.
    if (sameContent(await host.fs.read(asset.vaultPath), asset.content)) return undefined;
    const ok = await host.confirm(host.t('Overwrite {0}?', asset.vaultPath), {
      confirmLabel: host.t('Overwrite'),
    });
    if (!ok) return 'skipped';
  }

  await host.fs.write(asset.vaultPath, asset.content);
  return 'written';
}

/**
 * Delete leftovers from the pre-`.labnoteo/` layout, after a single
 * confirmation covering the whole set. Returns how many files went.
 *
 * The confirmation spells out the new `core.hooksPath` because removing
 * `.githooks/pre-commit` while the Git config still points there leaves Git
 * running no hook at all — large-file protection would switch off silently.
 */
async function removeLegacyAssets(host: LabnoteHost): Promise<number> {
  const present: string[] = [];
  for (const path of LEGACY_ASSET_PATHS) {
    if (await host.fs.exists(path)) present.push(path);
  }
  if (present.length === 0) return 0;

  const ok = await host.confirm(
    host.t(
      'Remove {0} file(s) left by the previous layout ({1})? Afterwards run `git config core.hooksPath {2}` so the pre-commit hook keeps working.',
      String(present.length),
      present.join(', '),
      HOOKS_DIR_PATH
    ),
    { confirmLabel: host.t('Remove') }
  );
  if (!ok) return 0;

  for (const path of present) await host.fs.remove(path);
  // Deepest first, so `ai/` is only considered once `ai/prompts` is gone.
  for (const dir of LEGACY_DIRS) await host.fs.rmdir(dir);
  return present.length;
}

/**
 * Whether the vault root is a git repository. The automation lives at the vault
 * root (`.github/`, `.labnoteo/`), so only a repository rooted there runs it.
 * `.git` may be a file (worktree) as well as a folder.
 */
export async function isVaultGitRepository(host: LabnoteHost): Promise<boolean> {
  return host.fs.exists('.git');
}

/**
 * Iterate the scaffold registry and provision each asset into the vault.
 */
export async function setupResearchAutomationCommand(host: LabnoteHost): Promise<void> {
  const result: ScaffoldResult = { written: 0, merged: 0, skipped: 0, removed: 0 };

  for (const asset of SCAFFOLD_ASSETS) {
    const tally = await applyAsset(host, asset);
    if (tally) result[tally] += 1;
  }

  result.removed = await removeLegacyAssets(host);

  host.notify(
    'info',
    host.t(
      'Research automation set up ({0} written, {1} merged, {2} skipped, {3} removed). Researchers: see {4}. Admin setup: {5} (run `git config core.hooksPath {6}`).',
      String(result.written),
      String(result.merged),
      String(result.skipped),
      String(result.removed),
      QUICKSTART_DOC_PATH,
      SETUP_DOC_PATH,
      HOOKS_DIR_PATH
    )
  );

  // Without a repository neither the hooks setting nor any push can happen, so
  // issues and checks stay off until the admin setup links one.
  if (!(await isVaultGitRepository(host))) {
    host.notify(
      'warn',
      host.t(
        'This vault is not a git repository yet, so issues and checks will not run. Finish the repository setup in {0}.',
        SETUP_DOC_PATH
      )
    );
  }

  // `.gitignore` merges by appending, so a vault upgraded from an older version
  // keeps the blanket `.claude/` / `.agents/` lines that stop agent skills from
  // ever being committed. Nothing visibly breaks, hence the explicit warning.
  if (await host.fs.exists('.gitignore')) {
    const stale = findStaleIgnoreLines(await host.fs.read('.gitignore'), STALE_IGNORE_LINES);
    if (stale.length > 0) {
      host.notify(
        'warn',
        host.t(
          'Delete these lines from .gitignore so agent skills can be committed: {0}',
          stale.join(', ')
        )
      );
    }
  }
}
