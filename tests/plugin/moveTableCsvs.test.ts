import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { moveTableCsvs } from '../../src/commands';

const A = 'labnote/001_A';
const B = 'labnote/002_B';
const NOTE = '001_WT020_Assay.labnote.md';

function vault(files: Record<string, string>): { fs: MemFileSystem; app: App } {
  const fs = new MemFileSystem(files);
  const app = {
    vault: { getFileByPath: (path: string) => (path in fs.snapshot() ? new TFile(path) : null) },
    fileManager: {
      renameFile: async (file: TFile, newPath: string) => {
        await fs.write(newPath, await fs.read(file.path));
        await fs.remove(file.path);
      },
    },
  } as unknown as App;
  return { fs, app };
}

// #206
describe('moveTableCsvs to another folder', () => {
  it('moves the CSVs of a note moved to another experiment', async () => {
    const { fs, app } = vault({
      [`${B}/${NOTE}`]: 'note',
      [`${A}/001_WT020_Assay.labnote_table1.csv`]: 'a',
      [`${A}/001_WT020_Assay.labnote_table2.csv`]: 'b',
      [`${A}/002_Other.labnote_table1.csv`]: 'other',
    });
    const result = await moveTableCsvs(
      app,
      { from: A, to: B },
      { from: NOTE, to: NOTE },
      new Set(['001_WT020_Assay.labnote_table1.csv', '001_WT020_Assay.labnote_table2.csv', '002_Other.labnote_table1.csv']),
      new Set([NOTE])
    );
    expect(result).toEqual({ moved: 2, skipped: 0, kept: [] });
    expect(Object.keys(fs.snapshot()).sort()).toEqual(
      [
        `${A}/002_Other.labnote_table1.csv`,
        `${B}/001_WT020_Assay.labnote_table1.csv`,
        `${B}/001_WT020_Assay.labnote_table2.csv`,
        `${B}/${NOTE}`,
      ].sort()
    );
  });

  it('leaves a CSV whose name is taken in the destination', async () => {
    const csv = '001_WT020_Assay.labnote_table1.csv';
    const { fs, app } = vault({ [`${A}/${csv}`]: 'old', [`${B}/${csv}`]: 'theirs' });
    const result = await moveTableCsvs(app, { from: A, to: B }, { from: NOTE, to: NOTE }, new Set([csv]), new Set([csv]));
    expect(result).toEqual({ moved: 0, skipped: 1, kept: [csv] });
    expect(await fs.read(`${B}/${csv}`)).toBe('theirs');
    expect(await fs.read(`${A}/${csv}`)).toBe('old');
  });
});
