/**
 * `.labnoteo/installed.json` — which template each scaffolded file was last
 * reconciled with. A file whose content still hashes to its entry was not
 * edited since, so a plugin update may replace it without asking.
 */
import type { LabnoteHost } from '@labnoteo/core';
import { INSTALL_RECORD_PATH } from './assets';

export interface InstallRecord {
  /** Plugin version that last wrote the record; older plugins leave files alone. */
  pluginVersion: string;
  /** Vault path → {@link contentHash} of the template it was reconciled with. */
  files: Record<string, string>;
  /**
   * Vault path → {@link contentHash} of the template a managed block last
   * held. Unlike `files`, an edited block left as it is keeps its entry, so
   * setup can tell a block it would put back from one it would update (#351).
   */
  blocks?: Record<string, string>;
}

/** Hash of `text` ignoring CRLF vs LF, as Git may check a file out either way. */
export function contentHash(text: string): string {
  const s = text.replace(/\r\n/g, '\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Numeric `x.y.z` comparison: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The record in the vault, or an empty one when missing or unreadable. */
export async function readInstallRecord(host: LabnoteHost): Promise<InstallRecord> {
  const empty: InstallRecord = { pluginVersion: '', files: {} };
  if (!(await host.fs.exists(INSTALL_RECORD_PATH))) return empty;
  try {
    const data = JSON.parse(await host.fs.read(INSTALL_RECORD_PATH)) as Partial<InstallRecord>;
    const hashes = (map: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (map && typeof map === 'object') {
        for (const [path, hash] of Object.entries(map)) {
          if (typeof hash === 'string') out[path] = hash;
        }
      }
      return out;
    };
    const pluginVersion = typeof data.pluginVersion === 'string' ? data.pluginVersion : '';
    const files = hashes(data.files);
    return data.blocks ? { pluginVersion, files, blocks: hashes(data.blocks) } : { pluginVersion, files };
  } catch {
    return empty;
  }
}

export async function writeInstallRecord(host: LabnoteHost, record: InstallRecord): Promise<void> {
  await host.fs.write(INSTALL_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether two `files` (or `blocks`) maps hold the same entries. */
export function sameFiles(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}
