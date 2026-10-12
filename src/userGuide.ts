/**
 * "Open user guide" — the in-app way to the researcher quick-start (#39).
 *
 * The guide used to appear only as a side effect of "Setup research
 * automation", which also installs Git hooks and GitHub workflows a researcher
 * who just wants to take notes does not need. This writes only `QUICKSTART.md`
 * (when missing) and opens it.
 */
import type { LabnoteHost } from '@labnoteo/core';
import { QUICKSTART_DOC_CONTENT, QUICKSTART_DOC_PATH } from './scaffold/assets';

export async function openUserGuide(host: LabnoteHost): Promise<void> {
  // An existing copy may carry the researcher's own notes, so never overwrite.
  if (!(await host.fs.exists(QUICKSTART_DOC_PATH))) {
    await host.fs.write(QUICKSTART_DOC_PATH, QUICKSTART_DOC_CONTENT);
    host.notify('info', host.t('Created the user guide: {0}', QUICKSTART_DOC_PATH));
  }
  await host.openFile(QUICKSTART_DOC_PATH);
}
