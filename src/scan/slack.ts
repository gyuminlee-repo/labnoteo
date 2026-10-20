/**
 * Slack as a way in for scans: send photos of worksheets to your own Slack
 * bot by DM (or post them in a private channel the bot was invited to), and
 * this PC files them and replies in the thread.
 *
 * The bot token and the link to one Slack user stay on this PC (see
 * `pcStore`). Linking works with a one-time code the user sends to the bot,
 * so only that person's files are taken, and only messages sent after it.
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
}

const KEY = 'slack';
const API = 'https://slack.com/api/';
const FILE_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

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

export function newLinkCode(random: () => number = Math.random): string {
  return `labnote-${Math.floor(random() * 900000 + 100000)}`;
}

/** Messages to take from a channel's history (newest first, as Slack returns them): the linked user's files after `lastTs`. */
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

  constructor(private readonly deps: SlackDeps) {}

  config(): SlackConfig | undefined {
    const cfg = this.deps.store.get<SlackConfig>(KEY);
    return cfg && typeof cfg.token === 'string' && cfg.token ? cfg : undefined;
  }

  save(cfg: SlackConfig | undefined): void {
    this.deps.store.set(KEY, cfg);
    this.warned = false;
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

  private async api<T>(method: string, params: Record<string, string>, token: string, post = false): Promise<T> {
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
    if (!json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  private history(token: string, channel: string, oldest?: string): Promise<{ messages: SlackMessage[] }> {
    const params: Record<string, string> = { channel, limit: '50' };
    if (oldest) params.oldest = oldest;
    return this.api('conversations.history', params, token);
  }

  /** Check for the link code or for new files. */
  async poll(): Promise<void> {
    const cfg = this.config();
    if (!cfg || this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (!cfg.userId) await this.pollLink(cfg);
      else await this.pollFiles(cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[labnoteo] Slack check failed:', msg);
      if (!this.warned) {
        this.warned = true;
        this.deps.notify(this.deps.t('Slack scans: checking failed ({0}). See the Slack section of docs/SCAN.md for the bot permissions.', msg));
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollLink(cfg: SlackConfig): Promise<void> {
    if (!cfg.linkCode) return;
    const channels =
      cfg.mode === 'channel' && cfg.channelId
        ? [cfg.channelId]
        : (await this.api<{ channels: { id: string }[] }>('conversations.list', { types: 'im', limit: '200' }, cfg.token)).channels.map(c => c.id);
    for (const channel of channels) {
      const { messages } = await this.history(cfg.token, channel);
      const hit = findLinkMessage(messages, cfg.linkCode);
      if (!hit?.user) continue;
      this.save({ ...cfg, channelId: channel, userId: hit.user, lastTs: hit.ts, linkCode: undefined });
      await this.api('chat.postMessage', { channel, thread_ts: hit.ts, text: this.deps.t('Linked. Send photos or scans of printed worksheets here, and they will be filed in their notes.') }, cfg.token, true);
      this.deps.notify(this.deps.t('Slack scans are linked. Photos you send to the bot are filed in their notes.'));
      return;
    }
  }

  private async pollFiles(cfg: SlackConfig): Promise<void> {
    if (!cfg.channelId) return;
    const { messages } = await this.history(cfg.token, cfg.channelId, cfg.lastTs);
    for (const message of messagesToProcess(messages, cfg)) {
      const inputs: ScanInput[] = [];
      const skipped: string[] = [];
      for (const file of message.files ?? []) {
        const name = file.name ?? 'slack-file';
        if (!file.url_private_download || !FILE_RE.test(name) || (file.size ?? 0) > MAX_FILE_BYTES) {
          skipped.push(name);
          continue;
        }
        const res = await requestUrl({ url: file.url_private_download, headers: { Authorization: `Bearer ${cfg.token}` } });
        inputs.push({ name, bytes: res.arrayBuffer });
      }
      const results = inputs.length ? await this.deps.run(inputs) : [];
      const lines = results.filter(r => r.status !== 'skipped').map(r => `• ${r.sourcePage ? `${r.source} p.${r.sourcePage}` : r.source}: ${describeResult(this.deps.t, r)}`);
      for (const name of skipped) lines.push(`• ${name}: ${this.deps.t('Not an image, PDF or zip file.')}`);
      const text = [this.deps.summarize(results), ...lines].join('\n');
      await this.api('chat.postMessage', { channel: cfg.channelId, thread_ts: message.ts, text }, cfg.token, true);
      const latest = this.config();
      if (latest) this.save({ ...latest, lastTs: message.ts });
      if (results.length) this.deps.report(results);
    }
  }
}
