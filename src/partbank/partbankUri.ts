/**
 * `obsidian://labnoteo-import?server=…&type=part&id=…` — the "Send to
 * labnoteo" button in partbank.
 *
 * Any web page can open an `obsidian://` URI, so this is treated as untrusted
 * input end to end. The parameters are validated before anything happens, the
 * `server` only *selects* a connection that is already configured (the key is
 * never sent to an address the URI supplies), and the item and where it will
 * be registered are shown for confirmation before a record is written.
 */
import { Notice } from 'obsidian';
import { isPartbankType, type PartbankType } from '@labnoteo/core';
import { isSameSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import type LabnotePlugin from '../main';
import { confirmModal, pickModal } from '../modals';
import { insertSampleReference } from '../sampleActions';
import { noticeForRegistration, registerPartbankItem, resolveSampleType } from './partbankRegister';

/** The protocol action this plugin answers. */
export const IMPORT_ACTION = 'labnoteo-import';

/** A `labnoteo-import` request that passed validation. */
export interface PartbankImportRequest {
  server: string;
  type: PartbankType;
  id: string;
}

/** partbank's ids are Mongo ObjectIds; anything else cannot be an item. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Read the URI parameters, or undefined when any of them is not what it
 * claims to be. Deliberately strict: this is the one entry point a web page
 * can reach.
 */
export function parseImportRequest(
  params: Record<string, string>
): PartbankImportRequest | undefined {
  const server = (params.server ?? '').trim();
  const type = (params.type ?? '').trim().toLowerCase();
  const id = (params.id ?? '').trim();
  if (!server || !isPartbankType(type) || !OBJECT_ID_RE.test(id)) return undefined;
  try {
    const { protocol } = new URL(server);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { server, type, id };
}

/**
 * Handle one `labnoteo-import` URI: fetch the item, confirm, register, and
 * either insert the reference at the cursor or put it on the clipboard.
 */
export async function handleImportUri(
  plugin: LabnotePlugin,
  params: Record<string, string>
): Promise<void> {
  const request = parseImportRequest(params);
  if (!request) {
    new Notice(plugin.t('That partbank link is not something labnoteo can read.'));
    return;
  }
  // The address is only matched against the configured ones; the call goes to
  // what is in settings, never to what the link said.
  const client = plugin.partbank.clientForOrigin(request.server);
  if (!client) {
    new Notice(
      plugin.t('That link points at a partbank that is not set up here ({0}).', request.server),
      8000
    );
    return;
  }

  let item;
  try {
    item = await client.getItem(request.type, request.id);
  } catch (err) {
    plugin.partbank.notifyError(err, client.kind);
    return;
  }

  const type = await resolveSampleType(plugin, item);
  if (!type) return;

  const folder = await pickImportFolder(plugin, item.name ?? item.kid ?? request.id, type);
  if (!folder) return;

  const result = await registerPartbankItem(plugin, client, item, { folder, type });
  if (!result) return;
  noticeForRegistration(plugin, result);
  await deliverReference(plugin, result.referenceText);
}

/**
 * Where the sample goes: this note's experiment, or Global. Shown rather than
 * assumed, since the user may not have the intended note open.
 */
async function pickImportFolder(
  plugin: LabnotePlugin,
  itemName: string,
  type: string
): Promise<string | undefined> {
  const local = plugin.localSampleFolder();
  const globalFolder = plugin.settings.globalSampleFolder;
  // Outside an experiment the local folder already *is* the global one.
  if (!globalFolder || isSameSampleFolder(local, globalFolder)) {
    const ok = await confirmModal(
      plugin.app,
      plugin.t('Register "{0}" from partbank as a {1} sample in {2}?', itemName, type, local),
      plugin.t('Register')
    );
    return ok ? local : undefined;
  }
  return pickModal(
    plugin.app,
    [
      { label: plugin.t('Local: {0}', local), value: local },
      { label: plugin.t('Global: {0}', globalFolder), value: globalFolder },
    ],
    { title: plugin.t('Register "{0}" from partbank as a {1} sample where?', itemName, type) }
  );
}

/** Put the reference where the user can use it. */
async function deliverReference(plugin: LabnotePlugin, referenceText: string): Promise<void> {
  const target = plugin.host.editTarget();
  if (target && plugin.sampleTrackingFor(target.path)) {
    const ok = await confirmModal(
      plugin.app,
      plugin.t('Insert {0} into the open note?', referenceText),
      plugin.t('Insert')
    );
    if (ok) {
      await insertSampleReference(plugin, target, referenceText);
      return;
    }
  }
  await navigator.clipboard.writeText(referenceText);
  new Notice(plugin.t('Copied {0} to the clipboard.', referenceText));
}
