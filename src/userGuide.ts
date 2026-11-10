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
import {
  freeBackupPath,
  managedBlockBroken,
  managedBlockStatus,
  managedFileContent,
  rebuildBrokenManagedFile,
  upsertManagedBlock,
} from './scaffold/scaffold';
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
 * `processFile` changes a file as it is when written ('' when it does not exist), through the
 * vault so an open editor of the guide follows; false when it wrote nothing that it should
 * have. The guide is judged again there: changed meanwhile so the answer asked for no longer
 * fits it, it is left as it is and the user told to open it again.
 */
export async function openUserGuide(
  host: LabnoteHost,
  pluginVersion: string,
  processFile: (path: string, change: (text: string) => string) => Promise<boolean> = async (path, change) => {
    await host.fs.write(path, change((await host.fs.exists(path)) ? await host.fs.read(path) : ''));
    return true;
  }
): Promise<void> {
  const write = (path: string, content: string) => processFile(path, () => content);
  // The guide changed as `fits` asks of the text written over: left as it is, and said so.
  const update = async (fits: (text: string) => boolean, change: (text: string) => string): Promise<boolean> => {
    let refused = false;
    const written = await processFile(QUICKSTART_DOC_PATH, text => {
      refused = !fits(text);
      return refused ? text : change(text);
    });
    if (refused) {
      host.notify(
        'warn',
        host.t('The user guide changed while you were deciding, so it was not updated. Run "{0}" again to update it.', host.t('Open user guide'))
      );
      return false;
    }
    if (!written) {
      host.notify('warn', host.t('{0} was not written: it was still being saved, or it changed while the change went in. Try again in a moment.', QUICKSTART_DOC_PATH));
    }
    return written;
  };
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
  } else if (!newer && managedBlockBroken(await host.fs.read(QUICKSTART_DOC_PATH))) {
    // Neither marker can be trusted, so no update could find the block (#563).
    const current = await host.fs.read(QUICKSTART_DOC_PATH);
    const backup = await freeBackupPath(host.fs, QUICKSTART_BACKUP_PATH, guideVersion(current));
    const ok = await host.confirm(
      host.t(
        'The BEGIN/END labnoteo (managed) marks of {0} are broken (one is missing or they are out of order), so updates cannot tell their block from your text. Rebuild the block with the new version? Text outside the marks that cannot be part of the block is kept, and the current file is kept as {1}.',
        QUICKSTART_DOC_PATH,
        backup
      ),
      { confirmLabel: host.t('Rebuild'), destructive: true }
    );
    if (ok) {
      await write(backup, current);
      if (await update(managedBlockBroken, text => rebuildBrokenManagedFile(text, QUICKSTART_ASSET))) {
        await remember();
        host.notify('info', host.t('Updated the user guide to labnoteo {0}. The previous file is kept as {1}.', pluginVersion, backup));
      }
    }
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
        const sameStatus = (text: string) =>
          managedBlockStatus(text, QUICKSTART_ASSET, record.files[QUICKSTART_DOC_PATH]) === status;
        if (await update(sameStatus, text => upsertManagedBlock(text, QUICKSTART_ASSET.content))) {
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
  }
  await host.openFile(QUICKSTART_DOC_PATH);
}
