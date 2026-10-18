/**
 * In-process MCP tool server (desktop only).
 *
 * Exposes the core {@link createLabnoteTools} set over the MCP Streamable HTTP
 * transport so external MCP clients (or the built-in commands) can call Labnote
 * tools against the current vault.
 *
 * Scope: a **stateless** server. It implements the initialization handshake,
 * `tools/list` and `tools/call`, and answers `GET` with 405 — none of our tools
 * push server-initiated messages, so there is nothing for an SSE stream to
 * carry and no reason to hand out an `Mcp-Session-Id`.
 *
 * Security posture:
 *
 * - **Loopback only** — binds `127.0.0.1`, never a routable interface.
 * - **Bearer token** — a random token guards every request. It is kept in the
 *   plugin's `data.json` so client configs survive restarts, and changes only
 *   when the user regenerates it. This is not the spec's OAuth 2.1 flow, so a
 *   client must be able to set a custom `Authorization` header.
 * - **Origin check** — the spec requires it to defend against DNS rebinding.
 * - **Write confirmation** — mutating tools prompt the user before executing.
 *
 * Guarded behind `Platform.isDesktopApp`; Node's `http` is required lazily so
 * the module still loads on mobile (where the feature is simply unavailable).
 */
import { Notice, Platform } from 'obsidian';
import {
  createLabnoteTools,
  runTool,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from '@labnoteo/core';
import type LabnotePlugin from '../main';
import { getObsidianLanguage } from '../i18n';
import { buildApprovalMessage } from './approvalMessage';

// Available in the CommonJS bundle at runtime (desktop/Electron).
declare const require: (id: string) => unknown;

interface NodeReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): void;
  on(ev: 'data', cb: (chunk: unknown) => void): void;
  on(ev: 'end', cb: () => void): void;
  on(ev: 'error', cb: (e: unknown) => void): void;
}
interface NodeRes {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  on(ev: 'close', cb: () => void): void;
  readonly writableFinished: boolean;
}
interface NodeServer {
  listen(port: number, host: string, cb?: () => void): void;
  close(cb?: () => void): void;
  on(ev: 'error', cb: (e: unknown) => void): void;
}
interface NodeHttp {
  createServer(handler: (req: NodeReq, res: NodeRes) => void): NodeServer;
}

const DEFAULT_PORT = 3987;
/**
 * Hard cap on a single JSON-RPC request body to avoid unbounded buffering.
 * Counted in UTF-16 characters, not bytes — the body is decoded before it is
 * measured, so a multibyte payload may occupy up to ~3x this in memory.
 */
const MAX_BODY_CHARS = 1_000_000;
/** MCP revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/**
 * How long a write waits for the user's answer. Kept under the 60s request
 * timeout common MCP clients use, so the client hears why instead of timing out.
 */
export const APPROVAL_TIMEOUT_MS = 50_000;

export class LabnoteMcpServer {
  private server: NodeServer | null = null;
  private readonly tools: ToolDef[] = createLabnoteTools();

  constructor(private readonly plugin: LabnotePlugin) {}

  get running(): boolean {
    return this.server !== null;
  }

  start(port = DEFAULT_PORT): void {
    if (this.server) return;
    if (!Platform.isDesktopApp) {
      new Notice(this.plugin.t('MCP server is desktop-only.'));
      return;
    }

    const http = require('http') as NodeHttp;
    this.ensureToken();

    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    // Without an 'error' listener a port conflict (e.g. the same plugin running
    // in another vault already holds 3987) throws as an uncaught exception and
    // crashes plugin init. Surface it as a Notice and reset to a stopped state.
    server.on('error', (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'EADDRINUSE') {
        new Notice(this.plugin.t('MCP server port {0} is already in use.', String(port)));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(this.plugin.t('MCP server error: {0}', msg));
      }
      this.server = null;
    });
    this.server = server;
    server.listen(port, '127.0.0.1', () => {
      // Do NOT log the bearer token; it would leak into the (shared) console.
      console.info(`[labnoteo] MCP server on http://127.0.0.1:${port}`);
      new Notice(this.plugin.t('MCP server started on 127.0.0.1:{0}', String(port)));
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** The stored bearer token, created and saved on first use. Works while stopped. */
  ensureToken(): string {
    if (!this.plugin.settings.mcpToken) {
      this.plugin.settings.mcpToken = randomToken();
      void this.plugin.saveSettings();
    }
    return this.plugin.settings.mcpToken;
  }

  /** Replace the stored token; a running server accepts only the new one from now on. */
  async regenerateToken(): Promise<string> {
    this.plugin.settings.mcpToken = randomToken();
    await this.plugin.saveSettings();
    return this.plugin.settings.mcpToken;
  }

  private context(): ToolContext {
    return {
      fs: this.plugin.fs,
      workspaceRoot: '.',
      globalSampleFolder: this.plugin.settings.globalSampleFolder,
      customTypes: this.plugin.settings.customSampleTypes,
      locale: getObsidianLanguage(),
      // `update_section` targets a note the user is plausibly looking at right
      // now. Going through the vault means the open editor picks the change up
      // instead of overwriting it on its next flush.
      writeNote: (path, content) => this.plugin.writeNoteStamped(path, content),
    };
  }

  private async handle(req: NodeReq, res: NodeRes): Promise<void> {
    // Order matters: auth first. Origin validation exists to stop a token-less
    // malicious page, and such a request is rejected here anyway — checking auth
    // up front just tells an unauthenticated caller less about the server.
    //
    // Compared in constant time so a network-local attacker can't recover the
    // token byte-by-byte via response-timing on early mismatch.
    if (!isAuthorized(headerValue(req.headers['authorization']), this.plugin.settings.mcpToken)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST') {
      // Streamable HTTP uses GET to open the server-to-client SSE stream. We
      // have nothing to push, and the spec's prescribed answer for that is 405.
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (!isAllowedOrigin(headerValue(req.headers['origin']))) {
      return sendJson(res, 403, { error: 'forbidden origin' });
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }

    let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      rpc = JSON.parse(body);
    } catch {
      return sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
    }

    // A JSON-RPC message with no `id` member is a notification and gets no
    // response body. `notifications/initialized` closes the handshake this way.
    if (!('id' in rpc)) {
      return sendEmpty(res, 202);
    }
    const id = rpc.id ?? null;

    if (rpc.method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: buildInitializeResult(this.plugin.manifest.version),
      });
    }

    if (rpc.method === 'ping') {
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    }

    if (rpc.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: this.tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    }

    if (rpc.method === 'tools/call') {
      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};

      // The tool itself declares whether it mutates, so a new mutating tool in
      // core cannot slip past this gate by being missing from a host allowlist.
      const tool = this.tools.find(t => t.name === name);
      if (tool?.mutates) {
        // A call the tool would reject anyway is not put to the user (#69).
        const preview = tool.describe ? await tool.describe(this.context(), args) : undefined;
        if (preview && 'error' in preview) {
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: buildToolCallResult({ ok: false, error: preview.error }),
          });
        }
        // Surface the write target so the user is not blind-approving by tool
        // name alone (an LLM could target any note/sample path).
        const target =
          typeof args.documentPath === 'string' && args.documentPath.length > 0
            ? args.documentPath
            : null;
        const message = buildApprovalMessage(
          this.plugin.t,
          this.plugin.t('Allow MCP tool "{0}" to modify the vault?', name),
          target,
          preview
        );

        // A client that gave up must not have its write applied by a late "Allow".
        // `res` (not `req`) closes early only when the connection drops.
        const disconnected = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) disconnected.abort();
        });
        notifyIfUnfocused(message);
        const outcome = await awaitApproval(
          signal =>
            this.plugin.host.confirm(message, { confirmLabel: this.plugin.t('Allow'), signal }),
          { timeoutMs: APPROVAL_TIMEOUT_MS, signal: disconnected.signal }
        );
        switch (outcome) {
          case 'allowed':
            break;
          case 'denied':
            return sendJson(res, 200, jsonRpcError(id, -32001, 'User denied write'));
          case 'timeout':
            new Notice(this.plugin.t('MCP tool "{0}" was not run: no answer in time.', name));
            return sendJson(
              res,
              200,
              jsonRpcError(id, -32001, 'Approval timed out: the user did not answer in Obsidian')
            );
          case 'disconnected':
            new Notice(this.plugin.t('MCP tool "{0}" was not run: the client disconnected.', name));
            return;
        }
      }

      const result = await runTool(this.tools, name, this.context(), args);
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: buildToolCallResult(result) });
    }

    return sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${rpc.method}`));
  }
}

// --- helpers ---------------------------------------------------------------

export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'disconnected';

/**
 * Ask for a write approval that gives up after `timeoutMs` or when `signal`
 * (the client disconnecting) aborts. Either way the question is withdrawn via
 * the signal handed to `confirm`, and a late answer no longer counts.
 */
export async function awaitApproval(
  confirm: (signal: AbortSignal) => Promise<boolean>,
  opts: { timeoutMs: number; signal: AbortSignal }
): Promise<ApprovalOutcome> {
  if (opts.signal.aborted) return 'disconnected';
  const withdraw = new AbortController();
  let reason: 'timeout' | 'disconnected' | undefined;
  const stop = (why: 'timeout' | 'disconnected'): void => {
    if (reason) return;
    reason = why;
    withdraw.abort();
  };
  const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
  const onDisconnect = (): void => stop('disconnected');
  opts.signal.addEventListener('abort', onDisconnect);
  try {
    const allowed = await confirm(withdraw.signal);
    if (reason) return reason;
    return allowed ? 'allowed' : 'denied';
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onDisconnect);
  }
}

/**
 * Notices and the approval dialog only show inside the Obsidian window, so when
 * another window covers it raise an OS notification as well.
 */
function notifyIfUnfocused(message: string): void {
  if (document.hasFocus() || typeof Notification === 'undefined') return;
  try {
    new Notification('Labnote Assistant', { body: message });
  } catch {
    // Notifications disabled or unsupported: the dialog is still waiting.
  }
}

/**
 * The `CallToolResult` for a `tools/call` request. Warnings (e.g. ignored
 * arguments) go in extra text items so `content[0]` keeps the shape existing
 * clients already parse.
 */
export function buildToolCallResult(result: ToolResult) {
  const content = [{ type: 'text', text: JSON.stringify(result.data ?? result.error ?? null) }];
  for (const warning of result.warnings ?? []) {
    content.push({ type: 'text', text: `Warning: ${warning}` });
  }
  return { isError: !result.ok, content };
}

/**
 * The `InitializeResult` handed back to a client's `initialize` request.
 *
 * `capabilities` advertises only what we actually serve: a static tool list
 * (`listChanged: false` — the catalog is fixed for the session), no resources,
 * no prompts, no sampling.
 */
export function buildInitializeResult(serverVersion: string) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'labnoteo', version: serverVersion },
  };
}

/**
 * Whether a request's `Origin` may proceed. Required by the MCP spec to defend
 * against DNS rebinding: a page on `evil.com` can resolve a hostname to
 * 127.0.0.1, but it cannot forge the `Origin` the browser attaches.
 *
 * An absent header means the caller is not a browser (curl, an MCP client, the
 * built-in commands), which is the normal case and is allowed.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function headerValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function readBody(req: NodeReq): Promise<string> {
  return new Promise((resolve, reject) => {
    // Decode as UTF-8 up front so multibyte characters split across chunk
    // boundaries are reassembled correctly (the old `String(chunk)` on a raw
    // Buffer could corrupt them). Enforce a size cap to bound memory.
    req.setEncoding('utf8');
    let body = '';
    let size = 0;
    req.on('data', (chunk: unknown) => {
      const s = typeof chunk === 'string' ? chunk : String(chunk);
      size += s.length;
      if (size > MAX_BODY_CHARS) {
        reject(new Error('request body too large'));
        return;
      }
      body += s;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Constant-time string comparison. Returns as soon as the lengths differ (the
 * token length is not secret), but for equal lengths compares every character
 * so timing does not reveal the first mismatching position.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Whether an `Authorization` header carries the current token. No token set means no access. */
export function isAuthorized(header: string, token: string): boolean {
  return Boolean(token) && timingSafeEqual(header, `Bearer ${token}`);
}

/** The token's last characters, shown in settings so a regenerated token is visibly different. */
export function tokenFingerprint(token: string): string {
  return token ? `…${token.slice(-6)}` : '';
}

function sendJson(res: NodeRes, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Status-only reply, for a notification that must not carry a response body. */
function sendEmpty(res: NodeRes, status: number): void {
  res.writeHead(status);
  res.end();
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
