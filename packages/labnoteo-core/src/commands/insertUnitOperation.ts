/**
 * Shared command logic: insert a Unit Operation block into a workflow file.
 *
 * This is the platform-neutral (text-editor / Obsidian CM6) path. It is written
 * against {@link LabnoteHost} so both the VS Code extension and the Obsidian
 * plugin can call it. VS Code additionally keeps a Section-Editor webview path
 * that this function does not attempt to model.
 */
import type { EditTarget, LabnoteHost } from '../host';
import { findUnitOpInsertPointAt, type UnitOpInsertPoint } from '../sections/workflowSectionParser';
import { isValidWorkflowPath, parseExperimenterFromReadme } from '../lib/workflowStructure';
import { getSeoulDateTimeString } from '../lib/dateUtils';
import { buildSwUnitOpMarkdown, buildHwUnitOpMarkdown } from '../lib/unitOpTemplate';
import * as posix from '../util/posixPath';

/** The unit-operation payload a caller (tree/menu/suggest) provides. */
export interface InsertUnitOperationInput {
  opId: string;
  opName: string;
  opDescription?: string;
  opType: 'hw' | 'sw';
  equipment?: string;
  software?: string;
  /**
   * Where the block goes, when the caller already worked it out (it needs the
   * offset to find the new heading afterwards). Defaults to
   * {@link findUnitOpInsertPointAt} at the cursor.
   */
  at?: UnitOpInsertPoint;
}

/**
 * Insert a unit-operation template into the workflow's
 * `## Related Unit Operations` section, following the cursor (#103): right
 * after the block the cursor is in, before the first block when the cursor is
 * between the TOC and the blocks, and after the last block anywhere else.
 *
 * Returns `true` when a block was inserted, `false` when the command bailed
 * (no active workflow document, invalid path, or missing info) — after already
 * having notified the user in that case.
 */
export async function insertUnitOperation(
  host: LabnoteHost,
  input: InsertUnitOperationInput
): Promise<boolean> {
  const target = host.editTarget();
  if (!target) {
    host.notify('warn', host.t('Please open a workflow file.'));
    return false;
  }

  if (!isValidWorkflowPath(target.path)) {
    host.notify(
      'warn',
      host.t('Please run this command on a workflow file inside the labnote folder.')
    );
    return false;
  }

  const { opId, opName, opDescription, opType, equipment, software } = input;
  if (!opId || !opName) {
    host.notify('error', host.t('Missing unit operation info.'));
    return false;
  }

  // Experimenter comes from the sibling README front matter, if present.
  const readmePath = posix.join(posix.dirname(target.path), 'README.labnote.md');
  let experimenter = '';
  if (await host.fs.exists(readmePath)) {
    experimenter = parseExperimenterFromReadme(await host.fs.read(readmePath));
  }

  const dateTime = getSeoulDateTimeString();
  const info = { opId, opName, opDescription: opDescription ?? '' };
  const template =
    opType === 'sw'
      ? buildSwUnitOpMarkdown(info, { experimenter, dateTime, software })
      : buildHwUnitOpMarkdown(info, { experimenter, dateTime, equipment });

  const at = input.at ?? (await unitOpInsertPointAtCursor(target));
  await target.replaceRange(at.offset, at.offset, template);
  const where =
    at.place === 'after'
      ? host.t('(after {0})', at.after ?? '')
      : at.place === 'first'
        ? host.t('(before the first unit operation)')
        : at.place === 'end'
          ? host.t('(after the last unit operation)')
          : '';
  host.notify('info', [host.t('Unit operation inserted: {0} {1}', opId, opName), where].filter(Boolean).join(' '));
  return true;
}

/** {@link findUnitOpInsertPointAt} for the target's cursor; after the last block when it has none. */
export async function unitOpInsertPointAtCursor(target: EditTarget): Promise<UnitOpInsertPoint> {
  const text = await target.getText();
  const cursor = target.getCursorOffset ? await target.getCursorOffset() : text.length;
  return findUnitOpInsertPointAt(text, cursor);
}
