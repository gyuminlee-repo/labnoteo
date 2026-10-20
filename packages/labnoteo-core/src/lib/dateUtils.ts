/**
 * Date utility functions for Lab Note Editor
 * Pure functions that can be shared between Extension and Webview
 */
import { escapeRegExp } from './regexUtils';

/**
 * Returns YYYY-MM-DD in Asia/Seoul timezone
 */
export function getSeoulDateString(date?: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date || new Date());
}

/**
 * Returns YYYY-MM-DD HH:mm in Asia/Seoul timezone (24h)
 */
export function getSeoulDateTimeString(date?: Date): string {
  const d = date || new Date();
  const datePart = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `${datePart} ${timePart}`;
}

/**
 * A `- Start_date: '...'` / `- End_date: '...'` line inside a unit operation's
 * `#### Meta` block, located precisely enough to replace just the value.
 */
export interface MetaDateFieldMatch {
  field: 'Start_date' | 'End_date';
  /** Offset of the value within the line, excluding the surrounding quotes. */
  valueStart: number;
  /** End offset of the value (equals `valueStart` when the value is empty). */
  valueEnd: number;
  value: string;
  /** The quote character wrapping the value, or null when unquoted. */
  quote: "'" | '"' | null;
}

const META_DATE_LINE = /^(\s*[-*][ \t]+)(Start_date|End_date)([ \t]*:[ \t]*)(.*)$/i;

/**
 * Locate the editable date value on a Meta `Start_date`/`End_date` line.
 * Returns null for any other line, including headings and prose that merely
 * mention the field name.
 */
export function findMetaDateFieldInLine(line: string): MetaDateFieldMatch | null {
  const m = META_DATE_LINE.exec(line);
  if (!m) return null;

  const [, bullet, rawField, separator, rest] = m;
  const field = rawField.toLowerCase() === 'start_date' ? 'Start_date' : 'End_date';
  const restStart = bullet.length + separator.length + rawField.length;
  // Trailing whitespace is never part of the value, so excluding it here keeps
  // the replacement range tight.
  const text = rest.replace(/[ \t]+$/, '');

  const first = text[0];
  if ((first === "'" || first === '"') && text.length >= 2 && text[text.length - 1] === first) {
    return {
      field,
      valueStart: restStart + 1,
      valueEnd: restStart + text.length - 1,
      value: text.slice(1, -1),
      quote: first,
    };
  }

  return {
    field,
    valueStart: restStart,
    valueEnd: restStart + text.length,
    value: text,
    quote: null,
  };
}

/**
 * Convert a stored `YYYY-MM-DD HH:mm` (or bare `YYYY-MM-DD`) value into the
 * `YYYY-MM-DDTHH:mm` form an `<input type="datetime-local">` expects. Returns
 * an empty string when the value is missing or not a recognised date.
 */
export function toDateTimeLocalValue(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(value.trim());
  if (!m) return '';
  return `${m[1]}T${m[2] ?? '00:00'}`;
}

/** Inverse of {@link toDateTimeLocalValue}; returns '' for unparseable input. */
export function fromDateTimeLocalValue(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value.trim());
  return m ? `${m[1]} ${m[2]}` : '';
}

/**
 * The other date of the Meta block holding `lineIndex` (#192): `End_date` for
 * a `Start_date` line and the reverse, with its value as written. The block
 * runs between the nearest headings; undefined when `lineIndex` is not a Meta
 * date line or the block has no such field.
 */
export function findPairedMetaDate(
  lines: readonly string[],
  lineIndex: number
): { field: MetaDateFieldMatch['field']; value: string } | undefined {
  const own = lines[lineIndex] === undefined ? null : findMetaDateFieldInLine(lines[lineIndex]);
  if (!own) return undefined;
  const want: MetaDateFieldMatch['field'] = own.field === 'Start_date' ? 'End_date' : 'Start_date';
  const isHeading = (l: string) => /^#{1,6}\s/.test(l);
  let start = lineIndex;
  while (start > 0 && !isHeading(lines[start - 1])) start--;
  for (let i = start; i < lines.length && (i === start || !isHeading(lines[i])); i++) {
    const m = findMetaDateFieldInLine(lines[i]);
    if (m?.field === want) return { field: want, value: m.value };
  }
  return undefined;
}

/**
 * Whether `end` is earlier than `start`, both Meta date values (#192). False
 * when either is empty or not a date, so an unfinished block raises nothing.
 */
export function isEndBeforeStart(start: string, end: string): boolean {
  const a = toDateTimeLocalValue(start);
  const b = toDateTimeLocalValue(end);
  return a !== '' && b !== '' && b < a;
}

/**
 * Date field match result
 */
export interface DateFieldMatch {
  field: string;
  line: number;
  value: string;
  fullLine: string;
}

/**
 * Updates a date field value in a single line
 * @param line The line containing the date field
 * @param fieldName The name of the field to update (e.g., 'last_updated_date')
 * @param newDate The new date value in YYYY-MM-DD or YYYY-MM-DD HH:mm format
 * @returns The updated line, or original line if field not found
 */
export function updateDateFieldInLine(line: string, fieldName: string, newDate: string): string {
  // Match pattern: fieldName: 'value' or fieldName: "value" or fieldName: value
  const pattern = new RegExp(`(${escapeRegExp(fieldName)}):\\s*['"]?[^'"]*['"]?`, 'i');
  if (!pattern.test(line)) {
    return line;
  }
  return line.replace(pattern, `$1: '${newDate}'`);
}

/**
 * Updates all date/datetime patterns in a single line
 * Matches dates in formats: YYYY-MM-DD or YYYY-MM-DD HH:mm
 * Handles quotes: '...', "...", or no quotes
 * @param line The line containing date patterns
 * @param newDateTime The new datetime value in YYYY-MM-DD HH:mm format
 * @returns The updated line with all dates replaced
 */
export function updateAllDatesInLine(line: string, newDateTime: string): string {
  // Date patterns:
  // - YYYY-MM-DD or YYYY-MM-DD HH:mm (hyphen separator)
  // - YYYY.MM.DD or YYYY.MM.DD. HH:mm (dot separator)
  const hyphenPattern = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?/g;
  const dotPattern = /\d{4}\.\d{2}\.\d{2}\.?(?:\s+\d{2}:\d{2})?/g;
  
  // Find all matches from both patterns
  const matches: Array<{ start: number; end: number; quoted: boolean; quoteChar: string | null }> = [];
  
  // Helper function to process matches
  const processMatches = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const beforeChar = start > 0 ? line[start - 1] : '';
      const afterChar = end < line.length ? line[end] : '';
      
      let quoted = false;
      let quoteChar: string | null = null;
      
      // Check if date is inside single quotes
      if (beforeChar === "'" && afterChar === "'") {
        quoted = true;
        quoteChar = "'";
      }
      // Check if date is inside double quotes
      else if (beforeChar === '"' && afterChar === '"') {
        quoted = true;
        quoteChar = '"';
      }
      
      matches.push({ start, end, quoted, quoteChar });
    }
  };
  
  // Process both patterns
  processMatches(hyphenPattern);
  processMatches(dotPattern);
  
  // Sort matches by start position to handle overlapping cases
  matches.sort((a, b) => a.start - b.start);
  
  // Remove overlapping matches (keep the first one)
  const uniqueMatches: Array<{ start: number; end: number; quoted: boolean; quoteChar: string | null }> = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (i === 0 || current.start >= uniqueMatches[uniqueMatches.length - 1].end) {
      uniqueMatches.push(current);
    }
  }
  
  // If no matches found, return original line
  if (uniqueMatches.length === 0) {
    return line;
  }
  
  // Replace from end to start to preserve indices
  let result = line;
  for (let i = uniqueMatches.length - 1; i >= 0; i--) {
    const { start, end, quoted, quoteChar } = uniqueMatches[i];
    
    if (quoted && quoteChar) {
      // Replace quoted date (including quotes)
      const beforeStart = start - 1;
      const afterEnd = end + 1;
      result = result.substring(0, beforeStart) + 
               `'${newDateTime}'` + 
               result.substring(afterEnd);
    } else {
      // Replace unquoted date
      result = result.substring(0, start) + 
               `'${newDateTime}'` + 
               result.substring(end);
    }
  }
  
  return result;
}

/**
 * Finds all date fields in a document
 * @param content The document content
 * @returns Array of date field matches
 */
export function findDateFieldsInDocument(content: string): DateFieldMatch[] {
  // Canonical, case-insensitively-unique field names. The per-field pattern uses
  // the `i` flag, so listing both `end_date` and `End_date` (as before) matched
  // every such line twice and produced duplicate entries. One entry per name.
  const dateFields = ['created_date', 'last_updated_date', 'end_date', 'start_date'];
  const matches: DateFieldMatch[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const field of dateFields) {
      // Match pattern: fieldName: 'value' or fieldName: "value" or fieldName: value
      const pattern = new RegExp(`(${escapeRegExp(field)}):\\s*['"]?([^'"]*)['"]?`, 'i');
      const match = line.match(pattern);
      if (match) {
        matches.push({
          field: match[1],
          line: i,
          value: match[2] || '',
          fullLine: line
        });
      }
    }
  }

  return matches;
}

/**
 * Updates all occurrences of a specific date field in a document
 * @param content The document content
 * @param fieldName The name of the field to update
 * @param newDate The new date value in YYYY-MM-DD format
 * @returns The updated document content
 */
export function updateAllDateFields(content: string, fieldName: string, newDate: string): string {
  const lines = content.split('\n');

  // Restrict rewriting to the leading YAML front matter block. Without this the
  // function also rewrote any `<field>:` appearing in the body or inside fenced
  // code blocks. Front matter must open on the first line.
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEnd = i;
        break;
      }
    }
  }
  if (fmEnd === -1) return content; // no front matter → nothing in scope

  for (let i = 1; i < fmEnd; i++) {
    lines[i] = updateDateFieldInLine(lines[i], fieldName, newDate);
  }
  return lines.join('\n');
}

const LAST_UPDATED_LINE = /^(last_updated_date:[ \t]*)(.*?)([ \t]*\r?)$/;

interface LastUpdatedLine {
  lines: string[];
  index: number;
  prefix: string;
  raw: string;
  suffix: string;
}

/** The top-level `last_updated_date:` line of the leading front matter, if any. */
function findLastUpdatedLine(content: string): LastUpdatedLine | undefined {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return undefined;
    const m = LAST_UPDATED_LINE.exec(lines[i]);
    if (m) return { lines, index: i, prefix: m[1], raw: m[2], suffix: m[3] };
  }
  return undefined;
}

function splitQuote(raw: string): { quote: string; value: string } {
  const q = raw[0];
  if ((q === "'" || q === '"') && raw.length >= 2 && raw[raw.length - 1] === q) {
    return { quote: q, value: raw.slice(1, -1) };
  }
  return { quote: '', value: raw };
}

/** Value of the front matter `last_updated_date`, without quotes; undefined when absent. */
export function readLastUpdatedDate(content: string): string | undefined {
  const found = findLastUpdatedLine(content);
  return found ? splitQuote(found.raw).value : undefined;
}

/**
 * Set the front matter `last_updated_date` to `today`, keeping its quoting and
 * line ending. Returns `content` unchanged when the value already matches or
 * when there is no such field (it is never added).
 */
export function touchLastUpdatedDate(content: string, today: string): string {
  const found = findLastUpdatedLine(content);
  if (!found) return content;
  const { quote, value } = splitQuote(found.raw);
  if (value === today) return content;
  const prefix = /[ \t]$/.test(found.prefix) ? found.prefix : `${found.prefix} `;
  const eol = found.suffix.endsWith('\r') ? '\r' : '';
  found.lines[found.index] = `${prefix}${quote}${today}${quote}${eol}`;
  return found.lines.join('\n');
}
