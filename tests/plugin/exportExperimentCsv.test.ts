/**
 * #347: every table of an experiment in one go. #343 #345 #346: the Excel
 * warning names each kind of change. #348: a CSV path Excel cannot open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App, TFile as VaultFile } from 'obsidian';
import { Notice, Platform, TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { exportExperimentTablesToCsv, exportTablesToCsv } from '../../src/exportCsv';
import { confirmModal } from '../../src/modals';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/modals', () => ({
  confirmModal: vi.fn(),
  workflowAliasModal: vi.fn(),
}));

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const WF1 = `${DIR}/001_WT020_A.labnote.md`;
const WF2 = `${DIR}/002_WT030_B.labnote.md`;
const table = (header: string, ...cells: string[]) =>
  `| ${header} |\n|---|\n${cells.map(c => `| ${c} |\n`).join('')}`;

const t = (key: string, ...args: unknown[]) =>
  args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key);

let fs: MemFileSystem;
let app: App;
let basePath: string | undefined;
const plugin = () => ({ app, fs, t }) as unknown as LabnotePlugin;

beforeEach(() => {
  vi.mocked(confirmModal).mockReset();
  Notice.reset();
  basePath = undefined;
  fs = new MemFileSystem({});
  app = {
    vault: {
      read: async (file: TFile) => fs.read(file.path),
      getFileByPath: (path: string) => (path in fs.snapshot() ? new TFile(path) : null),
      adapter: { getBasePath: () => basePath },
    },
    fileManager: {
      trashFile: async (file: TFile) => fs.remove(file.path),
      renameFile: async (file: TFile, to: string) => {
        await fs.write(to, await fs.read(file.path));
        await fs.remove(file.path);
      },
    },
  } as unknown as App;
});

afterEach(() => {
  Platform.isWin = false;
});

describe('exportExperimentTablesToCsv (#347)', () => {
  it('exports the tables of the README and every workflow note, with a count per note', async () => {
    await fs.write(README, table('요약', '1'));
    await fs.write(WF1, `${table('a', '1')}\n${table('b', '2')}`);
    await fs.write(WF2, 'no tables');
    await fs.write(`${DIR}/notes.md`, table('x', '9'));

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(await fs.read(`${DIR}/README.labnote_table1.csv`)).toBe('\uFEFF요약\n1\n');
    expect(await fs.read(`${DIR}/001_WT020_A.labnote_table1.csv`)).toBe('\uFEFFa\n1\n');
    expect(await fs.read(`${DIR}/001_WT020_A.labnote_table2.csv`)).toBe('\uFEFFb\n2\n');
    expect(await fs.exists(`${DIR}/notes_table1.csv`)).toBe(false);
    const notice = Notice.shown.at(-1)!;
    expect(notice).toContain('Exported 3 CSV file(s).');
    expect(notice).toContain('Tables per note: README 1, 001_WT020_A 2.');
    expect(notice).toContain('1 note(s) without tables were skipped.');
    expect(confirmModal).not.toHaveBeenCalled();
  });

  it('asks once about the CSVs of removed tables across all notes', async () => {
    await fs.write(README, 'no tables');
    await fs.write(WF1, table('a', '1'));
    await fs.write(`${DIR}/README.labnote_table1.csv`, '\uFEFFold\n');
    await fs.write(`${DIR}/001_WT020_A.labnote_table1.csv`, '\uFEFFa\n1\n');
    await fs.write(`${DIR}/001_WT020_A.labnote_table2.csv`, '\uFEFFold\n');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmModal).mock.calls[0][1]).toContain(
      'README.labnote_table1.csv\n001_WT020_A.labnote_table2.csv'
    );
    expect(await fs.exists(`${DIR}/README.labnote_table1.csv`)).toBe(false);
    expect(await fs.exists(`${DIR}/001_WT020_A.labnote_table2.csv`)).toBe(false);
    expect(Notice.shown.at(-1)).toContain('2 CSV file(s) moved to the trash.');
  });

  it('writes nothing when the overwrite prompt is declined', async () => {
    await fs.write(WF1, `${table('a', '1')}\n${table('b', '2')}`);
    await fs.write(`${DIR}/001_WT020_A.labnote_table1.csv`, '\uFEFFb\n2\n');
    await fs.write(WF2, table('c', '3'));
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(await fs.exists(`${DIR}/002_WT030_B.labnote_table1.csv`)).toBe(false);
    expect(await fs.read(`${DIR}/001_WT020_A.labnote_table1.csv`)).toBe('\uFEFFb\n2\n');
    expect(Notice.shown.at(-1)).toBe('No changes made.');
  });

  it('says so when no note has a table', async () => {
    await fs.write(README, 'none');
    await fs.write(WF1, 'none');

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(Notice.shown.at(-1)).toBe('No tables found in the notes of 001_Test.');
  });
});

describe('the Excel warning (#343 #345 #346)', () => {
  it('names each kind of change with up to two examples', async () => {
    await fs.write(
      WF1,
      '| 희석 | 바코드 | 회차 | ID |\n|---|---|---|---|\n' +
        '| 1:80 | 880123456789012345 | (1) | 007 |\n' +
        '| 1:60 | 880123456789012346 | (2) | 008 |\n' +
        '| 3-1 | 1 | 2 | 3 |\n'
    );

    await exportTablesToCsv(plugin(), new TFile(WF1) as unknown as VaultFile);

    expect(Notice.shown.at(-1)).toContain(
      'Excel would change cells when it opens the CSV: 1:80, 1:60 become dates or times; ' +
        '880123456789012345, 880123456789012346 lose the digits past the 15th; ' +
        '(1), (2) become negative numbers; 007, 008 lose their leading zeros.'
    );
  });
});

describe('a CSV path Excel cannot open (#348)', () => {
  it('warns on Windows when the full path is past 218 characters, and still writes the CSV', async () => {
    Platform.isWin = true;
    basePath = `C:\\${'v'.repeat(180)}`;
    await fs.write(WF1, table('a', '1'));

    await exportTablesToCsv(plugin(), new TFile(WF1) as unknown as VaultFile);

    expect(await fs.exists(`${DIR}/001_WT020_A.labnote_table1.csv`)).toBe(true);
    expect(Notice.shown.at(-1)).toMatch(
      /Excel cannot open a file whose path is longer than 218 characters, and 001_WT020_A\.labnote_table1\.csv is \d+ characters long/
    );
  });

  it('stays quiet when the path fits', async () => {
    Platform.isWin = true;
    basePath = 'C:\\vault';
    await fs.write(WF1, table('a', '1'));

    await exportTablesToCsv(plugin(), new TFile(WF1) as unknown as VaultFile);

    expect(Notice.shown.at(-1)).not.toContain('Excel cannot open');
  });
});
