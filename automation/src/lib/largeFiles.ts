/**
 * largeFiles — large-file guard for a research vault.
 *
 * Backs the zero-dependency `scripts/check-large-files.mjs` the plugin scaffolds
 * into a vault, and is also called by `validate` as its central size re-check.
 * It scans the repo and classifies files by size so bulky raw data never lands
 * in Git history:
 *
 *   - `< 10 MB`  → ok
 *   - `10–50 MB` → warn (printed, does not fail)
 *   - `> 50 MB`  → block (non-zero exit)
 *
 * It never moves or deletes anything; blocking is deliberate so a researcher
 * decides where large data belongs (NAS/object storage linked by EXP-ID).
 *
 * Zero runtime deps (node built-ins only) so the built `.mjs` runs on any vault
 * with `node` — no `npm install` in the vault. The classification is a pure
 * function (`classifyFileSize`) kept separate for unit testing.
 */
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { gitPaths } from './git';

/** Size thresholds in bytes. */
export const WARN_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB
export const BLOCK_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Outcome of classifying a single file by its byte size. */
export type SizeClass = 'ok' | 'warn' | 'block';

/**
 * Pure size classifier — the single source of truth for the thresholds.
 *
 *   - `< 10 MB`       → `'ok'`
 *   - `10 MB–50 MB`   → `'warn'`  (inclusive of the 10 MB boundary)
 *   - `> 50 MB`       → `'block'`
 *
 * Kept side-effect free so it can be unit-tested without touching the FS.
 */
export function classifyFileSize(bytes: number): SizeClass {
  if (bytes > BLOCK_THRESHOLD_BYTES) return 'block';
  if (bytes >= WARN_THRESHOLD_BYTES) return 'warn';
  return 'ok';
}

/** Human-readable MB, one decimal. */
function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** A scanned file plus its size and classification. */
interface ScannedFile {
  file: string;
  bytes: number;
  cls: SizeClass;
}

/**
 * Resolve the candidate file list. Prefers Git (tracked + staged), which keeps
 * the scan aligned with repository paths. Falls back to walking the working
 * tree (excluding `.git` and `node_modules`) when Git is unavailable or this
 * is not a repository.
 */
function collectFiles(): string[] {
  try {
    const tracked = gitPaths(['ls-files']);
    const staged = gitPaths(['diff', '--cached', '--name-only', '--diff-filter=ACM']);
    return unique([...tracked, ...staged]);
  } catch {
    // Not a git repo (or git missing): walk the working tree instead.
    return walk('.');
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

const IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** Recursively list files under `dir`, skipping VCS/dependency folders. */
function walk(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      results.push(...walk(path.join(dir, entry.name)));
    } else if (entry.isFile()) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/** Stat + classify every candidate file (missing/unreadable files are skipped). */
function scan(files: string[]): ScannedFile[] {
  const scanned: ScannedFile[] = [];
  for (const file of files) {
    let bytes: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      // A listed path that cannot be stat'd is skipped, but never in silence:
      // a size guard that quietly checks nothing is worse than a noisy one.
      console.warn(`⚠️  크기를 확인할 수 없어 건너뜁니다: ${file}`);
      continue;
    }
    scanned.push({ file, bytes, cls: classifyFileSize(bytes) });
  }
  return scanned;
}

/** Read the exact staged objects; disabling rename detection includes every destination. */
function scanStaged(): ScannedFile[] {
  const entries = gitPaths([
    'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--diff-filter=ACMT',
  ]);
  const scanned: ScannedFile[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const [, mode, , oid] = entries[i].split(' ');
    if (mode === '160000') continue; // A gitlink names a commit in another repository, not a blob.
    const bytes = Number(execFileSync('git', ['cat-file', '-s', oid], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    scanned.push({ file: entries[i + 1], bytes, cls: classifyFileSize(bytes) });
  }
  return scanned;
}

/**
 * Run the guard. Returns the process exit code (0 = ok/warn only, 1 = blocked).
 * The caller decides what to do with it: `check-large-files.ts` forwards it to
 * `process.exit`, `validate.ts` folds it into its own result.
 */
export function run(argv: string[] = process.argv.slice(2)): number {
  const stagedOnly = argv.includes('--staged');
  let scanned: ScannedFile[];
  try {
    scanned = stagedOnly ? scanStaged() : scan(collectFiles());
  } catch {
    console.error('❌ staged blob 크기를 확인할 수 없어 커밋을 차단합니다.');
    return 1;
  }

  const blocked = scanned.filter(s => s.cls === 'block');
  const warned = scanned.filter(s => s.cls === 'warn');

  for (const w of warned) {
    console.warn(`⚠️  큰 파일 (${toMb(w.bytes)} MB): ${w.file}`);
  }

  if (blocked.length === 0) {
    if (warned.length > 0) {
      console.warn(
        `\n${warned.length}개 파일이 10 MB를 초과합니다. 원시 데이터라면 별도 스토리지 보관을 권장합니다.`
      );
    }
    return 0;
  }

  console.error('\n❌ 커밋 차단: 50 MB를 초과하는 파일이 있습니다.');
  for (const b of blocked) {
    console.error(`   - ${b.file} (${toMb(b.bytes)} MB)`);
  }
  console.error(
    '\n대용량 원시 데이터(시퀀싱/이미지/계측 데이터 등)는 Git에 올리지 마세요.\n' +
      'NAS·오브젝트 스토리지 등 별도 저장소에 두고 연구노트에서 EXP-ID로 링크하세요.\n' +
      '(.gitignore에 데이터 패턴을 추가하면 실수로 스테이징되는 것을 예방할 수 있습니다.)'
  );
  return 1;
}
