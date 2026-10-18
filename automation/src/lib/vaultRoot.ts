/**
 * Where a scaffolded script's vault is, so it can run from any working folder.
 *
 * The plugin installs the bundles as `<vault>/.labnoteo/scripts/*.mjs`, and
 * every check reads vault-relative paths (`labnote/`, the large-file scan). Run
 * from elsewhere — an AI agent following AGENTS.md from a parent folder (#129)
 * — those paths find nothing and the check passes on zero notes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The vault root of a script at `scriptPath` (a file path, `/` or `\`
 * separated), or undefined when it is not inside `.labnoteo/scripts/` — the
 * sources under `automation/src/` and this repo's `dist-automation/` bundles
 * are left to the working folder.
 */
export function vaultRootFromScript(scriptPath: string): string | undefined {
  const m = /^(.*)[\\/]\.labnoteo[\\/]scripts[\\/][^\\/]+$/.exec(scriptPath);
  if (!m) return undefined;
  const root = m[1];
  if (root === '') return '/';
  return /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
}

/** Whether `dir` looks like a vault the automation was set up in. */
export function isVaultRoot(dir: string): boolean {
  return existsSync(join(dir, '.labnoteo'));
}
