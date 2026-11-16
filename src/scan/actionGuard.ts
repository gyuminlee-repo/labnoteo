import { Notice } from 'obsidian';
import type { Translator } from '@labnoteo/core';

/**
 * Run a scan action started from a button or a file drop, where nothing awaits it: a failure
 * (a note that could not be read, say) is said in a notice instead of ending as an unhandled
 * rejection the user never sees.
 */
export async function guardScanAction(t: Translator, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error('[labnoteo] scan action failed:', err);
    new Notice(t('Command failed: {0}', err instanceof Error ? err.message : String(err)));
  }
}
