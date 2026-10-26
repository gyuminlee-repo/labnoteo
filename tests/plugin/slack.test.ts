import { describe, it, expect, afterEach } from 'vitest';
import { __setRequestUrlHandler, type RequestUrlParam, type RequestUrlResponse } from '../stubs/obsidian';
import type { PcStore } from '../../src/scan/pcStore';
import type { ScanInput, ScanResult } from '../../src/scan/scanPipeline';
import {
  SlackInbox,
  describeSlackError,
  findLinkMessage,
  messagesToProcess,
  newLinkCode,
  slackChannelId,
  type SlackConfig,
} from '../../src/scan/slack';

const file = (name: string) => ({ name, size: 10, url_private_download: `https://files.slack.com/${name}` });

// #397
describe('Slack errors and channel links', () => {
  const t = (s: string, ...a: Array<string | number | boolean>) => s.replace(/\{(\d+)\}/g, (_, i: string) => String(a[Number(i)] ?? ''));

  it('says what to fix, keeping the code', () => {
    expect(describeSlackError(t, 'invalid_auth')).toMatch(/^The bot token is not valid\..*\(invalid_auth\)$/);
    expect(describeSlackError(t, 'token_revoked')).toMatch(/revoked.*\(token_revoked\)$/);
    expect(describeSlackError(t, 'missing_scope')).toMatch(/missing a permission.*\(missing_scope\)$/);
    expect(describeSlackError(t, 'channel_not_found')).toBe('channel_not_found');
    expect(describeSlackError(t, 'net::ERR_INTERNET_DISCONNECTED')).toMatch(/^Could not reach Slack/);
  });

  it('takes the channel ID from an ID or a link, trimmed', () => {
    expect(slackChannelId(' C07FAKE123 ')).toBe('C07FAKE123');
    expect(slackChannelId('https://app.slack.com/client/T01ABCDE/C07FAKE123')).toBe('C07FAKE123');
    expect(slackChannelId('https://lab.slack.com/archives/G01FAKE123/p1700000000')).toBe('G01FAKE123');
    expect(slackChannelId('https://app.slack.com/client/T01ABCDE')).toBeUndefined();
    expect(slackChannelId('general')).toBeUndefined();
  });
});

describe('Slack message selection', () => {
  const cfg = { token: 't', mode: 'dm' as const, userId: 'U1', lastTs: '100.0' };

  it("takes the linked user's file messages after the last one handled, oldest first", () => {
    const messages = [
      { ts: '103.0', user: 'U1', files: [file('b.jpg')] },
      { ts: '102.0', user: 'U2', files: [file('other.jpg')] },
      { ts: '101.5', user: 'U1', text: 'no files' },
      { ts: '101.0', user: 'U1', files: [file('a.jpg')] },
      { ts: '101.2', bot_id: 'B1', user: 'U1', files: [file('bot.jpg')] },
      { ts: '99.0', user: 'U1', files: [file('old.jpg')] },
    ];
    expect(messagesToProcess(messages, cfg).map(m => m.ts)).toEqual(['101.0', '103.0']);
  });

  it('finds the message carrying the link code, not a bot echo of it', () => {
    const code = newLinkCode(() => 0.5);
    expect(code).toBe('labnote-550000');
    const messages = [
      { ts: '2.0', bot_id: 'B1', user: 'U9', text: `code ${code}` },
      { ts: '1.0', user: 'U1', text: ` ${code} ` },
    ];
    expect(findLinkMessage(messages, code)?.user).toBe('U1');
    expect(findLinkMessage(messages, 'labnote-000000')).toBeUndefined();
  });
});

describe('SlackInbox', () => {
  afterEach(() => __setRequestUrlHandler(null));

  /** `slack(method, params)` may carry `__status`/`__headers` to shape the HTTP response. */
  function inbox(
    slack: (method: string, params: Record<string, string>) => unknown,
    fileRes: (url: string) => Partial<RequestUrlResponse> = () => ({})
  ) {
    const saved = new Map<string, unknown>();
    const store: PcStore = { get: <T>(k: string) => saved.get(k) as T | undefined, set: (k, v) => void saved.set(k, v) };
    const posted: Record<string, string>[] = [];
    const reacted: string[] = [];
    const runs: string[][] = [];
    const notices: string[] = [];
    __setRequestUrlHandler((p: RequestUrlParam) => {
      if (p.url.startsWith('https://files.slack.com/')) {
        return { status: 200, text: '', headers: {}, arrayBuffer: new ArrayBuffer(4), ...fileRes(p.url) } as RequestUrlResponse;
      }
      const url = new URL(p.url);
      const method = url.pathname.replace('/api/', '');
      const params = p.body ? (JSON.parse(p.body) as Record<string, string>) : Object.fromEntries(url.searchParams);
      if (method === 'chat.postMessage') posted.push(params);
      if (method === 'reactions.add') reacted.push(params.timestamp);
      const { __status, __headers, ...body } = { __status: 200, __headers: {}, ...(slack(method, params) as object) } as {
        __status: number;
        __headers: Record<string, string>;
      } & Record<string, unknown>;
      const json = { ok: true, ...body };
      return { status: __status, text: JSON.stringify(json), json, headers: __headers };
    });
    const box = new SlackInbox({
      store,
      t: (s: string, ...args: Array<string | number | boolean>) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s),
      run: async (inputs: ScanInput[]) => {
        runs.push(inputs.map(i => i.name));
        return inputs.map((i): ScanResult => ({ source: i.name, status: 'filed', notePath: 'n.md' }));
      },
      summarize: results => `${results.length} summarized`,
      notify: m => notices.push(m),
      report: () => undefined,
    });
    const linked = (over: Partial<SlackConfig> = {}) =>
      saved.set('slack', { token: 'xoxb-1', mode: 'dm', channelId: 'D1', userId: 'U1', lastTs: '10.0', ...over } as SlackConfig);
    return { box, posted, reacted, runs, notices, saved, linked };
  }

  it('links to whoever sends the code, then files only their later photos and answers in the thread', async () => {
    let code = '';
    const s = inbox((method, params) => {
      if (method === 'conversations.list') return { channels: [{ id: 'D1' }] };
      if (method === 'conversations.history' && !params.oldest) return { messages: [{ ts: '10.0', user: 'U1', text: code }] };
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('page.jpg'), file('notes.txt')] },
            { ts: '11.0', user: 'U2', files: [file('stranger.jpg')] },
          ],
        };
      }
      return {};
    });
    code = s.box.beginLink(' xoxb-1 ', 'dm');
    expect(s.box.status()).toBe('linking');

    await s.box.poll();
    expect(s.box.status()).toBe('linked');
    expect(s.box.config()).toMatchObject({ token: 'xoxb-1', channelId: 'D1', userId: 'U1', lastTs: '10.0' });
    expect(s.posted.map(p => p.thread_ts)).toEqual(['10.0']);
    expect(s.posted[0].text).toContain('not as a reply in this thread');

    await s.box.poll();
    expect(s.runs).toEqual([['page.jpg']]);
    expect(s.reacted).toEqual(['12.0']);
    expect(s.posted[1]).toMatchObject({ channel: 'D1', thread_ts: '12.0' });
    expect(s.posted[1].text).toContain('2 summarized'); // the filed page and the unsupported notes.txt
    expect(s.posted[1].text).toContain('notes.txt');
    expect(s.posted[1].text).toContain('not as a reply in this thread');
    expect(s.box.config()?.lastTs).toBe('12.0');
    expect(s.box.config()?.claimedTs).toEqual(['12.0']);
  });

  it('warns once when Slack refuses, until the settings change', async () => {
    const s = inbox(() => ({ ok: false, error: 'missing_scope' }));
    s.box.beginLink('xoxb-1', 'channel', 'C1');
    await s.box.poll();
    await s.box.poll();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('checking failed');
    expect(s.box.lastError).toBe('missing_scope');
  });

  it('reads every history page and still handles the oldest message first', async () => {
    const cursors: (string | undefined)[] = [];
    const s = inbox((method, params) => {
      if (method !== 'conversations.history') return {};
      cursors.push(params.cursor);
      return params.cursor
        ? { messages: [{ ts: '11.0', user: 'U1', files: [file('a.jpg')] }] }
        : { messages: [{ ts: '12.0', user: 'U1', files: [file('b.jpg')] }], has_more: true, response_metadata: { next_cursor: 'c2' } };
    });
    s.linked();
    await s.box.poll();
    expect(cursors).toEqual([undefined, 'c2']);
    expect(s.runs).toEqual([['a.jpg'], ['b.jpg']]);
    expect(s.box.config()?.lastTs).toBe('12.0');
  });

  it('warns when the pages run out before the history does', async () => {
    const s = inbox(method =>
      method === 'conversations.history' ? { messages: [], has_more: true, response_metadata: { next_cursor: 'more' } } : {}
    );
    s.linked();
    await s.box.poll();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('oldest may have been skipped');
  });

  it('does not take a message back up after only the reply failed', async () => {
    const s = inbox(method => {
      if (method === 'conversations.history') return { messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] };
      if (method === 'chat.postMessage') return { ok: false, error: 'not_in_channel' };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg']]);
    expect(s.box.config()?.lastTs).toBe('12.0');
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('replying in Slack failed');

    await s.box.poll(); // lastTs moved on: nothing to redo, and the warning does not repeat
    expect(s.runs).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
  });

  it("skips a message another PC claimed, but finishes one this PC claimed and crashed on", async () => {
    const s = inbox(method => {
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('b.jpg')] },
            { ts: '11.0', user: 'U1', files: [file('a.jpg')] },
          ],
        };
      }
      if (method === 'reactions.add') return { ok: false, error: 'already_reacted' };
      return {};
    });
    s.linked({ claimedTs: ['12.0'] }); // 11.0 was claimed by another PC; 12.0 by this one, interrupted
    await s.box.poll();
    expect(s.runs).toEqual([['b.jpg']]);
    expect(s.box.config()?.lastTs).toBe('12.0');
    expect(s.posted.map(p => p.thread_ts)).toEqual(['12.0']);
    expect(s.notices).toEqual([]);
  });

  it('works without the reactions scope — unlocked, with one warning', async () => {
    const s = inbox(method => {
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('b.jpg')] },
            { ts: '11.0', user: 'U1', files: [file('a.jpg')] },
          ],
        };
      }
      if (method === 'reactions.add') return { ok: false, error: 'missing_scope' };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg'], ['b.jpg']]);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('reactions:write');
    expect(s.box.config()?.claimedTs ?? []).toEqual([]);
  });

  it('turns a refused or missing download into that file’s own failure line', async () => {
    const s = inbox(
      method =>
        method === 'conversations.history'
          ? {
              messages: [
                {
                  ts: '12.0',
                  user: 'U1',
                  files: [file('ok.jpg'), file('forbidden.jpg'), file('login.jpg'), { name: 'gone.jpg', size: 10 }],
                },
              ],
            }
          : {},
      url =>
        url.endsWith('forbidden.jpg')
          ? { status: 403 }
          : url.endsWith('login.jpg')
            ? { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            : {}
    );
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['ok.jpg']]);
    const text = s.posted[0].text;
    expect(text).toContain('4 summarized');
    expect(text).toMatch(/forbidden\.jpg: .*refused the download/);
    expect(text).toMatch(/login\.jpg: .*refused the download/);
    expect(text).toMatch(/gone\.jpg: .*no download link/);
    expect(s.box.config()?.lastTs).toBe('12.0');
  });

  it('goes quiet on a rate limit and keeps what was already done', async () => {
    let historyCalls = 0;
    const s = inbox(method => {
      if (method === 'conversations.history') {
        historyCalls++;
        return { messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] };
      }
      if (method === 'chat.postMessage') return { __status: 429, __headers: { 'Retry-After': '1' } };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg']]);
    expect(s.box.config()?.lastTs).toBe('12.0'); // saved before the reply hit the limit
    expect(s.notices).toEqual([]);
    expect(s.box.lastError).toBeUndefined();

    await s.box.poll(); // still inside the pause: no call at all
    expect(historyCalls).toBe(1);
  });

  describe('verify', () => {
    it('names the bot and the missing permissions', async () => {
      const s = inbox(method =>
        method === 'auth.test' ? { user: 'labnote-scans', __headers: { 'X-OAuth-Scopes': 'im:history, files:read' } } : {}
      );
      expect(await s.box.verify('xoxb-1', 'dm')).toEqual({
        botName: 'labnote-scans',
        missingScopes: ['im:read', 'chat:write'],
        missingRecommended: true,
        notInChannel: false,
      });
    });

    it('does not block when Slack omits the scopes header', async () => {
      const s = inbox(method => (method === 'auth.test' ? { user: 'bot' } : {}));
      expect(await s.box.verify('xoxb-1', 'dm')).toMatchObject({ missingScopes: [], missingRecommended: false });
    });

    it('notices when the bot was not invited to the channel', async () => {
      const s = inbox(method => {
        if (method === 'auth.test')
          return { user: 'bot', __headers: { 'x-oauth-scopes': 'groups:history,files:read,chat:write,reactions:write' } };
        if (method === 'conversations.history') return { ok: false, error: 'not_in_channel' };
        return {};
      });
      expect(await s.box.verify('xoxb-1', 'channel', 'C1')).toMatchObject({ missingScopes: [], notInChannel: true });
    });

    it('rejects a bad token', async () => {
      const s = inbox(() => ({ ok: false, error: 'invalid_auth' }));
      await expect(s.box.verify('xoxb-bad', 'dm')).rejects.toThrow('invalid_auth');
    });
  });
});
