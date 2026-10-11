/**
 * Obsidian-side i18n: build a {@link Translator} from the plugin's Korean
 * catalog via the shared {@link createTranslator} primitive from core.
 *
 * {@link obsidianKo} is the single source of Korean strings for this plugin.
 * (It previously merged over a copy of the VS Code extension's
 * `l10n/bundle.l10n.ko.json`, but that bundle was almost entirely VS Code-only
 * keys; the handful actually used here were folded into `l10n.ko.ts`.) English
 * is the identity locale — keys are the English source strings by convention.
 */
import { getLanguage } from 'obsidian';
import { createTranslator, type Translator } from '@labnoteo/core';
import obsidianKo from './l10n.ko';

/** Resolve Obsidian's active UI language (e.g. 'en', 'ko'). */
export function getObsidianLanguage(): string {
  try {
    // getLanguage() exists from Obsidian 1.8.7; the localStorage key it
    // replaced is no longer kept current, so it is only a fallback.
    if (typeof getLanguage === 'function') return getLanguage();
    return window.localStorage.getItem('language') ?? 'en';
  } catch {
    return 'en';
  }
}

/** Build a {@link Translator} appropriate for the current Obsidian locale. */
export function createObsidianTranslator(lang = getObsidianLanguage()): Translator {
  if (lang.toLowerCase().split('-')[0] === 'ko') {
    return createTranslator(obsidianKo);
  }
  return createTranslator();
}
