/**
 * Turn a failed LLM request into a notice that says what to fix (#123). The raw
 * error stays in the console; the notice names the setting to check, using the
 * labels the settings tab shows.
 */
import type { Translator } from '@labnoteo/core';
import type { LabnoteSettings } from '../settings';

/** An HTTP error response from a provider, with the status and body kept apart. */
export class LlmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`${provider} request failed (${status}): ${body}`);
    this.name = 'LlmHttpError';
  }
}

const CONNECTION_FAILURE =
  /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|timed? ?out/i;

/** The endpoint is not an http(s) URL, e.g. `htp://…` or `ftp://…` (#203). */
const SCHEME_FAILURE =
  /only supports http: and https:|Invalid URL|Failed to parse URL|unsupported protocol|ERR_UNKNOWN_URL_SCHEME|ERR_INVALID_URL/i;

const DETAIL_MAX = 160;

/** The `error.message` (OpenAI) or `error` (Ollama) of a JSON body, else the body. */
function errorDetail(body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const error = parsed?.error;
    if (typeof error === 'string') detail = error;
    else if (error && typeof (error as { message?: unknown }).message === 'string') {
      detail = (error as { message: string }).message;
    }
  } catch {
    // Not JSON: show the body as is.
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

export function describeLlmError(err: unknown, settings: LabnoteSettings, t: Translator): string {
  const ollama = settings.llmProvider === 'ollama';
  const providerName = ollama ? 'Ollama' : 'OpenAI';
  const endpoint = ollama ? settings.llmEndpointOllama : settings.llmEndpointOpenai;
  const setting = (label: string): string =>
    [t('Settings'), 'Labnote Assistant', t('AI provider'), t(label)].join(' → ');
  const endpointSetting = setting(ollama ? 'Ollama endpoint' : 'OpenAI endpoint');

  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403) {
      return t('The API key is missing or wrong. Check {0}.', setting('API key'));
    }
    if (err.status === 404) {
      if (/model/i.test(err.body)) {
        return t('Model {0} was not found. Check {1}.', settings.llmModel, setting('Model'));
      }
      return t(
        '{0} has no such address (404). Check {1}: enter only the server address, without a path such as /v1 or /api.',
        endpoint,
        endpointSetting
      );
    }
    return t('AI request failed: {0}', `${err.status} ${errorDetail(err.body)}`.trim());
  }

  const message = err instanceof Error ? err.message : String(err);
  if (SCHEME_FAILURE.test(message)) {
    return t(
      '{0} is not an http:// or https:// address. Check {1}: write it like {2}.',
      endpoint,
      endpointSetting,
      ollama ? 'http://localhost:11434' : 'https://api.openai.com'
    );
  }
  if (CONNECTION_FAILURE.test(message)) {
    return t('Cannot connect to {0} ({1}). Check that it is running and that {2} is right.', providerName, endpoint, endpointSetting);
  }
  return t('AI request failed: {0}', errorDetail(message));
}
