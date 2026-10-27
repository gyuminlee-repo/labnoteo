/**
 * Tell partbank which lab notes use its items, so an item's page can list the
 * experiments and notes it went into (to its owner only) and open them here
 * through `obsidian://labnoteo-open`.
 *
 * Only lab notes (`*.labnote.md`) are reported, whether sample tracking is on
 * or not: the item page is about experiments, and a template or daily note
 * would read as one. A note is sent again only when what it would send
 * changed, so saving a note costs at most one call per server.
 *
 * Each install has its own `client_id`; a backfill tags everything it sends
 * with a new `generation` and prunes the rest once every batch went through,
 * which clears notes deleted while the plugin was off. Nothing here ever shows
 * a Notice except a refused key: a server that is down is retried on the next
 * change or start, and one too old for the endpoint is left alone until restart.
 */
import { TFile } from 'obsidian';
import type { SampleSource } from '@labnoteo/core';
import type { LabnoteFs } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { maskAiCallouts } from '@labnoteo/core/lib/aiCallout';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { findSampleReferenceSpans, findSampleUsageSpots } from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta, maskSampleListTables } from '@labnoteo/core/lib/sampleUtils';
import type LabnotePlugin from '../main';
import { resolveSampleDefinition, sampleListHeaders, type ResolvedSampleDefinition } from '../sampleActions';
import { contentHash } from '../scaffold/installRecord';
import { createPcStore, type PcStore } from '../scan/pcStore';
import { PartbankError, type NoteUsage, type NoteUsageRef, type PartbankClient } from './client';

const CLIENT_ID_KEY = 'partbankUsageClientId';
const SENT_KEY = 'partbankUsageSent';
const DIRTY_KEY = 'partbankUsageDirty';
const BACKFILL_KEY = 'partbankUsageBackfill';

const NOTE_SUFFIX = '.labnote.md';
const BATCH_SIZE = 50;
const SAVE_DEBOUNCE_MS = 5_000;
const RECONCILE_DEBOUNCE_MS = 30_000;
const STARTUP_DELAY_MS = 30_000;

/** Server key → note path → hash of what was last sent for it. */
type SentMap = Record<string, Record<string, string>>;
/** Server key → the backfill that tags its rows. */
type BackfillMap = Record<string, { fingerprint: string; generation: string; done: boolean }>;

export type SampleResolver = (
  type: string,
  id: string,
  docPath: string
) => Promise<ResolvedSampleDefinition | undefined>;

export function isUsageNote(path: string): boolean {
  return path.toLowerCase().endsWith(NOTE_SUFFIX);
}

/** Which configured server a client talks to; also the key of its sent map. */
export function serverKey(client: Pick<PartbankClient, 'kind' | 'origin'>): string {
  return `${client.kind}:${client.origin.toLowerCase()}`;
}

/**
 * A read-only view of `fs` that reads each file once. The sample registries a
 * batch of notes resolves against are the same few files over and over.
 */
export function cachedReadFs(fs: LabnoteFs): LabnoteFs {
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      cache.set(key, hit);
    }
    return hit;
  };
  const reads = new Map<string, Promise<string>>();
  const exists = new Map<string, Promise<boolean>>();
  const lists = new Map<string, Promise<string[]>>();
  const refuse = (): Promise<never> => Promise.reject(new Error('read-only'));
  return {
    read: p => memo(reads, p, () => fs.read(p)),
    exists: p => memo(exists, p, () => fs.exists(p)),
    list: p => memo(lists, p, () => fs.list(p)),
    write: refuse,
    modify: refuse,
    mkdir: refuse,
    remove: refuse,
    rmdir: refuse,
  };
}

/**
 * The resolver "Go to definition" uses (Local, Global, then catalog), over a
 * cached copy of the registries. Going through `resolveSampleDefinition` itself
 * keeps the two from ever disagreeing on which sample a reference names.
 */
export function cachedResolver(plugin: LabnotePlugin): SampleResolver {
  const view = Object.create(plugin, { fs: { value: cachedReadFs(plugin.fs) } }) as LabnotePlugin;
  return (type, id, docPath) => resolveSampleDefinition(view, { type, id, docPath });
}

/**
 * The partbank references of one note, per server. A reference counts where
 * "View usages" counts it: not inside an AI callout (#318) nor a sample list
 * table (#385). Samples without a partbank link, or linked to a server that
 * is not set up here, are left out.
 */
export async function collectNoteRefs(
  doc: { path: string; text: string },
  types: readonly string[],
  headers: ReadonlyArray<readonly string[]>,
  resolve: SampleResolver,
  serverOf: (source: SampleSource) => string | undefined
): Promise<Map<string, NoteUsageRef[]>> {
  const masked = maskSampleListTables(maskAiCallouts(doc.text), headers);
  const seen = new Set<string>();
  const out = new Map<string, NoteUsageRef[]>();
  for (const span of findSampleReferenceSpans(masked, types)) {
    const key = `${span.type}\u0000${span.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = await resolve(span.type, span.id, doc.path);
    const source = resolved?.record.source;
    if (!source) continue;
    const server = serverOf(source);
    if (!server) continue;
    const headings = [
      ...new Set(
        findSampleUsageSpots([doc], span.type, span.id, headers)
          .map(s => s.heading)
          .filter(Boolean)
      ),
    ];
    const ref: NoteUsageRef = {
      type: source.type,
      id: source.id,
      sample_type: span.type,
      sample_id: span.id,
      ...(resolved.record.alias ? { alias: resolved.record.alias } : {}),
      headings,
    };
    out.set(server, [...(out.get(server) ?? []), ref]);
  }
  return out;
}

/** What is sent for a note; refs sorted so the same note hashes the same. */
export function noteUsage(path: string, refs: NoteUsageRef[]): NoteUsage {
  const expDir = getExperimentDir(path);
  const name = posix.basename(path);
  const sorted = [...refs].sort((a, b) =>
    `${a.type}\u0000${a.id}\u0000${a.sample_type}\u0000${a.sample_id}`.localeCompare(
      `${b.type}\u0000${b.id}\u0000${b.sample_type}\u0000${b.sample_id}`
    )
  );
  return {
    note_path: path,
    note_title: name.toLowerCase().endsWith(NOTE_SUFFIX) ? name.slice(0, -NOTE_SUFFIX.length) : name,
    experiment: expDir ? posix.basename(expDir) : null,
    refs: sorted,
  };
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('-');
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface Server {
  key: string;
  client: PartbankClient;
  /** Changes when the address or the key does, which calls for a new backfill. */
  fingerprint: string;
}

export class PartbankUsageSync {
  private readonly dirty = new Set<string>();
  /** Servers too old for the endpoint; left alone until the plugin restarts. */
  private readonly unsupported = new Set<string>();
  private readonly warnedUnauthorized = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: LabnotePlugin,
    private readonly store: PcStore = createPcStore(plugin.app)
  ) {
    for (const path of store.get<string[]>(DIRTY_KEY) ?? []) this.dirty.add(path);
  }

  register(): void {
    const { plugin } = this;
    const { vault, workspace } = plugin.app;
    plugin.registerEvent(
      vault.on('modify', file => {
        if (file instanceof TFile && isUsageNote(file.path)) this.markDirty(file.path);
      })
    );
    plugin.registerEvent(
      vault.on('rename', (file, oldPath) => {
        if (isUsageNote(oldPath)) this.markDirty(oldPath);
        if (file instanceof TFile && isUsageNote(file.path)) this.markDirty(file.path);
      })
    );
    plugin.registerEvent(
      vault.on('delete', file => {
        if (isUsageNote(file.path)) this.markDirty(file.path);
      })
    );
    workspace.onLayoutReady(() => {
      this.startupTimer = setTimeout(() => void this.syncAll(), STARTUP_DELAY_MS);
    });
    plugin.register(() => {
      clearTimeout(this.saveTimer);
      clearTimeout(this.reconcileTimer);
      clearTimeout(this.startupTimer);
    });
  }

  /** A note changed, moved or went away: send it after the edits settle. */
  markDirty(path: string): void {
    this.dirty.add(path);
    this.store.set(DIRTY_KEY, [...this.dirty]);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.syncDirty(), SAVE_DEBOUNCE_MS);
  }

  /**
   * The sample registries changed while the notes did not (a sample deleted,
   * moved, linked to partbank, the Global folder changed…): look at every note
   * again once things settle, sending only those whose references changed.
   */
  scheduleReconcile(): void {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => void this.syncAll(), RECONCILE_DEBOUNCE_MS);
  }

  syncDirty(): Promise<void> {
    return this.enqueue(async () => {
      const paths = new Set(this.dirty);
      if (paths.size > 0) await this.sync(paths);
    });
  }

  /** Every lab note and every note sent before, so ones gone since are cleared too. */
  syncAll(): Promise<void> {
    return this.enqueue(() => this.sync('all'));
  }

  /**
   * Turned off: drop what this install sent to each server (a prune with a
   * generation nothing carries) and forget it, so turning it on backfills anew.
   * Best effort: a server out of reach keeps its rows.
   */
  disable(): Promise<void> {
    return this.enqueue(async () => {
      clearTimeout(this.saveTimer);
      clearTimeout(this.reconcileTimer);
      const clientId = this.store.get<string>(CLIENT_ID_KEY);
      if (clientId) {
        for (const server of this.servers()) {
          try {
            await server.client.pruneNoteUsages({ client_id: clientId, generation: `off-${newId()}` });
          } catch (err) {
            console.warn('[labnoteo] could not clear the note usages on partbank:', err);
          }
        }
      }
      this.dirty.clear();
      this.store.set(DIRTY_KEY, undefined);
      this.store.set(SENT_KEY, undefined);
      this.store.set(BACKFILL_KEY, undefined);
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job).catch(err => console.warn('[labnoteo] note usage sync failed:', err));
    this.chain = next;
    return next;
  }

  private clientId(): string {
    let id = this.store.get<string>(CLIENT_ID_KEY);
    if (!id) {
      id = newId();
      this.store.set(CLIENT_ID_KEY, id);
    }
    return id;
  }

  private servers(): Server[] {
    return this.plugin.partbank.available().flatMap(config => {
      const client = this.plugin.partbank.client(config.kind);
      if (!client) return [];
      const key = serverKey(client);
      if (this.unsupported.has(key)) return [];
      return [{ key, client, fingerprint: contentHash(`${config.kind}\u0000${config.url}\u0000${config.apiKey}`) }];
    });
  }

  private async sync(paths: Set<string> | 'all'): Promise<void> {
    const { plugin } = this;
    if (!plugin.settings.partbankSendUsages) return;
    const servers = this.servers();
    if (servers.length === 0) return;

    const sent = this.store.get<SentMap>(SENT_KEY) ?? {};
    const backfill = this.store.get<BackfillMap>(BACKFILL_KEY) ?? {};
    const needsBackfill = (s: Server): boolean =>
      backfill[s.key]?.fingerprint !== s.fingerprint || !backfill[s.key]?.done;
    const notes = plugin.app.vault.getMarkdownFiles().filter(f => isUsageNote(f.path));
    const targets =
      paths === 'all' || servers.some(needsBackfill)
        ? new Set([...notes.map(f => f.path), ...Object.values(sent).flatMap(m => Object.keys(m))])
        : paths;

    const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
    const headers = sampleListHeaders(plugin);
    const resolve = cachedResolver(plugin);
    const byServer = new Map(servers.map(s => [s.key, s]));
    const serverOf = (source: SampleSource): string | undefined => {
      const client = plugin.partbank.clientForSource(source);
      const key = client ? serverKey(client) : undefined;
      return key && byServer.has(key) ? key : undefined;
    };
    const refs = new Map<string, Map<string, NoteUsageRef[]>>();
    for (const path of targets) {
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !isUsageNote(path)) continue;
      const text = await plugin.app.vault.cachedRead(file);
      refs.set(path, await collectNoteRefs({ path, text }, types, headers, resolve, serverOf));
    }

    const clientId = this.clientId();
    const vaultName = plugin.app.vault.getName();
    let retry = false;
    for (const server of servers) {
      const full = needsBackfill(server);
      const state = full
        ? { fingerprint: server.fingerprint, generation: newId(), done: false }
        : backfill[server.key];
      backfill[server.key] = state;
      this.store.set(BACKFILL_KEY, backfill);
      const before = sent[server.key] ?? {};
      const after: Record<string, string> = full ? {} : { ...before };
      const outgoing: Array<{ usage: NoteUsage; hash: string | undefined }> = [];
      for (const path of targets) {
        const usage = noteUsage(path, refs.get(path)?.get(server.key) ?? []);
        const hash = usage.refs.length > 0 ? contentHash(JSON.stringify(usage)) : undefined;
        // A backfill sends every note with references; the prune clears the rest.
        if (full ? hash !== undefined : hash !== before[path]) outgoing.push({ usage, hash });
      }
      try {
        for (const batch of chunks(outgoing, BATCH_SIZE)) {
          await server.client.putNoteUsages({
            client_id: clientId,
            generation: state.generation,
            vault_name: vaultName,
            notes: batch.map(b => b.usage),
          });
          for (const { usage, hash } of batch) {
            if (hash) after[usage.note_path] = hash;
            else delete after[usage.note_path];
          }
        }
        if (full) {
          await server.client.pruneNoteUsages({ client_id: clientId, generation: state.generation });
          state.done = true;
          this.store.set(BACKFILL_KEY, backfill);
        }
      } catch (err) {
        retry = this.handleError(err, server) || retry;
      } finally {
        // A backfill that stopped halfway starts over next time, so keep what it sent only once it is done.
        if (!full || state.done) {
          sent[server.key] = after;
          this.store.set(SENT_KEY, sent);
        }
      }
    }

    if (!retry) {
      for (const path of targets) this.dirty.delete(path);
      this.store.set(DIRTY_KEY, this.dirty.size > 0 ? [...this.dirty] : undefined);
    }
  }

  /** True when the notes should be sent again later. */
  private handleError(err: unknown, server: Server): boolean {
    const status = err instanceof PartbankError ? err.status : undefined;
    // An older server has no such endpoint. The desktop app's catch-all page
    // route answers a PUT it does not know with 405 rather than 404.
    if (status === 404 || status === 405) {
      this.unsupported.add(server.key);
      console.info(`[labnoteo] ${server.client.origin} does not take note usages; not sending them this session.`);
      return false;
    }
    if (err instanceof PartbankError && err.kind === 'unauthorized' && !this.warnedUnauthorized.has(server.key)) {
      this.warnedUnauthorized.add(server.key);
      this.plugin.partbank.notifyError(err, server.client.kind);
    } else {
      console.warn('[labnoteo] could not send note usages to partbank:', err);
    }
    return true;
  }
}
