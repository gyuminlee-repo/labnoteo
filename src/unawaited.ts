import { Notice } from 'obsidian';
import { createObsidianTranslator } from './i18n';
import { NoteSwitchedError } from './obsidianHost';

/**
 * Work a user action starts and no one awaits (a button, a menu item, a setting, a command):
 * its failure is said in a notice, as `run` says a command's, instead of ending as an unhandled
 * rejection the user never sees. Takes the promise, or the async function to start.
 */
export function sayFailure(action: Promise<unknown> | (() => Promise<unknown>)): void {
  let started: Promise<unknown>;
  try {
    started = typeof action === 'function' ? action() : action;
  } catch (err) {
    started = Promise.reject(err);
  }
  started.catch((err: unknown) => {
    // The note was switched under the action: said as it is, nothing changed.
    if (err instanceof NoteSwitchedError) {
      new Notice(err.message);
      return;
    }
    console.error('[labnoteo] action failed:', err);
    new Notice(createObsidianTranslator()('Command failed: {0}', err instanceof Error ? err.message : String(err)));
  });
}

/**
 * Work started in the background (a timer, a vault event, a view refresh) and not awaited: a
 * failure is logged with what it was, not left as an unhandled rejection. No notice, as the user
 * did nothing just then; the next run of the same work tries again.
 */
export function logFailure(what: string, task: Promise<unknown>): void {
  task.catch((err: unknown) => console.error(`[labnoteo] ${what} failed:`, err));
}
