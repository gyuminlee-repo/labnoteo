/**
 * "Open user guide" — the in-app way to the researcher quick-start (#39).
 *
 * The guide used to appear only as a side effect of "Setup research
 * automation", which also installs Git hooks and GitHub workflows a researcher
 * who just wants to take notes does not need. This writes only `QUICKSTART.md`
 * (when missing, or left behind by an older release) and opens it.
 */
import type { LabnoteHost } from '@labnoteo/core';
import { QUICKSTART_ASSET, QUICKSTART_DOC_CONTENT, QUICKSTART_DOC_PATH } from './scaffold/assets';
import { freeBackupPath, managedBlockStatus, managedFileContent, upsertManagedBlock } from './scaffold/scaffold';
import { compareVersions, contentHash, readInstallRecord, writeInstallRecord } from './scaffold/installRecord';

/** Where the guide's text before a replacement is kept, while that name is free. */
export const QUICKSTART_BACKUP_PATH = 'QUICKSTART.backup.md';

/** The release a copy of the guide was written for, from its version line. */
export function guideVersion(text: string): string | undefined {
  return /^> 이 설명서는 labnoteo (\S+) 기준입니다\.$/m.exec(text)?.[1];
}

/**
 * Open the guide. A copy whose marked block was left at an older release is
 * brought up to this one first (#305): silently while the block is the one a
 * release wrote, after asking when someone edited it (the old file is kept
 * as {@link QUICKSTART_BACKUP_PATH}, or a free name beside it). An edited block of this release, a copy
 * without the markers, or one a newer plugin recorded is opened as it is.
 * `write` goes through the vault so an open editor of the guide follows.
 */
export async function openUserGuide(
  host: LabnoteHost,
  pluginVersion: string,
  write: (path: string, content: string) => Promise<void> = (path, content) => host.fs.write(path, content)
): Promise<void> {
  const record = await readInstallRecord(host);
  const newer = record.pluginVersion !== undefined && compareVersions(record.pluginVersion, pluginVersion) > 0;
  const remember = (): Promise<void> => {
    const hash = contentHash(QUICKSTART_DOC_CONTENT);
    return writeInstallRecord(host, {
      pluginVersion: newer ? record.pluginVersion : pluginVersion,
      files: { ...record.files, [QUICKSTART_DOC_PATH]: hash },
      blocks: { ...record.blocks, [QUICKSTART_DOC_PATH]: hash },
    });
  };

  if (!(await host.fs.exists(QUICKSTART_DOC_PATH))) {
    await write(QUICKSTART_DOC_PATH, managedFileContent(QUICKSTART_ASSET));
    // Recorded so later plugin updates refresh the guide while it stays unedited.
    await remember();
    host.notify('info', host.t('Created the user guide: {0}', QUICKSTART_DOC_PATH));
  } else if (!newer) {
    const current = await host.fs.read(QUICKSTART_DOC_PATH);
    const status = managedBlockStatus(current, QUICKSTART_ASSET, record.files[QUICKSTART_DOC_PATH]);
    const stale = status === 'outdated' || (status === 'edited' && guideVersion(current) !== guideVersion(QUICKSTART_DOC_CONTENT));
    if (stale) {
      // An earlier backup is not written over (#344).
      const backup =
        status === 'edited' ? await freeBackupPath(host.fs, QUICKSTART_BACKUP_PATH, guideVersion(current)) : undefined;
      const replace =
        backup === undefined ||
        (await host.confirm(
          host.t(
            'This user guide was written for labnoteo {0}, older than the installed {1}, and its marked block was edited. Replace the block with the new version? The current file is kept as {2}; in a Git vault that copy is committed too. Cancel opens it as it is.',
            guideVersion(current) ?? host.t('an earlier version'),
            pluginVersion,
            backup
          ),
          { confirmLabel: host.t('Replace with the new version') }
        ));
      if (replace) {
        if (backup !== undefined) await write(backup, current);
        await write(QUICKSTART_DOC_PATH, upsertManagedBlock(current, QUICKSTART_ASSET.content));
        await remember();
        host.notify(
          'info',
          backup === undefined
            ? host.t('Updated the user guide to labnoteo {0}.', pluginVersion)
            : host.t('Updated the user guide to labnoteo {0}. The previous file is kept as {1}.', pluginVersion, backup)
        );
      }
    }
  }
  await host.openFile(QUICKSTART_DOC_PATH);
}
