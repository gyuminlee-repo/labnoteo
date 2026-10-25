/**
 * #327: a failed experiment run again is linked to its retry through the new
 * README's `retry_of`; #333: the workflow view finds a status by its name.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { parseFrontMatterYaml } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { retryExperimentCommand, retryTitle, statusNames } from '../../src/commands';
import obsidianKo from '../../src/l10n.ko';

const t = (key: string, ...args: string[]) => key.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)]);
const ko = (key: string, ...args: string[]) => t((obsidianKo as Record<string, string>)[key] ?? key, ...args);

describe('retryTitle', () => {
  it('counts a Korean run number up, and adds the run suffix otherwise', () => {
    expect(retryTitle({ t: ko }, '장 오가노이드 교차 1차')).toBe('장 오가노이드 교차 2차');
    expect(retryTitle({ t: ko }, 'CRISPR 2차')).toBe('CRISPR 3차');
    expect(retryTitle({ t: ko }, 'GFP 발현')).toBe('GFP 발현 2차');
    expect(retryTitle({ t }, 'GFP')).toBe('GFP (retry)');
  });
});

describe('retryExperimentCommand', () => {
  it('creates the next experiment with retry_of linking the original', async () => {
    const fs = new MemFileSystem({
      'labnote/061_Organoid/README.labnote.md': '---\ntitle: 오가노이드 1차\nstatus: failed\n---\nbody\n',
    });
    const prompt = vi.fn(async (opts: { value?: string; title?: string }) => opts.value);
    const host = { fs, t, prompt, notify: vi.fn(), openFile: vi.fn(async () => undefined) };
    const app = { vault: { adapter: {} } } as unknown as App;

    await retryExperimentCommand(app, host as unknown as LabnoteHost, 'labnote/061_Organoid');

    expect(prompt.mock.calls[0][0]).toMatchObject({ value: '오가노이드 2차', title: 'Retry experiment 061_Organoid' });
    const readme = await fs.read('labnote/062_오가노이드_2차/README.labnote.md');
    const { frontMatter } = parseFrontMatterYaml(readme);
    expect(frontMatter.title).toBe('오가노이드 2차');
    expect(frontMatter.status).toBe('planned');
    expect(frontMatter.retry_of).toBe('[[labnote/061_Organoid/README.labnote|061]]');
  });
});

describe('statusNames', () => {
  it('takes the name before the meaning, in either language', () => {
    expect(statusNames({ t: ko } as unknown as LabnoteHost)).toMatchObject({
      'needs-review': '검토 필요',
      'in-progress': '진행 중',
      'needs-repeat': '재실험 필요',
    });
    expect(statusNames({ t } as unknown as LabnoteHost)['needs-review']).toBe('Needs review');
  });
});
