/**
 * #74, #75: table CSVs that no longer belong to a table go to the trash, but
 * only after the user agrees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App, TFile as VaultFile } from 'obsidian';
import { Notice, TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { exportTablesToCsv } from '../../src/exportCsv';
import { offerTableCsvCleanupOnDelete } from '../../src/commands';
import { confirmModal } from '../../src/modals';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/modals', () => ({
  confirmModal: vi.fn(),
  workflowAliasModal: vi.fn(),
}));

const DIR = 'labnote/001_Test';
const NOTE = '001_WT020_A.labnote.md';
const csv = (n: number) => `${DIR}/001_WT020_A.labnote_table${n}.csv`;
const TABLE = '| a |\n|---|\n| 1 |\n';
const noteFile = () => new TFile(`${DIR}/${NOTE}`) as unknown as VaultFile;

const t = (key: string, ...args: unknown[]) =>
  args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

let fs: MemFileSystem;
let trashed: string[];
let app: App;

beforeEach(() => {
  vi.mocked(confirmModal).mockReset();
  Notice.reset();
  fs = new MemFileSystem({ [csv(1)]: 'old1', [csv(2)]: 'old2', [csv(3)]: 'old3' });
  trashed = [];
  app = {
    vault: {
      read: async (file: TFile) => fs.read(file.path),
      getFileByPath: (path: string) => (path in fs.snapshot() ? new TFile(path) : null),
    },
    fileManager: {
      trashFile: async (file: TFile) => {
        trashed.push(file.path);
        await fs.remove(file.path);
      },
    },
  } as unknown as App;
});

describe('re-exporting tables (#74)', () => {
  const plugin = () => ({ app, fs, t }) as unknown as LabnotePlugin;

  it('trashes the CSVs of removed tables when the user agrees', async () => {
    await fs.write(`${DIR}/${NOTE}`, TABLE);
    vi.mocked(confirmModal).mockResolvedValue(true);

    await exportTablesToCsv(plugin(), noteFile());

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain('001_WT020_A.labnote_table2.csv\n001_WT020_A.labnote_table3.csv');
    expect(trashed).toEqual([csv(2), csv(3)]);
    expect(await fs.exists(csv(1))).toBe(true);
    expect(Notice.shown.at(-1)).toBe('Exported 1 CSV file(s). 2 CSV file(s) moved to the trash.');
  });

  it('keeps them when the user declines', async () => {
    await fs.write(`${DIR}/${NOTE}`, TABLE);
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    expect(trashed).toEqual([]);
    expect(await fs.exists(csv(3))).toBe(true);
    expect(Notice.shown.at(-1)).toBe('Exported 1 CSV file(s). 2 old CSV file(s) kept.');
  });

  it('offers every CSV when the note has no table left', async () => {
    await fs.write(`${DIR}/${NOTE}`, 'no tables');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await exportTablesToCsv(plugin(), noteFile());

    expect(trashed).toEqual([csv(1), csv(2), csv(3)]);
  });

  it('does not ask when nothing is left over', async () => {
    await fs.write(`${DIR}/${NOTE}`, `${TABLE}\n${TABLE}\n${TABLE}`);

    await exportTablesToCsv(plugin(), noteFile());

    expect(confirmModal).not.toHaveBeenCalled();
  });
});

describe('deleting a workflow note (#75)', () => {
  const host = (answer: boolean) =>
    ({ fs, t, confirm: vi.fn().mockResolvedValue(answer), notify: vi.fn() }) as unknown as LabnoteHost;

  it('trashes the deleted note\'s CSVs after the user agrees', async () => {
    const h = host(true);
    await fs.write(`${DIR}/002_WB030_B.labnote_table1.csv`, 'other');

    await offerTableCsvCleanupOnDelete(app, h, [`${DIR}/${NOTE}`]);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(trashed).toEqual([csv(1), csv(2), csv(3)]);
    expect(await fs.exists(`${DIR}/002_WB030_B.labnote_table1.csv`)).toBe(true);
  });

  it('keeps them when the user declines', async () => {
    await offerTableCsvCleanupOnDelete(app, host(false), [`${DIR}/${NOTE}`]);
    expect(trashed).toEqual([]);
  });

  it('does not ask when the note is back or has no CSVs', async () => {
    await fs.write(`${DIR}/${NOTE}`, 'restored');
    const h = host(true);

    await offerTableCsvCleanupOnDelete(app, h, [`${DIR}/${NOTE}`, `${DIR}/009_WB030_Z.labnote.md`]);

    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('falls back to the adapter trash for a CSV not indexed yet', async () => {
    const trashSystem = vi.fn().mockResolvedValue(false);
    const trashLocal = vi.fn().mockResolvedValue(undefined);
    const bare = {
      vault: { getFileByPath: () => null, adapter: { trashSystem, trashLocal } },
      fileManager: {},
    } as unknown as App;

    await offerTableCsvCleanupOnDelete(bare, host(true), [`${DIR}/${NOTE}`]);

    expect(trashSystem).toHaveBeenCalledWith(csv(1));
    expect(trashLocal).toHaveBeenCalledTimes(3);
  });
});
