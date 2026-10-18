/**
 * Plugin load brings scaffolded files up to the embedded templates without a
 * "Setup research automation" re-run, but only files the user has not edited
 * since the last reconcile (`.labnoteo/installed.json`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import {
  applyAsset,
  managedFileContent,
  refreshAutomationFiles,
  setupResearchAutomationCommand,
} from '../../src/scaffold/scaffold';
import {
  INSTALL_RECORD_PATH,
  ISSUE_SYNC_WORKFLOW_PATH,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  QUICKSTART_DOC_PATH,
  SCAFFOLD_ASSETS,
  type ScaffoldAsset,
} from '../../src/scaffold/assets';
import { compareVersions, contentHash } from '../../src/scaffold/installRecord';
import { LEGACY_HASH_SELF_CHECK, LEGACY_TEMPLATE_HASHES } from '../../src/scaffold/legacyTemplateHashes';
import obsidianKo from '../../src/l10n.ko';

function makeHost(files: Record<string, string> = {}) {
  const fs = new MemFileSystem(files);
  const host = {
    fs,
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    t: (key: string, ...args: Array<string | number | boolean>) =>
      key.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])),
  };
  return { fs, host, asHost: host as unknown as LabnoteHost };
}

const ASSETS: ScaffoldAsset[] = [
  { vaultPath: 'DOC.md', content: 'v2\n' },
  { vaultPath: ISSUE_SYNC_WORKFLOW_PATH, content: 'wf\n' },
  { vaultPath: 'AGENTS.md', content: 'rules v2', merge: 'managed-block' },
  { vaultPath: '.gitignore', content: 'a\nb\n', merge: 'append-missing' },
  { vaultPath: 'wiki-staging/Home.md', content: 'seed v2\n', seed: true },
];

function record(files: Record<string, string>, pluginVersion = '1.0.0'): string {
  return JSON.stringify({ pluginVersion, files });
}

async function readRecord(fs: MemFileSystem) {
  return JSON.parse(await fs.read(INSTALL_RECORD_PATH)) as {
    pluginVersion: string;
    files: Record<string, string>;
  };
}

describe('refreshAutomationFiles', () => {
  it('replaces a file still matching the template it was installed from', async () => {
    const { fs, host, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'v1\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v1\n') }),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('v2\n');
    expect(result.updated).toContain('DOC.md');
    const saved = await readRecord(fs);
    expect(saved.files['DOC.md']).toBe(contentHash('v2\n'));
    expect(saved.pluginVersion).toBe('1.1.0');
    expect(host.notify).toHaveBeenCalledWith('info', expect.stringContaining('DOC.md'));
  });

  it('treats CRLF checkouts of an untouched file as untouched', async () => {
    const { fs, asHost } = makeHost({
      'DOC.md': 'v1\r\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v1\n') }),
    });

    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('v2\n');
  });

  it('keeps an edited file and reports it once the template has changed', async () => {
    const { fs, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'v1 with my notes\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v1\n') }),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('v1 with my notes\n');
    expect(result.pending).toEqual(['DOC.md']);
  });

  it('stays quiet about an edit already reconciled with the current template', async () => {
    // The setup command records the template even when the overwrite is declined.
    const { asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'my own version\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v2\n') }),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(result.pending).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('records an unrecorded file that already matches, and reports one that differs only once', async () => {
    const { fs, host, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'from an older release\n',
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('from an older release\n');
    expect(result.pending).toEqual(['DOC.md']);
    const saved = await readRecord(fs);
    expect(saved.files[ISSUE_SYNC_WORKFLOW_PATH]).toBe(contentHash('wf\n'));
    expect(saved.files['DOC.md']).toBe(contentHash('v2\n'));

    host.notify.mockClear();
    const again = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);
    expect(again.pending).toEqual([]);
    expect(host.notify).not.toHaveBeenCalled();
    expect(await fs.read('DOC.md')).toBe('from an older release\n');
  });

  // #93: vaults set up before 0.95.0 have no record.
  it('replaces an unrecorded file that is an earlier release\'s template', async () => {
    const { fs, asHost } = makeHost({ [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n', 'DOC.md': 'v1\r\n' });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS, { 'DOC.md': [contentHash('v1\n')] });

    expect(await fs.read('DOC.md')).toBe('v2\n');
    expect(result).toEqual({ updated: ['DOC.md'], pending: [], missing: [] });
  });

  it('replaces an unrecorded plugin-owned file without an earlier hash', async () => {
    const owned: ScaffoldAsset[] = [...ASSETS, { vaultPath: '.labnoteo/scripts/x.mjs', content: 'new\n', owned: true }];
    const { fs, asHost } = makeHost({ [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n', '.labnoteo/scripts/x.mjs': 'old\n' });

    const result = await refreshAutomationFiles(asHost, '1.1.0', owned, {});

    expect(await fs.read('.labnoteo/scripts/x.mjs')).toBe('new\n');
    expect(result.updated).toContain('.labnoteo/scripts/x.mjs');
  });

  it('refreshes an earlier guide left out of a 0.95.0 record', async () => {
    const { fs, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'v1\n',
      [INSTALL_RECORD_PATH]: record({ [ISSUE_SYNC_WORKFLOW_PATH]: contentHash('wf\n') }, '0.95.0'),
    });

    const result = await refreshAutomationFiles(asHost, '0.96.0', ASSETS, { 'DOC.md': [contentHash('v1\n')] });

    expect(await fs.read('DOC.md')).toBe('v2\n');
    expect(result.pending).toEqual([]);
  });

  it('leaves everything alone when a newer plugin wrote the record', async () => {
    const { fs, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'DOC.md': 'v3\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v3\n') }, '1.2.0'),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('v3\n');
    expect(result).toEqual({ updated: [], pending: [], missing: [] });
  });

  it('refreshes only the managed block of AGENTS.md, and only when it is there', async () => {
    const withBlock = `my rules\n\n${MANAGED_BLOCK_BEGIN}\nrules v1\n${MANAGED_BLOCK_END}\n`;
    const { fs, asHost } = makeHost({ 'AGENTS.md': withBlock });
    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);
    expect(await fs.read('AGENTS.md')).toBe(
      `my rules\n\n${MANAGED_BLOCK_BEGIN}\nrules v2\n${MANAGED_BLOCK_END}\n`
    );

    const { fs: fs2, asHost: host2 } = makeHost({ 'AGENTS.md': 'my rules only\n' });
    await refreshAutomationFiles(host2, '1.1.0', ASSETS);
    expect(await fs2.read('AGENTS.md')).toBe('my rules only\n');
  });

  it('appends missing .gitignore lines once per template change', async () => {
    const { fs, asHost } = makeHost({ [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n', '.gitignore': 'a\n' });
    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);
    expect(await fs.read('.gitignore')).toBe('a\n\nb\n');

    // A line the user deletes afterwards is not put back on the next load.
    await fs.write('.gitignore', 'a\n');
    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);
    expect(await fs.read('.gitignore')).toBe('a\n');
  });

  it('never touches wiki-staging skeletons', async () => {
    const { fs, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'wiki-staging/Home.md': 'seed v1\n',
      [INSTALL_RECORD_PATH]: record({ 'wiki-staging/Home.md': contentHash('seed v1\n') }),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('wiki-staging/Home.md')).toBe('seed v1\n');
    expect(result.pending).not.toContain('wiki-staging/Home.md');
  });

  it('reports a missing file once, but not one deleted after being installed', async () => {
    const added = makeHost({ [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n' });
    expect((await refreshAutomationFiles(added.asHost, '1.1.0', ASSETS)).missing).toEqual(['DOC.md']);
    expect(added.host.notify).toHaveBeenCalledWith('info', expect.stringContaining('are not in the vault: DOC.md'));
    expect(await added.fs.exists('DOC.md')).toBe(false);
    expect((await refreshAutomationFiles(added.asHost, '1.1.0', ASSETS)).missing).toEqual([]);

    const deleted = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v1\n') }),
    });
    expect((await refreshAutomationFiles(deleted.asHost, '1.1.0', ASSETS)).missing).toEqual([]);
  });

  it('installs nothing and writes no record into a vault without the automation', async () => {
    const { fs, host, asHost } = makeHost({ 'note.md': 'x' });

    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.exists('DOC.md')).toBe(false);
    expect(await fs.exists(INSTALL_RECORD_PATH)).toBe(false);
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('refreshes an untouched guide from "Open user guide" in a vault without the automation', async () => {
    const { fs, host, asHost } = makeHost({
      'DOC.md': 'v1\n',
      [INSTALL_RECORD_PATH]: record({ 'DOC.md': contentHash('v1\n') }),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('DOC.md')).toBe('v2\n');
    expect(result.pending).toEqual([]);
    expect(host.notify).toHaveBeenCalledTimes(1);
  });
});

describe('setup command and refresh together', () => {
  it('a later template version reaches files the setup command installed', async () => {
    const { fs, asHost } = makeHost();
    await setupResearchAutomationCommand(asHost, '1.0.0');
    expect((await readRecord(fs)).files[QUICKSTART_DOC_PATH]).toBeDefined();
    expect((await readRecord(fs)).files['wiki-staging/Home.md']).toBeUndefined();

    const next = SCAFFOLD_ASSETS.map(a =>
      a.vaultPath === QUICKSTART_DOC_PATH ? { ...a, content: `${a.content}\nNew section\n` } : a
    );
    const result = await refreshAutomationFiles(asHost, '1.1.0', next);

    expect(result.updated).toEqual([QUICKSTART_DOC_PATH]);
    expect(result.pending).toEqual([]);
    expect(await fs.read(QUICKSTART_DOC_PATH)).toContain('New section');
  });
});

// #127: the lab's own text in QUICKSTART.md survives updates.
describe('QUICKSTART managed block', () => {
  const GUIDE: ScaffoldAsset = {
    vaultPath: 'GUIDE.md',
    content: 'guide v2\n',
    merge: 'managed-block',
    migrateUnmarked: true,
    trailer: 'Write below.',
  };
  const WF: ScaffoldAsset = { vaultPath: ISSUE_SYNC_WORKFLOW_PATH, content: 'wf\n' };
  const legacy = { 'GUIDE.md': [contentHash('guide v0\n')] };
  const marked = (inner: string, below: string) =>
    `${MANAGED_BLOCK_BEGIN}\n${inner}\n${MANAGED_BLOCK_END}\n\n${below}\n`;

  it('is written as the block, then the line inviting the lab text', () => {
    expect(managedFileContent(GUIDE)).toBe(marked('guide v2', 'Write below.'));
  });

  it('refreshes only the block and keeps what is written below it', async () => {
    const { fs, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'GUIDE.md': marked('guide v1', 'Our lab: label tubes in pencil.'),
    });

    const result = await refreshAutomationFiles(asHost, '1.1.0', [WF, GUIDE], legacy);

    expect(result.updated).toEqual(['GUIDE.md']);
    expect(await fs.read('GUIDE.md')).toBe(marked('guide v2', 'Our lab: label tubes in pencil.'));
  });

  it.each([
    ['recorded', { [INSTALL_RECORD_PATH]: record({ 'GUIDE.md': contentHash('guide v1\n') }) }, 'guide v1\n'],
    ['earlier release', {}, 'guide v0\n'],
    ['current template', {}, 'guide v2\n'],
  ])('moves an unedited unmarked copy (%s) to the new form on load', async (_how, extra, text) => {
    const { fs, asHost } = makeHost({ 'GUIDE.md': text, ...extra });

    const result = await refreshAutomationFiles(asHost, '1.1.0', [WF, GUIDE], legacy);

    expect(result.updated).toEqual(['GUIDE.md']);
    expect(await fs.read('GUIDE.md')).toBe(managedFileContent(GUIDE));
  });

  it('leaves an edited unmarked copy for the setup command, once', async () => {
    const { fs, host, asHost } = makeHost({
      [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n',
      'GUIDE.md': 'guide v1\nOur rule\n',
      [INSTALL_RECORD_PATH]: record({ 'GUIDE.md': contentHash('guide v1\n') }),
    });

    const first = await refreshAutomationFiles(asHost, '1.1.0', [WF, GUIDE], legacy);
    const second = await refreshAutomationFiles(asHost, '1.1.0', [WF, GUIDE], legacy);

    expect(first.pending).toEqual(['GUIDE.md']);
    expect(second.pending).toEqual([]);
    expect(await fs.read('GUIDE.md')).toBe('guide v1\nOur rule\n');
    expect(host.notify).toHaveBeenCalledTimes(1);
  });

  it('replaces an unedited unmarked copy in the setup command without appending a second guide', async () => {
    const { fs, host, asHost } = makeHost({ 'GUIDE.md': 'guide v1\n' });

    expect(await applyAsset(asHost, GUIDE, contentHash('guide v1\n'), legacy)).toBe('written');

    expect(host.confirm).not.toHaveBeenCalled();
    const text = await fs.read('GUIDE.md');
    expect(text).toBe(managedFileContent(GUIDE));
    expect(text.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
  });

  it('asks before replacing an edited unmarked copy in the setup command', async () => {
    const { fs, host, asHost } = makeHost({ 'GUIDE.md': 'guide v1\nOur rule\n' });

    host.confirm.mockResolvedValueOnce(false);
    expect(await applyAsset(asHost, GUIDE, contentHash('guide v1\n'), legacy)).toBe('skipped');
    expect(await fs.read('GUIDE.md')).toBe('guide v1\nOur rule\n');
    expect(host.confirm).toHaveBeenCalledWith(expect.stringContaining('updates change only the marked block'), expect.anything());

    expect(await applyAsset(asHost, GUIDE, contentHash('guide v1\n'), legacy)).toBe('written');
    expect(await fs.read('GUIDE.md')).toBe(managedFileContent(GUIDE));
  });

  it('does not put a block back into an unmarked file of an asset without migrateUnmarked', async () => {
    const { fs, asHost } = makeHost({ [ISSUE_SYNC_WORKFLOW_PATH]: 'wf\n', 'AGENTS.md': 'our rules\n' });

    await refreshAutomationFiles(asHost, '1.1.0', ASSETS);

    expect(await fs.read('AGENTS.md')).toBe('our rules\n');
  });
});

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.94.0', '0.94.0')).toBe(0);
    expect(compareVersions('0.94.0', '0.95.0')).toBeLessThan(0);
  });
});

describe('refresh strings are translated', () => {
  it.each([
    'Updated {0} automation file(s) to this plugin version: {1}',
    'These automation files changed after they were installed, or cannot be checked against an earlier version, so they were left as they are: {0}. Run "Setup research automation" to get the new version.',
    'These automation files are not in the vault: {0}. Run "Setup research automation" to install them if you need them.',
    '{0} differs from the new version. Edits made after it was installed are lost if you replace it. Replace it with the new version?',
    'From then on, updates change only the marked block and keep what you write below it.',
  ])('%s', key => {
    expect(obsidianKo[key]).toBeTruthy();
  });
});

describe('earlier template hashes (#93)', () => {
  it('were made with the same hash function', () => {
    expect(contentHash(LEGACY_HASH_SELF_CHECK.text)).toBe(LEGACY_HASH_SELF_CHECK.hash);
  });

  it('cover installed files only, and every plain template file', () => {
    const paths = new Set(SCAFFOLD_ASSETS.map(a => a.vaultPath));
    for (const path of Object.keys(LEGACY_TEMPLATE_HASHES)) expect(paths).toContain(path);
    // A migrated managed block still needs them to tell an unedited unmarked copy.
    const plain = SCAFFOLD_ASSETS.filter(a => (!a.merge || a.migrateUnmarked) && !a.seed && !a.owned).map(
      a => a.vaultPath
    );
    expect(Object.keys(LEGACY_TEMPLATE_HASHES).sort()).toEqual(plain.sort());
  });

  it('mark every built script as plugin-owned', () => {
    const scripts = SCAFFOLD_ASSETS.filter(a => a.vaultPath.startsWith('.labnoteo/scripts/'));
    expect(scripts.length).toBe(3);
    expect(scripts.every(a => a.owned)).toBe(true);
  });
});
