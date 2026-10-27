/**
 * Talking to partbank: the desktop app on this PC, or a web server.
 *
 * Two things shape this file. First, `requestUrl` rather than `fetch`: the
 * desktop app's CORS allow-list has no port, so a browser request from the
 * renderer is refused, and `requestUrl` is not subject to it. Second, the key
 * is only ever sent to an address stored in settings — a note, a catalog or an
 * `obsidian://` URI may name a server, but it only *selects* a connection, it
 * never supplies the address.
 */
import { requestUrl, type RequestUrlResponse } from 'obsidian';
import {
  isDesktopOrigin,
  normalizeOrigin,
  resourceSegment,
  typeFromSearchEntity,
  type PartbankConnection,
  type PartbankItem,
  type PartbankSearchEntity,
  type PartbankStock,
  type PartbankType,
  type SampleSource,
} from '@labnoteo/core';

/** A configured connection: where it is and the key that opens it. */
export interface PartbankConnectionConfig {
  kind: PartbankConnection;
  url: string;
  apiKey: string;
}

/** Why a call did not produce data, in the terms the user can act on. */
export type PartbankErrorKind =
  | 'offline'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'timeout'
  | 'server'
  /** The address answered, but not the way partbank's API does (#278). */
  | 'notPartbank';

export class PartbankError extends Error {
  constructor(
    readonly kind: PartbankErrorKind,
    readonly status: number | undefined,
    message: string
  ) {
    super(message);
    this.name = 'PartbankError';
  }
}

/** A row of `POST /search/global`. */
export interface PartbankSearchHit extends PartbankItem {
  ownedByMe: boolean;
  sharingLevel: string | null;
}

/** How long one call may take. `requestUrl` has no timeout of its own. */
const TIMEOUT_MS = 15_000;
/**
 * Minimum gap between web calls. The server allows 100 requests a minute per
 * IP, shared with the browser tab the same person may have partbank open in,
 * so a batch refresh paces itself rather than spending the whole budget.
 */
const WEB_CALL_GAP_MS = 1_000;
/** Page size of the catalog download; the endpoint allows up to 1000. */
const LIST_PAGE_SIZE = 200;

/** One reference of a note, as `PUT /labnoteo/usages/notes` takes it. */
export interface NoteUsageRef {
  type: PartbankType;
  id: string;
  sample_type: string;
  sample_id: string;
  alias?: string;
  headings: string[];
}

/** A note's whole set of references; no refs removes the note's rows. */
export interface NoteUsage {
  note_path: string;
  note_title: string;
  experiment: string | null;
  refs: NoteUsageRef[];
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Query string parameters, already decoded. */
  query?: Record<string, string | number | boolean>;
}

export class PartbankClient {
  /** When the next web call may go out (see {@link WEB_CALL_GAP_MS}). */
  private nextWebCallAt = 0;

  constructor(private readonly config: PartbankConnectionConfig) {}

  get kind(): PartbankConnection {
    return this.config.kind;
  }

  /** The configured address, without a trailing slash. */
  get origin(): string {
    return this.config.url.trim().replace(/\/+$/, '');
  }

  /** The signed-in user's name, which is what "test connection" reports. */
  async whoAmI(): Promise<string> {
    const me = await this.request<{ username?: unknown; email?: unknown } | null>('/auth/me');
    const name = [me?.username, me?.email].find((v): v is string => typeof v === 'string' && Boolean(v.trim()));
    // Any web server can answer 200 with JSON; partbank's account call names the account.
    if (!name) throw new PartbankError('notPartbank', 200, 'no account in the response');
    return name.trim();
  }

  /**
   * Substring search across partbank, the same call its own web app makes,
   * narrowed to the key owner's own items and those shared with their groups:
   * a public item from another lab is not something they keep a tube of.
   * `limit` is per entity, so asking for three entities can return three times
   * as many rows.
   */
  async searchGlobal(
    query: string,
    entities: readonly PartbankSearchEntity[],
    limit = 10
  ): Promise<PartbankSearchHit[]> {
    if (!query.trim() || entities.length === 0) return [];
    const res = await this.request<{ results?: unknown[] }>('/search/global', {
      method: 'POST',
      body: { query: query.trim(), types: [...entities], limit, exclude_public: true },
    });
    return (res.results ?? []).flatMap(row => {
      const hit = toSearchHit(row);
      // A server older than `exclude_public` ignores it and still sends public items.
      return hit && (hit.ownedByMe || hit.sharingLevel !== 'public') ? [hit] : [];
    });
  }

  /** One item in full. Only a Mongo ObjectId works here; a KID gives a 404. */
  async getItem(type: PartbankType, id: string): Promise<PartbankItem> {
    const raw = await this.request<Record<string, unknown>>(`/${resourceSegment(type)}/${id}`);
    return toItem(type, raw) ?? { type, id };
  }

  /** The stocks of an item that this key's owner can see. */
  async getStocks(type: PartbankType, id: string): Promise<PartbankStock[]> {
    const res = await this.request<{ items?: PartbankStock[] }>(
      `/stock-box/by-resource/${type}/${id}`
    );
    return Array.isArray(res.items) ? res.items : [];
  }

  /**
   * Every item of one type in the key owner's own workspace, walking the pages.
   * Without a search term the endpoint lists only what they own, so items other
   * people share with their groups stay out. `devices` already excludes plasmids and
   * the generated members of a combinatorial library.
   */
  async listAll(type: PartbankType, onPage?: (count: number) => void): Promise<PartbankItem[]> {
    const out: PartbankItem[] = [];
    for (let skip = 0; ; skip += LIST_PAGE_SIZE) {
      const res = await this.request<{ items?: unknown[]; total?: number }>(
        `/workspace/${resourceSegment(type)}`,
        { query: { skip, limit: LIST_PAGE_SIZE, include_components: false } }
      );
      const items = Array.isArray(res.items) ? res.items : [];
      for (const row of items) {
        const item = toItem(type, row);
        if (item) out.push(item);
      }
      onPage?.(out.length);
      if (items.length < LIST_PAGE_SIZE) return out;
      // A server that ignores `skip` would loop forever otherwise.
      if (typeof res.total === 'number' && out.length >= res.total) return out;
    }
  }

  /**
   * Replace this labnoteo client's rows of each note on the server, which
   * shows them on the item pages to the key owner only. Items the owner
   * neither owns nor has shared with their groups come back as skipped.
   */
  async putNoteUsages(body: {
    client_id: string;
    generation: string;
    vault_name: string;
    notes: NoteUsage[];
  }): Promise<{ stored: number; skipped: unknown[] }> {
    return this.request('/labnoteo/usages/notes', { method: 'PUT', body });
  }

  /** Drop this client's rows sent under any other generation. */
  async pruneNoteUsages(body: { client_id: string; generation: string }): Promise<{ deleted: number }> {
    return this.request('/labnoteo/usages/prune', { method: 'POST', body });
  }

  private async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    await this.waitForWebSlot();
    const query = opts.query
      ? `?${new URLSearchParams(
          Object.entries(opts.query).map(([k, v]) => [k, String(v)])
        ).toString()}`
      : '';
    const url = `${this.origin}/api/v1${path}${query}`;
    let res: RequestUrlResponse;
    try {
      res = await withTimeout(
        requestUrl({
          url,
          method: opts.method ?? 'GET',
          headers: {
            'X-API-Key': this.config.apiKey,
            Accept: 'application/json',
            ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          // Read the status ourselves so a 404 is a message, not a stack trace.
          throw: false,
        })
      );
    } catch (err) {
      if (err instanceof PartbankError) throw err;
      throw new PartbankError('offline', undefined, String(err));
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        return (res.json ?? JSON.parse(res.text)) as T;
      } catch {
        // A login page or a site's front page, not partbank's API.
        throw new PartbankError('notPartbank', res.status, 'malformed response');
      }
    }
    throw new PartbankError(statusKind(res.status), res.status, res.text?.slice(0, 200) ?? '');
  }

  /** Space out web calls; the desktop app has no rate limit. */
  private async waitForWebSlot(): Promise<void> {
    if (this.config.kind !== 'web') return;
    const wait = this.nextWebCallAt - Date.now();
    this.nextWebCallAt = Date.now() + Math.max(wait, 0) + WEB_CALL_GAP_MS;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
}

function statusKind(status: number): PartbankErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 0) return 'offline';
  return 'server';
}

function withTimeout(call: Promise<RequestUrlResponse>): Promise<RequestUrlResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PartbankError('timeout', undefined, 'timed out')),
      TIMEOUT_MS
    );
    call.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A list or detail row as an item, or undefined when it has no usable id. */
function toItem(type: PartbankType, row: unknown): PartbankItem | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const id = str(r, 'id');
  if (!id) return undefined;
  return {
    type,
    id,
    kid: str(r, 'kid'),
    name: str(r, 'name'),
    description: str(r, 'description'),
    moleculeType: str(r, 'molecule_type'),
  };
}

function toSearchHit(row: unknown): PartbankSearchHit | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const entity = str(r, 'type');
  const id = str(r, 'id');
  if (!entity || !id) return undefined;
  const type = typeFromSearchEntity(entity);
  if (!type) return undefined;
  return {
    type,
    id,
    kid: str(r, 'kid'),
    name: str(r, 'name'),
    description: str(r, 'description'),
    moleculeType: str(r, 'molecule_type'),
    ownedByMe: r.owner_is_me === true,
    sharingLevel: str(r, 'sharing_level'),
  };
}

/**
 * The connection a stored link belongs to, or undefined when none is
 * configured for it. Desktop links match by kind alone (the app's port moves),
 * web links by origin, so an item from another server is not fetched from ours.
 */
export function connectionForSource(
  source: SampleSource,
  connections: readonly PartbankConnectionConfig[]
): PartbankConnectionConfig | undefined {
  return connections.find(c => {
    if (c.kind !== source.connection) return false;
    if (c.kind === 'desktop') return true;
    return normalizeOrigin(c.url) === normalizeOrigin(source.origin);
  });
}

/**
 * The connection an `obsidian://labnoteo-import` URI names, if any. The URI
 * supplies an origin to *match*, never an address to call: the key would
 * otherwise go to whoever sent the link.
 */
export function connectionForOrigin(
  origin: string,
  connections: readonly PartbankConnectionConfig[]
): PartbankConnectionConfig | undefined {
  const wanted = normalizeOrigin(origin);
  if (!wanted) return undefined;
  const desktop = isDesktopOrigin(origin);
  return connections.find(c =>
    desktop ? c.kind === 'desktop' : normalizeOrigin(c.url) === wanted
  );
}
