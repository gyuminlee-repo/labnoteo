/**
 * The partbank entries of the sample context menu and the definition dialog:
 * refresh where a sample is kept, and show it in partbank.
 *
 * Both appear only for a sample that carries a link, so a vault that never
 * touched partbank sees the menus it always did.
 */
import { Menu, Notice, Platform } from 'obsidian';
import { desktopAppLink, webAppPath, type SampleSource } from '@labnoteo/core';
import type { SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import type LabnotePlugin from '../main';
import { refreshOneLocation } from './partbankLocation';
import { openExternalLink } from '../externalLink';

/** The sample a partbank action works on. */
export interface PartbankSampleRef {
  type: string;
  id: string;
  folder: string;
  record: SampleRecord;
}

/** Add the partbank items to a sample's context menu, if it has a link. */
export function addPartbankMenuItems(
  menu: Menu,
  plugin: LabnotePlugin,
  sample: PartbankSampleRef
): void {
  const source = sample.record.source;
  if (!source) return;
  menu.addItem(item =>
    item
      .setTitle(plugin.t('Refresh storage location from partbank'))
      .setIcon('refresh-cw')
      .onClick(() => void refreshOneLocation(plugin, sample))
  );
  menu.addItem(item =>
    item
      .setTitle(plugin.t('Open in partbank'))
      .setIcon('external-link')
      .onClick(() => void openInPartbank(plugin, source))
  );
}

/**
 * Show an item in partbank.
 *
 * The web app opens in the browser. The desktop app cannot be reached that
 * way — its no-login session secret is only readable inside its own window, so
 * a browser would land on a login screen — so it is asked through its own
 * `partbank://` scheme, which also starts the app when it is closed.
 */
export async function openInPartbank(plugin: LabnotePlugin, source: SampleSource): Promise<void> {
  if (source.connection === 'web') {
    const origin = plugin.partbank.url('web') || source.origin;
    await openExternalLink(
      `${origin.replace(/\/+$/, '')}${webAppPath(source)}`,
      plugin.t('Could not open partbank in the browser.'),
      plugin.t
    );
    return;
  }
  if (!Platform.isDesktopApp) {
    new Notice(plugin.t('This sample is linked to the partbank app on another PC.'));
    return;
  }
  await openExternalLink(
    desktopAppLink(source),
    plugin.t('Could not open the partbank app. If it is installed, start it once so that it registers its links.'),
    plugin.t
  );
}
