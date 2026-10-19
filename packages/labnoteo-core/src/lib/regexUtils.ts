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

/** Code points a generated name part keeps; long titles otherwise exceed OS path limits (#148). */
export const PATH_SEGMENT_MAX = 100;

/**
 * Cut a sanitized name part to `max` code points (never splitting a surrogate
 * pair) and drop the separators the cut leaves at its end. Shorter input is
 * returned unchanged.
 */
export function capPathSegment(segment: string, max: number = PATH_SEGMENT_MAX): string {
  const chars = Array.from(segment);
  if (chars.length <= max) return segment;
  return chars.slice(0, max).join('').replace(/[_.-]+$/, '');
}

/**
 * Whether a file-system error comes from a name or path that is too long
 * (#148): `ENAMETOOLONG`, or — as Windows reports it — `ENOENT` for a path
 * past its 260-character limit or with a part longer than {@link PATH_SEGMENT_MAX}.
 */
export function isPathTooLongError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message, path } = err as { code?: unknown; message?: unknown; path?: unknown };
  if (code === 'ENAMETOOLONG') return true;
  if (code !== 'ENOENT') return false;
  const p = typeof path === 'string' ? path : (/'([^']+)'/.exec(String(message ?? ''))?.[1] ?? '');
  return p.length >= 260 || p.split(/[\\/]/).some(part => Array.from(part).length > PATH_SEGMENT_MAX);
}
