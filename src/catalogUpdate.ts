/**
 * "Update catalogs" — bring the vault's `resources/workflows/*.json` up to the
 * catalogs bundled in this plugin version. Those files are seeded once and the
 * lab may edit them, so only new ids and fields still holding an earlier
 * bundled value change, after the researcher confirms the list.
 */
import * as posix from '@labnoteo/core/posix';
import {
  BUNDLED_CATALOG_HISTORY,
  CATALOG_FILE_SPECS,
  catalogKoEntry,
  applyCatalogUpdate,
  isCatalogPlanEmpty,
  parseCatalogFile,
  planCatalogUpdate,
  type CatalogField,
  type CatalogFileSpec,
  type CatalogUpdatePlan,
  type LabnoteHost,
} from '@labnoteo/core';
import { ensureWorkflowResources } from '@labnoteo/core/lib/workflowDataLoader';
import { getObsidianLanguage } from './i18n';
import { contentHash } from './scaffold/installRecord';

export const CATALOG_DIR = 'resources/workflows';

export interface VaultCatalogFile {
  spec: CatalogFileSpec;
  path: string;
  json: Record<string, unknown>;
  plan: CatalogUpdatePlan;
}

export interface VaultCatalogUpdate {
  files: VaultCatalogFile[];
  /** Catalog files that exist but are not readable as a catalog; never written. */
  broken: string[];
}

/** What "Update catalogs" would change in each catalog file the vault has. */
export async function planVaultCatalogUpdate(host: LabnoteHost): Promise<VaultCatalogUpdate> {
  const result: VaultCatalogUpdate = { files: [], broken: [] };
  for (const spec of CATALOG_FILE_SPECS) {
    const path = posix.join(CATALOG_DIR, spec.file);
    if (!(await host.fs.exists(path))) continue;
    const parsed = parseCatalogFile(await host.fs.read(path), spec.listKey);
    if (!parsed.ok) {
      result.broken.push(path);
      continue;
    }
    result.files.push({ spec, path, json: parsed.json, plan: planCatalogUpdate(parsed.items, spec.items, spec.fields) });
  }
  return result;
}

function counts(files: readonly VaultCatalogFile[]): { added: number; changed: number; kept: number } {
  let added = 0;
  let changed = 0;
  let kept = 0;
  for (const { plan } of files) {
    added += plan.added.length;
    changed += new Set(plan.updated.map(u => u.id)).size;
    kept += plan.keptEdited.length;
  }
  return { added, changed, kept };
}

function itemLabel(id: string, name: string | undefined): string {
  const ko = getObsidianLanguage().toLowerCase().startsWith('ko') ? catalogKoEntry(id)?.name : undefined;
  const shown = ko ?? name;
  return shown ? `${id} ${shown}` : id;
}

function fieldLabel(host: LabnoteHost, field: CatalogField): string {
  switch (field) {
    case 'name':
      return host.t('name');
    case 'description':
      return host.t('description');
    case 'category':
      return host.t('category');
    case 'equipment':
      return host.t('equipment');
    case 'software':
      return host.t('software');
  }
}

function planLines(host: LabnoteHost, file: VaultCatalogFile): string[] {
  const nameOf = (id: string): string | undefined => file.spec.items.find(item => item.id === id)?.name;
  const lines: string[] = [];
  for (const item of file.plan.added) lines.push(host.t('+ Add {0}', itemLabel(item.id, item.name)));
  for (const u of file.plan.updated) {
    const label = itemLabel(u.id, nameOf(u.id));
    lines.push(
      u.field === 'name'
        ? host.t('{0}: name "{1}" → "{2}"', label, u.from, u.to)
        : host.t('{0}: new {1}', label, fieldLabel(host, u.field))
    );
  }
  for (const k of file.plan.keptEdited) {
    lines.push(host.t('{0}: {1} kept (edited in this vault)', itemLabel(k.id, nameOf(k.id)), fieldLabel(host, k.field)));
  }
  return lines;
}

/**
 * How many lab notes have a `## [ID name]` workflow or `### [ID name]` unit
 * operation heading for one of `ids` (#232): an update renames neither them
 * nor their checklist entries.
 */
async function notesUsing(host: LabnoteHost, ids: ReadonlySet<string>): Promise<number> {
  const root = 'labnote';
  const pattern = [...ids].filter(id => /^[\w-]+$/.test(id)).join('|');
  if (!pattern || !(await host.fs.exists(root))) return 0;
  const heading = new RegExp(`^#{2,3} \\[(?:${pattern}) `, 'm');
  let count = 0;
  for (const experiment of await host.fs.list(root)) {
    if (!/^\d{3}_/.test(experiment)) continue;
    const dir = posix.join(root, experiment);
    let names: string[];
    try {
      names = await host.fs.list(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.labnote.md') || name === 'README.labnote.md') continue;
      if (heading.test(await host.fs.read(posix.join(dir, name)))) count++;
    }
  }
  return count;
}

/**
 * Run "Update catalogs": list the changes, and write them once confirmed.
 * Resolves true when a catalog file was written.
 */
export async function updateCatalogsCommand(host: LabnoteHost): Promise<boolean> {
  await ensureWorkflowResources(host.fs, '.');
  const { files, broken } = await planVaultCatalogUpdate(host);
  for (const path of broken) {
    host.notify(
      'warn',
      host.t('{0} could not be read as a catalog, so it was left as it is. Fix its JSON and run "{1}" again.', path, host.t('Update catalogs'))
    );
  }

  const pending = files.filter(f => !isCatalogPlanEmpty(f.plan));
  const { added, changed, kept } = counts(files);
  if (pending.length === 0) {
    if (broken.length === 0) {
      host.notify(
        'info',
        kept > 0
          ? host.t('The catalogs are up to date. {0} field(s) edited in this vault were kept.', kept)
          : host.t('The catalogs are up to date.')
      );
    }
    return false;
  }

  const blocks = files
    .map(file => ({ file, lines: planLines(host, file) }))
    .filter(b => b.lines.length > 0)
    .map(b => `${b.file.spec.file}\n${b.lines.join('\n')}`);
  const renamed = new Set(files.flatMap(f => f.plan.updated.filter(u => u.field === 'name').map(u => u.id)));
  let keptNames = '';
  if (renamed.size > 0) {
    const using = await notesUsing(host, renamed);
    keptNames = `\n\n${
      using > 0
        ? host.t(
            'Renamed items keep their old names in the workflow notes and README checklists already made: {0} note(s) use them. Rename those by hand if needed.',
            using
          )
        : host.t('Renamed items keep their old names in the workflow notes and README checklists already made.')
    }`;
  }
  const message = `${host.t(
    'Update the catalogs in {0} to this plugin version? Fields edited in this vault are kept.',
    CATALOG_DIR
  )}\n\n${blocks.join('\n\n')}${keptNames}`;
  if (!(await host.confirm(message, { confirmLabel: host.t('Update') }))) return false;

  for (const file of pending) {
    await host.fs.write(file.path, JSON.stringify(applyCatalogUpdate(file.json, file.spec, file.plan), null, 2));
  }
  host.notify(
    'info',
    host.t('Updated the catalogs: {0} added, {1} changed. Commit the changed files in {2}.', added, changed, CATALOG_DIR)
  );
  return true;
}

/** Changes whenever the bundled catalogs or their history change. */
export function bundledCatalogHash(): string {
  return contentHash(JSON.stringify([CATALOG_FILE_SPECS, BUNDLED_CATALOG_HISTORY]));
}

/**
 * On startup, say once per bundled catalog change that the vault's catalogs
 * can be updated. A vault without catalog files yet gets none (they are seeded
 * up to date when first used). Resolves the hash to store as `storedHash`.
 */
export async function catalogUpdateNotice(host: LabnoteHost, storedHash: string): Promise<string> {
  const hash = bundledCatalogHash();
  if (hash === storedHash) return storedHash;
  const { added, changed } = counts((await planVaultCatalogUpdate(host)).files);
  if (added + changed > 0) {
    host.notify(
      'info',
      host.t(
        'Catalog update available: {0} new, {1} changed. Run "{2}" from the command palette.',
        added,
        changed,
        host.t('Update catalogs')
      )
    );
  }
  return hash;
}
