/**
 * #123: a failed AI request says what to fix, in the settings' own labels,
 * instead of the raw `net::ERR_…` or JSON body.
 */
import { describe, it, expect } from 'vitest';
import { describeLlmError, LlmHttpError } from '../../src/llm/llmError';
import { DEFAULT_SETTINGS, type LabnoteSettings } from '../../src/settings';

const t = (key: string, ...args: Array<string | number | boolean>) =>
  key.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)]));

const settings = (over: Partial<LabnoteSettings> = {}): LabnoteSettings => ({
  ...DEFAULT_SETTINGS,
  llmProvider: 'ollama',
  llmModel: 'llama3.1',
  ...over,
});

describe('describeLlmError', () => {
  it('points an unreachable server to its endpoint setting', () => {
    expect(describeLlmError(new Error('net::ERR_CONNECTION_REFUSED'), settings(), t)).toBe(
      'Cannot connect to Ollama (http://localhost:11434). Check that it is running and that Settings → Labnote Assistant → AI provider → Ollama endpoint is right.'
    );
    expect(describeLlmError(new Error('getaddrinfo ENOTFOUND api.example'), settings({ llmProvider: 'openai' }), t)).toContain(
      'Cannot connect to OpenAI (https://api.openai.com).'
    );
    expect(describeLlmError(new Error('Request timed out'), settings(), t)).toContain('Cannot connect to Ollama');
  });

  it('points 401 and 403 to the API key', () => {
    for (const status of [401, 403]) {
      expect(describeLlmError(new LlmHttpError('OpenAI', status, '{}'), settings({ llmProvider: 'openai' }), t)).toBe(
        'The API key is missing or wrong. Check Settings → Labnote Assistant → AI provider → API key.'
      );
    }
  });

  it('tells a missing model from a wrong endpoint path on 404', () => {
    expect(
      describeLlmError(new LlmHttpError('Ollama', 404, '{"error":"model \\"llama3.1\\" not found, try pulling it first"}'), settings(), t)
    ).toBe('Model llama3.1 was not found. Check Settings → Labnote Assistant → AI provider → Model.');

    const s = settings({ llmProvider: 'openai', llmEndpointOpenai: 'https://api.openai.com/v1' });
    expect(describeLlmError(new LlmHttpError('OpenAI', 404, '404 page not found'), s, t)).toBe(
      'https://api.openai.com/v1 has no such address (404). Check Settings → Labnote Assistant → AI provider → OpenAI endpoint: enter only the server address, without a path such as /v1 or /api.'
    );
  });

  it('shows the status and the JSON error message, cut to length, otherwise', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached. '.repeat(20) } });
    const notice = describeLlmError(new LlmHttpError('OpenAI', 429, body), settings({ llmProvider: 'openai' }), t);

    expect(notice.startsWith('AI request failed: 429 Rate limit reached.')).toBe(true);
    expect(notice.endsWith('…')).toBe(true);
    expect(notice.length).toBeLessThan(200);
    expect(describeLlmError(new LlmHttpError('Ollama', 500, '{"error":"boom"}'), settings(), t)).toBe('AI request failed: 500 boom');
  });

  it('keeps the status in the error message itself', () => {
    expect(new LlmHttpError('Ollama', 500, 'x').message).toBe('Ollama request failed (500): x');
  });
});
