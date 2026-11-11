/**
 * A note write's result is `true`, `false` or `'uncertain'` (may or may not be in), so reading
 * it as a boolean counts a maybe as done. Every result of the writing functions must be
 * compared, not taken as truthy: `if (await write(…))`, `if (written)`, `if (!written)`,
 * `!!written`, `written ? …`, `written &&`, `+= written` are refused here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SOURCE_DIRS = ['src', 'packages/labnoteo-core/src'];
const WRITERS = [
  'processNoteThroughVault',
  'processNoteThroughVaultOnDisk',
  'processOrCreateNote',
  'processNoteStamped',
  'processInOpenEditor',
  'processInOpenEditorOnDisk',
  'writeInOpenEditor',
].join('|');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

/** Index just past the `)` closing the `(` at `open`. */
function pastClose(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return i + 1;
  }
  return source.length;
}

/** Writers whose result may also be `'kept'` (in the editor only), which is not on disk. */
const KEEPING = /^(?:processNoteThroughVaultOnDisk|processInOpenEditorOnDisk|writeInOpenEditor)$/;

/** `file:line` of each result taken as truthy in `source`. */
export function truthyWriteResults(file: string, source: string): string[] {
  const found: string[] = [];
  const call = `await\\s+(?:[\\w.]+\\.)?(${WRITERS})\\(`;
  // The call itself as a condition or operand, unless its result in parentheses is compared.
  const direct = new RegExp(`(?:\\bif\\s*\\(\\s*!?\\s*|!!\\s*|&&\\s*|\\|\\|\\s*)(\\(\\s*)?${call}`, 'g');
  for (const m of source.matchAll(direct)) {
    if (m[1] !== undefined) {
      const wrapped = m.index! + m[0].search(/await\s/) - m[1].length;
      if (/^\s*[!=]==/.test(source.slice(pastClose(source, wrapped)))) continue;
    }
    found.push(`${file}:${lineOf(source, m.index!)}`);
  }
  // The result bound to a name, then that name read as truthy in the same function, before
  // `'uncertain'` (and, for a writer that keeps, `'kept'`) were compared away.
  const bound = new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*(?::[^=;]+)?=\\s*${call}`, 'g');
  for (const m of source.matchAll(bound)) {
    const name = m[1];
    const handled = (before: string): boolean =>
      new RegExp(`\\b${name}\\s*[!=]==\\s*'uncertain'`).test(before) &&
      (!KEEPING.test(m[2]) || new RegExp(`\\b${name}\\s*[!=]==\\s*'kept'`).test(before));
    const start = m.index! + m[0].length;
    const next = source.slice(start).search(/\n(?:export |async |function |\s{2}(?:private |public |protected |async )+\w+\()/);
    const rest = source.slice(start, next < 0 ? undefined : start + next);
    const use = new RegExp(
      `\\bif\\s*\\(\\s*!?${name}\\s*\\)|!!${name}\\b|(?<![\\w.'"])${name}\\s*\\?(?![.?])|(?<![\\w.'"])${name}\\s*(?:&&|\\|\\|)|(?:&&|\\|\\|)\\s*!?${name}\\b(?!\\s*(?:===|!==|\\.))|\\+=\\s*${name}\\b`,
      'g'
    );
    for (const u of rest.matchAll(use)) {
      if (!handled(rest.slice(0, u.index!))) found.push(`${file}:${lineOf(source, start + u.index!)}`);
    }
  }
  return found;
}

describe('note write results', () => {
  it('are compared, never read as truthy', () => {
    const found = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir))).flatMap(path =>
      truthyWriteResults(relative(ROOT, path), readFileSync(path, 'utf8'))
    );
    expect(found).toEqual([]);
  });

  it('the check finds each truthy form, and passes compared ones', () => {
    const bad = [
      'if (await processNoteThroughVault(app, host, p, f)) n++;',
      'if (!(await processOrCreateNote(app, host, p, f))) return;',
      'const changed = await processNoteThroughVault(app, host, p, f);\nif (changed) n++;',
      'const w = await this.processNoteStamped(p, f);\nreturn w ? 1 : 0;',
      'const w = await processInOpenEditor(app, file, f);\nok = ok && w;',
      'let w = await processNoteThroughVault(app, host, p, f);\ncount += w;',
      "const w = await processNoteThroughVaultOnDisk(app, host, p, f);\nif (w === 'uncertain') return;\nif (!w) return;",
    ];
    for (const src of bad) expect(truthyWriteResults('x.ts', src), src).not.toEqual([]);
    const good = [
      "const w = await processNoteThroughVault(app, host, p, f);\nif (w === true) n++;\nelse if (w === 'uncertain') warn();",
      'if ((await processNoteThroughVault(app, host, p, f)) === true) n++;',
      'const w = await processNoteThroughVault(app, host, p, f);\nreturn said(w);',
      "const w = await processNoteThroughVault(app, host, p, f);\nif (w === 'uncertain') return;\nif (!w) return;",
      'if ((await processNoteThroughVault(app, host, p, f)) !== false) return;',
    ];
    for (const src of good) expect(truthyWriteResults('x.ts', src), src).toEqual([]);
  });
});
