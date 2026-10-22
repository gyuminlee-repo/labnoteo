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
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from './unitOpTemplate';

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

/** An AI answer this plugin inserted (#150), which is not the researcher's result. */
const AI_CALLOUT_RE = /^>\s*\[!\w+\]\s*AI\b/i;

/**
 * `md` without the `> [!note] AI …` callouts this plugin inserts, so a second
 * run does not read the first answer as a result.
 */
export function stripAiCallouts(md: string): string {
  const out: string[] = [];
  let inCallout = false;
  for (const line of md.split(/\r?\n/)) {
    if (inCallout) {
      if (line.trimStart().startsWith('>')) continue;
      inCallout = false;
    }
    if (AI_CALLOUT_RE.test(line.trimStart())) {
      inCallout = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** `md` without the template's `- (…)` placeholder lines, for the model's context. */
export function stripTemplatePlaceholders(md: string): string {
  return md
    .split(/\r?\n/)
    .filter(line => !PLACEHOLDERS.has(line.trim()))
    .join('\n');
}

interface HeadingSection {
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
      current = { title: heading[2].trim(), body: [] };
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

/**
 * Whether `md` has results written in: a unit operation's `Results &
 * Discussions` / `QC Metrics` / `Discussion`, the note's `Conclusions and
 * Discussion`, or any section the researcher added themselves (a note of their
 * own making is not judged by the template). A note that is not a workflow
 * note is left alone — there is no template to compare it with.
 */
export function hasRecordedResults(md: string): boolean {
  const text = stripAiCallouts(md);
  if (!isWorkflowNote(text)) return true;
  // What is left after the template's non-result headings is either a result
  // section or a heading of the researcher's own, and both count.
  return sections(text).some(
    ({ title, body }) =>
      !BRACKET_HEADING_RE.test(title) && !TEMPLATE_HEADINGS.has(title) && written(body)
  );
}
