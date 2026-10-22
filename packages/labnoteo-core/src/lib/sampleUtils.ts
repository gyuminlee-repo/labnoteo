/**
 * Sample utility functions for Lab Note Editor
 * Pure functions and constants that can be shared between Extension and Webview
 */

import { escapeRegExp } from './regexUtils';

/**
 * Sample types available
 */
export const SAMPLE_TYPES = ['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware', 'Other'] as const;
export type SampleType = typeof SAMPLE_TYPES[number];

/**
 * Canonical sample-id regex segment used everywhere: storage extraction,
 * document highlighting, SampleInfoPanel replace. Kept as (?:-\d+)* so that
 * collision-resolved ids (e.g. DNA-1737000000000-3) still match, and future
 * multi-segment counters do not drift the three consumers apart.
 *
 * The returned RegExp carries the `g` flag so callers can use `match()` /
 * `replace()` directly; each call returns a *new* instance to avoid the
 * stateful `lastIndex` footgun on shared regex objects.
 */
export function buildSampleIdPattern(type: string): RegExp {
  // `\b` is ASCII-only, so before a non-ASCII type (`배지`) it would require an
  // ASCII word character and never match at line start or after a space (#62).
  const lead = /^\w/.test(type) ? '\\b' : '';
  return new RegExp(`${lead}${escapeRegExp(type)}-\\d+(?:-\\d+)*\\b`, 'g');
}

/**
 * `id` as a valid `{type}-<number>[-<number>…]` sample id with the type prefix
 * in its canonical spelling (`equip-3` → `Equip-3`), or undefined when it does
 * not have that shape. The check ignores case but the result does not: the
 * highlighting pattern above is case-sensitive, so a lower-cased prefix would
 * never be recognised in the note.
 */
export function normalizeSampleId(type: string, id: string): string | undefined {
  const m = new RegExp(`^${escapeRegExp(type)}(-\\d+(?:-\\d+)*)$`, 'i').exec(id.trim());
  return m ? `${type}${m[1]}` : undefined;
}

/** The known type spelled like `type` ignoring case, or undefined. */
export function canonicalSampleType(type: string, types: readonly string[]): string | undefined {
  const lower = type.trim().toLowerCase();
  return types.find(t => t.toLowerCase() === lower);
}

/** `@sample` and `@item` are autocomplete keywords, never a type of their own. */
const RESERVED_SAMPLE_TYPE_NAMES = ['sample', 'item'];

/**
 * Whether `name` works as a custom sample type. `@type;` autocompletion reads
 * only letters, digits and `_` (see `parseSampleTrigger`), so a type with a
 * space or `-` is listed everywhere but never completes in a note (#81).
 */
export function isValidSampleTypeName(name: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(name) && !RESERVED_SAMPLE_TYPE_NAMES.includes(name.toLowerCase());
}

const isAsciiAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * Whether Obsidian would read a `_` in `name` as the start of italics (#252).
 * A `_` joins words only between ASCII letters and digits: `Cell_Line` is one
 * word, while `무세포_용해물` is shown as italics in the reading view and the
 * type no longer reads as what the note says.
 */
export function underscoreTurnsItalic(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== '_') continue;
    if (!isAsciiAlnum(name[i - 1]) || !isAsciiAlnum(name[i + 1])) return true;
  }
  return false;
}

/**
 * `name` as a type name that autocompletes and does not turn italic: runs of
 * other characters become `_` between ASCII letters and digits (`Cell Line` →
 * `Cell_Line`) and go away elsewhere (`무세포 용해물` → `무세포용해물`).
 */
export function suggestSampleTypeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, (run: string, at: number, whole: string) =>
    isAsciiAlnum(whole[at - 1]) && isAsciiAlnum(whole[at + run.length]) ? '_' : ''
  );
}

/**
 * Escape every `|` not already written as `\|`. A bare pipe splits a Markdown
 * table cell and ends a sample field, while `\|` renders as `|` and is read
 * back as part of the alias or description (#72).
 */
export function escapeSamplePipes(text: string): string {
  return text.replace(/(?<!\\)\|/g, '\\|');
}

/**
 * A Markdown table of `rows` under `headers` (#152). A `|` in a cell is
 * escaped and a line break becomes a space, so a cell cannot split the row.
 */
export function buildMarkdownTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const cell = (text: string): string => escapeSamplePipes(text.replace(/\r?\n/g, ' ').trim());
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  return [line(headers), `|${headers.map(() => ' --- ').join('|')}|`, ...rows.map(line)].join('\n');
}

/**
 * Whether an alias holds `;` or `:`, which end the alias in a note (`ID;alias;
 * description`), so the rest would be read back as a description (#98).
 */
export function hasSampleAliasSeparator(alias: string): boolean {
  return /[;:]/.test(alias);
}

/**
 * Why `alias` cannot be a sample alias, or undefined when it can:
 * - `'separator'`: `;` or `:` ends the alias in a note (#98);
 * - `'markdown'`: `#`, `[[`, `]]`, `*`, `_` or a backtick makes Markdown read
 *   the reference as a tag, link, emphasis or code, so it is not highlighted
 *   or read back (#168; `_` next to Korean turns italic, #225).
 * Aliases registered before these rules are left as they are; only new ones
 * are checked. {@link hasSampleAliasSeparator} stays narrow on purpose: it
 * parses older definitions.
 */
export function sampleAliasProblem(alias: string): 'separator' | 'markdown' | undefined {
  if (hasSampleAliasSeparator(alias)) return 'separator';
  if (/#|\[\[|\]\]|\*|_|`/.test(alias)) return 'markdown';
  return undefined;
}

/**
 * `name` rewritten into an alias {@link sampleAliasProblem} accepts, or
 * undefined when nothing is left. Used where nobody can be asked to fix it:
 * samples a model extracted (#61) and items pulled from partbank, whose names
 * routinely carry `_` (`pTrc99A_GFP`).
 */
export function toSampleAlias(name: string): string | undefined {
  return (
    name
      .replace(/[;:_]/g, '-')
      .replace(/\[\[|\]\]/g, '')
      .replace(/[#*`]/g, '')
      .trim() || undefined
  );
}

/** Whether a description holds `;`, which ends it in a note (#98). */
export function hasSampleDescriptionSeparator(description: string): boolean {
  return description.includes(';');
}

/**
 * Build the `;alias;description` suffix of a sample definition string while
 * keeping field positions stable.
 *
 * A sample definition is `@type;ID;alias;description`. Appending a plain
 * `;${description}` whenever the alias is empty would slide the description into
 * the alias slot (`@type;ID;description`). To prevent that, when a description
 * is present the alias slot is always emitted — empty if there is no alias
 * (`;;description`). Whitespace-only values are treated as absent.
 */
export function buildSampleDefSuffix(
  alias?: string | null,
  description?: string | null
): string {
  const a = alias && alias.trim() ? escapeSamplePipes(alias) : '';
  const d = description && description.trim() ? escapeSamplePipes(description) : '';
  if (!a && !d) return '';
  if (!d) return `;${a}`;
  return `;${a};${d}`;
}

/**
 * Build a full sample *definition* string: `@type;ID[;alias[;description]]`.
 *
 * The type prefix is lower-cased (matching the `@dna;` completion/highlight
 * convention) while the ID is kept verbatim. Alias/description positions are
 * kept stable via {@link buildSampleDefSuffix}. Shared by the Obsidian
 * autocomplete "create" flow and the sidebar "insert definition" action so both
 * emit an identical, re-syncable definition.
 */
export function buildSampleDefinitionText(
  type: string,
  id: string,
  alias?: string | null,
  description?: string | null
): string {
  return `@${type.toLowerCase()};${id}${buildSampleDefSuffix(alias, description)}`;
}

/**
 * Build a sample *reference* string: `id;alias` when an alias is present, else
 * the bare `id`. Matches the format of the existing completion insert text
 * (`buildSampleInsertText` in `sample/sampleSuggest`). Used when inserting a
 * reference into a document (registry-first: definitions live in JSON, the
 * document only references them).
 */
export function buildSampleReferenceText(id: string, alias?: string | null): string {
  return alias && alias.trim() ? `${id};${escapeSamplePipes(alias.trim())}` : id;
}

/**
 * Whether a type can have a read-only `{Type}_*.json` catalog beside its
 * registry.
 *
 * Every type can. It used to be only Reagent, Labware and Equip, which were
 * the types with vendor catalogs, but a downloaded partbank catalog is a
 * catalog of DNA parts, plasmids and primers. What decides whether a catalog
 * is offered is now simply whether such a file exists (`hasReferenceCatalog`),
 * so a vault without one sees the menus it always did.
 *
 * Kept as a function rather than removed: it names the rule at its six call
 * sites, and a type that must not take one would otherwise have no place to
 * be excluded.
 */
export function isCatalogSampleType(_type: string): boolean {
  return true;
}

/**
 * Decide which synthetic autocomplete actions to offer for a parsed sample
 * trigger. Mirrors the VS Code completion provider:
 * - a concrete authored single type gets `generate` ("Generate new ID") and
 *   `manual` ("Enter info") actions,
 * - a concrete catalog type (Reagent/Labware/Equip) additionally gets `catalog`
 *   ("Search catalog") when a catalog file exists (`catalogAvailable`, #99):
 *   picking a curated product is preferred, but a vault without a catalog
 *   must still be able to register one (#40),
 * - `@sample` expands to many types, so it gets no actions.
 *
 * Typed structurally (not against `SampleTrigger`) to avoid a module cycle
 * between `lib/sampleUtils` and `sample/sampleSuggest`.
 */
export function sampleSuggestActions(
  trigger: { typesToSearch: readonly string[] },
  opts: { catalogAvailable?: boolean } = {}
): { generate: boolean; manual: boolean; catalog: boolean } {
  const specific = trigger.typesToSearch.length === 1 ? trigger.typesToSearch[0] : null;
  if (!specific) return { generate: false, manual: false, catalog: false };
  const catalog = isCatalogSampleType(specific) && (opts.catalogAvailable ?? true);
  return { generate: true, manual: true, catalog };
}

/**
 * Colors for each sample type (used in highlighting and UI)
 */
export const sampleTypeColors: Record<SampleType, string> = {
  DNA: '#FFB6C1',
  RNA: '#ADD8E6',
  Plasmid: '#98FB98',
  Reagent: '#FFD700',
  Primer: '#FF69B4',
  Protein: '#DDA0DD',
  Equip: '#FFA07A',
  Labware: '#D8BFD8',
  Other: '#B0BEC5',
};

/**
 * Fallback color for user-defined custom types that do not have an explicit
 * entry in `sampleTypeColors`. Kept in sync with the webview's default.
 */
export const CUSTOM_SAMPLE_TYPE_FALLBACK_COLOR = '#607D8B';

/**
 * Single source of truth for "what sample types exist right now and what
 * colors do they use" on the extension side. Previously the `SectionEditor`
 * provider maintained two parallel helpers (`getAvailableTypes`,
 * `getSampleTypeColorMap`) that each re-read the user's
 * `customSampleTypes` setting and applied slightly different merge
 * rules. Having a single entry point keeps the init payload consistent and
 * guarantees the webview sees `types` and `colors` that agree — every built-in
 * + custom type ends up in both collections, with a stable fallback color so
 * no lookup ever returns undefined.
 */
export interface SampleDisplayMeta {
  types: string[];
  colors: Record<string, string>;
}

export function getSampleDisplayMeta(customTypes: readonly string[] = []): SampleDisplayMeta {
  const builtins = SAMPLE_TYPES as readonly string[];
  const merged = [...builtins];
  for (const t of customTypes) {
    if (t && !merged.includes(t)) merged.push(t);
  }
  const colors: Record<string, string> = { ...(sampleTypeColors as Record<string, string>) };
  for (const t of merged) {
    if (!(t in colors)) colors[t] = CUSTOM_SAMPLE_TYPE_FALLBACK_COLOR;
  }
  return { types: merged, colors };
}

// Counter for generating unique IDs within the same millisecond
let idCounter = 0;
let lastTimestamp = 0;

/**
 * Generate a unique sample ID using timestamp format
 * Ensures uniqueness even when called multiple times in the same millisecond
 * Format: {TYPE}-{timestamp} or {TYPE}-{timestamp}-{counter} if same millisecond
 */
export function generateSampleId(type: string): string {
  const timestamp = Date.now();
  if (timestamp === lastTimestamp) {
    idCounter++;
  } else {
    idCounter = 0;
    lastTimestamp = timestamp;
  }
  return `${type}-${timestamp}${idCounter > 0 ? `-${idCounter}` : ''}`;
}

/**
 * Reset the ID counter (useful for testing)
 */
export function resetIdCounter(): void {
  idCounter = 0;
  lastTimestamp = 0;
}

