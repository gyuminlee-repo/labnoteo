/**
 * MCP server helpers that are pure enough to test without standing up a socket:
 * the initialization handshake payload, the DNS-rebinding Origin check, and the
 * constant-time token comparison.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  awaitApproval,
  buildInitializeResult,
  buildToolCallResult,
  isAllowedOrigin,
  isAuthorized,
  timingSafeEqual,
  tokenFingerprint,
} from '../../src/llm/mcpServer';
import { buildApprovalMessage } from '../../src/llm/approvalMessage';
import { createObsidianTranslator } from '../../src/i18n';

// #47: a write approval must not hang forever, and a request the client has
// abandoned must not be applied by a late "Allow".
describe('awaitApproval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A dialog that answers `answer` after `ms`, or false as soon as it is withdrawn. */
  const dialog = (answer: boolean, ms: number) => {
    const seen: { withdrawn: boolean } = { withdrawn: false };
    const confirm = (signal: AbortSignal) =>
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(answer), ms);
        signal.addEventListener('abort', () => {
          seen.withdrawn = true;
          clearTimeout(timer);
          resolve(false);
        });
      });
    return { confirm, seen };
  };

  it('passes on an answer given in time', async () => {
    vi.useFakeTimers();
    const allow = dialog(true, 1000);
    const allowed = awaitApproval(allow.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await allowed).toBe('allowed');
    expect(allow.seen.withdrawn).toBe(false);

    const deny = dialog(false, 1000);
    const denied = awaitApproval(deny.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await denied).toBe('denied');
  });

  it('withdraws the dialog and reports a timeout', async () => {
    vi.useFakeTimers();
    const d = dialog(true, 60_000);
    const outcome = awaitApproval(d.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe('timeout');
    expect(d.seen.withdrawn).toBe(true);
  });

  it('withdraws the dialog when the client disconnects', async () => {
    vi.useFakeTimers();
    const d = dialog(true, 60_000);
    const client = new AbortController();
    const outcome = awaitApproval(d.confirm, { timeoutMs: 50_000, signal: client.signal });
    await vi.advanceTimersByTimeAsync(2000);
    client.abort();
    expect(await outcome).toBe('disconnected');
    expect(d.seen.withdrawn).toBe(true);
  });

  it('does not count an "Allow" that resolves after the request was abandoned', async () => {
    const client = new AbortController();
    client.abort();
    let asked = false;
    const outcome = await awaitApproval(
      async () => {
        asked = true;
        return true;
      },
      { timeoutMs: 1000, signal: client.signal }
    );
    expect(outcome).toBe('disconnected');
    expect(asked).toBe(false);
  });

  it('ignores the dialog result once the timeout fired, even if it says allow', async () => {
    vi.useFakeTimers();
    const outcome = awaitApproval(
      () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6000)),
      { timeoutMs: 5000, signal: new AbortController().signal }
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await outcome).toBe('timeout');
  });
});

describe('buildInitializeResult', () => {
  it('advertises the protocol revision and the plugin version', () => {
    const result = buildInitializeResult('0.77.0');
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual({ name: 'labnoteo', version: '0.77.0' });
  });

  it('claims tools but not resources, prompts, or listChanged notifications', () => {
    const { capabilities } = buildInitializeResult('0.0.0');
    expect(capabilities).toEqual({ tools: { listChanged: false } });
  });
});

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin header (not a browser)', () => {
    expect(isAllowedOrigin('')).toBe(true);
  });

  it.each([
    'http://localhost',
    'http://localhost:3987',
    'http://127.0.0.1:3987',
    'https://127.0.0.1:3987',
    'http://[::1]:3987',
  ])('allows loopback origin %s', origin => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each([
    'http://evil.com',
    'https://evil.com:3987',
    // A rebinding attack resolves its own hostname to 127.0.0.1; the browser
    // still stamps the attacker's hostname on the Origin header.
    'http://rebind.evil.com',
    // Neither a hostname that merely *contains* a loopback name...
    'http://localhost.evil.com',
    'http://notlocalhost',
    // ...nor one that a naive prefix check would accept.
    'http://127.0.0.1.evil.com',
  ])('rejects non-loopback origin %s', origin => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('rejects a non-http scheme', () => {
    expect(isAllowedOrigin('file://')).toBe(false);
    expect(isAllowedOrigin('app://obsidian.md')).toBe(false);
  });

  it('rejects an unparseable Origin instead of waving it through', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('Bearer abc', 'Bearer abc')).toBe(true);
  });

  it('rejects differing strings of equal length', () => {
    expect(timingSafeEqual('Bearer abc', 'Bearer abd')).toBe(false);
  });

  it('rejects differing lengths', () => {
    expect(timingSafeEqual('short', 'much longer')).toBe(false);
  });

  it('rejects an empty candidate against a real token', () => {
    expect(timingSafeEqual('', 'Bearer abc')).toBe(false);
  });

  it('rejects a correct prefix, which a short-circuit compare would accept', () => {
    expect(timingSafeEqual('Bearer ab', 'Bearer abc')).toBe(false);
  });
});

// #107: a regenerated token must lock out the old one.
describe('isAuthorized', () => {
  it('accepts only the current token', () => {
    expect(isAuthorized('Bearer new-token', 'new-token')).toBe(true);
    expect(isAuthorized('Bearer old-token', 'new-token')).toBe(false);
  });

  it('rejects every request while no token is set', () => {
    expect(isAuthorized('Bearer ', '')).toBe(false);
    expect(isAuthorized('', '')).toBe(false);
  });

  it('shows a fingerprint that changes with the token', () => {
    expect(tokenFingerprint('abcdef123456')).toBe('…123456');
    expect(tokenFingerprint('')).toBe('');
  });
});

describe('buildToolCallResult', () => {
  it('carries the data as a single text item', () => {
    expect(buildToolCallResult({ ok: true, data: { id: 'RNA-1' } })).toEqual({
      isError: false,
      content: [{ type: 'text', text: '{"id":"RNA-1"}' }],
    });
  });

  it('appends warnings after the data, leaving the first item as before', () => {
    const { content } = buildToolCallResult({
      ok: true,
      data: { id: 'RNA-1' },
      warnings: ['Ignored unsupported argument(s): foo. Supported: type.'],
    });
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe('{"id":"RNA-1"}');
    expect(content[1].text).toBe('Warning: Ignored unsupported argument(s): foo. Supported: type.');
  });

  it('flags a failed call as an error', () => {
    expect(buildToolCallResult({ ok: false, error: 'boom' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: '"boom"' }],
    });
  });
});

// #69: the prompt named only the tool and the note, so an empty update_section
// was approved without knowing it wiped recorded results.
describe('buildApprovalMessage', () => {
  const t = createObsidianTranslator('en');
  const preview = {
    kind: 'sectionEdit' as const,
    documentPath: 'n.md',
    heading: 'Results',
    parentHeading: '[UHW100 PCR]',
    occurrence: 1,
    total: 1,
    line: 8,
    removedLines: 12,
    removedSubheadings: 0,
    clearing: false,
  };

  it('adds the target and what the section holds now', () => {
    expect(buildApprovalMessage(t, 'Allow?', 'n.md', preview)).toBe(
      'Allow?\n\nTarget: n.md\n\nThis replaces section "[UHW100 PCR] > Results", which now has 12 line(s).'
    );
  });

  it('says when the section is emptied and nested headings go with it', () => {
    expect(
      buildApprovalMessage(t, 'Allow?', null, { ...preview, parentHeading: '', clearing: true, removedSubheadings: 2 })
    ).toBe(
      'Allow?\n\nThis empties section "Results", which now has 12 line(s). Its 2 nested heading(s) are replaced too.'
    );
  });

  it('is just the prompt and target without a preview', () => {
    expect(buildApprovalMessage(t, 'Allow?', 'n.md')).toBe('Allow?\n\nTarget: n.md');
  });

  // #114
  it('says which repeated section it is', () => {
    expect(buildApprovalMessage(t, 'Allow?', null, { ...preview, occurrence: 2, total: 3, line: 83 })).toBe(
      'Allow?\n\nThis replaces section "[UHW100 PCR] > Results", which now has 12 line(s). It is occurrence 2 of 3, with its heading on line 83.'
    );
  });

  // #113
  describe('create_sample', () => {
    const sample = {
      kind: 'sampleCreate' as const,
      type: 'Reagent',
      existing: false,
      folder: 'labnote/049_M/resources/labsamples',
      scope: 'local' as const,
    };

    it('names the type, alias, location and folder of a new sample', () => {
      expect(
        buildApprovalMessage(t, 'Allow?', 'n.md', { ...sample, alias: '배지성분-1', location: '선반-M / 칸-1' })
      ).toBe(
        'Allow?\n\nTarget: n.md\n\nThis creates a Reagent sample with a new ID.\nAlias: 배지성분-1\nStorage location: 선반-M / 칸-1\nSaved in the local samples folder labnote/049_M/resources/labsamples.'
      );
    });

    it('tells a given id apart from adding to an existing one', () => {
      expect(buildApprovalMessage(t, 'Allow?', null, { ...sample, id: 'Reagent-3' })).toContain(
        'This creates Reagent sample Reagent-3.'
      );
      expect(
        buildApprovalMessage(t, 'Allow?', null, { ...sample, id: 'Reagent-3', existing: true, scope: 'global', folder: 'g' })
      ).toBe('Allow?\n\nThis adds to Reagent sample Reagent-3.\nSaved in the global samples folder g.');
    });
  });
});
