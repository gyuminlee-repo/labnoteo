/**
 * #39: the researcher guide must be reachable without installing the Git
 * automation, and providing it early must not make the later setup run ask to
 * overwrite a file it would write identically.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { openUserGuide } from '../../src/userGuide';
import { applyAsset, managedFileContent } from '../../src/scaffold/scaffold';
import { QUICKSTART_ASSET, QUICKSTART_DOC_CONTENT, QUICKSTART_DOC_PATH } from '../../src/scaffold/assets';
import obsidianKo from '../../src/l10n.ko';

function makeHost(files: Record<string, string> = {}, confirmResult = true) {
  const fs = new MemFileSystem(files);
  const host = {
    fs,
    openFile: vi.fn(async () => undefined),
    notify: vi.fn(),
    confirm: vi.fn(async () => confirmResult),
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
    'New here? Open the quick-start guide. Searching "Labnote" in the command palette lists every command.',
    'Click an experiment to open its README, or right-click it to change its status or toggle its discussion flag. Right-click a catalog item to create a workflow or insert a unit operation. No experiment yet? Run "{0}" first.',
    'Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.',
  ])('%s', key => {
    expect(obsidianKo[key]).toBeTruthy();
  });
});
