/**
 * Whether a workflow note has results worth summarizing (#257).
 *
 * "AI: Summarize results" used to run on any note with text in it, so a note
 * holding nothing but the template answered with invented measurements. The
 * template's own wording is not a result, and neither is a reagent list: only
 * the sections results are written in count, plus any section the researcher
 * added themselves.
 */
import { stepFence, type OpenFence } from '../sections/sectionEdit';
import { stripFrontMatter } from '../sections/frontMatter';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from './unitOpTemplate';
import { stripAiCallouts } from './aiCallout';
import { stripIssueMarkers } from './issueMarker';
import { classifyUnitOp } from './worksheet';

export { stripAiCallouts, maskAiCallouts } from './aiCallout';

/**
 * Headings the templates write that hold no result: the unit operation's
 * `Results & Discussions` / `QC Metrics` / `Discussion` and the note's
 * `Conclusions and Discussion` are deliberately absent.
 */
const TEMPLATE_HEADINGS = new Set([
  'Related Unit Operations',
  'Meta',
  'Input',
  'Reagent',
  'Labware and Consumables',
  'Equipment',
  'Method',
  'Output',
  'Parameters',
  'Environment',
  'Worksheet scans',
]);

const PLACEHOLDERS = new Set<string>([...Object.values(HW_PLACEHOLDERS), ...Object.values(SW_PLACEHOLDERS)]);

/** `## [WD010 Design]` and `### [UHW010 Liquid Handling]`: template headings too. */
const BRACKET_HEADING_RE = /^\[[A-Za-z]+\d+\s/;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** `md` without the template's `- (…)` placeholder lines, for the model's context. */
export function stripTemplatePlaceholders(md: string): string {
  return md
    .split(/\r?\n/)
    .filter(line => !PLACEHOLDERS.has(line.trim()))
    .join('\n');
}

interface HeadingSection {
  level: number;
  title: string;
  body: string[];
}

/** The note's headings with the lines under each, code fences left alone. */
function sections(md: string): HeadingSection[] {
  const out: HeadingSection[] = [];
  let fence: OpenFence | null = null;
  let current: HeadingSection | null = null;
  for (const line of md.split(/\r?\n/)) {
    const next = stepFence(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      current = { level: heading[1].length, title: heading[2].trim(), body: [] };
      out.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return out;
}

/** The `---` the template puts between the note and its unit operations. */
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;

/** Whether anything is written under a heading, the template's own lines aside. */
function written(body: readonly string[]): boolean {
  return body.some(line => {
    const text = line.trim();
    return text !== '' && !RULE_RE.test(text) && !PLACEHOLDERS.has(text);
  });
}

/** Whether `md` follows the workflow template (a `## [ID Name]` heading or unit operations). */
function isWorkflowNote(md: string): boolean {
  return sections(md).some(s => BRACKET_HEADING_RE.test(s.title) || TEMPLATE_HEADINGS.has(s.title));
}

/** A result section of a workflow note: the unit operation it is in ('' for none), its title and text. */
interface ResultSection {
  block: string;
  title: string;
  body: string[];
}

/**
 * The sections of `text` results are written in: a unit operation's
 * `Results & Discussions` / `QC Metrics` / `Discussion`, a software unit
 * operation's `Output` (#317) — what the run produced, where a lab step's
 * Output only lists the samples passed on — the note's `Conclusions and
 * Discussion`, and any section the researcher added. Empty ones included.
 */
function resultSectionsOf(text: string): ResultSection[] {
  const out: ResultSection[] = [];
  let block = '';
  let opId = '';
  let meta: string[] = [];
  for (const { level, title, body } of sections(text)) {
    if (BRACKET_HEADING_RE.test(title)) {
      block = level >= 3 ? title : '';
      opId = level >= 3 ? (/^\[([A-Za-z]+\d+)\s/.exec(title)?.[1] ?? '') : '';
      meta = [];
      continue;
    }
    if (level <= 2) block = opId = '';
    if (title === 'Meta') meta = body;
    const swOutput = title === 'Output' && opId !== '' && classifyUnitOp(opId, meta) === 'sw';
    if (TEMPLATE_HEADINGS.has(title) && !swOutput) continue;
    out.push({ block, title, body });
  }
  return out;
}

/**
 * Whether `md` has results written in a section {@link resultSectionsOf}
 * reads (a note of the researcher's own making is not judged by the
 * template). A note that is not a workflow note is left alone — there is no
 * template to compare it with.
 */
export function hasRecordedResults(md: string): boolean {
  const text = stripAiCallouts(md);
  if (!isWorkflowNote(text)) return true;
  return resultSectionsOf(text).some(({ body }) => written(body));
}

/**
 * The result sections of a workflow note, each headed by the unit operation
 * it is in (`[UHW010 Liquid Handling] 조건 A › Results & Discussions`), for a
 * model to summarize (#279, #306): the sections {@link hasRecordedResults}
 * counts, with nothing of the front matter, the template, the reagent lists
 * or earlier AI answers. `@issue` markers become their topic sentence, so the
 * model does not copy them into a summary that would open issues (#354).
 * Empty when nothing is written in.
 */
export function extractResultSections(md: string): string {
  const text = stripIssueMarkers(stripTemplatePlaceholders(stripAiCallouts(stripFrontMatter(md))));
  const out: string[] = [];
  for (const { block, title, body } of resultSectionsOf(text)) {
    if (!written(body)) continue;
    const content = body
      .filter(line => !RULE_RE.test(line.trim()))
      .join('\n')
      .trim();
    out.push(`### ${block ? `${block} › ` : ''}${title}\n${content}`);
  }
  return out.join('\n\n');
}

/**
 * A line reduced for {@link dropEchoedLines}: no quote or list marks, no
 * short `head:` label (`검토 의견(시료 담당):`), no spaces or punctuation.
 */
function echoKey(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/, '')
    .replace(/^[^:：]{1,30}[:：]\s*/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * `reply` without the lines that only repeat a line of `memo` (#316): small
 * models told to take the researcher's notes as context still copy them
 * into the summary, where they read as the model's finding. A line counts
 * as a copy when, spaces, punctuation and a leading label aside, it is a
 * memo line or part of one, or a memo line makes up most of it. Lines
 * shorter than `minLength` are kept. When every line would go, `reply` is
 * returned whole.
 */
export function dropEchoedLines(reply: string, memo: string, minLength = 20): string {
  const memoKeys = memo
    .split(/\r?\n/)
    .map(echoKey)
    .filter(k => k.length >= minLength);
  if (memoKeys.length === 0) return reply;
  const echoed = (line: string): boolean => {
    const k = echoKey(line);
    if (k.length < minLength) return false;
    return memoKeys.some(m => m.includes(k) || (k.includes(m) && m.length >= k.length * 0.8));
  };
  const kept = reply.split(/\r?\n/).filter(line => !echoed(line));
  return kept.some(line => line.trim() !== '') ? kept.join('\n') : reply;
}

/**
 * Split `total` characters between texts of `lengths` (#306): each gets an
 * equal share, and what a short one leaves goes to the others in turn.
 */
export function shareBudget(lengths: readonly number[], total: number): number[] {
  const out = lengths.map(() => 0);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  let left = total;
  order.forEach(({ len, i }, k) => {
    const share = Math.floor(left / (order.length - k));
    out[i] = Math.min(len, share);
    left -= out[i];
  });
  return out;
}
