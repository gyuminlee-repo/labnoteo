import { describe, it, expect, afterEach } from 'vitest';
import { __setRequestUrlHandler, type RequestUrlParam, type RequestUrlResponse } from '../stubs/obsidian';
import type { PcStore } from '../../src/scan/pcStore';
import type { ScanInput, ScanResult } from '../../src/scan/scanPipeline';
import { SlackInbox, findLinkMessage, messagesToProcess, newLinkCode } from '../../src/scan/slack';

const file = (name: string) => ({ name, size: 10, url_private_download: `https://files.slack.com/${name}` });

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

  function inbox(slack: (method: string, params: Record<string, string>) => unknown) {
    const saved = new Map<string, unknown>();
    const store: PcStore = { get: <T>(k: string) => saved.get(k) as T | undefined, set: (k, v) => void saved.set(k, v) };
    const posted: Record<string, string>[] = [];
    const runs: string[][] = [];
    const notices: string[] = [];
    __setRequestUrlHandler((p: RequestUrlParam) => {
      if (p.url.startsWith('https://files.slack.com/')) {
        return { status: 200, text: '', headers: {}, arrayBuffer: new ArrayBuffer(4) } as RequestUrlResponse;
      }
      const url = new URL(p.url);
      const method = url.pathname.replace('/api/', '');
      const params = p.body ? (JSON.parse(p.body) as Record<string, string>) : Object.fromEntries(url.searchParams);
      if (method === 'chat.postMessage') posted.push(params);
      const json = { ok: true, ...(slack(method, params) as object) };
      return { status: 200, text: JSON.stringify(json), json, headers: {} };
    });
    const box = new SlackInbox({
      store,
      t: (s: string) => s,
      run: async (inputs: ScanInput[]) => {
        runs.push(inputs.map(i => i.name));
        return inputs.map((i): ScanResult => ({ source: i.name, status: 'filed', notePath: 'n.md' }));
      },
      summarize: results => `${results.length} filed`,
      notify: m => notices.push(m),
      report: () => undefined,
    });
    return { box, posted, runs, notices, saved };
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

    await s.box.poll();
    expect(s.runs).toEqual([['page.jpg']]);
    expect(s.posted[1]).toMatchObject({ channel: 'D1', thread_ts: '12.0' });
    expect(s.posted[1].text).toContain('1 filed');
    expect(s.posted[1].text).toContain('notes.txt');
    expect(s.box.config()?.lastTs).toBe('12.0');
  });

  it('warns once when Slack refuses, until the settings change', async () => {
    const s = inbox(() => ({ ok: false, error: 'missing_scope' }));
    s.box.beginLink('xoxb-1', 'channel', 'C1');
    await s.box.poll();
    await s.box.poll();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('checking failed');
  });
});
