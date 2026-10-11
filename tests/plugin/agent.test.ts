/**
 * The agent loop. Two properties carry real risk and get the most attention:
 * a mutating tool must never run without consent, and a model that keeps
 * calling tools must not loop forever.
 *
 * The provider is a scripted fake — the point is the loop's control flow, not
 * any model's behaviour.
 */
import { describe, it, expect } from 'vitest';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import type { ToolContext, ToolDef } from '@labnoteo/core';
import { runAgent, MAX_ITERATIONS } from '../../src/llm/agent';
import type { ChatMessage, ChatResult, LlmProvider, ToolCall } from '../../src/llm/provider';

/** Replays a fixed script of turns and records what it was sent. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly seen: ChatMessage[][] = [];
  private turn = 0;

  constructor(private readonly script: ChatResult[]) {}

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    // Past the end of the script the model just answers, which is how a real
    // one behaves once it has what it needs.
    return this.script[this.turn++] ?? { content: 'done', toolCalls: [] };
  }
}

const call = (name: string, args: Record<string, unknown> = {}, id = 'call_0'): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (toolCalls: ToolCall[]): ChatResult => ({ content: '', toolCalls });

/** Records every invocation so tests can assert a tool did or did not run. */
function makeTools(): { tools: ToolDef[]; ran: string[] } {
  const ran: string[] = [];
  const tools: ToolDef[] = [
    {
      name: 'read_thing',
      mutates: false,
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('read_thing');
        return { ok: true, data: { value: 42 } };
      },
    },
    {
      name: 'write_thing',
      mutates: true,
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('write_thing');
        return { ok: true, data: { written: true } };
      },
    },
    {
      name: 'failing_thing',
      mutates: false,
      description: 'fails',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('failing_thing');
        return { ok: false, error: 'boom' };
      },
    },
  ];
  return { tools, ran };
}

const ctx = (): ToolContext => ({ fs: new MemFileSystem(), workspaceRoot: '.' });

const allow = async (): Promise<boolean> => true;
const deny = async (): Promise<boolean> => false;

describe('runAgent', () => {
  it('returns the answer directly when the model asks for no tools', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([{ content: 'just an answer', toolCalls: [] }]);

    const run = await runAgent([{ role: 'user', content: 'hi' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(run.content).toBe('just an answer');
    expect(run.executed).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('runs a read-only tool without asking the user', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);
    let asked = 0;

    const run = await runAgent([{ role: 'user', content: 'read it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: async () => {
        asked++;
        return true;
      },
    });

    expect(ran).toEqual(['read_thing']);
    expect(asked).toBe(0);
    expect(run.content).toBe('done');
  });

  it('asks before a mutating tool and runs it once allowed', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const asked: string[] = [];

    await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: async (_c, tool) => {
        asked.push(tool.name);
        return true;
      },
    });

    expect(asked).toEqual(['write_thing']);
    expect(ran).toEqual(['write_thing']);
  });

  it('does NOT run a mutating tool when the user denies it', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);

    const run = await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: deny,
    });

    expect(ran).toEqual([]);
    expect(run.executed).toEqual([{ call: call('write_thing'), ok: false }]);
  });

  it('tells the model about a denial so it can adapt', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);

    await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: deny,
    });

    const secondRequest = provider.seen[1];
    const toolMessage = secondRequest[secondRequest.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).toContain('denied');
  });

  it('feeds a tool error back instead of aborting the run', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([
      turn([call('failing_thing')]),
      turn([call('read_thing')]),
    ]);

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    // The model recovered and called a second tool after the failure.
    expect(ran).toEqual(['failing_thing', 'read_thing']);
    expect(run.executed.map(e => e.ok)).toEqual([false, true]);
    expect(run.content).toBe('done');
  });

  it('reports an unknown tool to the model rather than throwing', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('no_such_tool')])]);

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    const second = provider.seen[1];
    expect(second[second.length - 1].content).toContain('Unknown tool');
    // An unknown name never counts as executed.
    expect(run.executed).toEqual([]);
  });

  it('tells the model which arguments the tool ignored', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing', { foo: 1 })])]);

    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });

    expect(ran).toEqual(['read_thing']);
    const second = provider.seen[1];
    const payload = JSON.parse(second[second.length - 1].content);
    expect(payload.data).toEqual({ value: 42 });
    expect(payload.warnings[0]).toContain('foo');
  });

  it('passes the tool data through unchanged when there is nothing to warn about', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);

    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });

    const second = provider.seen[1];
    expect(second[second.length - 1].content).toBe('{"value":42}');
  });

  it('echoes the assistant turn back before the tool results', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);

    await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    // Both providers reject a tool result that does not follow its call.
    const second = provider.seen[1];
    expect(second[1].role).toBe('assistant');
    expect(second[1].toolCalls).toEqual([call('read_thing')]);
    expect(second[2].role).toBe('tool');
    expect(second[2].toolCallId).toBe('call_0');
    expect(second[2].toolName).toBe('read_thing');
  });

  it('runs every call in a parallel tool turn', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([
      turn([call('read_thing', {}, 'a'), call('write_thing', {}, 'b')]),
    ]);

    await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(ran).toEqual(['read_thing', 'write_thing']);
  });

  it('stops at the iteration cap when the model never converges', async () => {
    const { tools, ran } = makeTools();
    // Always asks for another tool — a real runaway.
    const provider = new ScriptedProvider(
      Array.from({ length: MAX_ITERATIONS + 5 }, () => turn([call('read_thing')]))
    );

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(run.stoppedAtLimit).toBe(true);
    expect(ran).toHaveLength(MAX_ITERATIONS);
    expect(provider.seen).toHaveLength(MAX_ITERATIONS);
  });

  it('leaves the caller\'s message array untouched', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];

    await runAgent(messages, { provider, ctx: ctx(), tools, confirm: allow });

    expect(messages).toEqual([{ role: 'user', content: 'go' }]);
  });
});
