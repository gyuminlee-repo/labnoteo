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
import { diagnoseWorkflowPath, parseExperimenterFromNote, parseExperimenterFromReadme } from '../lib/workflowStructure';
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
   * Per-instance alias after `[id name]` in the heading, like a workflow's
   * (#118): `### [UHW180 Incubation] 1차 37도`. The TOC entry follows it.
   */
  alias?: string;
  /**
   * Where the block goes, when the caller already worked it out (it needs the
   * offset to find the new heading afterwards). Defaults to
   * {@link findUnitOpInsertPointAt} at the cursor.
   */
  at?: UnitOpInsertPoint;
}

/**
 * What keeps `filePath` from taking a unit operation, in the user's words, or
 * undefined for a workflow note. Lets a command say so before its picker
 * opens rather than after a choice was made (#201, #166).
 */
export function workflowPathProblem(host: Pick<LabnoteHost, 't'>, filePath: string): string | undefined {
  const found = diagnoseWorkflowPath(filePath);
  switch (found.kind) {
    case 'ok':
      return undefined;
    case 'readme':
      return host.t(
        'README.labnote.md is the experiment overview and holds no unit operations. Open one of its workflow notes (###_….labnote.md), or make one with "{0}".',
        host.t('Create workflow')
      );
    case 'notWorkflow':
      return host.t(
        '"{0}" is not a workflow note: unit operations go into a ###_….labnote.md note directly in the experiment folder. Open one, or make one with "{1}".',
        posix.basename(filePath),
        host.t('Create workflow')
      );
    case 'nested':
      return host.t(
        '"{0}" is not recognized as an experiment: experiment folders must be directly under labnote/. Move it back to labnote/.',
        posix.basename(found.folder)
      );
    case 'noPrefix':
      return host.t(
        '"{0}" is not an experiment folder: its name must start with ###_ (e.g. 001_Name).',
        posix.basename(found.folder)
      );
    case 'outside':
      return host.t('Please run this command on a workflow file inside the labnote folder.');
  }
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

  const problem = workflowPathProblem(host, target.path);
  if (problem) {
    host.notify('warn', problem);
    return false;
  }

  const { opId, opName, opDescription, opType, equipment, software } = input;
  if (!opId || !opName) {
    host.notify('error', host.t('Missing unit operation info.'));
    return false;
  }

  // The note's own experimenter first: a note may be someone else's than the
  // README author's (#404). The README author fills in for a note naming nobody.
  const readmePath = posix.join(posix.dirname(target.path), 'README.labnote.md');
  const author = (await host.fs.exists(readmePath)) ? parseExperimenterFromReadme(await host.fs.read(readmePath)) : '';
  const own = parseExperimenterFromNote(await target.getText());
  const experimenter = own || author;

  const dateTime = getSeoulDateTimeString();
  const alias = input.alias?.trim();
  const info = { opId, opName, opDescription: opDescription ?? '', descriptionExtra: alias ? ` ${alias}` : undefined };
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
          : at.place === 'noSection'
            ? at.beforeConclusions
              ? host.t('(before the conclusions: no unit operation section was found, so the table of contents was not updated)')
              : host.t('(at the end of the note: no unit operation section was found, so the table of contents was not updated)')
            : '';
  const who =
    own && author && own !== author
      ? host.t('Experimenter: {0}, from the note front matter; the README author is {1}.', own, author)
      : '';
  host.notify(
    'info',
    [host.t('Unit operation inserted: {0} {1}', opId, opName), where, who].filter(Boolean).join(' ')
  );
  return true;
}

/** {@link findUnitOpInsertPointAt} for the target's cursor; after the last block when it has none. */
export async function unitOpInsertPointAtCursor(target: EditTarget): Promise<UnitOpInsertPoint> {
  const text = await target.getText();
  const cursor = target.getCursorOffset ? await target.getCursorOffset() : text.length;
  return findUnitOpInsertPointAt(text, cursor);
}
