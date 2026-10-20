/**
 * The `discuss` front-matter flag — "this note needs team discussion".
 *
 * Deliberately separate from `status`: an experiment can be `in-progress` and
 * still need a decision, so flagging must not force a lifecycle change. The
 * flag is what the deterministic `issue-sync` automation promotes to a GitHub
 * Issue (alongside `status: needs-review`).
 *
 * Both readers live here so they cannot drift: the plugin's toggle command and
 * the vault automation must agree on what "flagged" means, or a note can look
 * flagged in Obsidian while the push quietly opens no issue.
 *
 * Domain-only: no Obsidian/Node APIs, so it bundles into the webview and is
 * reusable from the zero-dependency automation scripts.
 */

/** Front-matter key carrying the flag. */
export const DISCUSS_FLAG_KEY = 'discuss';

/** Values read as "flagged", compared trimmed and lower-cased. */
const ON_VALUES = new Set(['true', 'yes', 'y', 'on', '1', '예', '네']);
/** Values read as "not flagged" on purpose, so they draw no warning. */
const OFF_VALUES = new Set(['false', 'no', 'n', 'off', '0', '아니오', '아니요', '']);

/**
 * Whether front matter carries the discussion flag.
 *
 * Accepts the boolean `true` and the strings `true`, `yes`, `y`, `on`, `1`,
 * `예`, `네` (case-insensitive): YAML writers and hand edits both occur in
 * practice, and the same README's `sample_tracking` is written `yes`, so a
 * note reading `discuss: yes` should not silently fail to open an issue (#208).
 */
export function isDiscussFlagged(frontMatter: Record<string, unknown>): boolean {
  const raw = frontMatter[DISCUSS_FLAG_KEY];
  return raw === true || ON_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * The `discuss` value as written when it reads as neither on nor off (e.g.
 * `maybe`), else undefined, so validation can say it opens no issue (#208).
 */
export function unrecognizedDiscussValue(frontMatter: Record<string, unknown>): string | undefined {
  if (!(DISCUSS_FLAG_KEY in frontMatter)) return undefined;
  const raw = frontMatter[DISCUSS_FLAG_KEY];
  if (raw === true || raw === false || raw === null || raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  return ON_VALUES.has(value) || OFF_VALUES.has(value) ? undefined : String(raw);
}

/**
 * Return front matter with the flag turned `on` or off, without mutating the
 * input. Clearing DELETES the key rather than writing `discuss: false`, so
 * notes that were never flagged and notes that no longer are look identical —
 * front matter stays as small as the note actually needs.
 *
 * Key order is preserved; turning the flag on appends it to notes that predate
 * the field.
 */
export function setDiscussFlag(
  frontMatter: Record<string, unknown>,
  on: boolean
): Record<string, unknown> {
  if (on) return { ...frontMatter, [DISCUSS_FLAG_KEY]: true };
  const { [DISCUSS_FLAG_KEY]: _removed, ...rest } = frontMatter;
  return rest;
}
