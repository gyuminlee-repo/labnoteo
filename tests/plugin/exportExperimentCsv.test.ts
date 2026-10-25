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
    // #369: a plain note in the folder too, as exporting it alone does.
    expect(await fs.read(`${DIR}/notes_table1.csv`)).toBe('\uFEFFx\n9\n');
    const notice = Notice.shown.at(-1)!;
    expect(notice).toContain('Exported 4 CSV file(s).');
    expect(notice).toContain('Tables per note: README 1, 001_WT020_A 2, notes 1.');
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

  // #370: with several notes, which one holds the table left out.
  it('names the notes of the tables left out, and words the cleanup prompt for several notes', async () => {
    await fs.write(README, `${table('요약', '1')}\n%%\n${table('숨김', '2')}%%\n`);
    await fs.write(WF1, 'no tables');
    await fs.write(`${DIR}/001_WT020_A.labnote_table1.csv`, '\uFEFFold\n');
    vi.mocked(confirmModal).mockResolvedValue(false);

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(Notice.shown.at(-1)).toContain('1 table(s) were not exported: they are inside a comment');
    expect(Notice.shown.at(-1)).toContain('In: README 1.');
    expect(vi.mocked(confirmModal).mock.calls.at(-1)?.[1]).toContain('no longer match a table in their notes');
  });

  // #374: a CSV left on a note's old name by a rename has no note any more.
  it('offers the CSVs whose note is gone for the trash', async () => {
    await fs.write(WF1, table('a', '1'));
    await fs.write(`${DIR}/004_WT020_A.labnote_table1.csv`, '\uFEFFb\n2\n');
    vi.mocked(confirmModal).mockResolvedValue(true);

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(vi.mocked(confirmModal).mock.calls.at(-1)?.[1]).toContain(
      'These table CSV files have no note of their name in the folder'
    );
    expect(await fs.exists(`${DIR}/004_WT020_A.labnote_table1.csv`)).toBe(false);
    expect(await fs.exists(`${DIR}/001_WT020_A.labnote_table1.csv`)).toBe(true);
  });
});

describe('the Excel warning (#343 #345 #346 #375 #376)', () => {
  it('names the CSV and its columns, and each kind of change with up to three examples', async () => {
    await fs.write(
      WF1,
      '| 희석 | 바코드 | 회차 | ID | 판-웰 |\n|---|---|---|---|---|\n' +
        '| 1:80 | 880123456789012345 | (1) | 007 | 2E4 |\n' +
        '| 1:60 | 880123456789012346 | (2) | 008 | x |\n' +
        '| 3-1 | 1 | 2 | 3 | x |\n' +
        '| 1/2 | 1 | 2 | 3 | x |\n'
    );

    await exportTablesToCsv(plugin(), new TFile(WF1) as unknown as VaultFile);

    expect(Notice.shown.at(-1)).toContain(
      'Excel would change cells when it opens the CSV: 001_WT020_A.labnote_table1.csv, column(s) 희석, 바코드, 회차, ID, 판-웰: ' +
        '1:80, 1:60, 3-1 (+1 more) become dates or times; ' +
        '880123456789012345, 880123456789012346 lose the digits past the 15th; ' +
        '(1), (2) become negative numbers; 007, 008 lose their leading zeros; ' +
        '2E4 become numbers in E notation (2E4 → 20000).'
    );
  });

  it('warns for every note of an experiment, each CSV on its own', async () => {
    await fs.write(WF1, table('희석', '1/2', '1/4'));
    await fs.write(WF2, table('비율', '12/48', '1/8'));

    await exportExperimentTablesToCsv(plugin(), DIR);

    expect(Notice.shown.at(-1)).toContain(
      '001_WT020_A.labnote_table1.csv, column(s) 희석: 1/2, 1/4 become dates or times / ' +
        '002_WT030_B.labnote_table1.csv, column(s) 비율: 1/8 become dates or times.'
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
