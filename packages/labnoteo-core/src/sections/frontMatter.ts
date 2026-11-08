import * as yaml from 'js-yaml';
import { isInFrontMatter } from './documentHead';
import { findMetaDateFieldInLine } from '../lib/dateUtils';
import { endsAliasedReference } from '../sample/referenceInsert';
import { joinLineBuffer, spliceLineBuffer, spliceLineBufferMany, splitLineBuffer, type LineBuffer, type LineRef } from '../util/lineEnds';

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
 * How many lines at the top of `md` are its front matter, `---` lines included, as
 * {@link stripFrontMatter} finds it (0 without one). Obsidian reads them as properties,
 * so a fence-like line there opens no code block in the note.
 */
export function frontMatterLineCount(md: string): number {
  const head = md.slice(0, md.length - stripFrontMatter(md).length);
  if (head === '') return 0;
  return head.split('\n').length - (head.endsWith('\n') ? 1 : 0);
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
 * `undefined` drops the key but leaves its trailing comment on a line of its
 * own (#517); a key not present is added before the closing
 * `---` unless `add` is false. Every other line, comments included, stays as
 * written. A note without front matter gets a new block.
 */
export function setFrontMatterKeys(
  content: string,
  values: Readonly<Record<string, unknown>>,
  { add = true }: { add?: boolean } = {}
): string {
  // Every line not set keeps its own line break, even in mixed endings.
  const buf = splitLineBuffer(content);
  const { lines, newline } = buf;
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
  const seen = new Set<string>();
  const { edit, apply } = lineEdits(buf);
  for (let i = 1; i < fmEnd; i++) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i])?.[1];
    if (key === undefined || !Object.prototype.hasOwnProperty.call(values, key)) continue;
    seen.add(key);
    const first = lines[i];
    let end = i + 1;
    while (end < fmEnd && continues(lines[end])) end++;
    const multiline = end > i + 1;
    const value = values[key];
    if (value === undefined) {
      // A one-line key that goes keeps its trailing comment on its own line (#517).
      const comment = multiline ? '' : trailingComment(first).trimStart();
      edit(i, end - i, comment ? [comment] : []);
    } else {
      const entry = serializeFrontMatterEntry(key, value);
      const comment = !multiline && !entry.includes('\n') ? trailingComment(first) : '';
      edit(i, end - i, [comment ? `${entry.replace(/\s+$/, '')}${comment}` : entry]);
    }
    i = end - 1;
  }
  edit(fmEnd, 0, added(seen));
  apply();
  return joinLineBuffer(buf);
}

/**
 * Edits of `buf`, each given on its lines as written and in order from the top, applied in
 * one pass (many edits cost the text's length, not its length per edit). Edits that touch
 * run together as one, and a one-line replacement equal to a line it replaces keeps that
 * line as written, so the line breaks come out as {@link spliceLineBuffer} gives them with
 * the edits applied one after another from the top.
 */
export function lineEdits(buf: LineBuffer): { edit(start: number, count: number, items: readonly string[]): void; apply(): void } {
  const { lines } = buf;
  const edits: { start: number; count: number; body: (string | LineRef)[] }[] = [];
  return {
    edit(start, count, items) {
      const body = items.map((t, k): string | LineRef =>
        k > 0 || items.length > 1 ? t : t === lines[start] && count > 0 ? { line: start } : count > 1 && t === lines[start + count - 1] ? { line: start + count - 1 } : t
      );
      const last = edits[edits.length - 1];
      if (last && last.start + last.count === start) {
        last.count += count;
        last.body.push(...body);
      } else edits.push({ start, count, body });
    },
    apply() {
      spliceLineBufferMany(buf, edits);
    },
  };
}

/** The front-matter lines `[start, end)` of `key` with its continuation lines, if present. */
function frontMatterKeyBlock(lines: readonly string[], key: string): { start: number; end: number } | undefined {
  const fmEnd = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  for (let i = 1; i < fmEnd; i++) {
    if (/^([A-Za-z_][\w-]*)\s*:/.exec(lines[i])?.[1] !== key) continue;
    let end = i + 1;
    while (end < fmEnd && (/^\s+[^\s#]/.test(lines[end]) || /^-(\s|$)/.test(lines[end]))) end++;
    return { start: i, end };
  }
  return undefined;
}

/**
 * `content` with the front-matter lines of `keys` copied from `source` as
 * written there (#429), so `author: [[이서연]]` stays a link rather than the
 * nested list it parses as. A key `source` leaves empty, or a `source` whose
 * front matter cannot be read, leaves `content` as it is; a key `content`
 * lacks goes before its closing `---`.
 */
export function copyFrontMatterKeys(source: string, content: string, keys: readonly string[]): string {
  const from = source.replace(/\r\n/g, '\n');
  const parsed = parseFrontMatterYaml(from);
  if (parsed.parseError) return content;
  const fromLines = from.split('\n');
  // Lines not copied over keep their own line breaks, even in mixed endings.
  const buf = splitLineBuffer(content);
  const { lines } = buf;
  for (const key of keys) {
    const value = parsed.frontMatter[key];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && !value.trim()) ||
      (Array.isArray(value) && value.length === 0);
    const block = frontMatterKeyBlock(fromLines, key);
    if (empty || !block) continue;
    const copied = fromLines.slice(block.start, block.end);
    const target = frontMatterKeyBlock(lines, key);
    if (target) {
      spliceLineBuffer(buf, target.start, target.end - target.start, copied);
      continue;
    }
    const fmEnd = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
    if (fmEnd > 0) spliceLineBuffer(buf, fmEnd, 0, copied);
  }
  return joinLineBuffer(buf);
}

/**
 * The names a front-matter value such as `author` or `experimenter` holds
 * (#394): a string, a flow or block list, or the nested lists an unquoted
 * `[[이서연]]` reads as, alone or as a list item. A string holds one name per
 * comma (`김연구, 박협업`), as the plugin writes several experimenters (#548);
 * a comma inside `[[...]]` does not split. A wikilink gives its shown text (`[[a|b]]` → `b`,
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
    for (const part of splitOutsideLinks(String(v))) {
      const name = part
        .trim()
        .replace(/^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/, (_, target: string, shown?: string) =>
          (shown ?? target).trim()
        );
      if (name && !names.includes(name)) names.push(name);
    }
  };
  add(value, 0);
  return names;
}

function splitOutsideLinks(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('[[', i)) {
      depth++;
      i++;
    } else if (depth > 0 && text.startsWith(']]', i)) {
      depth--;
      i++;
    } else if (depth === 0 && text[i] === ',') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Where {@link planDateInsertion} puts the text: `[from, to)` becomes `text`. */
export type DateInsertion =
  /** `timeDropped`: a date and time put on a front matter date key kept only the date (#557). */
  | { from: number; to: number; text: string; timeDropped?: true }
  | { reason: 'frontMatter' }
  /** On an empty front matter key whose name is not a date's (#444). */
  | { reason: 'notDateKey'; key: string }
  /** On a date key whose value is the list or block on the lines below it (#526). */
  | { reason: 'listValue'; key: string }
  /** On a unit op's `Start_date`/`End_date` line that already has a value (#167). */
  | { reason: 'metaDate' };

/** A front matter key meant for a date or time: `created_date`, `end_date`, `start_time`. */
export function isDateLikeKey(key: string): boolean {
  return /date|time/i.test(key);
}

/**
 * Plan inserting a date `text` over the selection `[from, to)` (#106).
 *
 * In the body the selection is replaced as before. In the front matter only a
 * top-level date key ({@link isDateLikeKey}) with an empty value (`key:`,
 * `key: ''`, `key: ""`) takes it, written the way the other entries are
 * ({@link serializeFrontMatterEntry}), so an empty `end_date` can be filled;
 * an empty `author` or a `tags:` with its list below is refused (#444), and
 * so is a date key whose list or block value is on the lines below (#526).
 * A date and time (`2026-10-18 10:30`) is written as Obsidian's date-time
 * property (`2026-10-18T10:30`) on a key with `time` in its name, and as the
 * date alone on any other date key (#557). Anywhere else in the front matter —
 * a line with a value, a `---` line, a list item — typing the date would break
 * the YAML, so it is refused. A unit op's `- Start_date:`/`- End_date:` line
 * follows the same rule (#167): an empty value is filled inside its quotes,
 * and a line that has one is refused rather than given a second date.
 *
 * With the sample `types`, a body date right after a reference's alias is
 * kept apart from it by a space, which would otherwise read it in (#479).
 */
export function planDateInsertion(
  doc: string,
  from: number,
  to: number,
  text: string,
  types?: readonly string[]
): DateInsertion {
  if (from > to) [from, to] = [to, from];
  const lineStart = doc.lastIndexOf('\n', from - 1) + 1;
  const nl = doc.indexOf('\n', from);
  let lineEnd = nl === -1 ? doc.length : nl;
  if (!isInFrontMatter(doc, from) && !isInFrontMatter(doc, to)) {
    const pad = types && endsAliasedReference(doc.slice(lineStart, from), types) ? ' ' : '';
    if (to > lineEnd) return { from, to, text: `${pad}${text}` };
    if (doc[lineEnd - 1] === '\r') lineEnd--;
    const meta = findMetaDateFieldInLine(doc.slice(lineStart, lineEnd));
    if (!meta) return { from, to, text: `${pad}${text}` };
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
  if (!isDateLikeKey(m[1])) return { reason: 'notDateKey', key: m[1] };
  const next = doc.slice(lineEnd).replace(/^\r?\n/, '').split(/\r?\n/, 1)[0];
  if (/^(?:\s+\S|-(?:\s|$))/.test(next)) return { reason: 'listValue', key: m[1] };
  // Obsidian reads `2026-10-18 10:30` as text, not as a date (#557).
  const dateTime = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(text);
  if (!dateTime) return { from: lineStart, to: lineEnd, text: serializeFrontMatterEntry(m[1], text) };
  if (/time/i.test(m[1])) {
    return { from: lineStart, to: lineEnd, text: serializeFrontMatterEntry(m[1], `${dateTime[1]}T${dateTime[2]}`) };
  }
  return { from: lineStart, to: lineEnd, text: serializeFrontMatterEntry(m[1], dateTime[1]), timeDropped: true };
}
