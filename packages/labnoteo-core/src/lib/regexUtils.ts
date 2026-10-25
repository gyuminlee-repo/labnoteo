/**
 * Regex utilities shared across the extension.
 *
 * Keep this module dependency-free so it can be imported by both the Node
 * extension host and (if needed) webview bundles.
 */

/**
 * Escape a string so it can be safely embedded inside a RegExp source and
 * matched as a literal. This is required any time we build a regex from a
 * user-controlled or document-derived string (sample alias, sample id, etc.)
 * — otherwise a `.` or `(` in the input would change the regex meaning and
 * cause incorrect matches or, in the worst case, a syntax error.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise an arbitrary title/name into a single safe path segment: collapse
 * whitespace to `_`, keep hyphens, drop anything else that is not a Unicode
 * letter/number/`_`, and trim redundant separators.
 *
 * Dashes (`–`, `—`, …), the minus sign (`−`) and range tildes (`~`, `～`) become an ASCII `-`, so a
 * range like `M1–M8` stays readable as `M1-M8` instead of collapsing to `M1M8`.
 * A separator run containing a hyphen (`M1 – M8` → `M1_-_M8`) is reduced to a
 * single `-`.
 *
 * A minus sign — a dash right before a digit and not after a letter or digit —
 * is kept together with the separator before it, so `냉동고 -20°C` becomes
 * `냉동고_-20C` and `−80°C 보관` becomes `-80C_보관` instead of reading as +80.
 *
 * A decimal point between digits is kept (`OD600 0.4~0.8` → `OD600_0.4-0.8`,
 * `37.5°C` → `37.5C`). Any other symbol run between digits must not simply
 * vanish, or two numbers fuse into a different one (`3×2` → `32`):
 * - a multiplication sign becomes `x`, like the ASCII form (`3×2` → `3x2`);
 * - a thousands comma — followed by exactly three digits — is dropped, since
 *   the value is unchanged (`2,500` → `2500`). A three-digit decimal comma
 *   (`1,500` meaning 1.5) is read the same way; other lengths are not
 *   (`0,4` → `0_4`);
 * - everything else becomes `_` (`pH 7.0/8.0` → `pH_7.0_8.0`, `1:10` → `1_10`,
 *   `37±2` → `37_2`, `5%/10%` → `5_10`).
 * Not between digits, these symbols are dropped (`A/B` → `AB`).
 *
 * A `+` or `-` ending a word right after a letter or digit is a sign that
 * tells two things apart (`IND+` vs `IND-`), so it is spelled out as `_plus`
 * / `_minus` instead of being dropped or trimmed into the same name (#165).
 *
 * Uses the Unicode property escapes (`\p{L}\p{N}`) so non-ASCII names (Korean,
 * CJK, accented Latin, …) survive intact. This is the SINGLE rule shared by both
 * the experiment folder-name and the workflow file-name builders, which used to
 * disagree (`[^\w\u3131-\uD79D_]` vs `[^\p{L}\p{N}_]u`) and could produce
 * mismatched folder/file names for the same title in one vault.
 */
export function sanitizePathSegment(input: string): string {
  return sanitizeSegment(
    input
      .replace(/[\uE000\uE001]/g, '')
      .replace(/([\p{L}\p{N}])[+\uFF0B](?![\p{L}\p{N}])/gu, '$1 plus ')
      .replace(/([\p{L}\p{N}])[-\u2212](?![\p{L}\p{N}\-\u2212\u2013\uFF0D])/gu, '$1 minus ')
  );
}

/**
 * {@link sanitizePathSegment} as it was before word-ending `+`/`-` were
 * spelled out (#165): names made then are compared with it so existing files
 * still match their titles and checklist labels.
 */
export function legacySanitizePathSegment(input: string): string {
  return sanitizeSegment(input.replace(/[\uE000\uE001]/g, ''));
}

function sanitizeSegment(input: string): string {
  // Private-use placeholders that shield the sign (and the decimal point) from
  // symbol stripping, separator merging and edge trimming. No lookbehind: the
  // plugin also runs on mobile WebViews.
  const SIGN = '\uE000';
  const DOT = '\uE001';
  return input
    .replace(/(^|[^\p{L}\p{N}])[-\u2212\u2013\uFF0D](?=\d)/gu, `$1${SIGN}`)
    .replace(/(\d)\.(?=\d)/g, `$1${DOT}`)
    .replace(/(\d)\s*\u00D7\s*(?=[\d\uE000])/g, '$1x')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\s*[^\p{L}\p{N}\s_\uE000\uE001\p{Pd}\u2212~\uFF5E]+\s*(?=[\d\uE000])/gu, '$1_')
    .replace(/[\p{Pd}\u2212~\uFF5E]/gu, '-')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_\uE000\uE001-]/gu, '')
    .replace(/[_-]*-[_-]*/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/\uE000/g, '-')
    .replace(/\uE001/g, '.');
}

/**
 * Code points the title part of an experiment folder name keeps; `NNN_` comes
 * on top (#148). With {@link WORKFLOW_FILE_NAME_MAX} this keeps a workflow's
 * path inside the vault near 170 characters, so a vault folder of up to about
 * 85 characters stays within Windows' 260.
 */
export const EXPERIMENT_FOLDER_TITLE_MAX = 60;

/**
 * Code points the `ID_name_alias` part of a workflow file name keeps; `NNN_`
 * and `.labnote.md` come on top (#148).
 */
export const WORKFLOW_FILE_NAME_MAX = 80;

/** The longest file or folder name the common file systems take. */
export const FS_NAME_MAX = 255;

/** Windows' classic path limit: a path this long or longer fails there. */
export const WINDOWS_PATH_MAX = 260;

/**
 * The longest path, drive, folders and extension included, Excel opens (#348):
 * a CSV past it does not open even with Windows' long paths turned on.
 */
export const EXCEL_PATH_MAX = 218;

/**
 * Cut a sanitized name part to `max` code points (never splitting a surrogate
 * pair) and drop the separators the cut leaves at its end. Shorter input is
 * returned unchanged.
 */
export function capPathSegment(segment: string, max: number): string {
  const chars = Array.from(segment);
  if (chars.length <= max) return segment;
  return chars.slice(0, max).join('').replace(/[_.-]+$/, '');
}

/**
 * Whether a file-system error comes from a name or path that is too long
 * (#148): `ENAMETOOLONG`, or — as Windows reports it — `ENOENT` for a path
 * past {@link WINDOWS_PATH_MAX} or with a part longer than {@link FS_NAME_MAX}.
 * Judged by the file-system limits, not the shorter caps names are made with,
 * so a missing file with an older, longer name is not reported as too long.
 */
export function isPathTooLongError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message, path } = err as { code?: unknown; message?: unknown; path?: unknown };
  if (code === 'ENAMETOOLONG') return true;
  if (code !== 'ENOENT') return false;
  const p = typeof path === 'string' ? path : (/'([^']+)'/.exec(String(message ?? ''))?.[1] ?? '');
  return p.length >= WINDOWS_PATH_MAX || p.split(/[\\/]/).some(part => Array.from(part).length > FS_NAME_MAX);
}

/**
 * Length of `vaultPath` on disk once the vault's own folder `basePath` is put
 * in front, in UTF-16 units as Windows counts them (#148).
 */
export function fullPathLength(basePath: string, vaultPath: string): number {
  const base = basePath.replace(/[\\/]+$/, '');
  return base ? base.length + 1 + vaultPath.length : vaultPath.length;
}

/** Why a vault folder path cannot be made on some OS; see {@link invalidVaultFolderReason}. */
export type InvalidFolderReason =
  | { kind: 'empty' }
  | { kind: 'chars'; chars: string }
  | { kind: 'parent' }
  | { kind: 'trailing'; part: string }
  | { kind: 'reserved'; part: string };

const FOLDER_FORBIDDEN_RE = /[<>:"|?*\u0000-\u001f]/g;
const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * Why `path` (vault-relative, `/`-separated) cannot be a folder on every OS
 * the vault is shared to (#328), or undefined when it can. Windows is the
 * strictest: no `<>:"|?*` or control characters, no part ending in a dot or
 * a space, no reserved device names such as `CON` or `COM1`. Empty parts
 * (`a//b`) and `..` are refused too. One leading or trailing `/` is allowed.
 */
export function invalidVaultFolderReason(path: string): InvalidFolderReason | undefined {
  const trimmed = path.trim().replace(/^\/|\/$/g, '');
  if (!trimmed) return { kind: 'empty' };
  const chars = [...new Set(trimmed.match(FOLDER_FORBIDDEN_RE) ?? [])];
  if (chars.length > 0) return { kind: 'chars', chars: chars.join('') };
  for (const part of trimmed.split(/[\\/]/)) {
    if (part === '' || part === '.' || part === '..') return { kind: 'parent' };
    if (/[. ]$/.test(part)) return { kind: 'trailing', part };
    if (RESERVED_NAME_RE.test(part)) return { kind: 'reserved', part };
  }
  return undefined;
}
