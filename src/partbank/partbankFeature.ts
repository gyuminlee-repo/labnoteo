/**
 * The partbank connections this vault knows about, and the one thing every
 * caller needs besides a client: a failure turned into a sentence the user can
 * act on.
 *
 * The API keys live in the per-PC store rather than `data.json`, which travels
 * with the vault through git or Obsidian Sync. A key is a credential for one
 * person on one machine; the desktop app's key is not even meaningful
 * elsewhere, since its database is local.
 */
import { Notice, Platform } from 'obsidian';
import type { PartbankConnection } from '@labnoteo/core';
import type LabnotePlugin from '../main';
import { createPcStore, type PcStore } from '../scan/pcStore';
import {
  PartbankClient,
  PartbankError,
  connectionForOrigin,
  connectionForSource,
  type PartbankConnectionConfig,
} from './client';
import type { SampleSource } from '@labnoteo/core';

const KEY = 'partbank';

interface StoredKeys {
  desktop?: string;
  web?: string;
}

export class PartbankFeature {
  /** One client per connection, so the web call spacing is shared. */
  private readonly clients = new Map<string, PartbankClient>();

  constructor(
    private readonly plugin: LabnotePlugin,
    private readonly store: PcStore = createPcStore(plugin.app)
  ) {}

  /** The key stored for a connection on this PC, or '' when there is none. */
  apiKey(kind: PartbankConnection): string {
    return this.store.get<StoredKeys>(KEY)?.[kind]?.trim() ?? '';
  }

  setApiKey(kind: PartbankConnection, key: string): void {
    const next: StoredKeys = { ...this.store.get<StoredKeys>(KEY) };
    const trimmed = key.trim();
    if (trimmed) next[kind] = trimmed;
    else delete next[kind];
    this.store.set(KEY, next);
    this.clients.clear();
  }

  /** The address configured for a connection. */
  url(kind: PartbankConnection): string {
    const { settings } = this.plugin;
    return (kind === 'desktop' ? settings.partbankDesktopUrl : settings.partbankWebUrl).trim();
  }

  /**
   * Which connections can be used. The desktop app runs on this machine, so
   * it is never reachable from a phone or tablet.
   */
  available(): PartbankConnectionConfig[] {
    const kinds: PartbankConnection[] = Platform.isDesktopApp ? ['desktop', 'web'] : ['web'];
    return kinds.flatMap(kind => {
      const url = this.url(kind);
      const apiKey = this.apiKey(kind);
      return url && apiKey ? [{ kind, url, apiKey }] : [];
    });
  }

  /** Whether anything is set up at all; what hides the partbank actions. */
  get configured(): boolean {
    return this.available().length > 0;
  }

  /** A client for one connection, or undefined when it has no key yet. */
  client(kind: PartbankConnection): PartbankClient | undefined {
    const config = this.available().find(c => c.kind === kind);
    return config ? this.clientFor(config) : undefined;
  }

  /**
   * The connection search and the catalog download use: the chosen default,
   * falling back to the other one when the default has no key.
   */
  defaultClient(): PartbankClient | undefined {
    const available = this.available();
    const preferred = this.plugin.settings.partbankDefaultConnection;
    const config = available.find(c => c.kind === preferred) ?? available[0];
    return config ? this.clientFor(config) : undefined;
  }

  /** The client that can fetch a stored link, or undefined when none matches. */
  clientForSource(source: SampleSource): PartbankClient | undefined {
    const config = connectionForSource(source, this.available());
    return config ? this.clientFor(config) : undefined;
  }

  /** The client for an origin an external caller named; see {@link connectionForOrigin}. */
  clientForOrigin(origin: string): PartbankClient | undefined {
    const config = connectionForOrigin(origin, this.available());
    return config ? this.clientFor(config) : undefined;
  }

  /** A client built from an explicit address and key, for "test connection". */
  probeClient(kind: PartbankConnection, url: string, apiKey: string): PartbankClient {
    return new PartbankClient({ kind, url: url.trim(), apiKey: apiKey.trim() });
  }

  private clientFor(config: PartbankConnectionConfig): PartbankClient {
    const cacheKey = `${config.kind}\u0000${config.url}\u0000${config.apiKey}`;
    const hit = this.clients.get(cacheKey);
    if (hit) return hit;
    const client = new PartbankClient(config);
    this.clients.set(cacheKey, client);
    return client;
  }

  /** What went wrong, said in terms of what to do about it. */
  describeError(err: unknown, kind: PartbankConnection): string {
    const t = this.plugin.t;
    if (!(err instanceof PartbankError)) return String(err);
    switch (err.kind) {
      case 'offline':
      case 'timeout':
        return kind === 'desktop'
          ? t(
              'Could not reach the partbank app at {0}. Check that it is running, and that its port has not moved.',
              this.url('desktop')
            )
          : t('Could not reach the partbank server at {0}.', this.url('web'));
      case 'unauthorized':
        return t(
          'The partbank API key was refused. Issue a new one in partbank under Profile - API Keys (a key lasts at most 365 days).'
        );
      case 'forbidden':
        return t('This partbank item is not shared with your account.');
      case 'notFound':
        return t('This item is no longer in partbank, or it was never on this server.');
      case 'rateLimited':
        return t('partbank is refusing further requests for now. Try again in a minute.');
      case 'notPartbank':
        return t('The address answered, but not as partbank does. Check the partbank address in the settings.');
      default:
        return t('partbank returned an error ({0}).', String(err.status ?? '?'));
    }
  }

  /**
   * {@link describeError} for Test connection, where the call is the account
   * check: a 404 there means the address has no partbank API, not a missing item.
   */
  describeProbeError(err: unknown, kind: PartbankConnection): string {
    if (err instanceof PartbankError && (err.kind === 'notFound' || err.kind === 'notPartbank')) {
      return this.plugin.t('No partbank API was found at this address. Check the address.');
    }
    return this.describeError(err, kind);
  }

  /** Show {@link describeError}; returns false so callers can `return notify(...)`. */
  notifyError(err: unknown, kind: PartbankConnection): false {
    new Notice(this.describeError(err, kind), 8000);
    return false;
  }

  /** Told to the user wherever a partbank action is unavailable. */
  notifyNotConfigured(): void {
    new Notice(
      this.plugin.t('Set up a partbank connection in the plugin settings first.'),
      6000
    );
  }
}
