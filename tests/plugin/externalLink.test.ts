import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Notice, Platform } from '../stubs/obsidian';
import { openExternalLink } from '../../src/externalLink';

const t = (key: string, ...args: string[]): string => args.reduce((s, a, i) => s.replace(`{${i}}`, a), key);
const URL = 'partbank://open?type=part&id=507f1f77bcf86cd799439011';

describe('openExternalLink', () => {
  let openExternal: ReturnType<typeof vi.fn>;
  let windowOpen: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Notice.reset();
    Platform.isDesktopApp = true;
    openExternal = vi.fn().mockResolvedValue(undefined);
    windowOpen = vi.fn().mockReturnValue(null);
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { require: () => ({ shell: { openExternal } }), open: windowOpen });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Platform.isDesktopApp = true;
  });

  it('hands the link to Electron on desktop and says nothing when it opened', async () => {
    expect(await openExternalLink(URL, 'failed', t)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(URL);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
  });

  it('copies the link and tells the user when the system cannot open it', async () => {
    openExternal.mockRejectedValue(new Error('no handler'));
    expect(await openExternalLink(URL, 'failed', t)).toBe(false);
    expect(writeText).toHaveBeenCalledWith(URL);
    expect(Notice.shown).toEqual([`failed\nThe link was copied to the clipboard: ${URL}`]);
  });

  it('still shows the link when the clipboard refuses it', async () => {
    openExternal.mockRejectedValue(new Error('no handler'));
    writeText.mockRejectedValue(new Error('denied'));
    expect(await openExternalLink(URL, 'failed', t)).toBe(false);
    expect(Notice.shown).toEqual([`failed\n${URL}`]);
  });

  // Obsidian returns null from window.open even after handing the link to the browser.
  it('uses window.open on mobile and does not read null as a failure', async () => {
    Platform.isDesktopApp = false;
    expect(await openExternalLink('https://partbank.example/parts/1', 'failed', t)).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith('https://partbank.example/parts/1');
    expect(openExternal).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
  });

  it('falls back to window.open when require is not exposed', async () => {
    vi.stubGlobal('window', { open: windowOpen });
    expect(await openExternalLink(URL, 'failed', t)).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith(URL);
  });
});
