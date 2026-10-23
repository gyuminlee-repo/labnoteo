/**
 * Reading storage locations back from partbank.
 *
 * Deliberately *not* resolved while drawing: the sample tree, search, the
 * definition dialog, the sample table and the MCP tools all read
 * `record.location`, so a refresh writes there instead. That keeps every one
 * of them working unchanged, keeps the last known location readable offline,
 * and keeps the drawing code from firing a request per row.
 */
import { Notice } from 'obsidian';
import {
  formatStockLocation,
  LocalSampleLocationProvider,
  type SampleLocationProvider,
  type SampleLocationQuery,
  type SampleSource,
} from '@labnoteo/core';
import {
  loadSamplesByType,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import type LabnotePlugin from '../main';
import { confirmModal, pickManyModal } from '../modals';
import { PartbankError } from './client';
import type { PartbankFeature } from './partbankFeature';

/**
 * Resolves a linked sample's location from partbank, falling back to the
 * stored one. Implements the seam `LocalSampleLocationProvider` defines, so a
 * caller can swap providers without knowing partbank exists.
 */
export class PartbankLocationProvider implements SampleLocationProvider {
  private readonly local = new LocalSampleLocationProvider();

  constructor(private readonly partbank: PartbankFeature) {}

  async getLocation(query: SampleLocationQuery): Promise<string | null> {
    const source = query.record?.source;
    if (!source) return this.local.getLocation(query);
    try {
      const fresh = await this.fetch(source);
      return fresh ?? this.local.getLocation(query);
    } catch {
      // Offline, or the item is gone: the last known location is still the
      // best answer available.
      return this.local.getLocation(query);
    }
  }

  /** The location partbank reports, or null when it shows no visible stock. */
  async fetch(source: SampleSource): Promise<string | null> {
    const client = this.partbank.clientForSource(source);
    if (!client) throw new PartbankError('notFound', undefined, 'no connection for this link');
    return formatStockLocation(await client.getStocks(source.type, source.id)) || null;
  }
}

/** One sample whose location would change. */
export interface LocationChange {
  type: string;
  id: string;
  alias: string | null;
  folder: string;
  before: string | null;
  after: string | null;
}

/**
 * The changes worth showing. A refresh that found the same text is not a
 * change, and an unlinked sample is never touched.
 */
export function locationChangesOf(
  results: readonly { type: string; id: string; alias: string | null; folder: string; before: string | null; after: string | null }[]
): LocationChange[] {
  return results.filter(r => (r.before ?? '') !== (r.after ?? ''));
}

/**
 * Whether a change is ticked by default in the confirmation list. A location
 * that would be emptied is not: partbank showing no stock is often a sharing
 * boundary rather than a move, and the text may have been typed by hand.
 */
export function checkedByDefault(change: LocationChange): boolean {
  return Boolean(change.after);
}

/** Every sample in `folders` that carries a partbank link. */
export async function linkedSamplesIn(
  plugin: LabnotePlugin,
  folders: readonly string[]
): Promise<{ type: string; id: string; folder: string; record: SampleRecord }[]> {
  const types = getSampleDisplayMeta(plugin.settings.customSampleTypes).types;
  const out: { type: string; id: string; folder: string; record: SampleRecord }[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    for (const type of types) {
      const records = await loadSamplesByType(plugin.fs, folder, type);
      for (const [id, record] of Object.entries(records)) {
        if (record.source) out.push({ type, id, folder, record });
      }
    }
  }
  return out;
}

/** Write the picked changes back to the registry. */
export async function applyLocationChanges(
  plugin: LabnotePlugin,
  changes: readonly LocationChange[]
): Promise<void> {
  for (const change of changes) {
    const record = (await loadSamplesByType(plugin.fs, change.folder, change.type))[change.id];
    if (!record) continue;
    await upsertSampleRecord(plugin.fs, change.folder, change.type, change.id, {
      alias: record.alias,
      description: record.descriptions?.[0] ?? null,
      location: change.after,
    });
  }
  if (changes.length > 0) plugin.samplesChanged();
}

/** `old → new`, as the confirmation list shows a change. */
export function describeChange(change: LocationChange, plugin: LabnotePlugin): string {
  const empty = plugin.t('(none)');
  return `${change.before || empty} → ${change.after || empty}`;
}

/**
 * Refresh one sample's location, asking before it is written. Returns whether
 * anything was stored. When partbank shows no stock the stored location is
 * kept without asking, by the same judgement as {@link checkedByDefault}: a
 * single Enter on that prompt used to erase a hand-typed location (#269).
 */
export async function refreshOneLocation(
  plugin: LabnotePlugin,
  args: { type: string; id: string; folder: string; record: SampleRecord }
): Promise<boolean> {
  const source = args.record.source;
  if (!source) {
    new Notice(plugin.t('This sample is not linked to partbank.'));
    return false;
  }
  const provider = new PartbankLocationProvider(plugin.partbank);
  let after: string | null;
  try {
    after = await provider.fetch(source);
  } catch (err) {
    plugin.partbank.notifyError(err, source.connection);
    return false;
  }
  const before = args.record.location ?? null;
  if ((before ?? '') === (after ?? '')) {
    new Notice(plugin.t('The storage location is unchanged.'));
    return false;
  }
  if (!after) {
    new Notice(
      plugin.t(
        'partbank shows no stock for {0}, so the current location is kept. To clear it, empty the location in Edit sample.',
        args.id
      )
    );
    return false;
  }
  const change: LocationChange = {
    type: args.type,
    id: args.id,
    alias: args.record.alias,
    folder: args.folder,
    before,
    after,
  };
  const ok = await confirmModal(
    plugin.app,
    plugin.t('Store the storage location of {0} as read from partbank?\n{1}', args.id, describeChange(change, plugin)),
    plugin.t('Store')
  );
  if (!ok) return false;
  await applyLocationChanges(plugin, [change]);
  return true;
}

/**
 * Refresh every linked sample in `folders`, then let the user pick which of
 * the changes to keep.
 *
 * Paced rather than parallel: the web server allows 100 calls a minute per IP
 * and the client spaces them out, and a 429 stops the run so the results
 * gathered so far are still offered.
 */
export async function refreshLocationsIn(
  plugin: LabnotePlugin,
  folders: readonly string[]
): Promise<void> {
  const linked = await linkedSamplesIn(plugin, folders);
  if (linked.length === 0) {
    new Notice(plugin.t('No sample in this vault is linked to partbank.'));
    return;
  }
  const notice = new Notice(plugin.t('Reading storage locations from partbank…'), 0);
  const provider = new PartbankLocationProvider(plugin.partbank);
  const results: LocationChange[] = [];
  let stopped: unknown;
  let failed = 0;
  try {
    for (const sample of linked) {
      const source = sample.record.source;
      if (!source) continue;
      try {
        results.push({
          type: sample.type,
          id: sample.id,
          alias: sample.record.alias,
          folder: sample.folder,
          before: sample.record.location ?? null,
          after: await provider.fetch(source),
        });
      } catch (err) {
        // One missing item should not end the run; a refusal to serve should.
        if (err instanceof PartbankError && err.kind === 'rateLimited') {
          stopped = err;
          break;
        }
        failed++;
      }
    }
  } finally {
    notice.hide();
  }

  const changes = locationChangesOf(results);
  if (stopped) plugin.partbank.notifyError(stopped, plugin.settings.partbankDefaultConnection);
  if (changes.length === 0) {
    new Notice(
      plugin.t('Checked {0} linked sample(s); no storage location changed.', String(results.length))
    );
    return;
  }
  const picked = await pickManyModal(
    plugin.app,
    changes.map(change => ({
      label: `${change.id}${change.alias ? `;${change.alias}` : ''}`,
      description: describeChange(change, plugin),
      checked: checkedByDefault(change),
      value: change,
    })),
    {
      title: plugin.t('Storage locations to store ({0} changed)', String(changes.length)),
    }
  );
  if (picked.length === 0) return;
  await applyLocationChanges(plugin, picked);
  new Notice(plugin.t('Stored {0} storage location(s).', String(picked.length)));
  if (failed > 0) {
    new Notice(plugin.t('{0} sample(s) could not be read from partbank.', String(failed)));
  }
}
