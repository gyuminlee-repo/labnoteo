/**
 * Locale selection and the Korean catalog. English is the identity locale — a
 * key IS its English string — so the only way an English regression shows up is
 * a lookup that returns something other than the key itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getObsidianLanguage, createObsidianTranslator, bilingualName } from '../../src/i18n';
import obsidianKo from '../../src/l10n.ko';
import { __setGetLanguage } from '../stubs/obsidian';

/** Fake just enough of `window` for `localStorage.getItem('language')`. */
const stubLanguage = (value: string | null): void => {
  vi.stubGlobal('window', { localStorage: { getItem: () => value } });
};

afterEach(() => {
  vi.unstubAllGlobals();
  __setGetLanguage(undefined);
});

describe('getObsidianLanguage', () => {
  it("uses Obsidian's getLanguage() even when localStorage has no language (#32)", () => {
    __setGetLanguage(() => 'ko');
    stubLanguage(null);
    expect(getObsidianLanguage()).toBe('ko');
  });

  it('prefers getLanguage() over a stale localStorage value', () => {
    __setGetLanguage(() => 'ko');
    stubLanguage('en');
    expect(getObsidianLanguage()).toBe('ko');
  });

  // The cases below run without getLanguage, as on Obsidian before 1.8.7.

  it('reads the language Obsidian persists in localStorage', () => {
    stubLanguage('ko');
    expect(getObsidianLanguage()).toBe('ko');
  });

  it("defaults to 'en' when the key is unset", () => {
    stubLanguage(null);
    expect(getObsidianLanguage()).toBe('en');
  });

  it("defaults to 'en' when there is no window at all (mobile/test harness)", () => {
    // No stub installed: the bare `window` reference throws and is caught.
    expect(getObsidianLanguage()).toBe('en');
  });
});

describe('createObsidianTranslator', () => {
  it('translates a known key into Korean', () => {
    const t = createObsidianTranslator('ko');
    expect(t('Create experiment')).toBe(obsidianKo['Create experiment']);
    expect(t('Create experiment')).not.toBe('Create experiment');
  });

  it('treats a region-tagged Korean code as Korean', () => {
    const t = createObsidianTranslator('ko-KR');
    expect(t('Create experiment')).toBe(obsidianKo['Create experiment']);
  });

  it('returns the key verbatim for English', () => {
    const t = createObsidianTranslator('en');
    expect(t('Create experiment')).toBe('Create experiment');
  });

  it('falls back to the key for a locale with no catalog', () => {
    const t = createObsidianTranslator('fr');
    expect(t('Create experiment')).toBe('Create experiment');
  });

  it('falls back to the key when Korean has no entry for it', () => {
    const t = createObsidianTranslator('ko');
    expect(t('An untranslated string')).toBe('An untranslated string');
  });

  it('substitutes positional placeholders in both locales', () => {
    expect(createObsidianTranslator('en')('Sample added: {0}', 'DNA-1')).toBe(
      'Sample added: DNA-1'
    );
    expect(createObsidianTranslator('ko')('Sample added: {0}', 'DNA-1')).toContain('DNA-1');
  });

  it('defaults its locale from the running Obsidian instance', () => {
    stubLanguage('ko');
    expect(createObsidianTranslator()('Create experiment')).toBe(obsidianKo['Create experiment']);
  });
});

describe('bilingualName', () => {
  it('appends the English key to the Korean name so either language finds the command', () => {
    expect(bilingualName(createObsidianTranslator('ko'), 'Create experiment')).toBe(
      `${obsidianKo['Create experiment']} (Create experiment)`
    );
  });

  it('shows the English name alone in English', () => {
    expect(bilingualName(createObsidianTranslator('en'), 'Create experiment')).toBe('Create experiment');
  });

  it('shows the key alone when Korean has no entry for it', () => {
    expect(bilingualName(createObsidianTranslator('ko'), 'An untranslated string')).toBe(
      'An untranslated string'
    );
  });
});

describe('Korean catalog', () => {
  it('has no empty translations, which would render as a blank UI label', () => {
    const blank = Object.entries(obsidianKo)
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k);
    expect(blank).toEqual([]);
  });

  it('keeps every placeholder the English key declares', () => {
    const placeholders = (s: string): string[] => (s.match(/\{\d+\}/g) ?? []).sort();
    const mismatched = Object.entries(obsidianKo)
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  // Notices, confirmations and setting descriptions are plain text, so a
  // backtick shows as itself instead of marking code (#273).
  it('has no Markdown backticks, which plain-text notices show as they are', () => {
    const listsTheCharacter = (key: string): boolean => key.startsWith('An alias cannot contain');
    const withBackticks = Object.entries(obsidianKo)
      .filter(([key, value]) => value.includes('`') && !listsTheCharacter(key))
      .map(([key]) => key);
    expect(withBackticks).toEqual([]);
  });

  it('uses the particle that fits a quoted label filled in at runtime', () => {
    const t = createObsidianTranslator('ko');
    const label = t('Process existing files too');
    const hasFinalConsonant = (word: string): boolean => {
      const code = word.charCodeAt(word.length - 1) - 0xac00;
      return code >= 0 && code <= 11171 && code % 28 !== 0;
    };
    const object = hasFinalConsonant(label) ? '을' : '를';
    expect(
      t('{0} file(s) that were already in the folder when it was set are skipped. Read them with "{1}".', '2', label)
    ).toContain(`"${label}"${object} `);
    expect(
      t(
        'Files that were already in the folder when it was set are skipped. Read them with "{0}", or set the folder again to take what is in it now as the starting point.',
        label
      )
    ).toContain(`"${label}"${object} `);
  });
});
