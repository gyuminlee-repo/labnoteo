/**
 * Settings that belong to this PC and this vault only: the scan folder, its
 * processing history, the Slack connection. Kept out of `data.json`, which
 * syncs with the vault (git, Obsidian Sync), so a second PC never picks up the
 * first one's folder path or token.
 *
 * `window.localStorage` alone is shared by every vault opened in Obsidian, so
 * two vaults would both process the same folder. `app.loadLocalStorage` (1.8.7+)
 * is scoped to the vault; older versions get the vault's ID in the key instead.
 */
import type { App } from 'obsidian';

const PREFIX = 'labnoteo:';

export interface PcStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

interface VaultScopedStorage {
  loadLocalStorage?(key: string): unknown;
  saveLocalStorage?(key: string, value: unknown): void;
  appId?: string;
}

export function createPcStore(app: App, storage: Storage = window.localStorage): PcStore {
  const scoped = app as unknown as VaultScopedStorage;
  if (typeof scoped.loadLocalStorage === 'function' && typeof scoped.saveLocalStorage === 'function') {
    const load = scoped.loadLocalStorage.bind(app);
    const save = scoped.saveLocalStorage.bind(app);
    return {
      get: <T>(key: string) => parse<T>(load(PREFIX + key)),
      set: (key, value) => save(PREFIX + key, value === undefined ? null : JSON.stringify(value)),
    };
  }
  const vault = scoped.appId ?? app.vault.getName();
  const full = (key: string) => `${PREFIX}${vault}:${key}`;
  return {
    get: <T>(key: string) => parse<T>(storage.getItem(full(key))),
    set: (key, value) => {
      if (value === undefined) storage.removeItem(full(key));
      else storage.setItem(full(key), JSON.stringify(value));
    },
  };
}

function parse<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
