/**
 * LLM provider wiring. The interesting property is a security one: the API key
 * lives in a single settings field, so an `Authorization` header must reach
 * OpenAI and must never reach a local Ollama endpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolDef } from '@labnoteo/core';
import { joinUrl, createLlmProvider, parseToolArguments } from '../../src/llm/provider';
import { DEFAULT_SETTINGS, type LabnoteSettings } from '../../src/settings';
import { __setRequestUrlHandler, type RequestUrlParam } from '../stubs/obsidian';

const settings = (over: Partial<LabnoteSettings>): LabnoteSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe('joinUrl', () => {
  it('inserts exactly one slash regardless of how each side is punctuated', () => {
    expect(joinUrl('http://h:1', '/api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1/', '/api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1', 'api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1///', '///api/chat')).toBe('http://h:1/api/chat');
  });

  it('leaves slashes inside the path alone', () => {
    expect(joinUrl('http://h:1', '/v1/chat/completions')).toBe('http://h:1/v1/chat/completions');
  });

  // #203: 'localhost:11434' without a scheme failed with a raw "ClientRequest only supports http:" error.
  it('adds http:// to a base without a scheme and keeps an existing one', () => {
    expect(joinUrl('localhost:11434', '/api/chat')).toBe('http://localhost:11434/api/chat');
    expect(joinUrl(' 127.0.0.1:11434/ ', 'api/chat')).toBe('http://127.0.0.1:11434/api/chat');
    expect(joinUrl('https://api.openai.com', '/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUrl('HTTP://h:1', '/x')).toBe('HTTP://h:1/x');
  });
});

describe('createLlmProvider', () => {
  it('returns null when AI is disabled', () => {
    expect(createLlmProvider(settings({ llmProvider: 'none' }))).toBeNull();
  });

  it('builds the provider named by the setting', () => {
    expect(createLlmProvider(settings({ llmProvider: 'ollama' }))?.name).toBe('ollama');
    expect(createLlmProvider(settings({ llmProvider: 'openai' }))?.name).toBe('openai');
  });
});

describe('provider.chat', () => {
  let calls: RequestUrlParam[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    __setRequestUrlHandler(null);
  });

  /** Install a handler that records the request and replies with `body`. */
  const respond = (status: number, json: unknown): void => {
    __setRequestUrlHandler(param => {
      calls.push(param);
      return { status, text: JSON.stringify(json), json, headers: {} };
    });
  };

  it('ollama posts to /api/chat and unwraps message.content', async () => {
    respond(200, { message: { content: 'hi from llama' } });
    const provider = createLlmProvider(
      settings({ llmProvider: 'ollama', llmEndpointOllama: 'http://localhost:11434/' })
    );

    const out = await provider!.chat([{ role: 'user', content: 'hello' }]);

    expect(out.content).toBe('hi from llama');
    expect(out.toolCalls).toEqual([]);
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].method).toBe('POST');
  });

  it('ollama never attaches an Authorization header, even with a key configured', async () => {
    respond(200, { message: { content: '' } });
    const provider = createLlmProvider(
      settings({ llmProvider: 'ollama', llmApiKey: 'sk-must-not-leak' })
    );

    await provider!.chat([{ role: 'user', content: 'x' }]);

    const headers = calls[0].headers ?? {};
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.stringify(calls[0])).not.toContain('sk-must-not-leak');
  });

  it('openai posts to /v1/chat/completions with a bearer key', async () => {
    respond(200, { choices: [{ message: { content: 'hi from gpt' } }] });
    const provider = createLlmProvider(
      settings({ llmProvider: 'openai', llmApiKey: 'sk-test', llmEndpointOpenai: 'https://api.openai.com' })
    );

    const out = await provider!.chat([{ role: 'user', content: 'hello' }]);

    expect(out.content).toBe('hi from gpt');
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers?.Authorization).toBe('Bearer sk-test');
  });

  it('openai omits Authorization when no key is set', async () => {
    respond(200, { choices: [] });
    const provider = createLlmProvider(settings({ llmProvider: 'openai', llmApiKey: '' }));

    await provider!.chat([{ role: 'user', content: 'x' }]);

    expect(calls[0].headers?.Authorization).toBeUndefined();
  });

  it('returns an empty string when the response has no content', async () => {
    respond(200, {});
    const ollama = createLlmProvider(settings({ llmProvider: 'ollama' }));
    expect((await ollama!.chat([])).content).toBe('');

    respond(200, { choices: [] });
    const openai = createLlmProvider(settings({ llmProvider: 'openai' }));
    expect((await openai!.chat([])).content).toBe('');
  });

  // #195: a thinking model that answers with reasoning only is marked so.
  it('marks a reply with reasoning but no content as thinking-only', async () => {
    respond(200, { message: { content: '', thinking: 'Let me think…' } });
    const ollama = createLlmProvider(settings({ llmProvider: 'ollama' }));
    expect(await ollama!.chat([])).toEqual({ content: '', toolCalls: [], thinkingOnly: true });

    respond(200, { choices: [{ message: { content: null, reasoning_content: 'hmm' } }] });
    const openai = createLlmProvider(settings({ llmProvider: 'openai' }));
    expect((await openai!.chat([])).thinkingOnly).toBe(true);

    respond(200, { message: { content: 'answer', thinking: 'Let me think…' } });
    expect((await ollama!.chat([])).thinkingOnly).toBeUndefined();
  });

  it('throws with the status and body on an error response', async () => {
    respond(500, { error: 'model not found' });
    const provider = createLlmProvider(settings({ llmProvider: 'ollama' }));

    await expect(provider!.chat([])).rejects.toThrow(/500/);
  });
});

describe('parseToolArguments', () => {
  it("accepts OpenAI's JSON string", () => {
    expect(parseToolArguments('{"type":"DNA","id":"DNA-1"}')).toEqual({ type: 'DNA', id: 'DNA-1' });
  });

  it("accepts Ollama's plain object", () => {
    expect(parseToolArguments({ type: 'DNA' })).toEqual({ type: 'DNA' });
  });

  it('degrades to an empty object rather than throwing on malformed JSON', () => {
    // A truncated or hallucinated payload must reach the handler as "no args"
    // so it answers with a validation error the model can fix, not a crash.
    expect(parseToolArguments('{"type": "DN')).toEqual({});
    expect(parseToolArguments('not json at all')).toEqual({});
  });

  it('rejects non-object payloads', () => {
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
    expect(parseToolArguments('[1,2,3]')).toEqual({});
    expect(parseToolArguments(42)).toEqual({});
  });
});

// The two providers agree on the request schema but disagree on every part of
// the response and on how a result is paired back to its call. These tests pin
// each difference, since getting one wrong fails only at runtime against a real
// model.
describe('tool calling', () => {
  let calls: RequestUrlParam[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    __setRequestUrlHandler(null);
  });

  const respond = (json: unknown): void => {
    __setRequestUrlHandler(param => {
      calls.push(param);
      return { status: 200, text: JSON.stringify(json), json, headers: {} };
    });
  };

  const body = (): Record<string, unknown> =>
    JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;

  const fakeTool: ToolDef = {
    name: 'get_sample',
    mutates: false,
    description: 'Look up a sample.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async () => ({ ok: true }),
  };

  it('sends the same OpenAI-style tool schema to both providers', async () => {
    const expected = [
      {
        type: 'function',
        function: {
          name: 'get_sample',
          description: 'Look up a sample.',
          parameters: fakeTool.inputSchema,
        },
      },
    ];

    respond({ message: { content: '' } });
    await createLlmProvider(settings({ llmProvider: 'ollama' }))!.chat([], { tools: [fakeTool] });
    expect(body().tools).toEqual(expected);

    calls = [];
    respond({ choices: [{ message: { content: '' } }] });
    await createLlmProvider(settings({ llmProvider: 'openai' }))!.chat([], { tools: [fakeTool] });
    expect(body().tools).toEqual(expected);
  });

  it('omits tools entirely for a plain completion', async () => {
    respond({ message: { content: 'hi' } });
    await createLlmProvider(settings({ llmProvider: 'ollama' }))!.chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(body().tools).toBeUndefined();
  });

  it('normalizes ollama tool calls, synthesizing the id it omits', async () => {
    respond({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'get_sample', arguments: { id: 'DNA-1' } } }],
      },
    });

    const out = await createLlmProvider(settings({ llmProvider: 'ollama' }))!.chat([], {
      tools: [fakeTool],
    });

    expect(out.toolCalls).toEqual([
      { id: 'call_0', name: 'get_sample', arguments: { id: 'DNA-1' } },
    ]);
  });

  it('normalizes openai tool calls, parsing the arguments string', async () => {
    respond({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: { name: 'get_sample', arguments: '{"id":"DNA-1"}' },
              },
            ],
          },
        },
      ],
    });

    const out = await createLlmProvider(settings({ llmProvider: 'openai' }))!.chat([], {
      tools: [fakeTool],
    });

    expect(out.toolCalls).toEqual([
      { id: 'call_abc123', name: 'get_sample', arguments: { id: 'DNA-1' } },
    ]);
  });

  it('drops a tool call with no name instead of dispatching an empty one', async () => {
    respond({ message: { content: '', tool_calls: [{ function: { arguments: {} } }] } });
    const out = await createLlmProvider(settings({ llmProvider: 'ollama' }))!.chat([]);
    expect(out.toolCalls).toEqual([]);
  });

  const history = [
    { role: 'user' as const, content: 'look it up' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'call_abc', name: 'get_sample', arguments: { id: 'DNA-1' } }],
    },
    {
      role: 'tool' as const,
      content: '{"alias":"pUC19"}',
      toolCallId: 'call_abc',
      toolName: 'get_sample',
    },
  ];

  it('serializes history for ollama: object arguments, results keyed by tool_name', async () => {
    respond({ message: { content: 'done' } });
    await createLlmProvider(settings({ llmProvider: 'ollama' }))!.chat(history);

    const messages = body().messages as Array<Record<string, unknown>>;
    expect(messages[1].tool_calls).toEqual([
      { function: { name: 'get_sample', arguments: { id: 'DNA-1' } } },
    ]);
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_name: 'get_sample',
      content: '{"alias":"pUC19"}',
    });
    // Ollama has no notion of a call id; sending one is not part of its schema.
    expect(messages[2].tool_call_id).toBeUndefined();
  });

  it('serializes history for openai: string arguments, results keyed by tool_call_id', async () => {
    respond({ choices: [{ message: { content: 'done' } }] });
    await createLlmProvider(settings({ llmProvider: 'openai' }))!.chat(history);

    const messages = body().messages as Array<Record<string, unknown>>;
    expect(messages[1].tool_calls).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_sample', arguments: '{"id":"DNA-1"}' },
      },
    ]);
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: '{"alias":"pUC19"}',
    });
    expect(messages[2].tool_name).toBeUndefined();
  });
});
