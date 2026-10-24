/**
 * #42: creating a workflow registers it in the experiment README checklist and
 * refreshes the README's `last_updated_date` — the README is written through
 * the vault so an open README editor does not overwrite the change.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { registerWorkflowInReadme } from '../../src/commands';

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const ENTRY = { title: 'WD010 Design', fileName: '002_WD010_Design.labnote.md' };

const README_TEXT = [
  '---',
  "last_updated_date: '2026-01-01'",
  '---',
  '# Test',
  '',
  '## 🗂️ Related Workflows',
  '',
  '- [ ] [WT010 Seq](001_WT010_Seq.labnote.md)',
  '',
  '## Summary and Discussion',
  '',
].join('\n');

const stampToday = (content: string) => content.replace('2026-01-01', '2026-10-13');

function makeApp(indexed: boolean, latest?: () => string) {
  const processed: string[] = [];
  const app = {
    vault: {
      getFileByPath: (path: string) => (indexed && path === README ? new TFile(README) : null),
      process: async (_file: TFile, fn: (data: string) => string) => {
        const next = fn(latest ? latest() : README_TEXT);
        processed.push(next);
        return next;
      },
    },
  };
  return { app: app as unknown as App, processed };
}

const hostFor = (fs: MemFileSystem) => ({ fs }) as unknown as LabnoteHost;

describe('registerWorkflowInReadme', () => {
  it('adds the checklist entry and stamps the date through vault.process', async () => {
    const fs = new MemFileSystem({ [README]: README_TEXT });
    const { app, processed } = makeApp(true);

    expect(await registerWorkflowInReadme(app, hostFor(fs), README, ENTRY, stampToday)).toBe(true);

    expect(processed).toHaveLength(1);
    // The existing entry is left as written (#293).
    expect(processed[0]).toContain('- [ ] [WT010 Seq](001_WT010_Seq.labnote.md)\n- [ ] [WD010 Design](./002_WD010_Design.labnote.md)\n');
    expect(processed[0]).toContain('- [ ] [WD010 Design](./002_WD010_Design.labnote.md)');
    expect(processed[0]).toContain("last_updated_date: '2026-10-13'");
    // The adapter copy is untouched: the open editor saves the vault write.
    expect(await fs.read(README)).toBe(README_TEXT);
  });

  it('applies the change to the README as it is at write time', async () => {
    const fs = new MemFileSystem({ [README]: README_TEXT });
    const edited = README_TEXT.replace('## Summary and Discussion\n', '## Summary and Discussion\n\n방금 쓴 글\n');
    const { app, processed } = makeApp(true, () => edited);

    await registerWorkflowInReadme(app, hostFor(fs), README, ENTRY, stampToday);

    expect(processed[0]).toContain('방금 쓴 글');
    expect(processed[0]).toContain('002_WD010_Design.labnote.md');
  });

  it('falls back to the adapter when the README is not indexed yet', async () => {
    const fs = new MemFileSystem({ [README]: README_TEXT });
    const { app, processed } = makeApp(false);

    await registerWorkflowInReadme(app, hostFor(fs), README, ENTRY, stampToday);

    expect(processed).toEqual([]);
    const written = await fs.read(README);
    expect(written).toContain('002_WD010_Design.labnote.md');
    expect(written).toContain("last_updated_date: '2026-10-13'");
  });

  // #88: the caller warns that the workflow is in no checklist.
  it('does nothing and says so when the experiment has no README', async () => {
    const fs = new MemFileSystem();
    const { app, processed } = makeApp(true);

    expect(await registerWorkflowInReadme(app, hostFor(fs), README, ENTRY, stampToday)).toBe(false);

    expect(processed).toEqual([]);
    expect(fs.snapshot()).toEqual({});
  });
});
