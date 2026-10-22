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
      .onClick(() => openInPartbank(plugin, source))
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
export function openInPartbank(plugin: LabnotePlugin, source: SampleSource): void {
  if (source.connection === 'web') {
    const origin = plugin.partbank.url('web') || source.origin;
    window.open(`${origin.replace(/\/+$/, '')}${webAppPath(source)}`);
    return;
  }
  if (!Platform.isDesktopApp) {
    new Notice(plugin.t('This sample is linked to the partbank app on another PC.'));
    return;
  }
  openCustomScheme(desktopAppLink(source));
}

/** Electron's shell, when the plugin runs in the desktop app. */
interface ElectronShell {
  shell?: { openExternal(url: string): Promise<void> };
}

/**
 * Hand a link Obsidian does not route itself (a scheme other than http) to the
 * operating system. Electron's shell takes it directly; `window.open` is the
 * fallback for builds where `require` is not exposed.
 */
function openCustomScheme(url: string): void {
  const load = (window as Window & { require?: (module: string) => ElectronShell }).require;
  const shell = load?.('electron').shell;
  if (shell) void shell.openExternal(url);
  else window.open(url);
}
