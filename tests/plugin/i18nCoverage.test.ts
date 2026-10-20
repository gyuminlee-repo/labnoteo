/**
 * Every literal handed to a translator (`t('…')`, `host.t('…')`, `this.t('…')`,
 * `this.paletteName('…')`) must have a Korean entry: a missing key silently renders the English source
 * in the Korean UI, which the catalog checks in `i18n.test.ts` cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import obsidianKo from '../../src/l10n.ko';

const ROOT = join(__dirname, '..', '..');
const SOURCE_DIRS = ['src', 'packages/labnoteo-core/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) && name !== 'l10n.ko.ts') {
      out.push(path);
    }
  }
  return out;
}

const unescape = (s: string): string =>
  s.replace(/\\(n|t|\\|'|"|`)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** Translator keys written as a single string literal (template literals with `${…}` are skipped). */
function translatorKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /\b(?:t|paletteName)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g;
  for (const m of source.matchAll(re)) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    keys.push(unescape(m[2]));
  }
  return keys;
}

describe('translatorKeys', () => {
  it('reads plain, escaped and multi-line calls', () => {
    const src = `host.t('A'); this.t("B {0}", x); t(\n  'C\\'s'\n); t(\`D\`); t(\`E \${x}\`); tt('F'); this.paletteName('G');`;
    expect(translatorKeys(src)).toEqual(['A', 'B {0}', "C's", 'D', 'G']);
  });
});

describe('Korean catalog coverage', () => {
  it('has an entry for every translator key used in the plugin and core', () => {
    const catalog = obsidianKo as Record<string, string>;
    const missing = new Set<string>();
    let scanned = 0;
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const key of translatorKeys(readFileSync(file, 'utf8'))) {
          scanned++;
          if (!(key in catalog)) missing.add(`${relative(ROOT, file)}: ${key}`);
        }
      }
    }
    // A scanner that silently matched nothing would pass the check below.
    expect(scanned).toBeGreaterThan(400);
    expect([...missing]).toEqual([]);
  });
});
