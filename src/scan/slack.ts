/**
 * Slack as a way in for scans: send photos of worksheets to your own Slack
 * bot by DM (or post them in a private channel the bot was invited to), and
 * this PC files them and replies in the thread.
 *
 * The bot token and the link to one Slack user stay on this PC (see
 * `pcStore`). Linking works with a one-time code the user sends to the bot,
 * so only that person's files are taken, and only messages sent after it.
 *
 * Before touching a message this PC claims it with an 👀 reaction, so two PCs
 * given the same token do not both file the same photo. `claimedTs` remembers
 * the claims this PC made, so a message it claimed and then crashed on is
 * finished rather than mistaken for another PC's work.
 */
import { requestUrl } from 'obsidian';
import type { Translator } from '@labnoteo/core';
import type { PcStore } from './pcStore';
import type { ScanInput, ScanResult } from './scanPipeline';
import { describeResult } from './resultModal';

export type SlackMode = 'dm' | 'channel';

export interface SlackConfig {
  token: string;
  mode: SlackMode;
  /** Private channel ID (`C…`/`G…`) in channel mode; the DM's ID once linked in DM mode. */
  channelId?: string;
  /** Code waiting to be sent to the bot, while linking. */
  linkCode?: string;
  /** The linked Slack user. */
  userId?: string;
  /** Slack timestamp of the newest message handled (or of the link message). */
  lastTs?: string;
  /** Timestamps of the messages this PC claimed with the 👀 reaction (newest last). */
  claimedTs?: string[];
}

const KEY = 'slack';
const API = 'https://slack.com/api/';
const FILE_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** History pages collected per check: Slack returns newest first, so the oldest fall off past this. */
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_LIMIT = 200;
/** Claims remembered; older ones are long handled (`lastTs` has moved past them). */
const MAX_CLAIMS = 200;

/** What the bot needs; `reactions:write` is only recommended (the 👀 claim that keeps two PCs apart). */
export const REQUIRED_SCOPES: Record<SlackMode, readonly string[]> = {
  dm: ['im:history', 'im:read', 'files:read', 'chat:write'],
  channel: ['groups:history', 'files:read', 'chat:write'],
};
export const RECOMMENDED_SCOPE = 'reactions:write';

/**
 * A Slack error as what to fix, with the code after it (#397). Slack's
 * codes are snake_case; anything else came from the request itself.
 */
export function describeSlackError(t: Translator, code: string): string {
  if (!/^[a-z_]+$/.test(code)) return t('Could not reach Slack; check the internet connection ({0}).', code);
  const fix =
    code === 'invalid_auth' || code === 'not_authed' || code === 'account_inactive'
      ? t('The bot token is not valid. Copy the Bot User OAuth Token (xoxb-…) again from OAuth & Permissions of your Slack app.')
      : code === 'token_revoked' || code === 'token_expired' || code === 'app_uninstalled'
        ? t('The bot token was revoked or the app was removed. Reinstall the Slack app and copy its new token.')
        : code === 'missing_scope'
          ? t('The bot token is missing a permission. Add the scopes in docs/SCAN.md under OAuth & Permissions and reinstall the app.')
          : '';
  return fix ? `${fix} (${code})` : code;
}

/**
 * The channel ID in `input`: an ID (`C…`/`G…`) or a Slack link holding one
 * (`…/archives/C…`, `…/client/T…/C…`); undefined otherwise (#397).
 */
export function slackChannelId(input: string): string | undefined {
  const s = input.trim();
  if (/^[CG][A-Z0-9]+$/.test(s)) return s;
  return /\/(?:archives|client\/T[A-Z0-9]+)\/([CG][A-Z0-9]+)(?:[/?#]|$)/.exec(s)?.[1];
}

interface SlackFile {
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}
interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: SlackFile[];
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('ratelimited');
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
}

export function newLinkCode(random: () => number = Math.random): string {
  return `labnote-${Math.floor(random() * 900000 + 100000)}`;
}

/** Messages to take from a channel's history: the linked user's files after `lastTs`, oldest first. */
export function messagesToProcess(messages: readonly SlackMessage[], cfg: SlackConfig): SlackMessage[] {
  const after = Number(cfg.lastTs ?? '0');
  return messages
    .filter(m => !m.bot_id && m.user === cfg.userId && Number(m.ts) > after && (m.files?.length ?? 0) > 0)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** The message carrying the link code, if any. */
export function findLinkMessage(messages: readonly SlackMessage[], code: string): SlackMessage | undefined {
  return messages.find(m => !m.bot_id && m.user && (m.text ?? '').includes(code));
}

export interface SlackVerification {
  /** The bot's user name, for "/invite @…" guidance. */
  botName: string;
  /** Required scopes the token does not have. Empty when the scopes header was absent. */
  missingScopes: string[];
  /** Whether `reactions:write` is missing (only when the scopes header was present). */
  missingRecommended: boolean;
  /** Channel mode: the bot is not in the channel (or the channel was not found). */
  notInChannel: boolean;
}

export interface SlackDeps {
  store: PcStore;
  t: Translator;
  run(inputs: ScanInput[]): Promise<ScanResult[]>;
  summarize(results: ScanResult[]): string;
  notify(message: string): void;
  report(results: ScanResult[]): void;
}

export class SlackInbox {
  readonly pollMs = 90_000;
  private polling = false;
  private stopped = false;
  private warned = false;
  private reactionScopeWarned = false;
  /** Wall-clock time before which Slack asked not to call again (429). */
  private pauseUntil = 0;
  /** What the last failed check said, for the settings screen. */
  lastError: string | undefined;

  constructor(private readonly deps: SlackDeps) {}

  config(): SlackConfig | undefined {
    const cfg = this.deps.store.get<SlackConfig>(KEY);
    return cfg && typeof cfg.token === 'string' && cfg.token ? cfg : undefined;
  }

  /** Settings changed: save and let warnings show again. */
  save(cfg: SlackConfig | undefined): void {
    this.deps.store.set(KEY, cfg);
    this.warned = false;
    this.reactionScopeWarned = false;
    this.lastError = undefined;
  }

  /** Bookkeeping (`lastTs`, `claimedTs`): saved without resetting the warning state. */
  private saveState(cfg: SlackConfig): void {
    this.deps.store.set(KEY, cfg);
  }

  status(): 'off' | 'linking' | 'linked' {
    const cfg = this.config();
    if (!cfg) return 'off';
    return cfg.userId ? 'linked' : 'linking';
  }

  /** Start linking: a fresh code to send to the bot. */
  beginLink(token: string, mode: SlackMode, channelId?: string): string {
    const code = newLinkCode();
    this.save({ token: token.trim(), mode, channelId: mode === 'channel' ? channelId?.trim() : undefined, linkCode: code });
    return code;
  }

  disconnect(): void {
    this.save(undefined);
  }

  start(): void {
    this.stopped = false;
    if (this.config()) void this.poll();
  }

  stop(): void {
    this.stopped = true;
  }

  private async call<T>(
    method: string,
    params: Record<string, string>,
    token: string,
    post = false
  ): Promise<{ json: { ok: boolean; error?: string } & T; headers: Record<string, string> }> {
    const res = post
      ? await requestUrl({
          url: API + method,
          method: 'POST',
          contentType: 'application/json; charset=utf-8',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(params),
          throw: false,
        })
      : await requestUrl({
          url: `${API}${method}?${new URLSearchParams(params).toString()}`,
          headers: { Authorization: `Bearer ${token}` },
          throw: false,
        });
    const json = (res.json ?? JSON.parse(res.text)) as { ok: boolean; error?: string } & T;
    if (res.status === 429 || json.error === 'ratelimited') {
      throw new RateLimited(Number(header(res.headers, 'retry-after') ?? '0') * 1000);
    }
    return { json, headers: res.headers ?? {} };
  }

  private async api<T>(method: string, params: Record<string, string>, token: string, post = false): Promise<T> {
    const { json } = await this.call<T>(method, params, token, post);
    if (!json.ok) throw new Error(json.error ?? 'HTTP error');
    return json;
  }

  /**
   * Check the token before linking: who the bot is, which required scopes are
   * missing (none reported when Slack omits the scopes header), and in channel
   * mode whether the bot is in the channel. Throws on a bad token.
   */
  async verify(token: string, mode: SlackMode, channelId?: string): Promise<SlackVerification> {
    const { json, headers } = await this.call<{ user?: string }>('auth.test', {}, token, true);
    if (!json.ok) throw new Error(json.error ?? 'HTTP error');
    const botName = json.user ?? 'bot';
    const scopesHeader = header(headers, 'x-oauth-scopes');
    const scopes = new Set((scopesHeader ?? '').split(',').map(s => s.trim()).filter(Boolean));
    const missingScopes = scopesHeader ? REQUIRED_SCOPES[mode].filter(s => !scopes.has(s)) : [];
    const missingRecommended = Boolean(scopesHeader) && !scopes.has(RECOMMENDED_SCOPE);
    let notInChannel = false;
    if (mode === 'channel' && channelId) {
      try {
        await this.api('conversations.history', { channel: channelId, limit: '1' }, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'not_in_channel' || msg === 'channel_not_found') notInChannel = true;
        else if (!(err instanceof RateLimited)) throw err;
      }
    }
    return { botName, missingScopes, missingRecommended, notInChannel };
  }

  /** The channel's history after `oldest`, oldest first (across pages, newest pages first from Slack). */
  private async collectHistory(
    token: string,
    channel: string,
    oldest?: string
  ): Promise<{ messages: SlackMessage[]; truncated: boolean }> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const params: Record<string, string> = { channel, limit: String(HISTORY_PAGE_LIMIT) };
      if (oldest) params.oldest = oldest;
      if (cursor) params.cursor = cursor;
      const res = await this.api<{ messages: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
        'conversations.history',
        params,
        token
      );
      messages.push(...res.messages);
      cursor = res.response_metadata?.next_cursor;
      if (!res.has_more || !cursor) return { messages, truncated: false };
    }
    return { messages, truncated: true };
  }

  /** Check for the link code or for new files. */
  async poll(): Promise<void> {
    const cfg = this.config();
    if (!cfg || this.polling || this.stopped || Date.now() < this.pauseUntil) return;
    this.polling = true;
    try {
      if (!cfg.userId) await this.pollLink(cfg);
      else await this.pollFiles(cfg);
      this.lastError = undefined;
    } catch (err) {
      if (err instanceof RateLimited) {
        // Slack asked for a pause: pick up where lastTs left off on a later check.
        this.pauseUntil = Date.now() + Math.max(err.retryAfterMs, this.pollMs);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      console.warn('[labnoteo] Slack check failed:', msg);
      if (!this.warned) {
        this.warned = true;
        this.deps.notify(
          this.deps.t(
            'Slack scans: checking failed ({0}). See the Slack section of docs/SCAN.md for the bot permissions.',
            describeSlackError(this.deps.t, msg)
          )
        );
      }
    } finally {
      this.polling = false;
    }
  }

  private threadGuidance(): string {
    return this.deps.t('Send new photos as a new message here, not as a reply in this thread.');
  }

  private async pollLink(cfg: SlackConfig): Promise<void> {
    if (!cfg.linkCode) return;
    const channels =
      cfg.mode === 'channel' && cfg.channelId
        ? [cfg.channelId]
        : (await this.api<{ channels: { id: string }[] }>('conversations.list', { types: 'im', limit: '200' }, cfg.token)).channels.map(c => c.id);
    for (const channel of channels) {
      const { messages } = await this.collectHistory(cfg.token, channel);
      const hit = findLinkMessage(messages, cfg.linkCode);
      if (!hit?.user) continue;
      this.save({ ...cfg, channelId: channel, userId: hit.user, lastTs: hit.ts, linkCode: undefined });
      await this.api(
        'chat.postMessage',
        {
          channel,
          thread_ts: hit.ts,
          text: `${this.deps.t('Linked. Send photos or scans of printed worksheets here, and they will be filed in their notes.')} ${this.threadGuidance()}`,
        },
        cfg.token,
        true
      );
      this.deps.notify(this.deps.t('Slack scans are linked. Photos you send to the bot are filed in their notes.'));
      return;
    }
  }

  /**
   * Claim `ts` with the 👀 reaction. `true` to process it here: a fresh claim,
   * one this PC made earlier (crashed mid-work), or no way to claim (the scope
   * is missing — a lone PC works fine without it).
   */
  private async claim(cfg: SlackConfig, ts: string): Promise<boolean> {
    try {
      await this.api('reactions.add', { channel: cfg.channelId!, timestamp: ts, name: 'eyes' }, cfg.token, true);
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'already_reacted') return (cfg.claimedTs ?? []).includes(ts);
      if (msg === 'missing_scope' && !this.reactionScopeWarned) {
        this.reactionScopeWarned = true;
        this.deps.notify(this.deps.t('The Slack bot cannot add the 👀 reaction (reactions:write). Fine on one PC, but do not link a second one.'));
      }
      return true;
    }
    const latest = this.config() ?? cfg;
    this.saveState({ ...latest, claimedTs: [...(latest.claimedTs ?? []), ts].slice(-MAX_CLAIMS) });
    return true;
  }

  /** One message's files, downloaded: inputs to run, plus per-file failures for the summary. */
  private async download(cfg: SlackConfig, files: readonly SlackFile[]): Promise<{ inputs: ScanInput[]; failures: ScanResult[] }> {
    const inputs: ScanInput[] = [];
    const failures: ScanResult[] = [];
    for (const file of files) {
      const name = file.name ?? 'slack-file';
      if (!FILE_RE.test(name) || (file.size ?? 0) > MAX_FILE_BYTES) {
        failures.push({ source: name, status: 'unsupported' });
        continue;
      }
      if (!file.url_private_download) {
        failures.push({ source: name, status: 'error', message: this.deps.t('Slack gave no download link (the file may be deleted, or hidden by the free plan limit).') });
        continue;
      }
      const res = await requestUrl({ url: file.url_private_download, headers: { Authorization: `Bearer ${cfg.token}` }, throw: false });
      const type = header(res.headers, 'content-type') ?? '';
      if (res.status >= 400 || type.includes('text/html')) {
        failures.push({ source: name, status: 'error', message: this.deps.t('Slack refused the download (check the files:read permission).') });
        continue;
      }
      inputs.push({ name, bytes: res.arrayBuffer });
    }
    return { inputs, failures };
  }

  private async pollFiles(cfg: SlackConfig): Promise<void> {
    if (!cfg.channelId) return;
    const { messages, truncated } = await this.collectHistory(cfg.token, cfg.channelId, cfg.lastTs);
    if (truncated) this.deps.notify(this.deps.t('Slack had more messages than one check reads; the oldest may have been skipped.'));
    for (const message of messagesToProcess(messages, cfg)) {
      if (this.stopped) return;
      if (!(await this.claim(cfg, message.ts))) {
        // Another PC's work: step past it and leave it alone.
        const latest = this.config() ?? cfg;
        this.saveState({ ...latest, lastTs: message.ts });
        continue;
      }
      const { inputs, failures } = await this.download(cfg, message.files ?? []);
      const results = [...(inputs.length ? await this.deps.run(inputs) : []), ...failures];
      // Done with this message — remember that before replying, so a failed
      // reply (chat:write missing, …) cannot make the next check redo it.
      const latest = this.config() ?? cfg;
      this.saveState({ ...latest, lastTs: message.ts });
      const lines = results
        .filter(r => r.status !== 'skipped')
        .map(r => `• ${r.sourcePage ? `${r.source} p.${r.sourcePage}` : r.source}: ${describeResult(this.deps.t, r)}`);
      const text = [this.deps.summarize(results), ...lines, this.threadGuidance()].join('\n');
      try {
        await this.api('chat.postMessage', { channel: cfg.channelId, thread_ts: message.ts, text }, cfg.token, true);
      } catch (err) {
        if (err instanceof RateLimited) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        console.warn('[labnoteo] Slack reply failed:', msg);
        if (!this.warned) {
          this.warned = true;
          this.deps.notify(this.deps.t('Slack scans were filed, but replying in Slack failed ({0}). Check the chat:write permission.', msg));
        }
      }
      if (results.length) this.deps.report(results);
    }
  }
}
