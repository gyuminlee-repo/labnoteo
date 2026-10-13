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
 * Uses the Unicode property escapes (`\p{L}\p{N}`) so non-ASCII names (Korean,
 * CJK, accented Latin, …) survive intact. This is the SINGLE rule shared by both
 * the experiment folder-name and the workflow file-name builders, which used to
 * disagree (`[^\w\u3131-\uD79D_]` vs `[^\p{L}\p{N}_]u`) and could produce
 * mismatched folder/file names for the same title in one vault.
 */
export function sanitizePathSegment(input: string): string {
  // Private-use placeholders that shield the sign (and the decimal point) from
  // symbol stripping, separator merging and edge trimming. No lookbehind: the
  // plugin also runs on mobile WebViews.
  const SIGN = '\uE000';
  const DOT = '\uE001';
  return input
    .replace(/[\uE000\uE001]/g, '')
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
