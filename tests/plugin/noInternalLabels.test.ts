/**
 * Review rounds named cases L1 to L5; those names mean nothing to a reader of the code. A comment,
 * test name or test string says what the case is instead ("a value over several lines", "the
 * unwritable-ID warning"). Data that happens to read L1 (a passage `L1-L6`, a location `'L1'`)
 * is no such name and is not refused.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const DIRS = ['src', 'packages/labnoteo-core/src', 'tests'];

// An L1 to L5 name used as a reference: in brackets, before a colon, after an article, before
// the word naming what it is, or closing a list in brackets.
const LABEL =
  /\(L[1-5]\)|\bL[1-5]:|\b(?:the|an?|no|is|it is)\s+L[1-5]\b|\bL[1-5]\s+(?:warning|allowance|write refusal|one)\b|[,:]\s*L[1-5]\)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.ts$/.test(name) ? [p] : [];
  });
}

describe('no internal case names', () => {
  it('tells a case name from data', () => {
    for (const named of [
      '// where the value is writable (L2), whatever',
      '// L1: the last `- [` line',
      " * with the L2 warning.",
      "  it.each(endings)('reassignCopiedId fails without the L2 warning (%s)'",
      "  ['ensureId', 'literal', 'LF', 'none', 'L2 write refusal', '{}'],",
      '// sequence, L2). Under a key',
      '// Under an empty value it is L2 (noteIdDashItem.test.ts).',
      ' * (over several lines: L2) and reads as an ID',
    ])
      expect(LABEL.test(named), named).toBe(true);
    for (const data of [
      "'title: WT100 Micro-scale Parallel Cell Culture 톨루엔 계대 L1-L6',",
      "['L1', '(1)', '(0.03)'],",
      "{ alias: 'a', location: 'L1' }",
      "expect(slash?.to).toBe('WT100 Micro-scale Parallel Cell Culture L1 L5');",
    ])
      expect(LABEL.test(data), data).toBe(false);
  });

  it('finds none in the sources and tests', () => {
    // This file holds the names above as samples.
    const found = DIRS.flatMap(d => files(join(ROOT, d)))
      .filter(f => f !== __filename)
      .flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(ROOT, f)}:${i + 1}` }))
        .filter(({ line }) => LABEL.test(line))
        .map(({ at }) => at)
    );
    expect(found).toEqual([]);
  });
});
