import * as yaml from 'js-yaml';
import { isInFrontMatter } from './documentHead';
import { findMetaDateFieldInLine } from '../lib/dateUtils';

/** Result of {@link parseFrontMatterYaml}. */
export interface FrontMatterParse {
  frontMatter: Record<string, unknown>;
  body: string;
  /**
   * Set only when a `---` block WAS present but could not be read as a YAML
   * mapping. `frontMatter` is then empty, which is indistinguishable from a
   * note that simply has no front matter — so any caller that writes the note
   * back must check this first and bail out.
   *
   * A note with no `---` block at all is not an error and leaves this unset.
   */
  parseError?: string;
}

/** `md` without its leading `---` YAML front matter, when it has one. */
export function stripFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

/**
 * Parse a `---` front-matter block using a real YAML parser (js-yaml).
 *
 * The previous line-based parser silently dropped YAML list items (Obsidian
 * `tags`/`aliases`) and flattened nested keys. Using js-yaml preserves the full
 * structure. CORE_SCHEMA (YAML 1.2) keeps ISO dates as plain strings and does
 * NOT coerce `yes/no` to booleans, matching the historical string handling.
 *
 * Reading stays lenient — a broken block yields an empty `frontMatter` so the
 * body still renders — but the failure is now reported in `parseError` instead
 * of being swallowed. An unquoted colon (`title: EXP: 3rd try`) is enough to
 * break the block, and callers that re-serialized the empty result were
 * erasing every other field in the note.
 *
 * Callers must already have normalized CRLF → LF (the block regex requires
 * a bare `\n` after the opening `---`).
 */
export function parseFrontMatterYaml(md: string): FrontMatterParse {
  // The closing fence must be a line that is exactly `---` (optional trailing
  // spaces/tabs) followed by a newline or end-of-input. Without the line anchor
  // a `----` (4-dash) body line was mistaken for the closing fence and ate part
  // of the document.
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!fmMatch) {
    return { frontMatter: {}, body: md };
  }
  const yamlBlock = fmMatch[1];
  const body = md.slice(fmMatch[0].length).replace(/^\n+/, '');

  // An empty block (`---\n---`) is legitimately "no fields", not a failure.
  if (yamlBlock.trim() === '') {
    return { frontMatter: {}, body };
  }

  try {
    const loaded = yaml.load(yamlBlock, { schema: yaml.CORE_SCHEMA });
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      return { frontMatter: loaded as Record<string, unknown>, body };
    }
    // Valid YAML, but a scalar or a list — there are no fields to read, and
    // re-serializing would drop whatever the author wrote.
    return {
      frontMatter: {},
      body,
      parseError: 'front matter is not a YAML mapping (expected `key: value` lines)',
    };
  } catch (err) {
    return {
      frontMatter: {},
      body,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Serialize a single non-known front-matter entry.
 *
 * Every non-null value (scalars included) goes through `yaml.dump`, so a scalar
 * that needs quoting — most importantly one containing a colon, e.g.
 * `Exp: run 1` — is emitted as valid YAML (`title: 'Exp: run 1'`) and survives a
 * serialize → parse round-trip instead of silently resetting the whole block to
 * `{}`. Lists and nested maps are emitted as proper YAML (2-space indent, no
 * line wrapping) so Obsidian `tags`/`aliases` survive too. `null`/`undefined`
 * keep the compact empty `key: ` form used by the workflow/readme templates.
 */
export function serializeFrontMatterEntry(key: string, val: unknown): string {
  if (val === null || val === undefined) {
    return `${key}: `;
  }
  const dumped = yaml.dump({ [key]: val }, {
    schema: yaml.CORE_SCHEMA,
    lineWidth: -1,
    noRefs: true,
  });
  return dumped.replace(/\n+$/, '');
}

/** The ` # comment` ending a single-line `key: value`, outside any quotes, or ''. */
function trailingComment(line: string): string {
  let quote: string | undefined;
  for (let i = line.indexOf(':') + 1; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && /\s/.test(line[i - 1] ?? '')) {
      return line.slice(i - 1);
    }
  }
  return '';
}

/**
 * `content` with the front-matter keys in `values` set line by line (#422):
 * a value replaces that key's line (and its indented continuation lines),
 * keeping a trailing ` # comment` when the new value fits on one line;
 * `undefined` drops the key; a key not present is added before the closing
 * `---` unless `add` is false. Every other line, comments included, stays as
 * written. A note without front matter gets a new block.
 */
export function setFrontMatterKeys(
  content: string,
  values: Readonly<Record<string, unknown>>,
  { add = true }: { add?: boolean } = {}
): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const fmEnd = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  const added = (seen: ReadonlySet<string>): string[] =>
    add
      ? Object.entries(values)
          .filter(([key, value]) => value !== undefined && !seen.has(key))
          .map(([key, value]) => serializeFrontMatterEntry(key, value))
      : [];
  if (fmEnd < 0) {
    const entries = added(new Set());
    if (entries.length === 0) return content;
    return ['---', ...entries, '---', '', content.replace(/^(\r?\n)+/, '')].join(newline);
  }
  const continues = (line: string): boolean => /^\s+[^\s#]/.test(line) || /^-(\s|$)/.test(line);
  const out = [lines[0]];
  const seen = new Set<string>();
  for (let i = 1; i < fmEnd; i++) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i])?.[1];
    if (key === undefined || !Object.prototype.hasOwnProperty.call(values, key)) {
      out.push(lines[i]);
      continue;
    }
    seen.add(key);
    const first = lines[i];
    let multiline = false;
    while (i + 1 < fmEnd && continues(lines[i + 1])) {
      i++;
      multiline = true;
    }
    const value = values[key];
    if (value === undefined) continue;
    const entry = serializeFrontMatterEntry(key, value);
    const comment = !multiline && !entry.includes('\n') ? trailingComment(first) : '';
    out.push(comment ? `${entry.replace(/\s+$/, '')}${comment}` : entry);
  }
  return [...out, ...added(seen), ...lines.slice(fmEnd)].join(newline);
}

/**
 * The names a front-matter value such as `author` or `experimenter` holds
 * (#394): a string, a flow or block list, or the nested lists an unquoted
 * `[[이서연]]` reads as, alone or as a list item. A wikilink gives its shown text (`[[a|b]]` → `b`,
 * `[[a#h]]` → `a`); empty entries are dropped and repeats kept once.
 */
export function frontMatterNames(value: unknown): string[] {
  const names: string[] = [];
  const add = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) {
      if (depth < 3) for (const item of v) add(item, depth + 1);
      return;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const name = String(v)
      .trim()
      .replace(/^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/, (_, target: string, shown?: string) =>
        (shown ?? target).trim()
      );
    if (name && !names.includes(name)) names.push(name);
  };
  add(value, 0);
  return names;
}

/** Where {@link planDateInsertion} puts the text: `[from, to)` becomes `text`. */
export type DateInsertion =
  | { from: number; to: number; text: string }
  | { reason: 'frontMatter' }
  /** On a unit op's `Start_date`/`End_date` line that already has a value (#167). */
  | { reason: 'metaDate' };

/**
 * Plan inserting a date `text` over the selection `[from, to)` (#106).
 *
 * In the body the selection is replaced as before. In the front matter only a
 * top-level key with an empty value (`key:`, `key: ''`, `key: ""`) takes it,
 * written the way the other entries are ({@link serializeFrontMatterEntry}),
 * so an empty `end_date` can be filled. Anywhere else in the front matter —
 * a line with a value, a `---` line, a list item — typing the date would break
 * the YAML, so it is refused. A unit op's `- Start_date:`/`- End_date:` line
 * follows the same rule (#167): an empty value is filled inside its quotes,
 * and a line that has one is refused rather than given a second date.
 */
export function planDateInsertion(doc: string, from: number, to: number, text: string): DateInsertion {
  if (from > to) [from, to] = [to, from];
  const lineStart = doc.lastIndexOf('\n', from - 1) + 1;
  const nl = doc.indexOf('\n', from);
  let lineEnd = nl === -1 ? doc.length : nl;
  if (!isInFrontMatter(doc, from) && !isInFrontMatter(doc, to)) {
    if (to > lineEnd) return { from, to, text };
    if (doc[lineEnd - 1] === '\r') lineEnd--;
    const meta = findMetaDateFieldInLine(doc.slice(lineStart, lineEnd));
    if (!meta) return { from, to, text };
    if (meta.value.trim() !== '') return { reason: 'metaDate' };
    const valueFrom = lineStart + meta.valueStart;
    const valueTo = lineStart + meta.valueEnd;
    if (meta.quote) return { from: valueFrom, to: valueTo, text };
    const space = doc[valueFrom - 1] === ':' ? ' ' : '';
    return { from: valueFrom, to: valueTo, text: `${space}'${text}'` };
  }

  if (to > lineEnd) return { reason: 'frontMatter' };
  if (doc[lineEnd - 1] === '\r') lineEnd--;
  const m = /^([A-Za-z_][\w-]*):[ \t]*(?:''|"")?[ \t]*$/.exec(doc.slice(lineStart, lineEnd));
  if (!m) return { reason: 'frontMatter' };
  return { from: lineStart, to: lineEnd, text: serializeFrontMatterEntry(m[1], text) };
}
