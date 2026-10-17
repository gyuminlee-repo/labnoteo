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
/** `TABLE` as exported. */
const CSV_A = '\uFEFFa\n1\n';
const noteFile = () => new TFile(`${DIR}/${NOTE}`) as unknown as VaultFile;

const t = (key: string, ...args: unknown[]) =>
  args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

let fs: MemFileSystem;
let trashed: string[];
let app: App;

beforeEach(() => {
  vi.mocked(confirmModal).mockReset();
  Notice.reset();
  fs = new MemFileSystem({ [csv(1)]: CSV_A, [csv(2)]: CSV_A, [csv(3)]: CSV_A });
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
    expect(Notice.shown.at(-1)).toBe('The CSV files are already up to date (1). 2 CSV file(s) moved to the trash.');
  });

  it('keeps them when the user declines', async () => {
    await fs.write(`${DIR}/${NOTE}`, TABLE);
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    expect(trashed).toEqual([]);
    expect(await fs.exists(csv(3))).toBe(true);
    expect(Notice.shown.at(-1)).toBe('The CSV files are already up to date (1). 2 old CSV file(s) kept.');
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

describe('re-exporting after the tables changed (#80)', () => {
  const plugin = () => ({ app, fs, t }) as unknown as LabnotePlugin;
  const NEW = '| 보고 방식 |\n|---|\n| x |\n';
  const CSV_NEW = '\uFEFF보고 방식\nx\n';

  beforeEach(() => {
    fs = new MemFileSystem({ [csv(1)]: CSV_A });
  });

  it('asks before a table added above shifts the CSVs, and writes nothing when declined', async () => {
    await fs.write(`${DIR}/${NOTE}`, `${NEW}\n${TABLE}`);
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain('- 001_WT020_A.labnote_table1.csv: a → 보고 방식');
    expect(await fs.read(csv(1))).toBe(CSV_A);
    expect(await fs.exists(csv(2))).toBe(false);
    expect(Notice.shown.at(-1)).toBe('No changes made.');
  });

  it('overwrites the shifted CSVs when the user agrees', async () => {
    await fs.write(`${DIR}/${NOTE}`, `${NEW}\n${TABLE}`);
    vi.mocked(confirmModal).mockResolvedValue(true);

    await exportTablesToCsv(plugin(), noteFile());

    expect(await fs.read(csv(1))).toBe(CSV_NEW);
    expect(await fs.read(csv(2))).toBe(CSV_A);
    expect(Notice.shown.at(-1)).toBe('Exported 2 CSV file(s).');
  });

  it('catches a shift between tables with the same header', async () => {
    await fs.write(`${DIR}/${NOTE}`, `| a |\n|---|\n| 0 |\n\n${TABLE}`);
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    expect(confirmModal).toHaveBeenCalledOnce();
  });

  it('overwrites without asking when only the values of the same table changed', async () => {
    await fs.write(`${DIR}/${NOTE}`, '| a |\n|---|\n| 9 |\n');

    await exportTablesToCsv(plugin(), noteFile());

    expect(confirmModal).not.toHaveBeenCalled();
    expect(await fs.read(csv(1))).toBe('\uFEFFa\n9\n');
  });

  it('does not rewrite a CSV whose content is unchanged, even with CRLF from Excel', async () => {
    fs = new MemFileSystem({ [csv(1)]: 'a\r\n1\r\n' });
    await fs.write(`${DIR}/${NOTE}`, TABLE);
    const write = vi.spyOn(fs, 'write');

    await exportTablesToCsv(plugin(), noteFile());

    expect(write).not.toHaveBeenCalled();
    expect(Notice.shown.at(-1)).toBe('The CSV files are already up to date (1).');
  });
});

describe('re-exporting after a header was renamed (#92)', () => {
  const plugin = () => ({ app, fs, t }) as unknown as LabnotePlugin;
  const overwritePrompts = () =>
    vi.mocked(confirmModal).mock.calls.map(c => String(c[1])).filter(m => m.includes('Overwrite them?'));

  beforeEach(() => {
    fs = new MemFileSystem({ [csv(1)]: CSV_A });
  });

  it('overwrites without asking when only the header changed', async () => {
    await fs.write(`${DIR}/${NOTE}`, '| a (mg) |\n|---|\n| 1 |\n');

    await exportTablesToCsv(plugin(), noteFile());

    expect(confirmModal).not.toHaveBeenCalled();
    expect(await fs.read(csv(1))).toBe('\uFEFFa (mg)\n1\n');
    expect(Notice.shown.at(-1)).toBe('Exported 1 CSV file(s).');
  });

  it('asks with the header wording when the header and the values changed', async () => {
    await fs.write(`${DIR}/${NOTE}`, '| b |\n|---|\n| 2 |\n');
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    const [prompt] = overwritePrompts();
    expect(prompt).toContain('The header of these CSV files changed.');
    expect(prompt).toContain('- 001_WT020_A.labnote_table1.csv: a → b');
    expect(prompt).not.toContain('a table was added, removed or moved');
    expect(await fs.read(csv(1))).toBe(CSV_A);
  });

  it('still does not ask about a renamed header while old CSVs are kept', async () => {
    fs = new MemFileSystem({ [csv(1)]: CSV_A, [csv(2)]: 'x\n1\n' });
    await fs.write(`${DIR}/${NOTE}`, '| a (mg) |\n|---|\n| 1 |\n');
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportTablesToCsv(plugin(), noteFile());

    expect(overwritePrompts()).toEqual([]);
    expect(await fs.read(csv(1))).toBe('\uFEFFa (mg)\n1\n');
    expect(Notice.shown.at(-1)).toBe('Exported 1 CSV file(s). 1 old CSV file(s) kept.');
  });

  it('counts only the files it wrote', async () => {
    fs = new MemFileSystem({ [csv(1)]: CSV_A, [csv(2)]: '\uFEFFa\n5\n' });
    await fs.write(`${DIR}/${NOTE}`, `${TABLE}\n| a |\n|---|\n| 9 |\n`);

    await exportTablesToCsv(plugin(), noteFile());

    expect(Notice.shown.at(-1)).toBe('Exported 1 CSV file(s) (1 unchanged file(s) left as they were).');
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
