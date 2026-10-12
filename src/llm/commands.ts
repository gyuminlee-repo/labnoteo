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
import { createLabnoteTools, runTool, type ToolContext } from '@labnoteo/core';
import type LabnotePlugin from '../main';
import { createLlmProvider, type ChatMessage } from './provider';
import { runAgent } from './agent';
import { writeNoteThroughVault } from '../commands';
import { getObsidianLanguage } from '../i18n';

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
    writeNote: (path, content) =>
      writeNoteThroughVault(plugin.app, plugin.host, path, content),
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

/** Draft a Method section from surrounding context and insert it at the cursor. */
export async function draftMethodCommand(plugin: LabnotePlugin): Promise<void> {
  const target = plugin.host.editTarget();
  if (!target) {
    new Notice(plugin.t('Open a note to insert into.'));
    return;
  }
  const context = (await target.getText()).slice(0, 6000);
  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'You write concise, reproducible **Method** subsections for a scientific lab notebook. Output GitHub-flavored Markdown only, no preamble or code fences.',
    },
    { role: 'user', content: `Draft a Method subsection for this note.\n\nContext:\n${context}` },
  ]);
  if (!out) return;
  await target.insertAtCursor(out.endsWith('\n') ? out : out + '\n');
}

/** Summarize the current results (selection or whole note) at the cursor. */
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
  await target.insertAtCursor(`\n${out}\n`);
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

  const out = await complete(plugin, [
    {
      role: 'system',
      content:
        'Extract laboratory sample definitions from the text. Respond with ONLY a JSON array of objects with keys "type", "id" (optional), "alias" (optional), "description" (optional). "type" should be a sample type like DNA, RNA, Plasmid, Reagent, Primer, Protein, Equip, or Labware. No prose.',
    },
    { role: 'user', content: text.slice(0, 6000) },
  ]);
  if (!out) return;

  const samples = parseJsonArray(out).filter(s => s.type);
  if (samples.length === 0) {
    new Notice(plugin.t('No samples found.'));
    return;
  }

  const tools = createLabnoteTools();
  const ctx = toolContext(plugin);

  let created = 0;
  for (const s of samples) {
    const res = await runTool(tools, 'create_sample', ctx, {
      type: s.type,
      id: s.id,
      alias: s.alias,
      description: s.description,
      documentPath: target.path,
    });
    if (res.ok) created++;
  }
  new Notice(plugin.t('Created {0} sample(s).', String(created)));
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

  const notice = new Notice(plugin.t('Contacting {0}…', provider.name), 0);
  try {
    const run = await runAgent(
      [
        {
          role: 'system',
          content:
            'You are a lab notebook assistant. Use the provided tools to inspect and edit the notebook. ' +
            `The active note is "${target.path}"; pass it as documentPath. ` +
            'Prefer reading before writing, and answer briefly in Markdown when done.',
        },
        { role: 'user', content: goal },
      ],
      {
        provider,
        ctx: toolContext(plugin),
        temperature: 0.2,
        confirm: (call, tool) => {
          // Show the write target, not just the tool name: the model chooses
          // the path, so approving by name alone is blind approval.
          const path = typeof call.arguments.documentPath === 'string' ? call.arguments.documentPath : null;
          const prompt = plugin.t('Allow AI tool "{0}" to modify the vault?', tool.name);
          return plugin.host.confirm(path ? `${prompt}\n\n${plugin.t('Target: {0}', path)}` : prompt, {
            confirmLabel: plugin.t('Allow'),
          });
        },
      }
    );

    if (run.stoppedAtLimit) {
      new Notice(plugin.t('AI stopped after too many steps.'));
      return;
    }
    if (run.content) await target.insertAtCursor(`\n${run.content}\n`);
    new Notice(plugin.t('AI ran {0} tool call(s).', String(run.executed.length)));
  } catch (err) {
    new Notice(plugin.t('AI request failed: {0}', err instanceof Error ? err.message : String(err)));
  } finally {
    notice.hide();
  }
}
