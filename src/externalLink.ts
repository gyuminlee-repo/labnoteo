import { Notice, Platform } from 'obsidian';

interface ElectronModule {
  shell?: { openExternal(url: string): Promise<void> };
}

function electronShell(): ElectronModule['shell'] {
  if (!Platform.isDesktopApp) return undefined;
  const load = (window as Window & { require?: (module: string) => ElectronModule }).require;
  try {
    return load?.('electron').shell;
  } catch {
    return undefined;
  }
}

/**
 * Open a link outside Obsidian: an http(s) page in the browser, another scheme
 * (`partbank://`) in the app registered for it. Resolves false when it failed.
 *
 * On desktop Electron's shell takes the link and rejects when the system has
 * nothing to open it with, which `window.open` swallows. Obsidian answers
 * `window.open` of an outside link with null even when it worked, so null is
 * not read as a failure. On failure the link goes to the clipboard so it can
 * still be opened by hand.
 */
export async function openExternalLink(
  url: string,
  failure: string,
  t: (key: string, ...args: string[]) => string
): Promise<boolean> {
  try {
    const shell = electronShell();
    if (shell) await shell.openExternal(url);
    else window.open(url);
    return true;
  } catch (err) {
    console.warn('[labnoteo] could not open', url, err);
  }
  try {
    await navigator.clipboard.writeText(url);
    new Notice(`${failure}\n${t('The link was copied to the clipboard: {0}', url)}`);
  } catch {
    new Notice(`${failure}\n${url}`);
  }
  return false;
}
