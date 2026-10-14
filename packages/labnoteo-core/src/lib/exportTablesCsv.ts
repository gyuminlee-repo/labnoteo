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

function escapeCsvCell(cell: string): string {
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
