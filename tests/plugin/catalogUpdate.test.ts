/**
 * "Update catalogs" and its startup notice: the vault's seeded catalog copies
 * change only after confirmation, a broken file is never written, and the
 * notice shows once per bundled catalog change.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ADDED_BUNDLED_IDS,
  CATALOG_FILE_SPECS,
  EARLIER_BUNDLED,
  type BundledCatalogItem,
  type CatalogFileSpec,
  type LabnoteHost,
} from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { bundledCatalogHash, catalogUpdateNotice, updateCatalogsCommand } from '../../src/catalogUpdate';
import obsidianKo from '../../src/l10n.ko';
import { __setGetLanguage } from '../stubs/obsidian';

const [WORKFLOWS, HW, SW] = CATALOG_FILE_SPECS;
const pathOf = (spec: CatalogFileSpec): string => `resources/workflows/${spec.file}`;

/** The catalog file a vault seeded by 0.106.0 or earlier still has. */
function oldCopy(spec: CatalogFileSpec): string {
  const items = spec.items
    .filter(item => !ADDED_BUNDLED_IDS.includes(item.id))
    .map(item => {
      const old: Record<string, string> = { ...(item as Record<string, string>) };
      for (const [field, values] of Object.entries(EARLIER_BUNDLED[item.id] ?? {})) old[field] = values![0];
      return old;
    });
  return JSON.stringify({ version: '1.0', language: 'English', lastUpdated: '2025-01-01', [spec.listKey]: items }, null, 2);
}

function currentCopy(spec: CatalogFileSpec): string {
  return JSON.stringify(
    { version: spec.version, language: 'English', lastUpdated: spec.lastUpdated, [spec.listKey]: spec.items },
    null,
    2
  );
}

function makeHost(files: Record<string, string>, confirmResult = true) {
  const fs = new MemFileSystem(files);
  const host = {
    fs,
    notify: vi.fn(),
    confirm: vi.fn(async (_message: string, _options?: { confirmLabel?: string }) => confirmResult),
    t: (key: string, ...args: Array<string | number | boolean>) =>
      key.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])),
  };
  return { fs, host, asHost: host as unknown as LabnoteHost };
}

const oldVault = (): Record<string, string> => ({
  [pathOf(WORKFLOWS)]: oldCopy(WORKFLOWS),
  [pathOf(HW)]: oldCopy(HW),
  [pathOf(SW)]: oldCopy(SW),
});

const listIds = (text: string, key: string): string[] =>
  (JSON.parse(text)[key] as BundledCatalogItem[]).map(item => item.id);

afterEach(() => __setGetLanguage(undefined));

describe('updateCatalogsCommand', () => {
  it('lists the changes, then writes them once confirmed', async () => {
    const { fs, host, asHost } = makeHost(oldVault());

    expect(await updateCatalogsCommand(asHost)).toBe(true);

    const message = host.confirm.mock.calls[0][0];
    expect(message).toContain('+ Add WB155 RCA-based Target Amplification');
    expect(message).toContain('WB125 Colony Selection: name "Colony Picking" → "Colony Selection"');
    expect(message).toContain('WT015 Nucleic Acid Size Verification: new description');
    expect(message).toContain(HW.file);
    expect(message).not.toContain(SW.file);
    expect(await fs.read(pathOf(WORKFLOWS))).toBe(currentCopy(WORKFLOWS));
    expect(await fs.read(pathOf(HW))).toBe(currentCopy(HW));
    expect(await fs.read(pathOf(SW))).toBe(oldCopy(SW));
    expect(host.notify).toHaveBeenLastCalledWith(
      'info',
      'Updated the catalogs: 5 added, 14 changed. Commit the changed files in resources/workflows.'
    );
  });

  it('leaves the files as they were when the confirmation is cancelled', async () => {
    const { fs, asHost } = makeHost(oldVault(), false);
    expect(await updateCatalogsCommand(asHost)).toBe(false);
    expect(await fs.read(pathOf(WORKFLOWS))).toBe(oldCopy(WORKFLOWS));
    expect(await fs.read(pathOf(HW))).toBe(oldCopy(HW));
  });

  it('skips a broken file with a warning and updates the rest', async () => {
    const { fs, host, asHost } = makeHost({ ...oldVault(), [pathOf(WORKFLOWS)]: '{ "workflows": [' });

    expect(await updateCatalogsCommand(asHost)).toBe(true);

    expect(await fs.read(pathOf(WORKFLOWS))).toBe('{ "workflows": [');
    expect(await fs.read(pathOf(HW))).toBe(currentCopy(HW));
    expect(host.notify).toHaveBeenCalledWith('warn', expect.stringContaining(pathOf(WORKFLOWS)));
  });

  it('says the catalogs are up to date without asking when nothing changes', async () => {
    const { host, asHost } = makeHost({});
    expect(await updateCatalogsCommand(asHost)).toBe(false);
    expect(host.confirm).not.toHaveBeenCalled();
    expect(host.notify).toHaveBeenCalledWith('info', 'The catalogs are up to date.');
  });

  it('keeps a field edited in the vault and says so', async () => {
    const edited = JSON.parse(oldCopy(HW));
    edited.unitOperations = edited.unitOperations.map((item: BundledCatalogItem) =>
      item.id === 'UHW310' ? { ...item, description: 'Our HPLC.' } : item
    );
    const { fs, host, asHost } = makeHost({ [pathOf(HW)]: JSON.stringify(edited) });
    await fs.write(pathOf(WORKFLOWS), currentCopy(WORKFLOWS));
    await fs.write(pathOf(SW), currentCopy(SW));

    await updateCatalogsCommand(asHost);

    expect(host.confirm.mock.calls[0][0]).toContain('UHW310 HPLC: description kept (edited in this vault)');
    const written = JSON.parse(await fs.read(pathOf(HW)));
    expect(written.unitOperations.find((i: BundledCatalogItem) => i.id === 'UHW310').description).toBe('Our HPLC.');
    expect(listIds(await fs.read(pathOf(HW)), 'unitOperations')).toEqual(HW.items.map(i => i.id));

    host.notify.mockClear();
    await updateCatalogsCommand(asHost);
    expect(host.notify).toHaveBeenCalledWith(
      'info',
      'The catalogs are up to date. 1 field(s) edited in this vault were kept.'
    );
  });

  it('says renamed items keep their old names in the notes already made, with how many use them (#232)', async () => {
    const note = (heading: string) => `---\ntitle: x\n---\n\n${heading}\n`;
    const { host, asHost } = makeHost(
      {
        ...oldVault(),
        'labnote/001_GFP/001_WB125_Colony_Picking.labnote.md': note('## [WB125 Colony Picking]'),
        'labnote/001_GFP/002_WB010_DNA.labnote.md': note('## [WB010 DNA]'),
        'labnote/001_GFP/README.labnote.md': note('## [WB125 Colony Picking]'),
      },
      false
    );
    await updateCatalogsCommand(asHost);
    expect(host.confirm.mock.calls[0][0]).toContain(
      'keep their old names in the workflow notes and README checklists already made: 1 note(s) use them.'
    );

    const empty = makeHost(oldVault(), false);
    await updateCatalogsCommand(empty.asHost);
    expect(empty.host.confirm.mock.calls[0][0]).toMatch(/README checklists already made\.$/);
  });

  it('names items in Korean in the Korean UI', async () => {
    __setGetLanguage(() => 'ko');
    const { host, asHost } = makeHost(oldVault(), false);
    await updateCatalogsCommand(asHost);
    const message = host.confirm.mock.calls[0][0];
    expect(message).toContain('+ Add WB155 RCA 기반 표적 증폭');
    expect(message).toContain('WB125 콜로니 선별: name "Colony Picking" → "Colony Selection"');
  });
});

describe('catalogUpdateNotice', () => {
  it('does not read the catalogs again for the same bundled catalogs', async () => {
    const { fs, host, asHost } = makeHost(oldVault());
    const read = vi.spyOn(fs, 'read');
    expect(await catalogUpdateNotice(asHost, bundledCatalogHash())).toBe(bundledCatalogHash());
    expect(read).not.toHaveBeenCalled();
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('tells once that an update is available', async () => {
    const { host, asHost } = makeHost(oldVault());
    expect(await catalogUpdateNotice(asHost, '')).toBe(bundledCatalogHash());
    expect(host.notify).toHaveBeenCalledTimes(1);
    expect(host.notify).toHaveBeenCalledWith(
      'info',
      'Catalog update available: 5 new, 14 changed. Run "Update catalogs" from the command palette.'
    );
  });

  it('stays quiet, without creating files, when the vault has no catalogs yet', async () => {
    const { fs, host, asHost } = makeHost({});
    expect(await catalogUpdateNotice(asHost, 'old')).toBe(bundledCatalogHash());
    expect(host.notify).not.toHaveBeenCalled();
    expect(await fs.exists(pathOf(WORKFLOWS))).toBe(false);
  });

  it('stays quiet when the catalogs are up to date', async () => {
    const { host, asHost } = makeHost({
      [pathOf(WORKFLOWS)]: currentCopy(WORKFLOWS),
      [pathOf(HW)]: currentCopy(HW),
    });
    expect(await catalogUpdateNotice(asHost, 'old')).toBe(bundledCatalogHash());
    expect(host.notify).not.toHaveBeenCalled();
  });
});

describe('catalog update strings are translated', () => {
  it.each([
    'Update catalogs',
    'Update',
    'Update the catalogs in {0} to this plugin version? Fields edited in this vault are kept.',
    '+ Add {0}',
    '{0}: name "{1}" → "{2}"',
    '{0}: new {1}',
    '{0}: {1} kept (edited in this vault)',
    'The catalogs are up to date.',
    'The catalogs are up to date. {0} field(s) edited in this vault were kept.',
    'Updated the catalogs: {0} added, {1} changed. Commit the changed files in {2}.',
    '{0} could not be read as a catalog, so it was left as it is. Fix its JSON and run "{1}" again.',
    'Catalog update available: {0} new, {1} changed. Run "{2}" from the command palette.',
    'Renamed items keep their old names in the workflow notes and README checklists already made: {0} note(s) use them. Rename those by hand if needed.',
    'Renamed items keep their old names in the workflow notes and README checklists already made.',
  ])('%s', key => {
    expect(obsidianKo[key]).toBeTruthy();
  });
});
