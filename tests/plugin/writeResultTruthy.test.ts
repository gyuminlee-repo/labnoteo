/**
 * A note write's result is `true`, `false` or `'uncertain'` (may or may not be in), so reading
 * it as a boolean counts a maybe as done. Every result of the writing functions must be
 * compared, not taken as truthy: `if (await write(…))`, `if (written)`, `if (!written)`,
 * `!!written`, `written ? …`, `written &&`, `+= written` are refused here, the result bound
 * where it is declared or assigned later. The writers are the functions below and every one
 * declared to resolve to `NoteWritten` or `NoteWrittenOnDisk`.
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
];

/**
 * The functions and methods `source` declares to resolve to a write result: `name(…):
 * Promise<NoteWritten>`, with `keeping` those whose result may be `'kept'` (`NoteWrittenOnDisk`).
 */
export function declaredWriters(source: string): { writers: string[]; keeping: string[] } {
  const writers: string[] = [];
  const keeping: string[] = [];
  for (const m of source.matchAll(/\)\s*:\s*Promise<\s*(NoteWritten(?:OnDisk)?)\s*>/g)) {
    let depth = 0;
    let i = m.index!;
    for (; i >= 0; i--) {
      if (source[i] === ')') depth++;
      else if (source[i] === '(' && --depth === 0) break;
    }
    const name = /(\w+)\s*(?:<[^<>]*>)?\s*$/.exec(source.slice(Math.max(0, i - 200), i))?.[1];
    if (!name || name === 'function') continue;
    writers.push(name);
    if (m[1] === 'NoteWrittenOnDisk') keeping.push(name);
  }
  return { writers, keeping };
}

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
const KEEPING = ['processNoteThroughVaultOnDisk', 'processInOpenEditorOnDisk', 'writeInOpenEditor'];

/** `file:line` of each result taken as truthy in `source`. */
export function truthyWriteResults(
  file: string,
  source: string,
  writers: readonly string[] = WRITERS,
  keepingWriters: readonly string[] = KEEPING
): string[] {
  const found: string[] = [];
  const keeping = new Set(keepingWriters);
  const call = `await\\s+(?:[\\w.]+\\.)?(${[...new Set(writers)].join('|')})\\(`;
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
  // `const w = await …`, `let w: T = await …`, and `w = await …` for a name declared before.
  const bound = new RegExp(`(?<![\\w.])(\\w+)\\s*(?::[^=;()]+)?(?<![=!<>])=(?!=)\\s*${call}`, 'g');
  for (const m of source.matchAll(bound)) {
    const name = m[1];
    const handled = (before: string): boolean =>
      new RegExp(`\\b${name}\\s*[!=]==\\s*'uncertain'`).test(before) &&
      (!keeping.has(m[2]) || new RegExp(`\\b${name}\\s*[!=]==\\s*'kept'`).test(before));
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
    const sources = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir))).map(path => ({
      path: relative(ROOT, path),
      text: readFileSync(path, 'utf8'),
    }));
    const declared = sources.map(f => declaredWriters(f.text));
    const writers = [...WRITERS, ...declared.flatMap(d => d.writers)];
    const keeping = [...KEEPING, ...declared.flatMap(d => d.keeping)];
    // The writers declared include those listed: the declarations are read as meant.
    expect(declared.flatMap(d => d.writers)).toEqual(expect.arrayContaining(['processNoteThroughVault', 'processOrCreateNote', 'processNoteStamped']));
    const found = sources.flatMap(f => truthyWriteResults(f.path, f.text, writers, keeping));
    expect(found).toEqual([]);
  });

  it('finds a result assigned apart from its declaration, and a writer known only by its declared type', () => {
    expect(truthyWriteResults('x.ts', 'let w;\nw = await processNoteThroughVault(app, host, p, f);\nif (w) n++;')).not.toEqual([]);
    expect(truthyWriteResults('x.ts', "let w;\nw = await processNoteThroughVault(app, host, p, f);\nif (w === 'uncertain') return;\nif (w) n++;")).toEqual([]);
    const own = 'async function saveIt(path: string, change: (s: string) => string): Promise<NoteWritten> {\n  return x;\n}\n';
    const mine = declaredWriters(own);
    expect(mine.writers).toEqual(['saveIt']);
    const use = `${own}async function go() {\n  if (await saveIt(p, f)) n++;\n}\n`;
    expect(truthyWriteResults('x.ts', use, [...WRITERS, ...mine.writers])).not.toEqual([]);
    expect(truthyWriteResults('x.ts', use)).toEqual([]);
    const kept = 'class A {\n  async keepIt(p: string): Promise<NoteWrittenOnDisk> {\n    return x;\n  }\n}\n';
    expect(declaredWriters(kept)).toEqual({ writers: ['keepIt'], keeping: ['keepIt'] });
    const keptUse = "async function go() {\n  const w = await a.keepIt(p);\n  if (w === 'uncertain') return;\n  if (!w) return;\n}\n";
    expect(truthyWriteResults('x.ts', keptUse, ['keepIt'], ['keepIt'])).not.toEqual([]);
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
