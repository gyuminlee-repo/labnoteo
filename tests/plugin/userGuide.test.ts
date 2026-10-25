/**
 * #39: the researcher guide must be reachable without installing the Git
 * automation, and providing it early must not make the later setup run ask to
 * overwrite a file it would write identically.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { QUICKSTART_BACKUP_PATH, guideVersion, openUserGuide } from '../../src/userGuide';
import { applyAsset, managedFileContent, upsertManagedBlock } from '../../src/scaffold/scaffold';
import { contentHash } from '../../src/scaffold/installRecord';
import { INSTALL_RECORD_PATH, QUICKSTART_ASSET, QUICKSTART_DOC_CONTENT, QUICKSTART_DOC_PATH } from '../../src/scaffold/assets';
import obsidianKo from '../../src/l10n.ko';

function makeHost(files: Record<string, string> = {}, confirmResult = true) {
  const fs = new MemFileSystem(files);
  const host = {
    fs,
    openFile: vi.fn(async () => undefined),
    notify: vi.fn(),
    confirm: vi.fn(async (_message: string) => confirmResult),
    t: (key: string, ...args: Array<string | number | boolean>) =>
      key.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])),
  };
  return { fs, host, asHost: host as unknown as LabnoteHost };
}

describe('openUserGuide', () => {
  it('writes only QUICKSTART.md when it is missing, then opens it', async () => {
    const { fs, host, asHost } = makeHost();
    expect(QUICKSTART_DOC_CONTENT.length).toBeGreaterThan(0);

    await openUserGuide(asHost, '1.0.0');

    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe(managedFileContent(QUICKSTART_ASSET));
    expect(await fs.exists('.labnoteo/SETUP.md')).toBe(false);
    expect(await fs.exists('.github/workflows/experiment-issues.yml')).toBe(false);
    expect(host.notify).toHaveBeenCalledTimes(1);
    expect(host.openFile).toHaveBeenCalledWith(QUICKSTART_DOC_PATH);
  });

  it('opens an existing copy without overwriting the researcher’s edits', async () => {
    const { fs, host, asHost } = makeHost({ [QUICKSTART_DOC_PATH]: '# my notes\n' });

    await openUserGuide(asHost, '1.0.0');

    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe('# my notes\n');
    expect(host.notify).not.toHaveBeenCalled();
    expect(host.openFile).toHaveBeenCalledWith(QUICKSTART_DOC_PATH);
  });
});

// #305: a guide whose marked block was edited stayed at an old release, and
// "Open user guide" opened it without a word.
describe('openUserGuide with a guide left at an older release', () => {
  const VERSION = guideVersion(QUICKSTART_DOC_CONTENT)!;
  const OLD = '# 연구노트 퀵스타트\n\n옛 설명서(partbank 없음)';
  const oldFile = (inner: string) => upsertManagedBlock('', inner) + '\n연구실 규칙\n';
  const record = (hash: string, pluginVersion = '0.100.0') =>
    JSON.stringify({ pluginVersion, files: { [QUICKSTART_DOC_PATH]: hash } });

  it('carries the release it was written for', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(guideVersion(OLD)).toBeUndefined();
  });

  it('brings an unedited old block up to date without asking', async () => {
    const { fs, host, asHost } = makeHost({
      [QUICKSTART_DOC_PATH]: oldFile(OLD),
      [INSTALL_RECORD_PATH]: record(contentHash(`${OLD}\n`)),
    });
    await openUserGuide(asHost, VERSION);
    expect(host.confirm).not.toHaveBeenCalled();
    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe(oldFile(QUICKSTART_DOC_CONTENT));
    expect(await fs.exists(QUICKSTART_BACKUP_PATH)).toBe(false);
    expect(host.openFile).toHaveBeenCalledWith(QUICKSTART_DOC_PATH);
  });

  it('asks before replacing an edited old block, keeping the old file as a backup', async () => {
    const edited = oldFile(`${OLD}\n우리 연구실 메모`);
    const { fs, host, asHost } = makeHost({
      [QUICKSTART_DOC_PATH]: edited,
      [INSTALL_RECORD_PATH]: record(contentHash(QUICKSTART_DOC_CONTENT)),
    });
    await openUserGuide(asHost, VERSION);
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(await fs.read(QUICKSTART_BACKUP_PATH)).toBe(edited);
    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe(oldFile(QUICKSTART_DOC_CONTENT));
    expect(await fs.read(QUICKSTART_DOC_PATH)).toContain('연구실 규칙');
  });

  it('does not write over a backup an earlier replacement left (#344)', async () => {
    const edited = oldFile(`> 이 설명서는 labnoteo 0.121.0 기준입니다.\n${OLD}\n메모 E`);
    const { fs, host, asHost } = makeHost({
      [QUICKSTART_DOC_PATH]: edited,
      [QUICKSTART_BACKUP_PATH]: '메모 C\n',
    });
    await openUserGuide(asHost, VERSION);
    expect(host.confirm.mock.calls[0][0]).toContain('QUICKSTART.backup-0.121.0.md');
    expect(await fs.read(QUICKSTART_BACKUP_PATH)).toBe('메모 C\n');
    expect(await fs.read('QUICKSTART.backup-0.121.0.md')).toBe(edited);
    expect(host.notify).toHaveBeenCalledWith('info', expect.stringContaining('QUICKSTART.backup-0.121.0.md'));
  });

  it('opens an edited old block as it is when declined', async () => {
    const edited = oldFile(`${OLD}\n우리 연구실 메모`);
    const { fs, host, asHost } = makeHost({ [QUICKSTART_DOC_PATH]: edited }, false);
    await openUserGuide(asHost, VERSION);
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe(edited);
    expect(await fs.exists(QUICKSTART_BACKUP_PATH)).toBe(false);
    expect(host.openFile).toHaveBeenCalledWith(QUICKSTART_DOC_PATH);
  });

  it('leaves an edited block of this release, and a guide a newer plugin recorded', async () => {
    const mine = oldFile(`${QUICKSTART_DOC_CONTENT.trim()}\n우리 연구실 메모`);
    const a = makeHost({ [QUICKSTART_DOC_PATH]: mine });
    await openUserGuide(a.asHost, VERSION);
    expect(a.host.confirm).not.toHaveBeenCalled();
    expect(await a.fs.read(QUICKSTART_DOC_PATH)).toBe(mine);

    const b = makeHost({
      [QUICKSTART_DOC_PATH]: oldFile(OLD),
      [INSTALL_RECORD_PATH]: record(contentHash(`${OLD}\n`), '99.0.0'),
    });
    await openUserGuide(b.asHost, VERSION);
    expect(b.host.confirm).not.toHaveBeenCalled();
    expect(await b.fs.read(QUICKSTART_DOC_PATH)).toBe(oldFile(OLD));
  });
});

describe('applyAsset overwrite prompt', () => {
  const asset = { vaultPath: QUICKSTART_DOC_PATH, content: QUICKSTART_DOC_CONTENT };

  it('skips without asking when the file already has the same content', async () => {
    const { host, asHost } = makeHost({ [QUICKSTART_DOC_PATH]: QUICKSTART_DOC_CONTENT });
    expect(await applyAsset(asHost, asset)).toBeUndefined();
    expect(host.confirm).not.toHaveBeenCalled();
  });

  it('treats CRLF line endings as the same content', async () => {
    const crlf = QUICKSTART_DOC_CONTENT.replace(/\r?\n/g, '\r\n');
    const { host, asHost } = makeHost({ [QUICKSTART_DOC_PATH]: crlf });
    expect(await applyAsset(asHost, asset)).toBeUndefined();
    expect(host.confirm).not.toHaveBeenCalled();
  });

  it('leaves the guide "Open user guide" wrote to the setup run without asking', async () => {
    const { fs, host, asHost } = makeHost();
    await openUserGuide(asHost, '1.0.0');
    const written = await fs.read(QUICKSTART_DOC_PATH);

    expect(await applyAsset(asHost, QUICKSTART_ASSET)).toBeUndefined();
    expect(host.confirm).not.toHaveBeenCalled();
    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe(written);
  });

  it('still asks before overwriting a file that differs', async () => {
    const { fs, host, asHost } = makeHost({ [QUICKSTART_DOC_PATH]: '# my notes\n' }, false);
    expect(await applyAsset(asHost, asset)).toBe('skipped');
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(await fs.read(QUICKSTART_DOC_PATH)).toBe('# my notes\n');
  });
});

describe('user guide strings are translated', () => {
  // A missing Korean entry silently falls back to English, so pin the new keys.
  it.each([
    'Open user guide',
    'User guide',
    'Created the user guide: {0}',
    'Replace with the new version',
    'Updated the user guide to labnoteo {0}.',
    'Updated the user guide to labnoteo {0}. The previous file is kept as {1}.',
    '{0} was edited, so it was left at its earlier version. Run "Open user guide" to get the new version.',
    'New here? Open the quick-start guide. Searching "Labnote" in the command palette lists every command.',
    'Click an experiment to open its README, or right-click it to change its status or toggle its discussion flag. Right-click a catalog item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.',
    'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.',
  ])('%s', key => {
    expect(obsidianKo[key]).toBeTruthy();
  });
});
