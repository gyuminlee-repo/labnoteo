/**
 * wiki-propose — Living Manuscript Wiki proposer (Phase 5).
 *
 * The AI here ONLY links objective facts into a paper-style template — it does
 * NOT author interpretation, conclusions, or opinions. The pipeline is:
 *
 *   1. Deterministically gather context: the changed experiments (mainly
 *      `status: completed`), reading each README.
 *   2. Deterministically extract OBJECTIVE FACTS only — actions, measurements,
 *      observations — excluding the note's own Summary/Discussion (conclusions).
 *      Each fact carries an evidence ID (the experiment identifier).
 *   3. Map facts to paper sections (MVP: Finding title/keyword/metadata matching,
 *      NO embeddings): protocol/action facts → Methods; the rest → the matching
 *      Results Finding (or a new Finding named after the note).
 *   4. For each affected section, send ONLY (existing approved section text + new
 *      facts) to the thin local-LLM chat client, which returns structured JSON
 *      of evidence-tagged sentences. It merges — never rewrites the whole wiki.
 *   5. Render markdown and splice it in with the bundled pure `replaceSectionBody`
 *      (title-matched lossless replace), writing ONLY `wiki-staging/` files.
 *
 * Never touches original notes or the live Wiki. Zero runtime deps: node
 * built-ins + inlined `@labnoteo/core`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findSectionMatches, listHeadings, replaceSectionBody } from '@labnoteo/core';
import {
  deriveIdentifier,
  getSectionBody,
  groupChangedExperiments,
  readExperimentNote,
  readStringField,
  type ExperimentNote,
} from './lib/experiments';
import { chatJson, chatOptionsFromEnv, type ChatClientOptions } from './lib/chat';
import { getChangedFiles } from './lib/git';

/** Directory (vault-relative) that holds the staged Wiki proposal files. */
export const WIKI_STAGING = 'wiki-staging';

/** Note sections that hold conclusions/interpretation — excluded from facts. */
const CONCLUSION_HEADINGS = ['Summary and Discussion', '🎯 Experiment Objective'];

/** A single objective fact plus the experiment it came from. */
export interface WikiFact {
  text: string;
  evidenceId: string;
}

/**
 * Deterministically extract objective-fact lines from a note body: bullet items
 * and non-empty prose lines, excluding headings, blockquotes and the note's own
 * conclusion sections. NO AI, NO interpretation. Pure/testable.
 */
// front matter: reads `note.body`, the note without it.
export function extractFacts(note: ExperimentNote): WikiFact[] {
  const evidenceId = deriveIdentifier(note.frontMatter, note.folderName);
  const lines = note.body.split(/\r?\n/);
  const facts: WikiFact[] = [];

  let excluded = false;
  let excludedLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (excluded && level <= excludedLevel) excluded = false;
      if (CONCLUSION_HEADINGS.some(h => title === h || title.endsWith(h))) {
        excluded = true;
        excludedLevel = level;
      }
      continue;
    }
    if (excluded) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('>')) continue;
    const text = trimmed.replace(/^[-*+]\s+/, '').trim();
    if (text === '') continue;
    facts.push({ text, evidenceId });
  }
  return facts;
}

/** Keywords that route a fact to the Methods section (protocol/action verbs). */
const METHOD_KEYWORDS = ['protocol', 'method', '프로토콜', '방법', '조건', '수행', 'perform', 'prepare'];

/** Lowercased word tokens (Latin + Hangul runs) for coarse keyword matching. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+|[가-힣]+/g) ?? []).filter(t => t.length > 1);
}

/** Whether any fact looks like a protocol/action (→ Methods). Pure. */
export function affectsMethods(facts: WikiFact[]): boolean {
  return facts.some(f => {
    const lower = f.text.toLowerCase();
    return METHOD_KEYWORDS.some(k => lower.includes(k));
  });
}

/**
 * Match a note's facts to existing Result Finding headings by shared keywords
 * (MVP: title/keyword overlap, NO embeddings). Returns the matching finding
 * titles; empty when none overlap. Pure/testable.
 */
export function matchFindings(facts: WikiFact[], findingTitles: string[]): string[] {
  const factTokens = new Set(facts.flatMap(f => tokenize(f.text)));
  return findingTitles.filter(title => tokenize(title).some(t => factTokens.has(t)));
}

/** A proposed edit to one Wiki section (target file + heading + new facts). */
export interface SectionTarget {
  file: string;
  heading: string;
  facts: WikiFact[];
}

/** Heading used for a note that has no matching existing Finding. */
export function newFindingHeading(note: ExperimentNote): string {
  const id = deriveIdentifier(note.frontMatter, note.folderName);
  const title = readStringField(note.frontMatter, 'title');
  return title ? `${title} (${id})` : id;
}

/**
 * Deterministically decide which Wiki sections a note affects. Pure given the
 * existing Finding titles (read from the staged Results file). Protocol/action
 * facts → Methods; other facts → matching Findings, or a new Finding when none
 * match.
 */
export function planSections(
  note: ExperimentNote,
  findingTitles: string[]
): SectionTarget[] {
  const facts = extractFacts(note);
  if (facts.length === 0) return [];
  const targets: SectionTarget[] = [];

  if (affectsMethods(facts)) {
    targets.push({ file: `${WIKI_STAGING}/Methods.md`, heading: 'Methods', facts });
  }

  const matched = matchFindings(facts, findingTitles);
  if (matched.length > 0) {
    for (const heading of matched) {
      targets.push({ file: `${WIKI_STAGING}/Results.md`, heading, facts });
    }
  } else {
    targets.push({ file: `${WIKI_STAGING}/Results.md`, heading: newFindingHeading(note), facts });
  }

  return targets;
}

/** One rendered sentence from the LLM (evidence-tagged). */
export interface ProposedSentence {
  text: string;
  evidence?: string;
  insufficient_evidence?: boolean;
}

/** Narrow the LLM reply to a sentence list. Pure/testable. */
export function parseProposal(value: unknown): ProposedSentence[] | undefined {
  const arr = (value as { sentences?: unknown })?.sentences ?? value;
  if (!Array.isArray(arr)) return undefined;
  const out: ProposedSentence[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.text !== 'string') continue;
    out.push({
      text: s.text,
      evidence: typeof s.evidence === 'string' ? s.evidence : undefined,
      insufficient_evidence: s.insufficient_evidence === true,
    });
  }
  return out;
}

/**
 * Render evidence-tagged sentences to Markdown. Every sentence must carry an
 * evidence ID; those without are marked "insufficient evidence". Pure/testable.
 */
export function renderSentences(sentences: ProposedSentence[]): string {
  if (sentences.length === 0) return '_No new evidence-backed statements._';
  return sentences
    .map(s => {
      if (s.insufficient_evidence || !s.evidence) {
        return `- ${s.text} _(insufficient evidence)_`;
      }
      return `- ${s.text} \`[${s.evidence}]\``;
    })
    .join('\n');
}

/** Read the `### `/`## ` Finding headings from the staged Results file. */
function readFindingTitles(): string[] {
  const path = `${WIKI_STAGING}/Results.md`;
  if (!existsSync(path)) return [];
  return findingTitlesIn(readFileSync(path, 'utf8'));
}

/** The `##`..`######` Finding headings of a Results file's text: the body's, none from the front matter or a code block. */
export function findingTitlesIn(md: string): string[] {
  return listHeadings(md)
    .filter(h => h.level >= 2)
    .map(h => h.text.trim())
    .filter(t => t && t.toLowerCase() !== 'results');
}

/** Read the gate/propose prompt from the vault `ai/` folder. */
function loadPrompt(): string {
  return readFileSync('ai/prompts/wiki-propose.md', 'utf8');
}

/** Ask the local LLM to link the new facts into the existing section text. */
async function proposeSection(
  opts: ChatClientOptions,
  prompt: string,
  target: SectionTarget,
  existingBody: string
): Promise<ProposedSentence[] | undefined> {
  const facts = target.facts
    .map(f => `- ${f.text} [evidence: ${f.evidenceId}]`)
    .join('\n');
  const user = [
    `SECTION: ${target.heading}`,
    '',
    'EXISTING SECTION TEXT:',
    existingBody || '(empty)',
    '',
    'NEW OBJECTIVE FACTS (with evidence IDs):',
    facts,
  ].join('\n');
  const reply = await chatJson<unknown>(opts, [
    { role: 'system', content: prompt },
    { role: 'user', content: user },
  ]);
  return parseProposal(reply);
}

/** Ensure a staged section file exists with its heading, then return its text. */
function ensureSectionFile(file: string, heading: string): string {
  if (!existsSync(WIKI_STAGING)) mkdirSync(WIKI_STAGING, { recursive: true });
  if (!existsSync(file)) {
    const base = file.endsWith('Results.md') ? '# Results\n' : `# ${heading}\n`;
    writeFileSync(file, base, 'utf8');
  }
  const md = readFileSync(file, 'utf8');
  const withHeading = withSectionHeading(md, file, heading);
  if (withHeading !== md) writeFileSync(file, withHeading, 'utf8');
  return withHeading;
}

/**
 * `md` with the target heading added at its end unless `replaceSectionBody` finds one already,
 * found as it finds it (a `## …` YAML comment in the front matter is none).
 */
export function withSectionHeading(md: string, file: string, heading: string): string {
  if (findSectionMatches(md, heading).length > 0) return md;
  const level = file.endsWith('Results.md') && heading !== 'Results' ? '###' : '##';
  return `${md.replace(/\s*$/, '')}\n\n${level} ${heading}\n`;
}

/** Run the proposer. Returns the process exit code (0 = ok, 1 = a failure). */
export async function run(): Promise<number> {
  const dirs = groupChangedExperiments(getChangedFiles());
  const notes = dirs
    .map(dir => readExperimentNote(dir))
    .filter((n): n is ExperimentNote => n !== undefined)
    // Focus on completed experiments (the manuscript reports finished findings).
    .filter(n => readStringField(n.frontMatter, 'status') === 'completed');

  if (notes.length === 0) {
    console.log('wiki-propose: 완료된 변경 실험이 없습니다 (스킵).');
    return 0;
  }

  const findingTitles = readFindingTitles();
  const opts = chatOptionsFromEnv();
  const prompt = loadPrompt();
  let failed = 0;
  let written = 0;

  for (const note of notes) {
    const targets = planSections(note, findingTitles);
    for (const target of targets) {
      try {
        ensureSectionFile(target.file, target.heading);
        const md = readFileSync(target.file, 'utf8');
        const existingBody = getSectionBody(md, target.heading) ?? '';
        const sentences = await proposeSection(opts, prompt, target, existingBody);
        if (!sentences) {
          failed += 1;
          console.error(`❌ [${target.heading}] LLM 응답 파싱 실패.`);
          continue;
        }
        const merged = renderSentences(sentences);
        const result = replaceSectionBody(md, target.heading, merged);
        if (!result.ok) {
          failed += 1;
          console.error(`❌ [${target.heading}] 섹션 병합 실패 (heading 미발견).`);
          continue;
        }
        writeFileSync(target.file, result.md, 'utf8');
        written += 1;
        console.log(`📝 제안: ${target.file} → "${target.heading}"`);
      } catch (err) {
        failed += 1;
        console.error(`❌ [${target.heading}] 처리 실패: ${(err as Error).message}`);
      }
    }
  }

  console.log(`wiki-propose: ${written}개 섹션 제안 작성 (wiki-staging/). 사람이 검토 후 병합하세요.`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(code => process.exit(code));
}
