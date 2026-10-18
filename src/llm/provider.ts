/**
 * LLM provider abstraction for the Obsidian build.
 *
 * VS Code delegates AI to Copilot Chat; Obsidian talks to a local Ollama or an
 * OpenAI-compatible endpoint directly. All HTTP goes through Obsidian's
 * {@link requestUrl}, which bypasses CORS and works on both desktop and mobile.
 *
 * Requests are **non-streaming**: `requestUrl` has no streaming API, and a
 * single buffered response keeps behaviour identical on mobile (where there is
 * no Node/Electron fallback). Streaming, if ever added, must be desktop-guarded
 * behind `Platform.isDesktopApp` with a Node `fetch` path.
 *
 * Tool calling: both providers accept the same OpenAI-style `tools` schema, but
 * their *responses* differ in three ways that this module normalizes away, so
 * the agent loop never branches on provider:
 *
 *   |            | tool call id | arguments   | result message keyed by |
 *   |------------|--------------|-------------|-------------------------|
 *   | OpenAI     | `id` present | JSON string | `tool_call_id`          |
 *   | Ollama     | omitted      | object      | `tool_name`             |
 */
import { requestUrl } from 'obsidian';
import type { ToolDef } from '@labnoteo/core';
import type { LabnoteSettings } from '../settings';
import { LlmHttpError } from './llmError';

/** One tool invocation the model asked for, in provider-neutral form. */
export interface ToolCall {
  /**
   * Correlates a result with its request. Synthesized for Ollama, which omits
   * ids — it pairs results by tool name instead.
   */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turn: the tools the model wants run before it can continue. */
  toolCalls?: ToolCall[];
  /** Tool turn: the id of the call this answers (OpenAI pairs on this). */
  toolCallId?: string;
  /** Tool turn: the name of the tool that ran (Ollama pairs on this). */
  toolName?: string;
}

/**
 * A model turn. `toolCalls` is empty for a normal completion; when it is not,
 * the caller must run the tools and send the results back as `role: 'tool'`
 * messages before the model will produce its answer.
 */
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  temperature?: number;
  /** Tools to offer the model. Omitted entirely for a plain completion. */
  tools?: ToolDef[];
}

export interface LlmProvider {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

/** Join a base URL and path with exactly one slash between them. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/**
 * Wire format for the `tools` request field. Ollama adopted OpenAI's shape, so
 * one serialization serves both.
 */
export function toolSchemas(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Coerce a tool call's arguments to an object.
 *
 * OpenAI sends a JSON *string*, Ollama sends an object, and a model can emit
 * malformed JSON in either. An unparseable payload becomes `{}` so the handler
 * reports a missing-argument error the model can recover from, rather than the
 * loop dying on a `SyntaxError`.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Normalize a provider's `tool_calls` array, synthesizing ids where absent. */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((call: RawToolCall, i) => ({
      id: typeof call?.id === 'string' && call.id ? call.id : `call_${i}`,
      name: typeof call?.function?.name === 'string' ? call.function.name : '',
      arguments: parseToolArguments(call?.function?.arguments),
    }))
    .filter(c => c.name !== '');
}

class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(private readonly settings: LabnoteSettings) {}

  /** Ollama keys tool results by `tool_name` and takes arguments as objects. */
  private static toWire(messages: ChatMessage[]): unknown[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_name: m.toolName, content: m.content };
      }
      if (m.toolCalls?.length) {
        return {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls.map(c => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const res = await requestUrl({
      url: joinUrl(this.settings.llmEndpointOllama, '/api/chat'),
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        model: this.settings.llmModel,
        messages: OllamaProvider.toWire(messages),
        stream: false,
        tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
        options: opts?.temperature != null ? { temperature: opts.temperature } : undefined,
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new LlmHttpError('Ollama', res.status, res.text);
    }
    return {
      content: res.json?.message?.content ?? '',
      toolCalls: normalizeToolCalls(res.json?.message?.tool_calls),
    };
  }
}

class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  constructor(private readonly settings: LabnoteSettings) {}

  /** OpenAI keys tool results by `tool_call_id` and takes arguments as JSON strings. */
  private static toWire(messages: ChatMessage[]): unknown[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.toolCalls?.length) {
        return {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.llmApiKey) {
      headers.Authorization = `Bearer ${this.settings.llmApiKey}`;
    }
    const res = await requestUrl({
      url: joinUrl(this.settings.llmEndpointOpenai, '/v1/chat/completions'),
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.settings.llmModel,
        messages: OpenAiProvider.toWire(messages),
        temperature: opts?.temperature,
        tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new LlmHttpError('OpenAI', res.status, res.text);
    }
    const message = res.json?.choices?.[0]?.message;
    return {
      content: message?.content ?? '',
      toolCalls: normalizeToolCalls(message?.tool_calls),
    };
  }
}

/** Build the configured provider, or null when AI is disabled. */
export function createLlmProvider(settings: LabnoteSettings): LlmProvider | null {
  switch (settings.llmProvider) {
    case 'ollama':
      return new OllamaProvider(settings);
    case 'openai':
      return new OpenAiProvider(settings);
    default:
      return null;
  }
}
