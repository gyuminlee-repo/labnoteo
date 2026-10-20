/**
 * Extracts GFM pipe tables from a Markdown body and converts them to CSV.
 * Pure functions, no `vscode` import.
 */
import { stepFence, type OpenFence } from '../sections/sectionEdit';

export interface CsvTable {
  /** 0-based index of the table within the source document (0 = first table). */
  index: number;
  /** Rows including the header row (the `---` separator row is dropped). */
  rows: string[][];
}

const SEPARATOR_ROW_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function stripEdgePipes(line: string): string {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s;
}

/** Splits a single pipe-table row into cells, honoring `\|` as an escaped literal pipe. */
function splitTableRow(line: string): string[] {
  const stripped = stripEdgePipes(line);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '\\' && stripped[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells.map(cell => stripInlineFormatting(cell.replace(/<br\s*\/?>/gi, '\n')));
}

/** A character that is part of a word for `_` emphasis, which may not open or close inside one. */
const WORD = '[\\p{L}\\p{N}_]';
const CODE_SPAN_RE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
const STRIKE_RE = /([ \t]*)~~(?=\S)[\s\S]*?\S~~([ \t]*)/g;
const STRONG_STAR_RE = /\*\*(?=[^\s*])([\s\S]*?[^\s\\])\*\*/g;
const STRONG_UNDERSCORE_RE = new RegExp(`(^|[^\\p{L}\\p{N}_\\\\])__(?=\\S)([\\s\\S]*?\\S)__(?!${WORD})`, 'gu');
const EM_STAR_RE = /(^|[^*\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*(?!\*)/g;
const EM_UNDERSCORE_RE = new RegExp(`(^|[^\\p{L}\\p{N}_\\\\])_(?=[^\\s_])([^_]*?[^\\s_\\\\])_(?!${WORD})`, 'gu');

/**
 * A cell's text without the inline Markdown the reading view hides (#139):
 * bold and italic marks and code backticks go, struck-through text goes with
 * its marks (`~~0.10~~ 0.12` → `0.12`). Code contents, marks inside a word
 * (`2*3`, `sample_id_1`) and escaped marks (`\*`) are left as they are.
 * Links are not rewritten.
 */
function stripInlineFormatting(cell: string): string {
  if (!/[*_`~]/.test(cell)) return cell;
  const codes: string[] = [];
  const hold = (text: string) => `\u0000${codes.push(text) - 1}\u0000`;
  let s = cell.replace(CODE_SPAN_RE, (_m, _ticks: string, body: string) =>
    hold(/^ [\s\S]*[^ ][\s\S]* $/.test(body) ? body.slice(1, -1) : body)
  );
  s = s.replace(/\\[*_`~]/g, hold);
  const struck = s.replace(STRIKE_RE, (_m, before: string, after: string) => (before || after ? ' ' : ''));
  if (struck !== s) s = struck.trim();
  s = s
    .replace(STRONG_STAR_RE, '$1')
    .replace(STRONG_UNDERSCORE_RE, '$1$2')
    .replace(EM_STAR_RE, '$1$2')
    .replace(EM_UNDERSCORE_RE, '$1$2');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Fits a data row to the header width the way GFM renders it: extra cells are dropped, missing ones are empty. */
function fitRow(cells: string[], width: number): string[] {
  if (cells.length >= width) return cells.slice(0, width);
  return [...cells, ...Array<string>(width - cells.length).fill('')];
}

/** A line with its blockquote / callout markers (`> `) taken off, and how many there were. */
interface QuotedLine {
  depth: number;
  text: string;
}

const QUOTE_MARK_RE = /^ {0,3}>[ \t]?/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

function unquote(line: string): QuotedLine {
  let depth = 0;
  let text = line;
  for (let m = QUOTE_MARK_RE.exec(text); m; m = QUOTE_MARK_RE.exec(text)) {
    depth++;
    text = text.slice(m[0].length);
  }
  return { depth, text };
}

const isPipeRow = (l: QuotedLine | undefined, depth: number): boolean =>
  !!l && l.depth === depth && l.text.trim().startsWith('|');

/**
 * Finds every GFM pipe table in `markdown` (header row + `---` separator +
 * zero or more data rows). Tables are matched in document order. Data rows
 * are fitted to the header width, `<br>` becomes a newline inside a cell, and
 * bold, italic, code and strikethrough marks are handled as the reading view
 * shows them (see {@link stripInlineFormatting}).
 *
 * The rendered note decides what is a table:
 * - pipe rows in a fenced code block (#90) or in an indented code block — four
 *   spaces after a blank line, outside a list (#209) — are code, so they are
 *   neither exported nor counted;
 * - a table inside a blockquote or callout (`> | a |`) is a table (#205); its
 *   rows must share the same quote depth.
 */
export function extractMarkdownTables(markdown: string): CsvTable[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n').map(unquote);
  const tables: CsvTable[] = [];

  let fence: OpenFence | null = null;
  let inList = false;
  let inIndentedCode = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const prev = lines[i - 1];
    const next = stepFence(line.text, fence);
    if (next !== fence || fence) {
      fence = next;
      i++;
      continue;
    }
    const blank = line.text.trim() === '';
    if (blank) {
      i++;
      continue;
    }
    const prevBlank = !prev || prev.text.trim() === '' || prev.depth !== line.depth;
    if (INDENTED_CODE_RE.test(line.text)) {
      if (inIndentedCode || (prevBlank && !inList)) {
        inIndentedCode = true;
        i++;
        continue;
      }
    } else {
      inIndentedCode = false;
      inList = LIST_ITEM_RE.test(line.text) || (inList && !prevBlank && /^\s/.test(line.text));
    }

    const nextIsSeparator =
      i + 1 < lines.length && lines[i + 1].depth === line.depth && SEPARATOR_ROW_RE.test(lines[i + 1].text);
    if (isPipeRow(line, line.depth) && nextIsSeparator) {
      const header = splitTableRow(line.text);
      const rows: string[][] = [header];
      const depth = line.depth;
      i += 2;
      while (i < lines.length && isPipeRow(lines[i], depth)) {
        rows.push(fitRow(splitTableRow(lines[i].text), header.length));
        i++;
      }
      tables.push({ index: tables.length, rows });
      continue;
    }
    i++;
  }

  return tables;
}

/** A leading character Excel reads as the start of a formula (full-width forms included). */
const FORMULA_START_RE = /^[=@+\-＝＠＋－]/;
/** A signed number Excel reads as one: `-80`, `+5`, `-1.2e3`, `-.5`, `-80%`, `-1,250`. */
const SIGNED_NUMBER_RE = /^[+-](?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;

/**
 * Whether Excel would evaluate `cell` instead of showing it (#122): `=2:1`
 * turns into `#NAME?` and `+82-2-000-0000` into 80. Signed numbers stay
 * numbers, and a lone `-` (a common "none") is not a formula.
 */
function readsAsFormula(cell: string): boolean {
  if (!FORMULA_START_RE.test(cell)) return false;
  const ascii = cell.replace(/^[＋－]/, (c) => (c === '＋' ? '+' : '-'));
  if (!/^[+-]/.test(ascii)) return true;
  return ascii.length > 1 && !SIGNED_NUMBER_RE.test(ascii);
}

const LONE_SIGN_RE = /^[+\-＋－]$/;

/**
 * Columns whose lone `+`/`-` must be protected too (#138): a data cell there
 * starts with a sign and reads as a formula (`+/-`, `++`), so the column is a
 * score, not a number column where `-` means "none". Excel turns a lone sign
 * next to such cells into an error or a blank. The header row is not counted.
 */
function signColumns(rows: string[][]): Set<number> {
  const cols = new Set<number>();
  for (const row of rows.slice(1)) {
    row.forEach((cell, c) => {
      if (/^[+\-＋－]/.test(cell) && readsAsFormula(cell)) cols.add(c);
    });
  }
  return cols;
}

function escapeCsvCell(cell: string, guardLoneSign = false): string {
  // A tab inside the quotes (OWASP's advice for Excel) keeps the text as typed;
  // a leading `'` would stay visible, since Excel does not hide it in a CSV.
  if (readsAsFormula(cell) || (guardLoneSign && LONE_SIGN_RE.test(cell))) {
    return `"\t${cell.replace(/"/g, '""')}"`;
  }
  if (/[",\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** UTF-8 byte-order mark. */
export const UTF8_BOM = '\uFEFF';

/**
 * Serialize rows as CSV. Pass `bom: true` for files a user will open in Excel:
 * without the BOM, Excel on a Korean Windows system decodes UTF-8 as CP949,
 * which garbles Hangul and can merge adjacent columns.
 */
export function tableToCsv(rows: string[][], opts: { bom?: boolean } = {}): string {
  const guarded = signColumns(rows);
  const body =
    rows.map((row, r) => row.map((cell, c) => escapeCsvCell(cell, r > 0 && guarded.has(c))).join(',')).join('\n') +
    '\n';
  return opts.bom ? UTF8_BOM + body : body;
}

/** What re-exporting a table does to its existing CSV; see {@link classifyCsvOverwrites}. */
export type CsvOverwriteKind =
  /** No CSV yet. */
  | 'new'
  /** Same content; left as it is. */
  | 'same'
  /** The same table with new values or a renamed header; overwritten without asking. */
  | 'updated'
  /** Header and values both changed; asked about as a header change. */
  | 'headerChanged'
  /** The CSV would now hold another table (one was added, removed or moved); asked about. */
  | 'moved';

/** One table's export: the CSV it writes and the one already there, both without BOM and with LF. */
export interface CsvOverwriteInput {
  fresh: string;
  old?: string;
}

/** A CSV split after its first record (the header), honouring line breaks inside quotes. */
function splitCsvHeader(csv: string): { header: string; data: string } {
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) return { header: csv.slice(0, i), data: csv.slice(i + 1) };
  }
  return { header: csv, data: '' };
}

/** A CSV's records, header first, honouring line breaks inside quotes; no trailing empty record. */
function splitCsvRecords(csv: string): string[] {
  const records: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) {
      records.push(csv.slice(start, i));
      start = i + 1;
    }
  }
  if (start < csv.length) records.push(csv.slice(start));
  return records;
}

/** Data rows of a CSV, the header not counted. */
export function csvRowCount(csv: string): number {
  return Math.max(0, splitCsvRecords(csv).length - 1);
}

/**
 * The first data row (1-based, header not counted) where two CSVs differ, with
 * both versions (`''` for a row one side lacks). Undefined when every row is equal.
 * Tells two same-header CSVs apart in the overwrite prompt (#110).
 */
export function firstDifferingRow(
  oldCsv: string,
  newCsv: string
): { row: number; from: string; to: string } | undefined {
  const before = splitCsvRecords(oldCsv).slice(1);
  const after = splitCsvRecords(newCsv).slice(1);
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) return { row: i + 1, from: before[i] ?? '', to: after[i] ?? '' };
  }
  return undefined;
}

/**
 * Classify each table's re-export against the CSV already at its
 * `_tableN.csv` path (#80, #92). `existingCount` is the highest table number
 * among the note's existing CSVs; `staleOld` holds the contents of the CSVs
 * numbered past the note's tables (left after a table was removed). The checks
 * run in order:
 *
 * 1. the old content is another table's new content, or the new content is
 *    another CSV's old content (stale ones included) → `moved`. The second half
 *    catches a removed table (#117): its CSV's old content is gone from the
 *    note, but the next table's content now arrives where it was.
 * 2. the header is unchanged → `updated`
 * 3. only the header changed, with at least one data row equal → `updated`
 *    (a header-only table cannot be told apart this way)
 * 4. the old header is another table's new header, or the table count
 *    changed → `moved`
 * 5. otherwise → `headerChanged`
 *
 * The table-count check comes after 2–3 because CSVs the user chose to keep
 * after a table was removed leave it true on every later export, and a renamed
 * header must still not be asked about then.
 */
export function classifyCsvOverwrites(
  outputs: readonly CsvOverwriteInput[],
  existingCount: number,
  staleOld: readonly string[] = []
): CsvOverwriteKind[] {
  const fresh = outputs.map(o => splitCsvHeader(o.fresh));
  return outputs.map((o, k) => {
    if (o.old === undefined) return 'new';
    if (o.old === o.fresh) return 'same';
    if (outputs.some((other, j) => j !== k && other.fresh === o.old)) return 'moved';
    if (outputs.some((other, j) => j !== k && other.old === o.fresh) || staleOld.includes(o.fresh)) {
      return 'moved';
    }
    const old = splitCsvHeader(o.old);
    if (old.header === fresh[k].header) return 'updated';
    if (fresh[k].data !== '' && old.data === fresh[k].data) return 'updated';
    if (fresh.some((other, j) => j !== k && other.header === old.header) || existingCount !== outputs.length) {
      return 'moved';
    }
    return 'headerChanged';
  });
}
