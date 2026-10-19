/**
 * Platform-neutral sample autocomplete + highlighting logic.
 *
 * The VS Code `SampleCompletionProvider` and the Obsidian `EditorSuggest` share
 * the same trigger detection, candidate formatting and ID-range scanning. Those
 * pure pieces live here (fully unit-tested) so each platform only writes the
 * thin UI adapter around them.
 */
import { buildSampleIdPattern, escapeSamplePipes } from '../lib/sampleUtils';
import { findSampleReferenceSpans } from '../lib/sampleStorage';

/** A resolved autocomplete trigger parsed from the text before the cursor. */
export interface SampleTrigger {
  /** Canonical `@type;` prefix (always lower-case type + `;`). */
  fullPrefix: string;
  /** Lower-cased search term typed after the delimiter. */
  searchTerm: string;
  /** Concrete sample types to search (expanded for `@sample`). */
  typesToSearch: string[];
  /** 0-based column where the `@` begins (for range replacement). */
  startCol: number;
}

/** A loaded sample record candidate (subset needed for completion). */
export interface SampleCandidate {
  id: string;
  alias: string | null;
  description?: string;
  /** Which registry the record came from, shown next to it (#109). */
  scope?: 'local' | 'global';
}

/** A ready-to-render completion entry. */
export interface SampleCompletionEntry {
  type: string;
  id: string;
  label: string;
  insertText: string;
  scope?: 'local' | 'global';
}

/**
 * Parse the text before the cursor into a {@link SampleTrigger}, or undefined
 * when there is no recognised `@type` / `@sample` / `@item` trigger.
 *
 * The delimiter (`;` or `:`) is optional so completion can fire the moment the
 * type name is typed, before the user adds the separator.
 */
export function parseSampleTrigger(
  linePrefix: string,
  types: readonly string[]
): SampleTrigger | undefined {
  if (!linePrefix.includes('@')) return undefined;

  // `.*` (was `\S*`) so the search term may contain spaces — otherwise aliases
  // like "my plasmid" could not be searched after `@type;`.
  // Unicode letters (not `\w`, which is ASCII-only even with `u`) so custom
  // types such as `배지` trigger too (#62).
  const m = linePrefix.match(/@([\p{L}\p{N}_]+)[;:]?(.*)$/u);
  if (!m || m.index === undefined) return undefined;

  const rawType = m[1].toLowerCase();
  const searchTerm = m[2].toLowerCase();
  const startCol = m.index;
  const fullPrefix = `@${rawType};`;

  let typesToSearch: string[];
  if (rawType === 'sample') {
    typesToSearch = [...types];
  } else if (rawType === 'item') {
    const labware = types.find(t => t.toLowerCase() === 'labware');
    if (!labware) return undefined;
    typesToSearch = [labware];
  } else {
    const match = types.find(t => t.toLowerCase() === rawType);
    if (!match) return undefined;
    typesToSearch = [match];
  }

  return { fullPrefix, searchTerm, typesToSearch, startCol };
}

/** Format the display label for a candidate: `ID`, `ID (alias)`, `+ - desc`. */
export function buildSampleCompletionLabel(candidate: SampleCandidate): string {
  let label = candidate.id;
  if (candidate.alias) label = `${label} (${candidate.alias})`;
  if (candidate.description) label = `${label} - ${candidate.description}`;
  return label;
}

/** Text inserted on accept: `ID` or `ID;alias`. */
export function buildSampleInsertText(candidate: SampleCandidate): string {
  return candidate.alias ? `${candidate.id};${escapeSamplePipes(candidate.alias)}` : candidate.id;
}

/**
 * Build completion entries for a trigger from already-loaded records (keyed by
 * type). Filtering by the trigger's search term is applied against the label.
 */
export function buildSampleCompletionEntries(
  trigger: SampleTrigger,
  recordsByType: Record<string, SampleCandidate[]>
): SampleCompletionEntry[] {
  const entries: SampleCompletionEntry[] = [];
  for (const type of trigger.typesToSearch) {
    const records = recordsByType[type] ?? [];
    for (const candidate of records) {
      const label = buildSampleCompletionLabel(candidate);
      if (trigger.searchTerm && !label.toLowerCase().includes(trigger.searchTerm)) {
        continue;
      }
      entries.push({
        type,
        id: candidate.id,
        label,
        insertText: buildSampleInsertText(candidate),
        ...(candidate.scope ? { scope: candidate.scope } : {}),
      });
    }
  }
  return entries;
}

/** A highlighted sample-ID span (half-open `[start, end)` character offsets). */
export interface SampleIdRange {
  start: number;
  end: number;
  type: string;
}

/**
 * Scan `text` for sample IDs of the given types and return their character
 * ranges (for CM6 decorations / reading-mode post-processing). Ranges are
 * returned sorted by start offset.
 */
export function findSampleIdRanges(text: string, types: readonly string[]): SampleIdRange[] {
  const ranges: SampleIdRange[] = [];
  for (const type of types) {
    const re = buildSampleIdPattern(type);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, type });
      if (match.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** A sample reference located at a specific column of a line. */
export interface SampleReferenceAt {
  type: string;
  id: string;
  start: number;
  end: number;
}

/**
 * Find the sample reference that the cursor column `ch` sits in on a single
 * `line` (boundaries inclusive). Returns the type/id and its range, or null.
 * Used by the editor "Go to definition" command and context menu.
 *
 * The id token is tried first and its range returned. Otherwise the whole
 * reference counts, alias included (`DNA-1;sampleA`, #136), and its range is
 * returned; where references overlap, the one starting nearest before `ch` wins.
 */
export function findSampleReferenceAt(
  line: string,
  ch: number,
  types: readonly string[]
): SampleReferenceAt | null {
  for (const range of findSampleIdRanges(line, types)) {
    if (ch >= range.start && ch <= range.end) {
      return {
        type: range.type,
        id: line.slice(range.start, range.end),
        start: range.start,
        end: range.end,
      };
    }
  }
  let hit: SampleReferenceAt | null = null;
  for (const span of findSampleReferenceSpans(line, types)) {
    if (span.start > ch) break;
    if (ch <= span.end) hit = { type: span.type, id: span.id, start: span.start, end: span.end };
  }
  return hit;
}
