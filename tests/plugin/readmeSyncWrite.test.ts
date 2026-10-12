/**
 * #41: the README checklist sync must rewrite the README as it is when the
 * write lands, not a copy read earlier.
 *
 * Obsidian may rewrite links in the same README after its "update links?"
 * prompt. Writing back a copy read before that rewrite discards it — and the
 * other way round, Obsidian applying its edit on top of ours at stale offsets is
 * what ate "## Summary and Discussion". These tests pin the first half: the
 * transform runs on whatever `vault.process` hands it.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../stubs/obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import {
  processNoteThroughVault,
  syncReadmeAndSamplesOnDelete,
  syncReadmeOrderOnRename,
} from '../../src/commands';

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;

function readme(entries: string[], summary = '요약 글'): string {
  return [
    '# Test',
    '',
    '## 🗂️ Related Workflows',
    '',
    ...entries,
    '',
    '## Summary and Discussion',
    '',
    summary,
    '',
  ].join('\n');
}

/** `vault.process` hands the updater `latest`, as if the file changed since it was read. */
function makeApp(latest: () => string) {
  const processed: string[] = [];
  const app = {
    vault: {
      getFileByPath: (path: string) => (path === README ? new TFile(README) : null),
      process: async (_file: TFile, fn: (data: string) => string) => {
        const next = fn(latest());
        processed.push(next);
        return next;
      },
    },
  };
  return { app: app as unknown as App, processed };
}

function makeHost(fs: MemFileSystem) {
  return { fs } as unknown as LabnoteHost;
}

describe('README checklist sync writes onto the latest content', () => {
  it('relinks a rename on the content process hands over', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, readme(['- [ ] [B](./003_WB030_B.labnote.md)']));
    // Since the read, the user typed into the summary.
    const latest = readme(['- [ ] [B](./003_WB030_B.labnote.md)'], '요약 글 — 새로 쓴 문장');
    const { app, processed } = makeApp(() => latest);

    await syncReadmeOrderOnRename(app, makeHost(fs), DIR, [
      { from: '003_WB030_B.labnote.md', to: '002_WB030_B.labnote.md' },
    ]);

    expect(processed).toEqual([
      readme(['- [ ] [B](./002_WB030_B.labnote.md)'], '요약 글 — 새로 쓴 문장'),
    ]);
  });

  it('prunes a deleted entry on the content process hands over', async () => {
    const fs = new MemFileSystem();
    const entries = ['- [ ] [A](./001_WD070_A.labnote.md)', '- [ ] [B](./002_WB030_B.labnote.md)'];
    await fs.write(README, readme(entries));
    const latest = readme(entries, '요약 글 — 새로 쓴 문장');
    const { app, processed } = makeApp(() => latest);

    await syncReadmeAndSamplesOnDelete(app, makeHost(fs), DIR, [`${DIR}/002_WB030_B.labnote.md`]);

    expect(processed).toEqual([
      readme(['- [ ] [A](./001_WD070_A.labnote.md)'], '요약 글 — 새로 쓴 문장'),
    ]);
    expect(processed[0]).toContain('\n## Summary and Discussion\n');
  });

  it('does not touch the note when nothing would change', async () => {
    const fs = new MemFileSystem();
    const content = readme(['- [ ] [A](./001_WD070_A.labnote.md)']);
    await fs.write(README, content);
    const { app, processed } = makeApp(() => content);

    const wrote = await processNoteThroughVault(app, makeHost(fs), README, c => c);
    await syncReadmeOrderOnRename(app, makeHost(fs), DIR, []);

    expect(wrote).toBe(false);
    expect(processed).toEqual([]);
  });

  it('writes through the adapter when the note is not indexed yet', async () => {
    const fs = new MemFileSystem();
    await fs.write(README, 'old');
    const app = { vault: { getFileByPath: () => null } } as unknown as App;

    const wrote = await processNoteThroughVault(app, makeHost(fs), README, c => `${c}+new`);

    expect(wrote).toBe(true);
    expect(await fs.read(README)).toBe('old+new');
  });
});
