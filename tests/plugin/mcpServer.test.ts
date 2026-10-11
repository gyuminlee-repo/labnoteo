/**
 * MCP server helpers that are pure enough to test without standing up a socket:
 * the initialization handshake payload, the DNS-rebinding Origin check, and the
 * constant-time token comparison.
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  buildInitializeResult,
  buildToolCallResult,
  isAllowedOrigin,
  timingSafeEqual,
} from '../../src/llm/mcpServer';

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
