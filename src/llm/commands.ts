/**
 * Built-in, edit-adjacent AI commands.
 *
 * Each command reads context from the active note, calls the configured
 * {@link LlmProvider}, and writes back through the editor / core tools. They are
 * intentionally thin: prompt construction + I/O only, with all durable document
 * mutation flowing through the tested core helpers (`create_sample`, section
 * edits).
 */
import { Notice } from 'obsidian';
import {
  createLabnoteTools,
  runTool,
  findUnitOpMethodAt,
  findUnitOpMethodByIndex,
  listUnitOpMethods,
  cleanMethodDraft,
  extractMethodBody,
  planBlockInsert,
  hasRecordedResults,
  extractResultSections,
  shareBudget,
  findAiCalloutInSection,
  planSectionAppend,
  sectionText,
  stripFrontMatter,
  stripAiCallouts,
  stripTemplatePlaceholders,
  replaceSectionBodyAt,
  minimalReplacement,
  type ToolContext,
  type EditTarget,
  type UnitOpMethodLocation,
} from '@labnoteo/core';
import {
  canonicalSampleType,
  getSampleDisplayMeta,
  normalizeSampleId,
  toSampleAlias as toAlias,
} from '@labnoteo/core/lib/sampleUtils';
import {
  findSampleReferenceSpans,
  loadSamplesByType,
  noteLabsamplesFolder,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import {
  diagnoseWorkflowPath,
  parseWorkflowFileName,
  workflowChecklistOrder,
  workflowLabelFor,
} from '@labnoteo/core/lib/workflowStructure';
import type LabnotePlugin from '../main';
import { createLlmProvider, type ChatMessage } from './provider';
import { describeLlmError } from './llmError';
import { countToolOutcomes, runAgent, type AgentRun } from './agent';
import { buildApprovalMessage, erasesRecordedLines } from './approvalMessage';
import { getObsidianLanguage } from '../i18n';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { aiAnswerModal } from '../modals';
import { sampleUsages } from '../sampleActions';

/**
 * Tool context for AI-driven edits.
 *
 * `writeNote` matters here for the same reason it does on the MCP path: the AI
 * edits notes the user is plausibly looking at, and an adapter-level write
 * would be overwritten by the open editor's next flush.
 */
function toolContext(plugin: LabnotePlugin): ToolContext {
  return {
    fs: plugin.fs,
    workspaceRoot: '.',
    globalSampleFolder: plugin.settings.globalSampleFolder,
    customTypes: plugin.settings.customSampleTypes,
    locale: getObsidianLanguage(),
    writeNote: (path, content) => plugin.writeNoteStamped(path, content),
    findSampleUsages: (folder, type, id) => sampleUsages(plugin.app, plugin, folder, type, id),
  };
}

/**
 * The system-prompt line telling the model to write in Obsidian's UI
 * language (#237): the note itself may be in English while the researcher
 * reads Korean, and models otherwise answer in the language of the prompt.
 */
export function replyLanguageInstruction(lang: string = getObsidianLanguage()): string {
  const code = lang.split('-')[0].toLowerCase() || 'en';
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    // An unknown code stays as it is.
  }
  return `Write the answer in ${name}. Keep sample IDs, units, numbers and quoted text exactly as they appear in the note.`;
}

/** The notice for an empty reply (#195), naming a thinking-only one as such. */
function noAnswerMessage(plugin: LabnotePlugin, thinkingOnly: boolean | undefined): string {
  return thinkingOnly
    ? plugin.t('The model gave no answer (it only thought). Try again or choose another model.')
    : plugin.t('The model gave no answer. Try again or choose another model.');
}

/**
 * The end notice of the assistant (#186): what changed, what was only read,
 * and what was denied or failed, so a denied write is not counted as done.
 */
export function toolRunNotice(plugin: LabnotePlugin, executed: AgentRun['executed']): string {
  if (executed.length === 0) return plugin.t('The AI used no tools; nothing in the vault changed.');
  const c = countToolOutcomes(executed);
  const parts: string[] = [];
  if (c.changed > 0) parts.push(plugin.t('{0} change(s) made', String(c.changed)));
  if (c.read > 0) parts.push(plugin.t('{0} lookup(s)', String(c.read)));
  if (c.denied > 0) parts.push(plugin.t('{0} denied by you', String(c.denied)));
  if (c.failed > 0) parts.push(plugin.t('{0} failed', String(c.failed)));
  const summary = plugin.t('AI tool calls: {0}.', parts.join(', '));
  const why = failureReasons(plugin, executed);
  const text = why ? `${summary} ${why}` : summary;
  return c.changed > 0 ? text : `${text} ${plugin.t('Nothing in the vault changed.')}`;
}

/** Failures named in the end notice; the rest are counted. */
const NAMED_FAILURES = 3;
/** Characters of a failure reason shown in the end notice. */
const FAILURE_REASON_MAX = 80;

/**
 * Why tool calls failed or were rejected (#281), as `tool (target) — reason`
 * for the first few, the target being the alias, ID, heading or note the call
 * named. All of them go to the console.
 */
function failureReasons(plugin: LabnotePlugin, executed: AgentRun['executed']): string {
  const failed = executed.filter(e => e.outcome === 'failed' || e.outcome === 'rejected');
  if (failed.length === 0) return '';
  for (const e of failed) console.warn('[labnoteo] AI tool call failed:', e.call.name, e.call.arguments, e.error);
  const named = failed.slice(0, NAMED_FAILURES).map(e => {
    const args = e.call.arguments as Record<string, unknown>;
    const pick = [args.alias, args.id, args.heading, args.documentPath].find(v => typeof v === 'string' && v.trim());
    const target = typeof pick === 'string' ? pick.split('/').pop() : undefined;
    const reason = (e.error ?? '').replace(/\s+/g, ' ').trim();
    const short = reason.length > FAILURE_REASON_MAX ? `${reason.slice(0, FAILURE_REASON_MAX - 1)}…` : reason;
    return `${e.call.name}${target ? ` (${target})` : ''}${short ? ` — ${short}` : ''}`;
  });
  const more = failed.length - named.length;
  const list = more > 0 ? `${named.join('; ')}; ${plugin.t('+{0} more', String(more))}` : named.join('; ');
  return plugin.t('Failed: {0}.', list);
}

async function complete(
  plugin: LabnotePlugin,
  messages: ChatMessage[]
): Promise<string | undefined> {
  const provider = createLlmProvider(plugin.settings);
  if (!provider) {
    new Notice(plugin.t('Configure an AI provider in settings first.'));
    return undefined;
  }
  try {
    const notice = new Notice(plugin.t('Contacting {0}…', provider.name), 0);
    let result;
    try {
      result = await provider.chat(messages, { temperature: 0.2 });
    } finally {
      notice.hide();
    }
    const content = result.content.trim();
    if (!content) {
      new Notice(noAnswerMessage(plugin, result.thinkingOnly), 10000);
      return undefined;
    }
    return content;
  } catch (err) {
    console.error('[labnoteo] AI request failed:', err);
    new Notice(describeLlmError(err, plugin.settings, plugin.t), 10000);
    return undefined;
  }
}

/**
 * Insert a model reply as its own block after the cursor's line, never
 * splitting the line (#48), then reveal it and mark the note edited so
 * `last_updated_date` refreshes. Reads text and cursor now, after the reply
 * arrived, since the user may have kept typing meanwhile.
 */
async function insertBlock(plugin: LabnotePlugin, target: EditTarget, block: string): Promise<void> {
  if (!target.getCursorOffset) {
    await target.insertAtCursor(`\n${block}\n`);
  } else {
    const plan = planBlockInsert(await target.getText(), await target.getCursorOffset(), block);
    await target.replaceRange(plan.offset, plan.offset, plan.text);
    await target.revealOffset?.(plan.offset + plan.text.length);
  }
  plugin.markUserEdit(target.path);
}

/** A note followed by reference, so a rename does not lose track of it (#260). */
interface NoteRef {
  readonly path: string;
}

/**
 * The note a command starts from. Obsidian keeps a `TFile`'s `path` up to
 * date, so holding the file rather than the path string means a reply still
 * goes in when the note was renamed while the model was writing (#260).
 * A note the vault index does not know falls back to the path as it was.
 */
function noteRef(plugin: LabnotePlugin, path: string): NoteRef {
  return plugin.app.vault.getFileByPath?.(path) ?? { path };
}

/**
 * Write a reply into the note the command started from (#112, the #77 rule).
 * The tab's editor may show another note by the time the reply arrives, so it
 * goes in directly only while that note is still the edit target; otherwise
 * it opens in the answer dialog, whose "Insert into note" checks again.
 */
async function deliverToNote(
  plugin: LabnotePlugin,
  note: NoteRef,
  content: string,
  write: (target: EditTarget) => Promise<void>,
  doneMessage: string
): Promise<void> {
  const writeIfOpen = async (): Promise<boolean> => {
    const current = plugin.host.editTarget();
    if (current?.path !== note.path) return false;
    await write(current);
    new Notice(plugin.t(doneMessage, note.path.split('/').pop() ?? note.path));
    return true;
  };
  if (await writeIfOpen()) return;
  aiAnswerModal(plugin.app, {
    content,
    sourcePath: note.path,
    onInsert: async () => {
      if (await writeIfOpen()) return true;
      new Notice(plugin.t('That note is no longer open. Copy the answer instead.'));
      return false;
    },
  });
}

/**
 * Put a Method draft in: over the unit operation's `#### Method` body when
 * the command started inside one (`loc`), else as a block after the cursor.
 */
async function writeMethodDraft(
  plugin: LabnotePlugin,
  target: EditTarget,
  loc: UnitOpMethodLocation | null,
  body: string
): Promise<void> {
  if (!loc) {
    await insertBlock(plugin, target, body);
    return;
  }
  const latest = await target.getText();
  const again = findUnitOpMethodByIndex(latest, loc.unitOpIndex, loc.unitOpHeading);
  if (!again) {
    new Notice(plugin.t('The unit operation changed while the AI was writing, so the draft was inserted after the cursor line instead.'));
    await insertBlock(plugin, target, body);
    return;
  }
  const edit = minimalReplacement(latest, replaceSectionBodyAt(latest, again.methodLine, body).md);
  if (edit) {
    await target.replaceRange(edit.start, edit.end, edit.text);
    await target.revealOffset?.(edit.start);
  }
  plugin.markUserEdit(target.path);
}

/** The model context for one unit operation: the note's head plus that block. */
function unitOpContext(text: string, loc: UnitOpMethodLocation): string {
  const lines = text.split('\n');
  const firstUnitOp = lines.findIndex(l => /^###\s+\[/.test(l));
  const head = lines.slice(0, firstUnitOp === -1 ? 40 : Math.min(firstUnitOp, 40)).join('\n');
  const block = lines.slice(loc.unitOpStartLine, loc.unitOpEndLine).join('\n');
  return `Note front matter and workflow description:\n${head.slice(0, 2000)}\n\nUnit operation:\n${block.slice(0, 4000)}`;
}

/**
 * Draft a Method section. Inside a unit operation the draft replaces that unit
 * operation's `#### Method` body (asking first when the researcher already
 * wrote one); anywhere else it goes in as a block after the cursor's line.
 */
export async function draftMethodCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note to insert into.'));
    return;
  }
  const note = noteRef(plugin, target.path);
  const text = await target.getText();
  let loc = target.getCursorOffset ? findUnitOpMethodAt(text, await target.getCursorOffset()) : null;
  if (!loc) {
    // Outside a unit operation of a note that has some: ask which Method (#164).
    const methods = listUnitOpMethods(text);
    if (methods.length > 0) {
      const chosen = await plugin.host.pick(
        methods.map(m => ({
          label: m.unitOpHeading.replace(/^###\s+/, ''),
          detail: m.isPlaceholder ? undefined : plugin.t('Has a Method already'),
          value: m,
        })),
        { placeholder: plugin.t("Which unit operation's Method should the draft go in?") }
      );
      if (!chosen) return;
      loc = chosen;
    }
  }

  if (loc && !loc.isPlaceholder) {
    // Ask before the request, not after: the reply can take minutes.
    if (!createLlmProvider(plugin.settings)) {
      new Notice(plugin.t('Configure an AI provider in settings first.'));
      return;
    }
    const ok = await plugin.host.confirm(
      plugin.t('This Method section already has content. Replace it with the AI draft?'),
      { confirmLabel: plugin.t('Replace'), destructive: true }
    );
    if (!ok) return;
  }

  if (!loc) {
    const out = await complete(plugin, [
      {
        role: 'system',
        content:
          'You write concise, reproducible **Method** subsections for a scientific lab notebook. Output only the Method body as GitHub-flavored Markdown: no front matter, no headings, no preamble or code fences. ' +
          replyLanguageInstruction(),
      },
      { role: 'user', content: `Draft a Method subsection for this note.\n\nContext:\n${text.slice(0, 6000)}` },
    ]);
    const cleaned = out ? cleanMethodDraft(out) : '';
    const draft = cleaned ? withDraftHeader(plugin, cleaned) : '';
    if (draft) {
      await deliverToNote(plugin, note, draft, t => writeMethodDraft(plugin, t, null, draft), 'Inserted the Method draft into {0}.');
    }
    return;
  }

  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You write the body of the **Method** subsection of one unit operation in a scientific lab notebook: concise, reproducible steps. Output only that body as GitHub-flavored Markdown (for example a numbered list) — no headings, no other subsections, no preamble or code fences. ' +
        replyLanguageInstruction(),
    },
    {
      role: 'user',
      content: `Draft the Method body for the unit operation "${loc.unitOpHeading.replace(/^###\s+/, '')}".\n\n${unitOpContext(text, loc)}`,
    },
  ]);
  if (!out) return;
  const body = withDraftHeader(plugin, extractMethodBody(out) || out.trim());
  await deliverToNote(plugin, note, body, t => writeMethodDraft(plugin, t, loc, body), 'Inserted the Method draft into {0}.');
}

/**
 * `draft` under a one-line `> [!note] AI draft (model, date)` callout (#280),
 * so a Method the model wrote reads as unchecked until someone removes it.
 * Summaries and the worksheet leave the line out.
 */
function withDraftHeader(plugin: LabnotePlugin, draft: string): string {
  const header = plugin.t(
    'AI draft ({0}, {1}) — review it, then delete this line',
    plugin.settings.llmModel || plugin.settings.llmProvider,
    getSeoulDateString()
  );
  return `> [!note] ${header}\n\n${draft}`;
}

/** Where a workflow note's result summary goes (#279). */
const CONCLUSIONS_HEADING = 'Conclusions and Discussion';
/** Where an experiment's summary goes in its README (#306). */
const README_SUMMARY_HEADING = 'Summary and Discussion';
/** Characters of results sent for a whole experiment, shared among its notes (#306). */
const EXPERIMENT_RESULTS_BUDGET = 10000;

/** The callout titles an earlier run of a summary wrote, in English and in the UI language. */
function summaryTitles(plugin: LabnotePlugin, key: string): string[] {
  const before = (title: string) => title.split(' (')[0].trim();
  return [...new Set([before(key), before(plugin.t(key))])];
}

/**
 * Put a summary callout at the end of the section `heading` (the note's end
 * without one), over the summary an earlier run left there when `replace`.
 * Reads the note now, after the reply arrived.
 */
async function writeSummary(
  plugin: LabnotePlugin,
  target: EditTarget,
  heading: string,
  titles: readonly string[],
  block: string
): Promise<void> {
  const text = await target.getText();
  const earlier = findAiCalloutInSection(text, heading, titles);
  if (earlier) {
    await target.replaceRange(earlier.start, earlier.end, block);
    await target.revealOffset?.(earlier.start);
  } else {
    const plan = planSectionAppend(text, heading, block) ?? {
      offset: text.length,
      text: `${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`,
    };
    await target.replaceRange(plan.offset, plan.offset, plan.text);
    await target.revealOffset?.(plan.offset + plan.text.length);
  }
  plugin.markUserEdit(target.path);
}

/** Ask before a summary replaces the one an earlier run wrote in `heading`. */
async function confirmReplaceSummary(plugin: LabnotePlugin, text: string, heading: string, titles: readonly string[]): Promise<boolean> {
  if (!findAiCalloutInSection(text, heading, titles)) return true;
  return plugin.host.confirm(plugin.t('"{0}" already has an AI summary. Replace it with a new one?', heading), {
    confirmLabel: plugin.t('Replace'),
    destructive: true,
  });
}

/** Whether `path` is an experiment README, which has a summary command of its own (#306). */
export function isExperimentReadme(path: string): boolean {
  return diagnoseWorkflowPath(path).kind === 'readme';
}

/**
 * Summarize the results of the active note (#279). In a workflow note only
 * its result sections are sent, and the summary goes at the end of
 * `Conclusions and Discussion`, replacing the one an earlier run put there;
 * in any other note the whole note is sent and the summary goes after the
 * cursor's line.
 */
export async function summarizeResultsCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note to insert into.'));
    return;
  }
  if (isExperimentReadme(target.path)) {
    new Notice(plugin.t('In an experiment README, run "{0}".', plugin.t('AI: Summarize experiment results')));
    return;
  }
  const note = noteRef(plugin, target.path);
  // Read from the SAME target we insert into (previously this read the active
  // MarkdownView, which could differ from the insert target when a sidebar had
  // focus — reading note A while writing to note B).
  const text = await target.getText();
  if (!text.trim()) {
    new Notice(plugin.t('Nothing to summarize.'));
    return;
  }
  // A note holding only the template used to be summarized into invented
  // measurements (#257), so stop while the result sections are still empty.
  if (!hasRecordedResults(text)) {
    new Notice(
      plugin.t('No results to summarize yet. Write them in "Results & Discussions" and run this again.'),
      8000
    );
    return;
  }
  const workflow = diagnoseWorkflowPath(target.path).kind === 'ok';
  const titles = summaryTitles(plugin, 'AI workflow results summary ({0}, {1})');
  if (workflow && !(await confirmReplaceSummary(plugin, text, CONCLUSIONS_HEADING, titles))) return;
  const results = workflow
    ? extractResultSections(text)
    : stripTemplatePlaceholders(stripAiCallouts(stripFrontMatter(text)));
  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You summarize experimental Results for a lab notebook as 3–6 concise Markdown bullet points. No preamble, no code fences. ' +
        'Use only measurements and observations written in the note; never invent a number, a result or a conclusion that is not there. ' +
        replyLanguageInstruction(),
    },
    {
      role: 'user',
      content: `Summarize these results:\n\n${results.slice(0, 6000)}`,
    },
  ]);
  if (!out) return;
  const model = plugin.settings.llmModel || plugin.settings.llmProvider;
  if (!workflow) {
    const block = toNoteCallout(out, plugin.t('AI summary ({0}, {1})', model, getSeoulDateString()));
    await deliverToNote(plugin, note, block, t => insertBlock(plugin, t, block), 'Inserted the summary into {0}.');
    return;
  }
  const block = toNoteCallout(out, plugin.t('AI workflow results summary ({0}, {1})', model, getSeoulDateString()));
  await deliverToNote(
    plugin,
    note,
    block,
    t => writeSummary(plugin, t, CONCLUSIONS_HEADING, titles, block),
    'Inserted the summary into {0}.'
  );
}

/** A note's text as the researcher sees it: from its open editor, else from the vault. */
async function readNoteNow(plugin: LabnotePlugin, path: string): Promise<string | undefined> {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view as { file?: { path: string }; editor?: { getValue(): string }; getMode?: () => string };
    if (view.file?.path === path && view.editor && view.getMode?.() === 'source') return view.editor.getValue();
  }
  const file = plugin.app.vault.getFileByPath(path);
  return file ? plugin.app.vault.cachedRead(file) : undefined;
}

/**
 * The workflow notes of the experiment in `dir`: in the README checklist's
 * order, then the ones it does not list, by number.
 */
function experimentNotes(plugin: LabnotePlugin, dir: string, readme: string): string[] {
  const names = plugin.app.vault
    .getMarkdownFiles()
    .filter(f => f.parent?.path === dir && parseWorkflowFileName(f.name))
    .map(f => f.name)
    .sort();
  const listed = workflowChecklistOrder(readme, names, dir);
  return [...listed, ...names.filter(n => !listed.includes(n))];
}

/**
 * Summarize a whole experiment from its README (#306): the result sections of
 * every workflow note, in checklist order and within a shared budget, plus
 * the README's own `Summary and Discussion` notes. The summary goes at the
 * end of that section, replacing the one an earlier run put there.
 */
export async function summarizeExperimentCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target || !isExperimentReadme(target.path)) {
    new Notice(plugin.t('Open an experiment README first.'));
    return;
  }
  const note = noteRef(plugin, target.path);
  const readme = await target.getText();
  const dir = target.path.slice(0, target.path.lastIndexOf('/'));
  const collected: Array<{ label: string; results: string }> = [];
  for (const name of experimentNotes(plugin, dir, readme)) {
    const text = await readNoteNow(plugin, `${dir}/${name}`);
    const results = text === undefined ? '' : extractResultSections(text);
    if (results) collected.push({ label: workflowLabelFor(name, text), results });
  }
  if (collected.length === 0) {
    new Notice(
      plugin.t('No results are written in the workflow notes of this experiment yet, so there is nothing to summarize.'),
      8000
    );
    return;
  }
  const titles = summaryTitles(plugin, 'AI experiment results summary ({0}, {1})');
  if (!(await confirmReplaceSummary(plugin, readme, README_SUMMARY_HEADING, titles))) return;
  const memo = stripAiCallouts(sectionText(readme, README_SUMMARY_HEADING) ?? '').trim();
  const shares = shareBudget(
    collected.map(c => c.results.length),
    EXPERIMENT_RESULTS_BUDGET
  );
  const body = collected.map((c, i) => `## ${c.label}\n${c.results.slice(0, shares[i])}`).join('\n\n');
  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You summarize a whole experiment for its lab notebook overview from the results of its workflows, given in order: ' +
        '3–8 concise Markdown bullet points on what was found and how the workflows connect, then one line on what is still open. ' +
        'No preamble, no code fences. Use only what is written; never invent a number, a result or a conclusion. ' +
        replyLanguageInstruction(),
    },
    {
      role: 'user',
      content: `${memo ? `The researcher's own notes on the experiment:\n${memo.slice(0, 2000)}\n\n` : ''}Results of each workflow:\n\n${body}`,
    },
  ]);
  if (!out) return;
  const header = plugin.t(
    'AI experiment results summary ({0}, {1})',
    plugin.settings.llmModel || plugin.settings.llmProvider,
    getSeoulDateString()
  );
  const block = toNoteCallout(out, header);
  await deliverToNote(
    plugin,
    note,
    block,
    t => writeSummary(plugin, t, README_SUMMARY_HEADING, titles, block),
    plugin.t('Summarized the results of {0} workflow note(s) into {1}.', String(collected.length), '{0}')
  );
}

/**
 * `body` as a `> [!note] header` callout (#150), so an AI summary reads as
 * one block that is clearly the model's and not the researcher's.
 */
export function toNoteCallout(body: string, header: string): string {
  const lines = body.trim().split(/\r?\n/).map(l => (l.trim() === '' ? '>' : `> ${l}`));
  return [`> [!note] ${header}`, ...lines].join('\n');
}

interface ExtractedSample {
  type?: string;
  id?: string;
  alias?: string;
  description?: string;
  location?: string;
}

/**
 * Pull a JSON array out of a model's reply.
 *
 * Models ignore "respond with ONLY JSON" often enough that this has to cope
 * with code fences and surrounding prose; anything it cannot parse becomes an
 * empty list, which the caller reports as "no samples found".
 */
export function parseJsonArray(raw: string): ExtractedSample[] {
  const fenced = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ExtractedSample[]) : [];
  } catch {
    return [];
  }
}

/** {@link prepareExtractedSamples} output: what to create, and what was fixed. */
export interface PreparedSamples {
  samples: Array<{ type: string; id?: string; alias?: string; description?: string; location?: string }>;
  /** Samples whose model-given id broke the `<Type>-<number>` rule and gets a new one. */
  regenerated: number;
  /** Samples dropped because their type is not a known sample type. */
  unknownType: number;
}

/**
 * Bring model-extracted samples in line with the sample rules before saving
 * (#61): the type takes its known spelling (unknown types are dropped), an id
 * keeps its canonical form when it is `<Type>-<number>` and is otherwise
 * replaced by a generated one. A dropped id like `ND-11` is usually a model
 * or catalog number, so it is kept as the alias when the model gave none.
 */
export function prepareExtractedSamples(
  extracted: readonly ExtractedSample[],
  types: readonly string[]
): PreparedSamples {
  const out: PreparedSamples = { samples: [], regenerated: 0, unknownType: 0 };
  for (const s of extracted) {
    const type = typeof s.type === 'string' ? canonicalSampleType(s.type, types) : undefined;
    if (!type) {
      out.unknownType++;
      continue;
    }
    const rawId = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : undefined;
    const id = rawId === undefined ? undefined : normalizeSampleId(type, rawId);
    const alias = typeof s.alias === 'string' && s.alias.trim() ? toAlias(s.alias) : undefined;
    const description = typeof s.description === 'string' ? s.description.replace(/;/g, ',') : undefined;
    // Free text in the registry, so it goes in as written (#190).
    const location = typeof s.location === 'string' && s.location.trim() ? s.location.trim() : undefined;
    if (rawId !== undefined && !id) {
      out.regenerated++;
      out.samples.push({ type, alias: alias ?? toAlias(rawId), description, location });
    } else {
      out.samples.push({ type, id, alias, description, location });
    }
  }
  return out;
}

/** A description compared the way {@link skipKnownSamples} compares them. */
function descriptionKey(v: string): string {
  return v.replace(/;/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Split extracted samples into new ones and ones already there (#153): an id
 * a registry in `registries` (`type → id → record`) holds or the note already
 * references (`referenced`, `type|id`), or the alias of a sample of the same
 * type (case ignored, registry aliases fitted like extracted ones). With no
 * alias on either side, the same type and description also count as the same
 * sample. Running the command again then adds only what is new.
 */
export function skipKnownSamples(
  samples: PreparedSamples['samples'],
  registries: ReadonlyArray<Record<string, Record<string, SampleRecord>>>,
  referenced: ReadonlySet<string>
): { fresh: PreparedSamples['samples']; skipped: number } {
  const ids = new Set(referenced);
  const aliases = new Set<string>();
  const descriptions = new Set<string>();
  const aliasKey = (type: string, alias: string | null | undefined): string | undefined => {
    const fitted = alias?.trim() ? toAlias(alias) : undefined;
    return fitted === undefined ? undefined : `${type}|${fitted}`.toLowerCase();
  };
  const descKey = (type: string, description: string | undefined): string | undefined => {
    const key = description ? descriptionKey(description) : '';
    return key ? `${type.toLowerCase()}|${key}` : undefined;
  };
  for (const registry of registries) {
    for (const [type, records] of Object.entries(registry)) {
      for (const [id, rec] of Object.entries(records)) {
        ids.add(`${type}|${id}`.toLowerCase());
        const a = aliasKey(type, rec.alias);
        if (a) aliases.add(a);
        else {
          for (const d of rec.descriptions ?? []) {
            const k = descKey(type, d);
            if (k) descriptions.add(k);
          }
        }
      }
    }
  }
  const fresh: PreparedSamples['samples'] = [];
  let skipped = 0;
  for (const s of samples) {
    const a = aliasKey(s.type, s.alias);
    const d = a ? undefined : descKey(s.type, s.description);
    const known =
      (s.id !== undefined && ids.has(`${s.type}|${s.id}`.toLowerCase())) ||
      (a !== undefined && aliases.has(a)) ||
      (d !== undefined && descriptions.has(d));
    if (known) {
      skipped++;
      continue;
    }
    fresh.push(s);
    // Two extracted entries for one sample count once.
    if (s.id !== undefined) ids.add(`${s.type}|${s.id}`.toLowerCase());
    if (a) aliases.add(a);
    if (d) descriptions.add(d);
  }
  return { fresh, skipped };
}

/** Ask the model to extract sample definitions, then persist them via the tool. */
export async function extractSamplesCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note first.'));
    return;
  }
  // Read from the same target we persist samples against (see above).
  const text = await target.getText();
  if (!text.trim()) {
    new Notice(plugin.t('Nothing to extract.'));
    return;
  }

  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'Extract laboratory sample definitions from the text. Respond with ONLY a JSON array of objects with keys "type", "id" (optional), "alias" (optional), "description" (optional), "location" (optional). ' +
        `"type" must be one of: ${types.join(', ')}. ` +
        '"alias" is the short name or code the text gives the sample (e.g. "YE-22"). ' +
        '"location" is where the text says it is stored (e.g. "4°C fridge shelf 1"); keep it out of "description". ' +
        '"id" must look like "<type>-<number>" (e.g. "DNA-3"); omit it when the text gives no such id — do not use model or catalog numbers as ids. No prose.',
    },
    { role: 'user', content: text.slice(0, 6000) },
  ]);
  if (!out) return;

  const prepared = prepareExtractedSamples(parseJsonArray(out).filter(s => s.type), types);
  if (prepared.samples.length === 0) {
    new Notice(plugin.t('No samples found.'));
    return;
  }

  const globalFolder = plugin.settings.globalSampleFolder;
  const folders = [noteLabsamplesFolder(target.path, globalFolder), globalFolder].filter(Boolean);
  const sampleTypes = [...new Set(prepared.samples.map(s => s.type))];
  const registries: Array<Record<string, Record<string, SampleRecord>>> = [];
  for (const folder of folders) {
    const registry: Record<string, Record<string, SampleRecord>> = {};
    for (const type of sampleTypes) registry[type] = await loadSamplesByType(plugin.fs, folder, type);
    registries.push(registry);
  }
  const referenced = new Set(
    findSampleReferenceSpans(await target.getText(), types).map(r => `${r.type}|${r.id}`.toLowerCase())
  );
  const { fresh, skipped } = skipKnownSamples(prepared.samples, registries, referenced);

  const tools = createLabnoteTools();
  const ctx = toolContext(plugin);

  let created = 0;
  let noLocation = 0;
  let inGlobal = false;
  for (const s of fresh) {
    const res = await runTool(tools, 'create_sample', ctx, { ...s, documentPath: target.path });
    if (res.ok) {
      created++;
      if (!s.location) noLocation++;
      if ((res.data as { scope?: string } | undefined)?.scope === 'global') inGlobal = true;
    }
  }
  const parts = [
    skipped > 0
      ? plugin.t('Created {0} new sample(s); skipped {1} already registered or in the note.', String(created), String(skipped))
      : plugin.t('Created {0} sample(s).', String(created)),
  ];
  if (prepared.regenerated > 0) {
    parts.push(plugin.t('{0} got a new ID because theirs did not match <Type>-<number>.', String(prepared.regenerated)));
  }
  if (prepared.unknownType > 0) {
    parts.push(plugin.t('{0} skipped: unknown sample type.', String(prepared.unknownType)));
  }
  if (noLocation > 0) {
    parts.push(plugin.t('{0} have no storage location; add it with Edit sample in the Samples view.', String(noLocation)));
  }
  if (inGlobal) {
    parts.push(plugin.t('This note is outside an experiment folder, so they were added to Global samples.'));
  }
  new Notice(parts.join(' '));
}

/**
 * Free-form agentic command: the user states a goal and the model reaches it by
 * calling Labnote tools, with every mutating call confirmed.
 *
 * Unlike the commands above, the sequence of tool calls is the model's decision
 * rather than hardcoded here — this is the same capability an external MCP
 * client already had.
 */
export async function askAgentCommand(plugin: LabnotePlugin): Promise<void> {
  const provider = createLlmProvider(plugin.settings);
  if (!provider) {
    new Notice(plugin.t('Configure an AI provider in settings first.'));
    return;
  }

  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a lab note first.'));
    return;
  }

  const goal = await plugin.host.prompt({
    title: plugin.t('Ask the AI assistant'),
    prompt: plugin.t('What should the assistant do?'),
    placeholder: plugin.t('e.g. Add a Method section describing the PCR setup'),
  });
  if (!goal?.trim()) return;

  const noteText = (await target.getText()).slice(0, 6000);
  const notice = new Notice(plugin.t('Contacting {0}…', provider.name), 0);
  try {
    const run = await runAgent(
      [
        {
          role: 'system',
          content:
            'You are a lab notebook assistant. Use the provided tools to inspect and edit the notebook. ' +
            `The active note is "${target.path}"; pass it as documentPath. ` +
            'Prefer reading before writing, and answer briefly in Markdown when done. ' +
            'Your final answer is shown to the user in a dialog and is not written to the note; ' +
            'to change the note, use the tools. ' +
            `Your tools are: ${createLabnoteTools().map(t => t.name).join(', ')}. ` +
            'If the request needs something these tools cannot do (for example changing the experiment status), ' +
            'do not pretend: answer that you cannot do it and which Labnote command the user can run instead.',
        },
        { role: 'user', content: `${goal}\n\nActive note:\n${noteText}` },
      ],
      {
        provider,
        ctx: toolContext(plugin),
        temperature: 0.2,
        confirm: (call, tool, preview) => {
          // Show the write target, not just the tool name: the model chooses
          // the path, so approving by name alone is blind approval.
          const path = typeof call.arguments.documentPath === 'string' ? call.arguments.documentPath : null;
          const prompt = plugin.t('Allow AI tool "{0}" to modify the vault?', tool.name);
          return plugin.host.confirm(buildApprovalMessage(plugin.t, prompt, path, preview), {
            confirmLabel: plugin.t('Allow'),
            destructive: erasesRecordedLines(preview),
          });
        },
      }
    );

    if (run.stoppedAtLimit) {
      new Notice(`${plugin.t('AI stopped after too many steps.')} ${toolRunNotice(plugin, run.executed)}`, 10000);
      return;
    }
    const answer = run.content;
    if (!answer.trim()) {
      // No answer to show; the tool summary below still says what happened
      // (#161, #186). After a change that summary is the answer: "try again"
      // would invite doing it twice (#286).
      if (countToolOutcomes(run.executed).changed === 0) {
        new Notice(
          run.thinkingOnly
            ? noAnswerMessage(plugin, true)
            : run.executed.length === 0
              ? plugin.t('The assistant gave no answer. What you asked may be outside the tools it can use.')
              : plugin.t('The assistant gave no answer.'),
          10000
        );
      }
    } else {
      // The answer only goes in on request (#77), possibly minutes later, so
      // the note must still be the one open.
      aiAnswerModal(plugin.app, {
        content: answer,
        sourcePath: target.path,
        onInsert: async () => {
          const current = plugin.host.editTarget();
          if (current?.path !== target.path) {
            new Notice(plugin.t('That note is no longer open. Copy the answer instead.'));
            return false;
          }
          await insertBlock(plugin, current, answer);
          return true;
        },
      });
    }
    new Notice(toolRunNotice(plugin, run.executed), 8000);
  } catch (err) {
    console.error('[labnoteo] AI request failed:', err);
    new Notice(describeLlmError(err, plugin.settings, plugin.t), 10000);
  } finally {
    notice.hide();
  }
}
