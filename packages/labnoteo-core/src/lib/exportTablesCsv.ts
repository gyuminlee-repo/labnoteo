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
  return cells.map(cell => cell.replace(/<br\s*\/?>/gi, '\n'));
}

/** Fits a data row to the header width the way GFM renders it: extra cells are dropped, missing ones are empty. */
function fitRow(cells: string[], width: number): string[] {
  if (cells.length >= width) return cells.slice(0, width);
  return [...cells, ...Array<string>(width - cells.length).fill('')];
}

/**
 * Finds every GFM pipe table in `markdown` (header row + `---` separator +
 * zero or more data rows). Tables are matched in document order. Data rows
 * are fitted to the header width and `<br>` becomes a newline inside a cell.
 * Pipe rows inside fenced code blocks are not tables in the rendered note, so
 * they are neither exported nor counted (#90).
 */
export function extractMarkdownTables(markdown: string): CsvTable[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const tables: CsvTable[] = [];

  let fence: OpenFence | null = null;
  let i = 0;
  while (i < lines.length) {
    const next = stepFence(lines[i], fence);
    if (next !== fence || fence) {
      fence = next;
      i++;
      continue;
    }
    const isHeaderLine = lines[i].trim().startsWith('|');
    const nextIsSeparator = i + 1 < lines.length && SEPARATOR_ROW_RE.test(lines[i + 1]);
    if (isHeaderLine && nextIsSeparator) {
      const header = splitTableRow(lines[i]);
      const rows: string[][] = [header];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(fitRow(splitTableRow(lines[i]), header.length));
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

function escapeCsvCell(cell: string): string {
  // A tab inside the quotes (OWASP's advice for Excel) keeps the text as typed;
  // a leading `'` would stay visible, since Excel does not hide it in a CSV.
  if (readsAsFormula(cell)) {
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
  const body = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n') + '\n';
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
