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
  extractMethodBody,
  planBlockInsert,
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
} from '@labnoteo/core/lib/sampleUtils';
import type LabnotePlugin from '../main';
import { createLlmProvider, type ChatMessage } from './provider';
import { runAgent } from './agent';
import { buildApprovalMessage } from './approvalMessage';
import { getObsidianLanguage } from '../i18n';
import { aiAnswerModal } from '../modals';

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
  };
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
    try {
      return (await provider.chat(messages, { temperature: 0.2 })).content.trim();
    } finally {
      notice.hide();
    }
  } catch (err) {
    new Notice(plugin.t('AI request failed: {0}', err instanceof Error ? err.message : String(err)));
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
  const text = await target.getText();
  const loc = target.getCursorOffset ? findUnitOpMethodAt(text, await target.getCursorOffset()) : null;

  if (loc && !loc.isPlaceholder) {
    // Ask before the request, not after: the reply can take minutes.
    if (!createLlmProvider(plugin.settings)) {
      new Notice(plugin.t('Configure an AI provider in settings first.'));
      return;
    }
    const ok = await plugin.host.confirm(
      plugin.t('This Method section already has content. Replace it with the AI draft?'),
      { confirmLabel: plugin.t('Replace') }
    );
    if (!ok) return;
  }

  if (!loc) {
    const out = await complete(plugin, [
      {
        role: 'system',
        content:
          'You write concise, reproducible **Method** subsections for a scientific lab notebook. Output GitHub-flavored Markdown only, no preamble or code fences.',
      },
      { role: 'user', content: `Draft a Method subsection for this note.\n\nContext:\n${text.slice(0, 6000)}` },
    ]);
    if (out) await insertBlock(plugin, target, out);
    return;
  }

  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You write the body of the **Method** subsection of one unit operation in a scientific lab notebook: concise, reproducible steps. Output only that body as GitHub-flavored Markdown (for example a numbered list) — no headings, no other subsections, no preamble or code fences.',
    },
    {
      role: 'user',
      content: `Draft the Method body for the unit operation "${loc.unitOpHeading.replace(/^###\s+/, '')}".\n\n${unitOpContext(text, loc)}`,
    },
  ]);
  if (!out) return;
  const body = extractMethodBody(out) || out.trim();

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

/** Summarize the whole note as a block after the cursor's line. */
export async function summarizeResultsCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note to insert into.'));
    return;
  }
  // Read from the SAME target we insert into (previously this read the active
  // MarkdownView, which could differ from the insert target when a sidebar had
  // focus — reading note A while writing to note B).
  const text = await target.getText();
  if (!text.trim()) {
    new Notice(plugin.t('Nothing to summarize.'));
    return;
  }
  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You summarize experimental Results for a lab notebook as 3–6 concise Markdown bullet points. No preamble, no code fences.',
    },
    { role: 'user', content: `Summarize these results:\n\n${text.slice(0, 6000)}` },
  ]);
  if (!out) return;
  await insertBlock(plugin, target, out);
}

interface ExtractedSample {
  type?: string;
  id?: string;
  alias?: string;
  description?: string;
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
  samples: Array<{ type: string; id?: string; alias?: string; description?: string }>;
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
    // `create_sample` rejects the characters that split a sample in a note
    // (#98); nobody can be asked here, so replace them instead.
    const toAlias = (v: string) => v.replace(/[;:]/g, '-');
    const alias = typeof s.alias === 'string' && s.alias.trim() ? toAlias(s.alias) : undefined;
    const description = typeof s.description === 'string' ? s.description.replace(/;/g, ',') : undefined;
    if (rawId !== undefined && !id) {
      out.regenerated++;
      out.samples.push({ type, alias: alias ?? toAlias(rawId), description });
    } else {
      out.samples.push({ type, id, alias, description });
    }
  }
  return out;
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
        'Extract laboratory sample definitions from the text. Respond with ONLY a JSON array of objects with keys "type", "id" (optional), "alias" (optional), "description" (optional). ' +
        `"type" must be one of: ${types.join(', ')}. ` +
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

  const tools = createLabnoteTools();
  const ctx = toolContext(plugin);

  let created = 0;
  let inGlobal = false;
  for (const s of prepared.samples) {
    const res = await runTool(tools, 'create_sample', ctx, { ...s, documentPath: target.path });
    if (res.ok) {
      created++;
      if ((res.data as { scope?: string } | undefined)?.scope === 'global') inGlobal = true;
    }
  }
  const parts = [plugin.t('Created {0} sample(s).', String(created))];
  if (prepared.regenerated > 0) {
    parts.push(plugin.t('{0} got a new ID because theirs did not match <Type>-<number>.', String(prepared.regenerated)));
  }
  if (prepared.unknownType > 0) {
    parts.push(plugin.t('{0} skipped: unknown sample type.', String(prepared.unknownType)));
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
            'to change the note, use the tools.',
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
          });
        },
      }
    );

    if (run.stoppedAtLimit) {
      new Notice(plugin.t('AI stopped after too many steps.'));
      return;
    }
    const answer = run.content;
    if (answer) {
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
    new Notice(plugin.t('AI ran {0} tool call(s).', String(run.executed.length)));
  } catch (err) {
    new Notice(plugin.t('AI request failed: {0}', err instanceof Error ? err.message : String(err)));
  } finally {
    notice.hide();
  }
}
