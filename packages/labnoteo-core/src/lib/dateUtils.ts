/**
 * Date utility functions for Lab Note Editor
 * Pure functions that can be shared between Extension and Webview
 */
import { frontMatterLineCountOf } from '../sections/frontMatter';
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
 * `YYYY-MM-DDTHH:mm` form an `<input type="datetime-local">` expects. The
 * dotted `YYYY.MM.DD HH:mm` and slashed `YYYY/MM/DD HH:mm` people type by
 * hand read too, with one-digit parts (#309, #364). Returns an empty string
 * when the value is missing or not a recognised date.
 */
export function toDateTimeLocalValue(value: string): string {
  const m = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})\.?(?:(?:[ \t]+|T)(\d{1,2}):(\d{2}))?(?!\d)/.exec(value.trim());
  if (!m) return '';
  const [, year, , month, day, hour, minute] = m;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return '';
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return '';
  const pad = (s: string): string => s.padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${hour === undefined ? '00:00' : `${pad(hour)}:${minute}`}`;
}

/**
 * Whether a Meta `End_date` value lies after `now` (`YYYY-MM-DD HH:mm`), so
 * the unit operation is planned to end rather than ended (#445). A value with
 * a time is compared to the minute, a bare date by the day. A value that does
 * not read as a date is not in the future.
 */
export function metaEndDateInFuture(value: string, now: string): boolean {
  const at = toDateTimeLocalValue(value);
  const current = toDateTimeLocalValue(now);
  if (!at || !current) return false;
  const dateOnly = /^\d{4}([-./])\d{1,2}\1\d{1,2}\.?$/.test(value.trim());
  return dateOnly ? at.slice(0, 10) > current.slice(0, 10) : at > current;
}

/**
 * What a filled Meta `End_date` says about its unit operation at `now`: a date
 * that has passed is `ended`, one still to come is `future` (#445), and a value
 * that does not read as a date, such as `11/7 예정`, is `unreadable` (#501).
 * Only `ended` counts as finished work wherever End_date is judged (#509).
 */
export function classifyMetaEndDate(value: string, now: string): 'ended' | 'future' | 'unreadable' {
  if (!toDateTimeLocalValue(value)) return 'unreadable';
  return metaEndDateInFuture(value, now) ? 'future' : 'ended';
}

/**
 * Whether closing the picker with Enter should write its value (#309). A
 * field that already held something keeps it when nothing was picked: the
 * picker shows the current time for a value it cannot read, and a date-only
 * value as midnight, so writing back what it shows would change the note.
 */
export function shouldWriteOnCommit(stored: string, initial: string, current: string): boolean {
  return stored.trim() === '' || current !== initial;
}

/**
 * Whether a picked `YYYY-MM-DDTHH:mm` (or stored) value is a believable
 * experiment date, years 1900–2100 (#308). The native field wraps a year
 * stepped past its limit to 0001 and passes through 0002, 0020, 0202 while a
 * year is typed; none of those should reach the note.
 */
export function isPlausibleMetaDate(value: string): boolean {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= 1900 && year <= 2100;
}

/** `value` moved inside `min`/`max` (same `YYYY-MM-DDTHH:mm` form), when given. */
export function clampDateTimeLocal(value: string, min?: string, max?: string): string {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
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
  // Front matter is YAML: no Meta block there, and none reaches into it.
  const fm = frontMatterLineCountOf(lines);
  if (lineIndex < fm) return undefined;
  const isHeading = (l: string) => /^#{1,6}[ \t]/.test(l);
  let start = lineIndex;
  while (start > fm && !isHeading(lines[start - 1])) start--;
  for (let i = start; i < lines.length && (i === start || !isHeading(lines[i])); i++) {
    const m = findMetaDateFieldInLine(lines[i]);
    if (m?.field === want) return { field: want, value: m.value };
  }
  return undefined;
}

/**
 * Whether `end` is earlier than `start`, both Meta date values (#192). False
 * when either is empty or not a date, so an unfinished block raises nothing.
 * A value without a time compares by day only (#531): an `End_date` of the
 * day the run started at 15:00 is not earlier than it.
 */
export function isEndBeforeStart(start: string, end: string): boolean {
  const a = toDateTimeLocalValue(start);
  const b = toDateTimeLocalValue(end);
  if (a === '' || b === '') return false;
  const hasTime = (v: string) => /\d{1,2}:\d{2}/.test(v);
  return hasTime(start) && hasTime(end) ? b < a : b.slice(0, 10) < a.slice(0, 10);
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
    // The value pattern would take a CRLF line's `\r` with the old value.
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    lines[i] = updateDateFieldInLine(lines[i].slice(0, lines[i].length - cr.length), fieldName, newDate) + cr;
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

/** Where a date falls against the week of `today`, weeks starting on Monday (#515). */
export type WeekBucket = 'thisWeek' | 'lastWeek' | 'earlier' | 'none';

/**
 * Which week `date` (`YYYY-MM-DD`, a time after it ignored) is in, seen from
 * `today` (`YYYY-MM-DD`, the Seoul date). A later date counts as this week; one
 * that does not read as a calendar date is `none`.
 */
export function seoulWeekBucket(date: string | undefined, today: string): WeekBucket {
  const day = calendarDay(date?.trim() ?? '');
  const now = calendarDay(today);
  if (day === undefined || now === undefined) return 'none';
  const monday = now - ((new Date(now * DAY_MS).getUTCDay() + 6) % 7);
  if (day >= monday) return 'thisWeek';
  return day >= monday - 7 ? 'lastWeek' : 'earlier';
}

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a leading `YYYY-MM-DD`, when it is a real date. */
function calendarDay(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(text);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return ms / DAY_MS;
}
