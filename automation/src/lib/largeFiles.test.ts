// Globals convention (no `import ... from 'vitest'`) — matches the core tests.
//
// Pins the pure size-classification thresholds used by the vault large-file
// guard. The boundaries are a researcher-facing contract (<10MB ok / 10-50MB
// warn / >50MB block), so the exact cutoffs are locked here.
import {
  run,
  classifyFileSize,
  WARN_THRESHOLD_BYTES,
  BLOCK_THRESHOLD_BYTES,
} from './largeFiles';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, truncateSync, unlinkSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('classifyFileSize', () => {
  it('classifies files under 10 MB as ok', () => {
    expect(classifyFileSize(0)).toBe('ok');
    expect(classifyFileSize(1024)).toBe('ok');
    expect(classifyFileSize(WARN_THRESHOLD_BYTES - 1)).toBe('ok');
  });

  it('classifies files in the 10-50 MB band as warn (10 MB inclusive)', () => {
    expect(classifyFileSize(WARN_THRESHOLD_BYTES)).toBe('warn');
    expect(classifyFileSize(25 * 1024 * 1024)).toBe('warn');
    expect(classifyFileSize(BLOCK_THRESHOLD_BYTES)).toBe('warn');
  });

  it('classifies files over 50 MB as block', () => {
    expect(classifyFileSize(BLOCK_THRESHOLD_BYTES + 1)).toBe('block');
    expect(classifyFileSize(500 * 1024 * 1024)).toBe('block');
  });

  it('uses 10 MB / 50 MB thresholds', () => {
    expect(WARN_THRESHOLD_BYTES).toBe(10 * 1024 * 1024);
    expect(BLOCK_THRESHOLD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('large-file guard against a real Git index', () => {
  let repo: string;
  let cwd: string;
  const file = '실험 raw\n001.bam';
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const large = (name = file): void => {
    writeFileSync(name, '');
    truncateSync(name, BLOCK_THRESHOLD_BYTES + 1);
  };
  // Seed only the isolated fixture's history; no user identity/config is changed.
  const baseline = (): void => {
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'fixture');
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'labnoteo-large-files-'));
    cwd = process.cwd();
    git('init', '--quiet');
    process.chdir(repo);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });

  it.each(['shrink', 'delete'])('blocks a large staged blob after working-tree %s', change => {
    large();
    git('add', '--', file);
    expect(Number(git('cat-file', '-s', `:${file}`))).toBe(BLOCK_THRESHOLD_BYTES + 1);
    expect(run(['--staged'])).toBe(1);
    if (change === 'shrink') writeFileSync(file, 'small');
    else unlinkSync(file);
    expect(run(['--staged'])).toBe(1);
  });

  it('allows a small staged blob despite a large working-tree file', () => {
    writeFileSync(file, 'small');
    git('add', '--', file);
    large();
    expect(run(['--staged'])).toBe(0);
    expect(run([])).toBe(1);
  });

  it('blocks a staged modification after the working-tree file is shrunk', () => {
    writeFileSync(file, 'small');
    git('add', '--', file);
    baseline();
    large();
    git('add', '--', file);
    writeFileSync(file, 'small');
    expect(run(['--staged'])).toBe(1);
  });

  it('measures a staged symlink blob rather than its large target', () => {
    large('target.bam');
    symlinkSync('target.bam', file);
    git('add', '--', file);
    expect(run(['--staged'])).toBe(0);
  });

  it('skips gitlinks whose commit objects are absent locally', () => {
    git('update-index', '--add', '--cacheinfo',
      '160000,1111111111111111111111111111111111111111,submodule');
    expect(run(['--staged'])).toBe(0);
  });

  it('keeps the working-tree fallback in normal mode outside Git', () => {
    large();
    vi.stubEnv('GIT_DIR', path.join(repo, 'missing-git-dir'));
    try {
      expect(run([])).toBe(1);
      expect(run(['--staged'])).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('checks renamed staged blobs even when rename detection is enabled', () => {
    large();
    git('add', '--', file);
    baseline();
    const renamed = 'renamed.bam';
    renameSync(file, renamed);
    git('add', '-A');
    expect(git('diff', '--cached', '--name-status', '-M')).toMatch(/^R100/);
    expect(run(['--staged'])).toBe(1);
  });

  it('checks a staged type change from symlink to large regular file', () => {
    symlinkSync('missing-target', file);
    git('add', '--', file);
    baseline();
    unlinkSync(file);
    large();
    git('add', '--', file);
    expect(git('diff', '--cached', '--name-status')).toMatch(/^T/);
    expect(run(['--staged'])).toBe(1);
  });

  it('ignores deleted staged files and unstaged additions', () => {
    writeFileSync(file, 'small');
    git('add', '--', file);
    baseline();
    unlinkSync(file);
    git('add', '-A');
    large('untracked.bam');
    expect(run(['--staged'])).toBe(0);
  });

  it('fails closed when the staged index cannot be read', () => {
    vi.stubEnv('GIT_INDEX_FILE', path.join(repo, 'broken-index'));
    writeFileSync(process.env.GIT_INDEX_FILE!, 'invalid');
    try {
      expect(run(['--staged'])).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
