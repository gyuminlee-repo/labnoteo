/**
 * Sample Storage - Functions for extracting and storing sample information
 * Supports formats: ID;alias;description, ID;alias, ID: description, ID
 * Legacy formats (|, :) are also recognized for backward compatibility
 */

import * as path from '../util/posixPath';
import type { LabnoteFs } from '../fs/labnoteFs';
import {
  SAMPLE_TYPES,
  SampleType,
  buildSampleDefinitionText,
  escapeSamplePipes,
  hasSampleAliasSeparator,
  isCatalogSampleType,
} from './sampleUtils';
import { escapeRegExp } from './regexUtils';
import { getExperimentDir, getExperimentLabsamplesFolder } from './labnoteStructure';

/**
 * Extracted sample information from document text
 */
export interface SampleInfo {
  id: string;
  type: SampleType;
  alias: string | null;
  description: string | null;
  /**
   * True for an `@type;ID…` definition. Anything else is a reference: its alias
   * has no end marker in the text (`ID;alias` runs to the end of the line), so
   * it may seed a record that does not exist yet but never overwrites one.
   */
  definition: boolean;
}

/**
 * Stored sample record in JSON file
 */
export interface SampleRecord {
  type: string;
  alias: string | null;
  descriptions: string[];
  sources: string[];
  /**
   * Physical storage location (e.g. "Freezer-2 / Box-3 / A1"). Optional and
   * additive: records written before this field load as `null`, so no migration
   * is needed. Authored locally today; for DNA/Plasmid/Primer it may later be
   * populated from partbank via a {@link SampleLocationProvider}.
   */
  location?: string | null;
  /**
   * The date (`YYYY-MM-DD`) the sample was marked used up or thrown away
   * (#158). It stays in the registry, so references keep resolving, but sorts
   * last in autocomplete. Absent or `null` for a sample still in use.
   */
  discarded?: string | null;
  /**
   * Which note (basename) put which description in, from its `@type;`
   * definition (#172). When that note's definition changes, its old
   * description is replaced rather than kept beside the new one. Descriptions
   * from "Edit sample" or from before this field are not listed and stay.
   */
  descriptionSources?: Record<string, string>;
}

/**
 * Database structure: { TYPE: { ID: SampleRecord } }
 */
export type SampleDatabase = Record<string, Record<string, SampleRecord>>;

/**
 * A sample `type` is used verbatim as a `{type}.json` filename, so it must stay
 * a single path segment. Reject anything that could escape the labsamples
 * folder (path separators, `.`/`..`, empty). Custom non-ASCII type names are
 * still allowed — this is a denylist of dangerous shapes, not an allowlist.
 *
 * Reproduced attack: `type = '../../../../.obsidian/plugins/evil/main'` would
 * otherwise write outside the vault-relative labsamples folder.
 */
function assertSafeSampleType(type: string): void {
  if (!type || /[\\/]/.test(type) || type === '.' || type === '..') {
    throw new Error(`Invalid sample type (path traversal blocked): ${JSON.stringify(type)}`);
  }
}

/**
 * Coerce an untrusted on-disk record into a well-formed {@link SampleRecord},
 * tolerating older/partial shapes: a missing/`null` value, missing
 * `sources`/`descriptions`, or wrong element types. This is the SINGLE guard
 * that prevents `record.sources.length`-style TypeErrors on legacy `{Type}.json`
 * data (previously each loader open-coded its own `?? []` defaults, and some
 * paths had none). `fallbackType` is used only when the record omits `type`.
 */
function normalizeSampleRecord(rec: unknown, fallbackType: string): SampleRecord {
  const r = (rec && typeof rec === 'object' ? rec : {}) as Partial<SampleRecord>;
  return {
    type: typeof r.type === 'string' && r.type ? r.type : fallbackType,
    alias: typeof r.alias === 'string' ? r.alias : null,
    descriptions: Array.isArray(r.descriptions)
      ? r.descriptions.filter((d): d is string => typeof d === 'string')
      : [],
    sources: Array.isArray(r.sources)
      ? r.sources.filter((s): s is string => typeof s === 'string')
      : [],
    location: typeof r.location === 'string' ? r.location : null,
    ...(typeof r.discarded === 'string' && r.discarded ? { discarded: r.discarded } : {}),
    ...(r.descriptionSources && typeof r.descriptionSources === 'object' && !Array.isArray(r.descriptionSources)
      ? {
          descriptionSources: Object.fromEntries(
            Object.entries(r.descriptionSources).filter(
              (e): e is [string, string] => typeof e[1] === 'string'
            )
          ),
        }
      : {}),
  };
}

/**
 * Collapse `{Type}.json` keys that differ only in case into a single canonical
 * record (unioning `descriptions`/`sources`, keeping the first non-empty
 * `alias`). Returns `changed = true` when a collision was merged so the caller
 * can rewrite the file and converge historical data (Phase 1-3b migration).
 * Every record is passed through {@link normalizeSampleRecord} first.
 */
function mergeCaseCollidingIds(
  raw: Record<string, SampleRecord>
): { records: Record<string, SampleRecord>; changed: boolean } {
  const out: Record<string, SampleRecord> = {};
  const canonicalByLower = new Map<string, string>();
  let changed = false;

  for (const [id, rawRec] of Object.entries(raw)) {
    const rec = normalizeSampleRecord(rawRec, '');
    const lower = id.toLowerCase();
    const canonical = canonicalByLower.get(lower);
    if (canonical === undefined) {
      canonicalByLower.set(lower, id);
      out[id] = rec;
      continue;
    }

    changed = true;
    const target = out[canonical];
    for (const d of rec.descriptions) {
      if (!target.descriptions.includes(d)) target.descriptions.push(d);
    }
    for (const s of rec.sources) {
      if (!target.sources.includes(s)) target.sources.push(s);
    }
    if (!target.alias && rec.alias) target.alias = rec.alias;
    if (!target.location && rec.location) target.location = rec.location;
  }

  return { records: out, changed };
}

/**
 * Parse the raw text of a `{Type}.json` into records, tolerating an empty/absent
 * file (`''` → `{}`) and malformed JSON (warns, returns `{}`), then applies the
 * Phase 1-3b case-collision merge so callers inside an atomic `fs.modify`
 * callback see the same normalized shape `loadSamplesByType` returns. Kept
 * synchronous so it can run inside `vault.process`'s sync callback.
 */
function parseSampleRecords(raw: string): Record<string, SampleRecord> {
  if (!raw || !raw.trim()) return {};
  let parsed: Record<string, SampleRecord>;
  try {
    parsed = JSON.parse(raw) as Record<string, SampleRecord>;
  } catch (error) {
    console.warn('[labnoteo] Failed to parse sample JSON during modify:', error);
    return {};
  }
  return mergeCaseCollidingIds(parsed).records;
}

/**
 * Build the sample-definition matcher for one `type`. Capture groups:
 *   [1] id (e.g. `DNA-12`; collision-resolved ids like `DNA-…-3` included)
 *   [2] alias (when `;`/`|` delimited)     [3] description (after the alias)
 *   [4] legacy `: description` form
 *
 * Shared by {@link extractSampleInfoFromText} and {@link findSampleDefinitionMatch}
 * so the two never drift. `type` is regex-escaped (custom types may in theory
 * contain metacharacters). The `gi` flags match the callers' stateful `exec`
 * loops, so each caller builds its own instance (never share `lastIndex`).
 */
function buildSampleDefinitionPattern(type: string): RegExp {
  return new RegExp(sampleDefinitionSource(type), 'gi');
}

function sampleDefinitionSource(type: string): string {
  const typeEsc = escapeRegExp(type);
  // Alias and description read `\|` as a literal pipe (#72).
  return `(?:@${typeEsc}[;:])?(${typeEsc}-\\d+(?:-\\d+)*)(?:[;|]((?:\\\\\\||[^;:\\n|])+)(?:[;:]((?:\\\\\\||[^\\n;|])+))?|:\\s*([^\\n;|]+))?`;
}

function unescapeSamplePipes(text: string): string {
  return text.replace(/\\\|/g, '|');
}

/**
 * Next match of a {@link buildSampleDefinitionPattern} pattern, with a plain
 * reference cut short where another same-type id follows after whitespace:
 * `Reagent-1;두번째시약 Reagent-2;세번째` reads as two references instead of
 * Reagent-2 being swallowed into the first one's alias (#57). `lastIndex` is
 * rewound so the next call matches that id.
 *
 * Only plain references are cut. A definition's description may legitimately
 * mention another sample (`@Reagent;Reagent-3;희석액;원액 Reagent-1 희석`), and
 * cutting it would also shrink the range {@link findSampleDefinitionMatch}
 * replaces, leaving the tail behind on edit. Whitespace is required before the
 * id because ids match without a leading boundary (`DNA-1;cDNA-2` stays whole).
 */
function nextSampleMatch(pattern: RegExp, text: string, type: string): RegExpExecArray | null {
  const match = pattern.exec(text);
  if (!match || match[0].startsWith('@')) return match;

  const typeEsc = escapeRegExp(type);
  const tail = match[0].slice(match[1].length);
  const next = new RegExp(`\\s+((?:@${typeEsc}[;:])?${typeEsc}-\\d)`, 'i').exec(tail);
  if (!next) return match;

  const cut = match[1].length + next.index;
  const trimmed = new RegExp(`^${sampleDefinitionSource(type)}`, 'i').exec(
    text.slice(match.index, match.index + cut)
  );
  if (!trimmed) return match;
  trimmed.index = match.index;
  pattern.lastIndex = match.index + cut + next[0].length - next[1].length;
  return trimmed;
}

/** A sample reference in a text with its `@type;` prefix, alias and description: `[start, end)`. */
export interface SampleReferenceSpan {
  type: string;
  id: string;
  start: number;
  end: number;
}

/**
 * Every sample reference in `text` for `types`, spanning what the definition
 * matcher reads as the reference. Nothing marks where a plain reference's
 * alias ends, so the span of `DNA-1;sampleA for the assembly` runs to the end
 * of the sentence. Sorted by start offset.
 */
export function findSampleReferenceSpans(text: string, types: readonly string[]): SampleReferenceSpan[] {
  const spans: SampleReferenceSpan[] = [];
  for (const type of types) {
    const pattern = buildSampleDefinitionPattern(type);
    let match: RegExpExecArray | null;
    while ((match = nextSampleMatch(pattern, text, type)) !== null) {
      spans.push({ type, id: match[1], start: match.index, end: match.index + match[0].length });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The IDs `text` defines with `@type;` (or `@type:`), lower-cased, read as
 * {@link extractSampleInfoFromText} reads definitions: a note's own
 * definitions count as known before the sample sync has saved them (#210).
 */
export function findDefinedSampleIds(text: string, types: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const type of types) {
    const pattern = buildSampleDefinitionPattern(type);
    let match;
    while ((match = nextSampleMatch(pattern, text, type)) !== null) {
      if (match[0].startsWith('@')) ids.add(match[1].toLowerCase());
    }
  }
  return ids;
}

/**
 * Extract sample information from document text
 * Supports formats (new ; delimiter + legacy |/: for backward compatibility):
 * - @type;ID;alias;description (definition format)
 * - @type;ID;alias (definition with alias only)
 * - @type;ID (definition with ID only)
 * - ID;alias;description (full format)
 * - ID;alias (alias only)
 * - ID: description (legacy format)
 * - ID (ID only)
 */
export function extractSampleInfoFromText(text: string, additionalTypes?: string[]): SampleInfo[] {
  // Collected in appearance order. `seenByLower` maps the case-normalized id to
  // its slot so `DNA-55` and `dna-55` collapse to one sample (the match regex is
  // case-insensitive but a case-sensitive Set would split them into two JSON
  // keys). Each slot tracks a rank — `@type;` definition (2) > reference with
  // an alias/description (1) > bare id (0) — so a stronger occurrence appearing
  // later upgrades that slot instead of being dropped.
  const collected: Array<{ info: SampleInfo; index: number; rank: number }> = [];
  const seenByLower = new Map<string, number>();

  const allTypes: string[] = [...SAMPLE_TYPES, ...(additionalTypes ?? []).filter(t => !(SAMPLE_TYPES as readonly string[]).includes(t))];
  for (const type of allTypes) {
    // Match sample ids with optional @type; prefix, alias and description.
    // ID segment uses (?:-\d+)* (same as buildSampleIdPattern) so collision-resolved
    // ids like DNA-1737000000000-3 are extracted. See buildSampleDefinitionPattern.
    const pattern = buildSampleDefinitionPattern(type);

    let match;
    while ((match = nextSampleMatch(pattern, text, type)) !== null) {
      const id = match[1];

      let alias: string | null = null;
      let description: string | null = null;

      if (match[2]) {
        // Format: ID|alias or ID|alias:description
        alias = unescapeSamplePipes(match[2].trim());
        if (match[3]) {
          description = unescapeSamplePipes(match[3].trim());
        }
      } else if (match[4]) {
        // Legacy format: ID: description
        description = match[4].trim();
      }

      // Only the `@type;` prefix makes a definition. An alias after a plain
      // reference (`DNA-2;pUC19 …`) is not trustworthy: nothing marks where it
      // ends, so trailing prose on the line is captured with it.
      const definition = match[0].startsWith('@');
      const rank = definition ? 2 : match[2] != null || match[4] != null ? 1 : 0;
      const info: SampleInfo = { id, type: type as SampleType, alias, description, definition };
      const key = id.toLowerCase();
      const slot = seenByLower.get(key);

      if (slot === undefined) {
        seenByLower.set(key, collected.length);
        collected.push({ info, index: match.index, rank });
      } else if (rank > collected[slot].rank) {
        // Upgrade the earlier, weaker occurrence (its casing becomes the
        // canonical JSON key), but keep the earliest position for ordering.
        collected[slot] = {
          info,
          index: Math.min(collected[slot].index, match.index),
          rank,
        };
      }
    }
  }

  // Sort by first appearance in text (captured match index, not indexOf).
  collected.sort((a, b) => a.index - b.index);

  return collected.map(c => c.info);
}

/**
 * Build a sample database from extracted samples
 * Groups samples by type and stores with source file info
 */
export function buildSampleDatabase(
  samples: SampleInfo[],
  sourceFile: string
): SampleDatabase {
  const db: SampleDatabase = {};

  for (const sample of samples) {
    const { type, id, alias, description } = sample;

    if (!db[type]) {
      db[type] = {};
    }

    db[type][id] = {
      type,
      alias,
      descriptions: description ? [description] : [],
      sources: [sourceFile],
    };
  }

  return db;
}

/** Key of a `(type, id)` pair in {@link mergeSampleDatabases}' `referenceOnly` set. */
export function sampleReferenceKey(type: string, id: string): string {
  return `${type}|${id.toLowerCase()}`;
}

/**
 * Merge two sample databases
 * New data overwrites alias, but descriptions and sources are combined.
 *
 * Ids in `opts.referenceOnly` (keys from {@link sampleReferenceKey}) came from
 * plain document references: when a record already exists (matched ignoring
 * case) only their sources are added, so the registry's alias/descriptions
 * stay authoritative.
 *
 * A reference whose id does NOT exist yet creates a record ONLY when its key is
 * in `opts.seedable` (e.g. a catalog pick, seeded from the product catalog).
 * Plain `id;alias` prose references to an unknown id are left out of the
 * registry (#54, #55): otherwise deleting a sample resurrects it on the next
 * edit, and a mangled fragment like `Other-1791` registers itself as a sample.
 * Definitions (`@type;...`) and other non-reference entries always create
 * records as before.
 */
export function mergeSampleDatabases(
  existing: SampleDatabase,
  newData: SampleDatabase,
  opts: { referenceOnly?: ReadonlySet<string>; seedable?: ReadonlySet<string> } = {}
): SampleDatabase {
  const merged: SampleDatabase = JSON.parse(JSON.stringify(existing));

  for (const [type, samples] of Object.entries(newData)) {
    if (!merged[type]) {
      merged[type] = {};
    }
    const target = merged[type];

    for (const [id, record] of Object.entries(samples)) {
      const referenceOnly = opts.referenceOnly?.has(sampleReferenceKey(type, id)) ?? false;
      const existingId =
        id in target
          ? id
          : referenceOnly
            ? Object.keys(target).find((k) => k.toLowerCase() === id.toLowerCase())
            : undefined;
      if (existingId !== undefined) {
        // Merge existing record
        const existingRecord = target[existingId];

        if (!referenceOnly) {
          // New alias overwrites (if provided)
          if (record.alias) {
            existingRecord.alias = record.alias;
          }

          // Put current document's descriptions first so sidebar shows latest (descriptions[0])
          const fromNew = record.descriptions || [];
          let kept = existingRecord.descriptions || [];
          // A description this note put in before and has since changed goes,
          // unless another note still writes it (#172).
          const source = record.sources[0];
          const written = source ? existingRecord.descriptionSources?.[source] : undefined;
          if (source && fromNew.length > 0 && written !== undefined && !fromNew.includes(written)) {
            const sharedBy = Object.entries(existingRecord.descriptionSources ?? {}).some(
              ([s, d]) => s !== source && d === written
            );
            if (!sharedBy) kept = kept.filter((d) => d !== written);
          }
          const fromExisting = kept.filter((d) => !fromNew.includes(d));
          existingRecord.descriptions = [...fromNew, ...fromExisting];
          if (source && fromNew.length > 0) {
            existingRecord.descriptionSources = { ...existingRecord.descriptionSources, [source]: fromNew[0] };
          }
        }

        // Combine sources (unique)
        for (const source of record.sources) {
          if (!existingRecord.sources.includes(source)) {
            existingRecord.sources.push(source);
          }
        }
      } else {
        // Add a new record only when this is not a bare document reference, or
        // the reference is explicitly seedable (a catalog pick). Plain prose
        // references to an unknown id never create registry entries.
        if (!referenceOnly || (opts.seedable?.has(sampleReferenceKey(type, id)) ?? false)) {
          const source = record.sources[0];
          target[id] =
            !referenceOnly && source && record.descriptions.length > 0
              ? { ...record, descriptionSources: { [source]: record.descriptions[0] } }
              : { ...record };
        }
      }
    }
  }

  return merged;
}

/**
 * Find the range of a sample definition in document text for replacement.
 * Returns { start, length } of the first matching definition, or null.
 * - General types: matches @type:ID with optional |alias:description (same pattern as extractSampleInfoFromText).
 *   Plain references (`ID;alias`) are skipped: their match runs to the end of
 *   the line, so replacing it would delete the prose that follows.
 * - Equip: if no match by id, tries @equip:|currentAlias with optional :description (definition without ID in text).
 */
export function findSampleDefinitionMatch(
  text: string,
  type: string,
  id: string,
  currentAlias?: string | null
): { start: number; length: number } | null {
  // 1) Match by @type;ID or @type:ID (supports ; and legacy |/: delimiters).
  //    Shared with extraction via buildSampleDefinitionPattern.
  const idPattern = buildSampleDefinitionPattern(type);
  let match = nextSampleMatch(idPattern, text, type);
  while (match) {
    if (match[1] === id && match[0].startsWith('@')) {
      // The match stops at a `;` inside an old alias; take the whole
      // definition so a rewrite leaves no tail behind (#98).
      const legacy =
        currentAlias && hasSampleAliasSeparator(currentAlias)
          ? legacyDefinitionSpan(text, aliasStartOf(text, match), currentAlias)
          : undefined;
      return { start: match.index, length: (legacy?.end ?? match.index + match[0].length) - match.index };
    }
    match = nextSampleMatch(idPattern, text, type);
  }

  // 2) Equip: match by @equip;|currentAlias when definition has no ID in text
  if ((type.toLowerCase() === 'equip') && currentAlias && currentAlias.trim()) {
    const aliasEsc = escapeRegExp(escapeSamplePipes(currentAlias));
    const equipAliasPattern = new RegExp(
      `@equip[;:][;|]${aliasEsc}(?:[;:]((?:\\\\\\||[^\\n;|])*))?`,
      'gi'
    );
    const equipMatch = equipAliasPattern.exec(text);
    if (equipMatch) {
      return { start: equipMatch.index, length: equipMatch[0].length };
    }
  }

  return null;
}

/** Offset where the alias of a pattern match starts: past the id, its delimiter and spaces. */
function aliasStartOf(text: string, match: RegExpExecArray): number {
  const delimiter = match.index + match[0].indexOf(match[1]) + match[1].length;
  return delimiter + 1 + /^[ \t]*/.exec(text.slice(delimiter + 1))![0].length;
}

/**
 * The extent of a definition whose alias holds `;` or `:` (allowed before
 * #98), which the pattern cuts short at that character. `aliasStart` is where
 * the alias begins. When the text there is `oldAlias` followed by a line end
 * or by `;`/`:` and a description, returns the end of the definition and that
 * description; otherwise undefined.
 */
export function legacyDefinitionSpan(
  text: string,
  aliasStart: number,
  oldAlias: string
): { end: number; description: string | null } | undefined {
  const aliasEsc = escapeSamplePipes(oldAlias);
  if (!text.startsWith(aliasEsc, aliasStart)) return undefined;
  const aliasEnd = aliasStart + aliasEsc.length;
  const next = text[aliasEnd];
  if (next === undefined || next === '\n' || next === '\r') return { end: aliasEnd, description: null };
  if (next !== ';' && next !== ':') return undefined;
  const raw = /^(?:\\\||[^\n;|])*/.exec(text.slice(aliasEnd + 1))![0].trimEnd();
  const description = unescapeSamplePipes(raw.trim());
  return { end: aliasEnd + 1 + raw.length, description: description || null };
}

/** One replacement planned by {@link planAliasRewrite}, in original-text offsets. */
export interface AliasRewriteEdit {
  start: number;
  end: number;
  text: string;
  kind: 'definition' | 'reference';
}

/**
 * Plan replacing `oldAlias` with `newAlias` for sample `id` throughout `text`
 * (#86), scanning with the same matcher as the registry sync so the alias read
 * there is the alias changed here. Ids must match exactly (`DNA-12` never
 * touches `DNA-12-3`).
 *
 * - An `@type;` definition whose alias is exactly `oldAlias` is rewritten,
 *   keeping its description. A stale definition would otherwise put the old
 *   alias back in the registry the next time its note is saved.
 * - A plain reference's alias runs to the next `;`, `:`, `|` or line end, so it
 *   may carry the rest of the sentence. Only a leading `oldAlias` followed by
 *   whitespace or that end is replaced; an empty `newAlias` drops the `;` too,
 *   leaving the bare id. Anything else is left as written.
 * - An `oldAlias` holding `;` or `:` (allowed before #98) is cut short by the
 *   pattern, so it is compared against the text after the id instead.
 * - An empty `oldAlias` adds `;newAlias` to the bare-id references (#170).
 *
 * Edits are in document order and do not overlap.
 */
export function planAliasRewrite(
  text: string,
  type: string,
  id: string,
  oldAlias: string,
  newAlias: string
): AliasRewriteEdit[] {
  const edits: AliasRewriteEdit[] = [];
  const oldEsc = escapeSamplePipes(oldAlias);
  const newEsc = escapeSamplePipes(newAlias);
  if (!oldAlias) return newAlias ? planAliasAddition(text, type, id, newEsc) : edits;
  if (oldAlias === newAlias) return edits;

  const startsWithAlias = (s: string, alias: string): boolean =>
    s.startsWith(alias) && (s.length === alias.length || /\s/.test(s[alias.length]));

  const legacy = hasSampleAliasSeparator(oldAlias);
  const pattern = buildSampleDefinitionPattern(type);
  let match: RegExpExecArray | null;
  while ((match = nextSampleMatch(pattern, text, type)) !== null) {
    if (match[1] !== id || match[2] === undefined) continue;
    // The alias group starts right after the id and its `;`/`|` delimiter.
    const delimiter = match.index + match[0].indexOf(match[1]) + match[1].length;
    const raw = match[2];

    if (legacy) {
      const aliasStart = aliasStartOf(text, match);
      let edit: AliasRewriteEdit | undefined;
      if (match[0].startsWith('@')) {
        const span = legacyDefinitionSpan(text, aliasStart, oldAlias);
        if (span) {
          edit = {
            start: match.index,
            end: span.end,
            text: buildSampleDefinitionText(type, id, newAlias || null, span.description),
            kind: 'definition',
          };
        }
      } else if (text.startsWith(oldEsc, aliasStart)) {
        const next = text[aliasStart + oldEsc.length];
        if (next === undefined || /[\s;:|]/.test(next)) {
          const end = aliasStart + oldEsc.length;
          edit = newAlias
            ? { start: aliasStart, end, text: newEsc, kind: 'reference' }
            : { start: delimiter, end, text: '', kind: 'reference' };
        }
      }
      if (edit) {
        edits.push(edit);
        pattern.lastIndex = Math.max(pattern.lastIndex, edit.end);
      }
      continue;
    }

    if (match[0].startsWith('@')) {
      if (unescapeSamplePipes(raw.trim()) !== oldAlias) continue;
      const body = match[0].trimEnd();
      const description = match[3] ? unescapeSamplePipes(match[3].trim()) : null;
      edits.push({
        start: match.index,
        end: match.index + body.length,
        text: buildSampleDefinitionText(type, id, newAlias || null, description),
        kind: 'definition',
      });
      continue;
    }

    const lead = raw.length - raw.trimStart().length;
    const rest = raw.slice(lead);
    if (!startsWithAlias(rest, oldEsc)) continue;
    if (newAlias && startsWithAlias(rest, newEsc)) continue;
    const aliasStart = delimiter + 1 + lead;
    edits.push(
      newAlias
        ? { start: aliasStart, end: aliasStart + oldEsc.length, text: newEsc, kind: 'reference' }
        : { start: delimiter, end: aliasStart + oldEsc.length, text: '', kind: 'reference' }
    );
  }
  return edits;
}

/**
 * A sample without an alias got one (#170): `;alias` after every plain
 * reference that is the bare id, so the notes show the name too. Definitions
 * are left alone; their blank alias keeps the stored one.
 */
function planAliasAddition(text: string, type: string, id: string, aliasEsc: string): AliasRewriteEdit[] {
  const edits: AliasRewriteEdit[] = [];
  const pattern = buildSampleDefinitionPattern(type);
  let match: RegExpExecArray | null;
  while ((match = nextSampleMatch(pattern, text, type)) !== null) {
    if (match[0].startsWith('@') || match[1] !== id || match[2] !== undefined) continue;
    const end = match.index + match[0].indexOf(match[1]) + match[1].length;
    // `DNA-1;` with nothing after the `;` reads as no alias too.
    const at = text[end] === ';' ? end + 1 : end;
    edits.push({ start: end, end: at, text: `;${aliasEsc}`, kind: 'reference' });
  }
  return edits;
}

/**
 * The id a sample of `oldType` gets as a `newType` one: the type prefix swapped,
 * the numbers kept (`RNA-1792298689414-3` → `DNA-1792298689414-3`, #116).
 * Undefined when `oldId` does not start with `oldType-`.
 */
export function sampleIdForType(oldType: string, oldId: string, newType: string): string | undefined {
  if (oldId.slice(0, oldType.length).toLowerCase() !== oldType.toLowerCase()) return undefined;
  const numbers = oldId.slice(oldType.length);
  return /^(?:-\d+)+$/.test(numbers) ? `${newType}${numbers}` : undefined;
}

/**
 * Plan renaming sample `oldId` (a `oldType` sample) to `newId` of `newType`
 * throughout `text` (#116): every reference, and the `@type;` keyword of a
 * definition, which keeps its case (`@rna;` → `@dna;`). Case is ignored, as in
 * the sync, and the id must stand alone: `RNA-1` does not touch `RNA-12` or
 * `RNA-1-3`. Code blocks are included, since the sync registers them too.
 */
export function planSampleIdRewrite(
  text: string,
  oldType: string,
  oldId: string,
  newType: string,
  newId: string
): AliasRewriteEdit[] {
  const pattern = new RegExp(
    `(?:(@${escapeRegExp(oldType)})([;:])|(?<![\\p{L}\\p{N}_]))${escapeRegExp(oldId)}(?![\\p{L}\\p{N}_]|-\\d)`,
    'giu'
  );
  const edits: AliasRewriteEdit[] = [];
  for (const m of text.matchAll(pattern)) {
    const keyword = m[1];
    if (keyword === undefined) {
      edits.push({ start: m.index, end: m.index + m[0].length, text: newId, kind: 'reference' });
      continue;
    }
    const typed = keyword.slice(1);
    const type = typed === typed.toLowerCase() && typed !== typed.toUpperCase() ? newType.toLowerCase() : newType;
    edits.push({ start: m.index, end: m.index + m[0].length, text: `@${type}${m[2]}${newId}`, kind: 'definition' });
  }
  return edits;
}

/** `text` with non-overlapping {@link AliasRewriteEdit}s applied. */
export function applyAliasRewrite(text: string, edits: readonly AliasRewriteEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * Get the resources/labsamples folder path for a document.
 *
 * Pure path computation — no side effects. The folder is created lazily by the
 * `LabnoteFs` adapter's `write` (which makes parent directories on demand) when
 * a sample JSON is actually saved, so read-only callers (completion, product
 * picker) never touch disk just to derive this path.
 */
export function getLabsamplesFolder(documentPath: string): string {
  const documentDir = path.dirname(documentPath);
  return path.join(documentDir, 'resources', 'labsamples');
}

/**
 * The Local labsamples folder of a note: its experiment's folder inside
 * `labnote/###_*`, the Global folder for a note at the vault root (#101), and
 * the note's own folder anywhere else. Without `globalFolder` a vault-root
 * note uses its own folder, the default Global one.
 */
export function noteLabsamplesFolder(documentPath: string, globalFolder?: string): string {
  const experiment = getExperimentDir(documentPath);
  if (experiment) return path.join(experiment, 'resources', 'labsamples');
  if (globalFolder && !path.normalize(documentPath).replace(/^\/+/, '').includes('/')) return globalFolder;
  return getLabsamplesFolder(documentPath);
}

/**
 * The Local-scope labsamples folder for the sample tree, autocomplete and
 * sample creation, given the active file and the last experiment seen (#4, #70).
 *
 * A file inside an experiment (`labnote/###_*`) maps to that experiment's
 * folder, which becomes the remembered one. A markdown note outside any
 * experiment uses {@link noteLabsamplesFolder}, the folder its references
 * resolve against and its definitions sync to — a vault-root note's is the
 * Global folder. Only a non-note file (image, PDF, canvas) keeps the remembered
 * experiment, so opening an attachment does not collapse the tree.
 */
export function resolveLocalSampleFolder(
  activePath: string | undefined,
  lastExperimentDir: string | undefined,
  globalFolder: string
): { folder: string; lastExperimentDir?: string } {
  const dir = activePath ? getExperimentDir(activePath) : undefined;
  if (dir) return { folder: path.join(dir, 'resources', 'labsamples'), lastExperimentDir: dir };
  if (activePath && /\.md$/i.test(activePath)) {
    return { folder: noteLabsamplesFolder(activePath, globalFolder), lastExperimentDir };
  }
  if (lastExperimentDir) {
    return { folder: path.join(lastExperimentDir, 'resources', 'labsamples'), lastExperimentDir };
  }
  return { folder: activePath ? noteLabsamplesFolder(activePath, globalFolder) : globalFolder };
}

/**
 * Whether two labsamples folders are the same directory (separators, `./` and
 * case ignored). A vault-root note's local folder is the default global one.
 */
export function isSameSampleFolder(a: string, b: string): boolean {
  return path.normalizeForCompare(a).toLowerCase() === path.normalizeForCompare(b).toLowerCase();
}

/**
 * A note's own Local labsamples folder, or undefined when it has none because
 * {@link noteLabsamplesFolder} gives the Global folder (a vault-root note).
 * A sample found there is then Global, not Local (#189).
 */
export function noteLocalSampleFolder(documentPath: string, globalFolder?: string): string | undefined {
  const local = noteLabsamplesFolder(documentPath, globalFolder);
  return globalFolder && isSameSampleFolder(local, globalFolder) ? undefined : local;
}

/**
 * Load sample database from JSON files for a specific type
 */
export async function loadSamplesByType(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string
): Promise<Record<string, SampleRecord>> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);

  if (!(await fs.exists(filePath))) {
    return {};
  }

  let raw: Record<string, SampleRecord>;
  try {
    raw = JSON.parse(await fs.read(filePath)) as Record<string, SampleRecord>;
  } catch (error) {
    console.warn(`[labnoteo] Failed to load ${filePath}:`, error);
    return {};
  }

  // Phase 1-3b: one-time in-memory migration for vaults written before the
  // case-normalized de-dup fix. If keys collided only by case, converge them
  // and write the merged result straight back so the file self-heals.
  const { records, changed } = mergeCaseCollidingIds(raw);
  if (changed) {
    try {
      await saveSamplesByType(fs, labsamplesFolder, type, records);
    } catch (error) {
      console.warn(`[labnoteo] Failed to rewrite migrated ${filePath}:`, error);
    }
  }
  return records;
}

/**
 * The IDs of `labsamplesFolder`'s `{type}.json`, lower-cased, for telling a
 * reference to an unregistered sample (#210). Unlike {@link loadSamplesByType}
 * it never writes: highlighting a note must not change the registry. An empty
 * set when there is no file; undefined when it cannot be read (a merge
 * conflict left in it), so nothing is reported missing because of it.
 */
export async function loadSampleIds(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string
): Promise<Set<string> | undefined> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  if (!(await fs.exists(filePath))) return new Set();
  try {
    const data: unknown = JSON.parse(await fs.read(filePath));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    return new Set(Object.keys(data).map(id => id.toLowerCase()));
  } catch {
    return undefined;
  }
}

const isReferenceCatalogFile = (name: string, type: string): boolean =>
  name.startsWith(`${type}_`) && name.endsWith('.json');

/**
 * Whether `labsamplesFolder` holds a `{type}_*.json` product catalog, without
 * reading it: cheap enough for autocomplete, which runs on every keystroke
 * (#99). An empty catalog file still counts.
 */
export async function hasReferenceCatalog(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string
): Promise<boolean> {
  if (!labsamplesFolder || !(await fs.exists(labsamplesFolder))) return false;
  try {
    return (await fs.list(labsamplesFolder)).some((name) => isReferenceCatalogFile(name, type));
  } catch {
    return false;
  }
}

/**
 * Load reference DB: all JSON files matching {type}_{suffix}.json in labsamples folder.
 * Used for Reagent/Labware product catalog (read-only). Same record format as loadSamplesByType.
 */
export async function loadReferenceSamplesByType(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string
): Promise<Record<string, SampleRecord>> {
  const merged: Record<string, SampleRecord> = {};
  if (!(await fs.exists(labsamplesFolder))) {
    return merged;
  }
  let names: string[];
  try {
    names = await fs.list(labsamplesFolder);
  } catch (err) {
    console.warn(`[labnoteo] Failed to readdir ${labsamplesFolder}:`, err);
    return merged;
  }
  for (const name of names) {
    if (!isReferenceCatalogFile(name, type)) {
      continue;
    }
    const filePath = path.join(labsamplesFolder, name);
    try {
      const content = await fs.read(filePath);
      const data = JSON.parse(content) as Record<string, unknown>;
      for (const [id, record] of Object.entries(data)) {
        if (record && typeof record === 'object' && !merged[id]) {
          merged[id] = normalizeSampleRecord(record, type);
        }
      }
    } catch (err) {
      console.warn(`[labnoteo] Failed to load reference ${filePath}:`, err);
    }
  }
  return merged;
}

/**
 * Save sample database to JSON file for a specific type
 */
export async function saveSamplesByType(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  samples: Record<string, SampleRecord>
): Promise<void> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  // The adapter creates parent directories on demand and owns atomicity.
  await fs.write(filePath, JSON.stringify(samples, null, 2));
}

/**
 * Atomically create-or-update a single sample record in `{Type}.json`.
 *
 * This is the shared "merge one record" primitive behind the sidebar's
 * create/edit actions and the MCP `create_sample` tool, which previously each
 * hand-rolled a `load → mutate → save` round-trip that a concurrent 800ms
 * sample-sync could clobber. Running the read-modify-write inside `fs.modify`
 * closes that lost-update window per `{Type}.json`.
 *
 * `sources` semantics:
 *  - omit `sources` to preserve whatever the existing record had (sidebar edit),
 *  - pass an explicit array to set them (tool create binds the note as source).
 * `location` follows the same preserve-when-omitted rule (pass `null` to clear).
 * `alias` is overwritten; `description` replaces only the first description
 * (the one the edit prompt shows), keeping those other notes added. Every other
 * field — `discarded`, `descriptionSources` — is kept (#188).
 */
export async function upsertSampleRecord(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  id: string,
  fields: {
    alias: string | null;
    description: string | null;
    sources?: string[];
    location?: string | null;
  }
): Promise<void> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    const existing = records[id];
    const others = (existing?.descriptions ?? []).slice(1);
    records[id] = {
      ...existing,
      type,
      alias: fields.alias,
      descriptions: fields.description
        ? [fields.description, ...others.filter(d => d !== fields.description)]
        : others,
      sources: fields.sources ?? existing?.sources ?? [],
      location: fields.location !== undefined ? fields.location : (existing?.location ?? null),
    };
    return JSON.stringify(records, null, 2);
  });
}

/**
 * Atomically add to a sample record in `{Type}.json`, creating it if absent,
 * with the document-sync rules of {@link mergeSampleDatabases} (#73):
 *  - `alias` and `location` replace the stored value only when given,
 *  - `description` goes first and the earlier ones stay (no duplicates),
 *  - `sources` are added to the stored ones.
 * Used by the MCP `create_sample` tool, which an agent may call again for an
 * existing id without knowing what is already recorded. Other fields, such as
 * a `discarded` date, are kept (#188); the stored record's `discarded` value is
 * returned so the caller can say so.
 */
export async function mergeSampleRecord(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  id: string,
  fields: {
    alias?: string;
    description?: string;
    sources?: string[];
    location?: string;
  }
): Promise<{ discarded: string | null }> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  let discarded: string | null = null;
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    const existing = records[id];
    discarded = existing?.discarded ?? null;
    const descriptions = existing?.descriptions ?? [];
    const sources = existing?.sources ?? [];
    records[id] = {
      ...existing,
      type,
      alias: fields.alias !== undefined ? fields.alias : (existing?.alias ?? null),
      descriptions: fields.description
        ? [fields.description, ...descriptions.filter(d => d !== fields.description)]
        : descriptions,
      sources: [...sources, ...(fields.sources ?? []).filter(s => !sources.includes(s))],
      location: fields.location !== undefined ? fields.location : (existing?.location ?? null),
    };
    return JSON.stringify(records, null, 2);
  });
  return { discarded };
}

/**
 * Atomically delete one sample record from `{Type}.json`.
 *
 * Counterpart to {@link upsertSampleRecord} for the sidebar's delete action,
 * which previously hand-rolled a `load → delete → save` round-trip that a
 * concurrent sample-sync could resurrect. Returns whether a record was actually
 * removed; a missing file or id is not an error, since the caller's intent
 * (the record is gone) already holds.
 */
export async function deleteSampleRecord(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  id: string
): Promise<boolean> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  if (!(await fs.exists(filePath))) return false;

  let removed = false;
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    if (!(id in records)) return raw;
    delete records[id];
    removed = true;
    return JSON.stringify(records, null, 2);
  });
  return removed;
}

/**
 * Atomically store one sample record **verbatim** into `{Type}.json`.
 *
 * Unlike {@link upsertSampleRecord} (which rebuilds the record from scalar
 * alias/description fields and so collapses `descriptions` to a single entry),
 * this writes the given {@link SampleRecord} as-is, preserving multiple
 * `descriptions` and all `sources`. It is the "write" half of a scope move
 * (Local <-> Global): the caller loads the source record, `putSampleRecord`s it
 * into the target, then `deleteSampleRecord`s it from the source. The
 * read-modify-write runs inside `fs.modify` so a concurrent sample-sync cannot
 * clobber sibling ids in the same file.
 */
export async function putSampleRecord(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  id: string,
  record: SampleRecord
): Promise<void> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    records[id] = record;
    return JSON.stringify(records, null, 2);
  });
}

/** What a labsamples folder holds of the given types, see {@link inventorySampleFolder}. */
export interface SampleFolderInventory {
  /** Sample records over all `{Type}.json` files. */
  records: number;
  /** `{Type}_*.json` product catalog file names. */
  catalogs: string[];
}

/** The `{Type}.json` record files and `{Type}_*.json` catalogs of `types` in `folder`. */
async function sampleFolderFiles(
  fs: LabnoteFs,
  folder: string,
  types: readonly string[]
): Promise<{ recordTypes: string[]; catalogs: string[] }> {
  if (!folder || !(await fs.exists(folder))) return { recordTypes: [], catalogs: [] };
  const names = await fs.list(folder);
  const recordNames = new Set(types.map((t) => `${t}.json`));
  return {
    recordTypes: types.filter((t) => names.includes(`${t}.json`)),
    catalogs: names.filter((n) => !recordNames.has(n) && types.some((t) => isReferenceCatalogFile(n, t))),
  };
}

/**
 * Count the samples and catalog files of `types` in `folder`: what the Global
 * folder leaves behind when the setting points somewhere else (#101).
 */
export async function inventorySampleFolder(
  fs: LabnoteFs,
  folder: string,
  types: readonly string[]
): Promise<SampleFolderInventory> {
  const { recordTypes, catalogs } = await sampleFolderFiles(fs, folder, types);
  let records = 0;
  for (const type of recordTypes) records += Object.keys(await loadSamplesByType(fs, folder, type)).length;
  return { records, catalogs };
}

/** Result of {@link moveSampleFolder}. */
export interface SampleFolderMove {
  moved: number;
  /** `Type ID` of records left behind because `to` has the same ID. */
  skipped: string[];
  catalogsMoved: number;
  /** Catalog files left behind because `to` has a file of that name. */
  catalogsSkipped: string[];
}

/**
 * Move the samples of `types` from `from` to `to` record by record, never
 * overwriting: a record whose ID `to` already has (case ignored) and a catalog
 * file `to` already has stay where they are. Emptied record files and an
 * emptied `from` are removed.
 */
export async function moveSampleFolder(
  fs: LabnoteFs,
  from: string,
  to: string,
  types: readonly string[]
): Promise<SampleFolderMove> {
  const result: SampleFolderMove = { moved: 0, skipped: [], catalogsMoved: 0, catalogsSkipped: [] };
  if (isSameSampleFolder(from, to)) return result;
  const { recordTypes, catalogs } = await sampleFolderFiles(fs, from, types);
  for (const type of recordTypes) {
    const source = await loadSamplesByType(fs, from, type);
    const taken = new Set(Object.keys(await loadSamplesByType(fs, to, type)).map((id) => id.toLowerCase()));
    let left = 0;
    for (const [id, record] of Object.entries(source)) {
      if (taken.has(id.toLowerCase())) {
        result.skipped.push(`${type} ${id}`);
        left++;
        continue;
      }
      await putSampleRecord(fs, to, type, id, record);
      await deleteSampleRecord(fs, from, type, id);
      result.moved++;
    }
    if (left === 0) await fs.remove(path.join(from, `${type}.json`));
  }
  for (const name of catalogs) {
    if (await fs.exists(path.join(to, name))) {
      result.catalogsSkipped.push(name);
      continue;
    }
    await fs.write(path.join(to, name), await fs.read(path.join(from, name)));
    await fs.remove(path.join(from, name));
    result.catalogsMoved++;
  }
  // The samples have moved; a folder that will not go only leaves an empty
  // directory behind, which must not turn the whole move into a failure.
  try {
    await fs.rmdir(from);
  } catch {
    // ignore
  }
  return result;
}

/**
 * Save samples extracted from a document to JSON files
 * Merges with existing data. Samples that exist in Global are not re-added to Local
 * (so after Move to Global, saving the document does not re-add the sample to Local).
 */
export async function saveSamplesFromDocument(
  fs: LabnoteFs,
  documentPath: string,
  documentText: string,
  globalLabsamplesFolder?: string,
  additionalTypes?: string[]
): Promise<void> {
  const labsamplesFolder = noteLabsamplesFolder(documentPath, globalLabsamplesFolder);
  const sourceFile = path.basename(documentPath);

  // Extract samples from document
  const samples = extractSampleInfoFromText(documentText, additionalTypes);

  if (samples.length === 0) {
    return;
  }

  // Build new database from extracted samples
  const newDb = buildSampleDatabase(samples, sourceFile);
  const references = samples.filter((s) => !s.definition);
  const referenceOnly = new Set(references.map((s) => sampleReferenceKey(s.type, s.id)));
  // References whose id is found in a product catalog may seed a new local
  // record (the sidebar/autocomplete catalog pick flow). Plain references to an
  // unknown id do not — see mergeSampleDatabases' `seedable`.
  const seedable = new Set<string>();

  const skipGlobalDedupe =
    Boolean(globalLabsamplesFolder) && isSameSampleFolder(labsamplesFolder, globalLabsamplesFolder!);

  for (const type of Object.keys(newDb)) {
    assertSafeSampleType(type);

    // Do not keep in Local samples that exist in Global (avoid re-adding after Move to Global).
    // When workspace root is the experiment folder, local and global paths are the same — skip
    // or we would load the same JSON as "global" and delete every merged id.
    //
    // This global read is hoisted OUT of the atomic callback below: `fs.modify`'s
    // updater must be synchronous, so the cross-file lookup is awaited first and
    // its ids captured into a Set the pure callback can consult.
    let globalIds: Set<string> | null = null;
    if (globalLabsamplesFolder && !skipGlobalDedupe) {
      const globalSamples = await loadSamplesByType(fs, globalLabsamplesFolder, type);
      globalIds = new Set(Object.keys(globalSamples));
    }

    // A catalog-type reference that seeds a new local record takes the
    // catalog's alias instead of the text after `ID;` (which may be the rest of
    // the sentence). Same folders as the catalog search that inserted it.
    const catalogRefs = isCatalogSampleType(type)
      ? references.filter((s) => s.type === type)
      : [];
    if (catalogRefs.length > 0) {
      const catalogFolder = getExperimentLabsamplesFolder(documentPath) ?? labsamplesFolder;
      const catalog = {
        ...(globalLabsamplesFolder
          ? await loadReferenceSamplesByType(fs, globalLabsamplesFolder, type)
          : {}),
        ...(await loadReferenceSamplesByType(fs, catalogFolder, type)),
      };
      for (const ref of catalogRefs) {
        const entry = catalog[ref.id];
        if (!entry) continue;
        newDb[type][ref.id].alias = entry.alias;
        newDb[type][ref.id].descriptions = [];
        seedable.add(sampleReferenceKey(type, ref.id));
      }
    }

    const merge = (existing: Record<string, SampleRecord>): Record<string, SampleRecord> => {
      const merged = mergeSampleDatabases(
        { [type]: existing },
        { [type]: newDb[type] },
        { referenceOnly, seedable }
      );
      if (globalIds) {
        for (const id of globalIds) {
          if (merged[type][id]) {
            delete merged[type][id];
          }
        }
      }
      return merged[type];
    };

    const filePath = path.join(labsamplesFolder, `${type}.json`);
    // Referencing only Global or unknown samples adds nothing here; creating
    // the file anyway left an empty `{}` registry in the experiment (#82).
    if (!(await fs.exists(filePath)) && Object.keys(merge({})).length === 0) continue;
    await fs.modify(filePath, (raw) => JSON.stringify(merge(parseSampleRecords(raw)), null, 2));
  }
}

/**
 * Reconcile a document's `@type;id;...` definitions against the on-disk
 * sample JSONs. For every record whose `sources` includes this document's
 * basename, drop the basename when the document no longer defines (type, id).
 *
 * The record itself is NEVER deleted — a sample stays in the registry (with its
 * alias, descriptions and location) even after the last note that referenced it
 * is removed. Samples created the two different ways (an `@type;` definition in
 * a note, or the sidebar/autocomplete menu) are therefore treated identically:
 * deleting a note never erases sample data, only the usage record.
 *
 * Records that started with empty `sources` (e.g. user-created via the
 * tree's Add Sample command before they have been written into any
 * document) are left untouched as before.
 *
 * Both the document's local labsamples folder and the optional global
 * folder are processed; if both paths resolve to the same directory
 * (e.g. workspaceRoot is the experiment folder, mirroring
 * `saveSamplesFromDocument`'s `skipGlobalDedupe` guard) the global pass
 * is skipped so a source is not dropped twice.
 */
export async function removeSourcesForDocument(
  fs: LabnoteFs,
  documentPath: string,
  documentText: string,
  globalLabsamplesFolder?: string,
  additionalTypes?: string[]
): Promise<void> {
  const localFolder = noteLabsamplesFolder(documentPath, globalLabsamplesFolder);
  const documentBasename = path.basename(documentPath);

  // Set of "type|id" pairs still defined in the document. Anything *not*
  // in this set is a candidate for source removal in scopes whose existing
  // record has this document listed as a source.
  const liveDefs = new Set<string>();
  for (const sample of extractSampleInfoFromText(documentText, additionalTypes)) {
    liveDefs.add(`${sample.type}|${sample.id}`);
  }

  const allTypes: string[] = [
    ...SAMPLE_TYPES,
    ...(additionalTypes ?? []).filter(
      (t) => !(SAMPLE_TYPES as readonly string[]).includes(t)
    ),
  ];

  // Mirror saveSamplesFromDocument's skipGlobalDedupe logic so we don't
  // process the same folder twice and double-report removals.
  const scopes: Array<{ scope: 'local' | 'global'; folder: string }> = [
    { scope: 'local', folder: localFolder },
  ];
  if (globalLabsamplesFolder && !isSameSampleFolder(localFolder, globalLabsamplesFolder)) {
    scopes.push({ scope: 'global', folder: globalLabsamplesFolder });
  }

  for (const { folder } of scopes) {
    if (!(await fs.exists(folder))) continue;

    for (const type of allTypes) {
      assertSafeSampleType(type);
      const filePath = path.join(folder, `${type}.json`);
      // Skip types with no on-disk file so we never create an empty `{Type}.json`
      // just to scan it.
      if (!(await fs.exists(filePath))) continue;

      // Atomic read-modify-write per file: the whole scan-and-prune runs inside
      // the `fs.modify` callback so a concurrent sample-sync can't clobber it.
      await fs.modify(filePath, (raw) => {
        const samples = parseSampleRecords(raw);
        let mutated = false;

        for (const id of Object.keys(samples)) {
          const record = samples[id];
          // Guard: tree-created records (sources === []) are off-limits to
          // automatic cleanup. They only exist in the tree until a markdown
          // file defines them, and silently deleting them on save would
          // erase data the user explicitly entered through the UI.
          if (record.sources.length === 0) continue;
          if (!record.sources.includes(documentBasename)) continue;
          if (liveDefs.has(`${type}|${id}`)) continue;

          // Drop only the usage record; keep the sample itself even when this
          // was its last source, so sample data survives a note deletion.
          record.sources = record.sources.filter((s) => s !== documentBasename);
          if (record.descriptionSources && documentBasename in record.descriptionSources) {
            delete record.descriptionSources[documentBasename];
          }
          mutated = true;
        }

        // Nothing changed → return the original bytes so we don't needlessly
        // rewrite/reformat a file we didn't touch.
        return mutated ? JSON.stringify(samples, null, 2) : raw;
      });
    }
  }
}

/**
 * Return the paths of the documents that reference `(type, id)` — either an
 * `@type;` definition or a plain `id;alias` reference, matched ignoring id case.
 * Used by the sidebar delete action to refuse deleting a sample that the body
 * still uses (otherwise the next edit resurrects a bare record, #54, and the
 * registry would silently drift from the notes).
 */
export function findSampleUsages(
  docs: ReadonlyArray<{ path: string; text: string }>,
  type: string,
  id: string,
  additionalTypes?: string[]
): string[] {
  const idLower = id.toLowerCase();
  const hits: string[] = [];
  for (const doc of docs) {
    const samples = extractSampleInfoFromText(doc.text, additionalTypes);
    if (samples.some((s) => s.type === type && s.id.toLowerCase() === idLower)) {
      hits.push(doc.path);
    }
  }
  return hits;
}

/** One Local sample to bring along with a note moved to another experiment (#97). */
export interface SampleAdoption {
  type: string;
  /** The id as the old registry keys it. */
  id: string;
  /** What to write into the new experiment's registry. */
  record: SampleRecord;
  /** `copy` when a note left in the old experiment still uses it. */
  action: 'move' | 'copy';
}

/**
 * The `{Type}.json` types the samples in `text` belong to, so a caller loads
 * only the registries a note can use.
 */
export function sampleTypesInText(text: string, additionalTypes?: string[]): string[] {
  return [...new Set(extractSampleInfoFromText(text, additionalTypes).map((s) => s.type))];
}

const findRecordIgnoringCase = (
  records: Record<string, SampleRecord> | undefined,
  id: string
): [string, SampleRecord] | undefined => {
  if (!records) return undefined;
  if (records[id]) return [id, records[id]];
  const lower = id.toLowerCase();
  return Object.entries(records).find(([key]) => key.toLowerCase() === lower);
};

/**
 * Plan bringing a moved note's Local samples into the experiment it moved to
 * (#97). A note reads Local samples from its own experiment's registry, so
 * after a move the ones it used stay behind and its references stop resolving.
 *
 * - Only ids the note's text uses are considered.
 * - An id already in the new experiment's or the Global registry resolves as
 *   is and is skipped.
 * - An id `usedElsewhere` (keys from {@link sampleReferenceKey}) is still used
 *   by a note left in the old experiment, so it is copied rather than moved.
 *   This is read from note text, not `sources`: `sources` only grows when a
 *   note is saved, so a note copied in and never edited is missing from it.
 */
export function planLocalSampleAdoption(opts: {
  noteText: string;
  /** File name of the note after the move; becomes the new record's source. */
  newName: string;
  from: SampleDatabase;
  to: SampleDatabase;
  global: SampleDatabase;
  usedElsewhere: ReadonlySet<string>;
  additionalTypes?: string[];
}): SampleAdoption[] {
  const out: SampleAdoption[] = [];
  const seen = new Set<string>();
  for (const s of extractSampleInfoFromText(opts.noteText, opts.additionalTypes)) {
    const key = sampleReferenceKey(s.type, s.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (findRecordIgnoringCase(opts.to[s.type], s.id)) continue;
    if (findRecordIgnoringCase(opts.global[s.type], s.id)) continue;
    const found = findRecordIgnoringCase(opts.from[s.type], s.id);
    if (!found) continue;
    const [id, record] = found;
    out.push({
      type: s.type,
      id,
      record: { ...record, sources: [opts.newName] },
      action: opts.usedElsewhere.has(key) ? 'copy' : 'move',
    });
  }
  return out;
}

/**
 * Atomically drop `sourceName` from one record's `sources`, leaving every other
 * field and id in the file as it is at write time. Returns whether it changed.
 */
export async function removeSampleSource(
  fs: LabnoteFs,
  labsamplesFolder: string,
  type: string,
  id: string,
  sourceName: string
): Promise<boolean> {
  assertSafeSampleType(type);
  const filePath = path.join(labsamplesFolder, `${type}.json`);
  if (!(await fs.exists(filePath))) return false;

  let changed = false;
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    const record = records[id];
    const sources = Array.isArray(record?.sources) ? record.sources : [];
    if (!record || !sources.includes(sourceName)) return raw;
    records[id] = { ...record, sources: sources.filter((s) => s !== sourceName) };
    changed = true;
    return JSON.stringify(records, null, 2);
  });
  return changed;
}

/**
 * Get the Global labsamples folder path (workspace root)
 */
export function getGlobalLabsamplesFolder(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'resources', 'labsamples');
}

/**
 * `records` with the note names in `sources` and `descriptionSources` renamed
 * by `renames` (old basename → new basename), after a note was renamed or the
 * workflows renumbered (#149). Without this the registry keeps pointing at
 * names that are gone, and the next save adds the new name beside them. A
 * rename onto a name already listed merges into it. `changed` is false when
 * no record mentions an old name.
 */
export function renameSampleSources(
  records: Record<string, SampleRecord>,
  renames: ReadonlyMap<string, string>
): { records: Record<string, SampleRecord>; changed: boolean } {
  const out: Record<string, SampleRecord> = JSON.parse(JSON.stringify(records));
  let changed = false;
  for (const record of Object.values(out)) {
    if (record.sources.some((s) => renames.has(s))) {
      const next: string[] = [];
      for (const s of record.sources) {
        const name = renames.get(s) ?? s;
        if (!next.includes(name)) next.push(name);
      }
      record.sources = next;
      changed = true;
    }
    if (record.descriptionSources && Object.keys(record.descriptionSources).some((s) => renames.has(s))) {
      record.descriptionSources = Object.fromEntries(
        Object.entries(record.descriptionSources).map(([s, d]) => [renames.get(s) ?? s, d])
      );
      changed = true;
    }
  }
  return { records: out, changed };
}

/**
 * Apply {@link renameSampleSources} to every `{Type}.json` of `types` in
 * `folder`. Files that mention none of the old names are not rewritten.
 * Returns how many files changed.
 */
export async function renameSampleSourcesInFolder(
  fs: LabnoteFs,
  folder: string,
  renames: ReadonlyMap<string, string>,
  types: readonly string[]
): Promise<number> {
  if (renames.size === 0) return 0;
  const { recordTypes } = await sampleFolderFiles(fs, folder, types);
  let files = 0;
  for (const type of recordTypes) {
    assertSafeSampleType(type);
    await fs.modify(path.join(folder, `${type}.json`), (raw) => {
      const { records, changed } = renameSampleSources(parseSampleRecords(raw), renames);
      if (!changed) return raw;
      files++;
      return JSON.stringify(records, null, 2);
    });
  }
  return files;
}

/**
 * Mark sample `id` discarded on `date`, or in use again with `null` (#158).
 * Returns false when the record is not in `folder`.
 */
export async function setSampleDiscarded(
  fs: LabnoteFs,
  folder: string,
  type: string,
  id: string,
  date: string | null
): Promise<boolean> {
  assertSafeSampleType(type);
  const filePath = path.join(folder, `${type}.json`);
  if (!(await fs.exists(filePath))) return false;
  let found = false;
  await fs.modify(filePath, (raw) => {
    const records = parseSampleRecords(raw);
    const record = records[id];
    if (!record) return raw;
    found = true;
    if (date) record.discarded = date;
    else delete record.discarded;
    return JSON.stringify(records, null, 2);
  });
  return found;
}

/**
 * The `resources/labsamples` folders of every experiment (`labnote/###_*`)
 * under `root` that have one, in folder order (#169, #173): where a sample
 * that is no experiment's Local sample by the open note may still be.
 */
export async function listExperimentSampleFolders(fs: LabnoteFs, root: string): Promise<string[]> {
  const labnote = path.join(root, 'labnote');
  if (!(await fs.exists(labnote))) return [];
  const out: string[] = [];
  for (const name of [...(await fs.list(labnote))].sort()) {
    if (!/^\d{3}_/.test(name)) continue;
    const folder = path.join(labnote, name, 'resources', 'labsamples');
    if (await fs.exists(folder)) out.push(folder);
  }
  return out;
}
