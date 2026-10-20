/**
 * The tool-calling loop that makes the built-in AI agentic.
 *
 * Until now the plugin's own AI was one-shot (prompt → text → insert) while an
 * *external* MCP client could drive the same tools in a loop. This closes that
 * gap by reusing the exact pieces the MCP path already uses — `createLabnoteTools`,
 * `ToolContext`, the `writeNote` hook, and the `mutates` confirmation policy —
 * so the two entry points cannot drift in what they permit.
 *
 * The loop is deliberately small: ask the model, run whatever it asked for,
 * feed the results back, repeat until it answers in prose or we hit the cap.
 */
import {
  createLabnoteTools,
  runTool,
  type ToolContext,
  type ToolPreview,
  type ToolDef,
} from '@labnoteo/core';
import type { ChatMessage, ChatResult, LlmProvider, ToolCall } from './provider';

/**
 * Ceiling on model round-trips per invocation.
 *
 * A model that keeps calling tools without converging would otherwise loop
 * forever, and every iteration is a real HTTP request plus possible vault
 * writes. Six leaves room for a realistic chain (look up a sample, read a unit
 * operation, then write a section) without letting a confused model run away.
 */
export const MAX_ITERATIONS = 6;

export interface AgentDeps {
  provider: LlmProvider;
  ctx: ToolContext;
  /**
   * Ask the user to approve a mutating tool call. Returning false is a normal
   * outcome, not an error: the denial is reported to the model, which can adapt.
   * `preview` is the tool's {@link ToolDef.describe} result, when it has one.
   */
  confirm(call: ToolCall, tool: ToolDef, preview?: Exclude<ToolPreview, { error: string }>): Promise<boolean>;
  /** Tools to offer. Defaults to the full core registry. */
  tools?: ToolDef[];
  temperature?: number;
}

/**
 * What became of one tool call (#186): `done` ran and succeeded, `denied` was
 * refused in the approval dialog, `rejected` was refused by the tool before
 * anyone was asked, `failed` ran and returned an error.
 */
export type ToolOutcome = 'done' | 'denied' | 'rejected' | 'failed';

export interface AgentRun {
  /** The model's final prose answer (empty if it never produced one). */
  content: string;
  /** True when the final turn had reasoning but no answer (#195). */
  thinkingOnly?: boolean;
  /** Every call of a known tool, in order; `mutates` tells writes from reads. */
  executed: Array<{ call: ToolCall; outcome: ToolOutcome; mutates: boolean }>;
  /** True when the cap stopped the loop before the model finished. */
  stoppedAtLimit: boolean;
}

/** {@link AgentRun.executed} counted the way the end notice reports it. */
export function countToolOutcomes(executed: AgentRun['executed']): {
  changed: number;
  read: number;
  denied: number;
  failed: number;
} {
  const counts = { changed: 0, read: 0, denied: 0, failed: 0 };
  for (const e of executed) {
    if (e.outcome === 'done') counts[e.mutates ? 'changed' : 'read']++;
    else if (e.outcome === 'denied') counts.denied++;
    else counts.failed++;
  }
  return counts;
}

/**
 * Serialize a tool outcome for the model. Errors are sent back as content
 * rather than thrown: a wrong argument or a missing sample is something the
 * model can correct on the next turn, and killing the run would discard the
 * work it already did.
 */
function resultMessage(call: ToolCall, payload: unknown): ChatMessage {
  return {
    role: 'tool',
    content: JSON.stringify(payload),
    toolCallId: call.id,
    toolName: call.name,
  };
}

/**
 * Run the model until it stops asking for tools.
 *
 * `messages` is not mutated; the returned transcript lives only inside the call.
 */
export async function runAgent(
  messages: ChatMessage[],
  deps: AgentDeps
): Promise<AgentRun> {
  const tools = deps.tools ?? createLabnoteTools();
  const history: ChatMessage[] = [...messages];
  const executed: AgentRun['executed'] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const turn: ChatResult = await deps.provider.chat(history, {
      temperature: deps.temperature,
      tools,
    });

    if (turn.toolCalls.length === 0) {
      return {
        content: turn.content,
        ...(turn.thinkingOnly ? { thinkingOnly: true } : {}),
        executed,
        stoppedAtLimit: false,
      };
    }

    // The assistant turn must be echoed back verbatim: both providers reject a
    // tool result that does not follow the call it answers.
    history.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      const tool = tools.find(t => t.name === call.name);
      if (!tool) {
        history.push(resultMessage(call, { error: `Unknown tool: ${call.name}` }));
        continue;
      }

      if (tool.mutates) {
        // A call the tool would reject anyway is not put to the user; the
        // model gets the real reason instead of "denied" (#69).
        const preview = tool.describe ? await tool.describe(deps.ctx, call.arguments) : undefined;
        if (preview && 'error' in preview) {
          history.push(resultMessage(call, { error: preview.error }));
          executed.push({ call, outcome: 'rejected', mutates: true });
          continue;
        }
        if (!(await deps.confirm(call, tool, preview))) {
          history.push(resultMessage(call, { error: 'User denied this write.' }));
          executed.push({ call, outcome: 'denied', mutates: true });
          continue;
        }
      }

      const res = await runTool(tools, call.name, deps.ctx, call.arguments);
      const payload = res.ok ? (res.data ?? null) : { error: res.error };
      // Wrapped only when there is something to say, so the common payload
      // stays exactly what the tool returned.
      history.push(
        resultMessage(
          call,
          res.warnings?.length
            ? { ...(res.ok ? { data: payload } : payload), warnings: res.warnings }
            : payload
        )
      );
      executed.push({ call, outcome: res.ok ? 'done' : 'failed', mutates: !!tool.mutates });
    }
  }

  return { content: '', executed, stoppedAtLimit: true };
}
