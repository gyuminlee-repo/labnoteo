/**
 * Front matter is YAML, not Markdown (Obsidian reads it as properties): a `## …` comment in it is
 * no heading. Every function that reads a note's lines for headings must leave it out, through
 * the shared helpers (`frontMatterLineCountOf`, `frontMatterLineCount`, `stripFrontMatter`,
 * `listHeadings`, `findSectionMatches`, `scanLines`, `asNote`), or say why it need not in a
 * `// front matter: …` comment just above or inside it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SOURCE_DIRS = ['src', 'packages/labnoteo-core/src', 'automation/src'];

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

const START =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(|^ {2}(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*(?!(?:for|if|while|switch|catch|return|function)\b)(\w+)\s*\([^)]*\)[^;]*\{\s*$/;
/** A heading pattern: a `^#…` regex or one of the shared heading regexes. */
const HEADING =
  /\^\(?#\{\d|\^\(?#\+|\^\(?##|\^\\s\*#|\bANY_HEADING_RE\b|\bHEADING_RE\b|\bBRACKET_HEADING_RE\b|\bUNIT_OP_HEADING_PATTERN\b|\bWORKFLOW_HEADING\w*\b|isWorkflowSectionHeading\(/;
/** Read line by line, or over the whole text. */
const LINES = /split\(\s*(?:\/\\r\?\\n\/|'\\n'|"\\n"|\/\(\?<=\\n\)\/)|\blines\b|matchAll|\.match\(|\/m\b|'m'\)/;
const SKIPS =
  /frontMatterLineCountOf|frontMatterLineCount|listHeadings\(|findSectionMatches\(|scanLines\(|asNote|stripFrontMatter|front matter:/;

/** `name` and line of each function of `source` that reads headings without leaving the front matter out. */
export function parsersMissingFrontMatter(file: string, source: string): string[] {
  const lines = source.split('\n');
  const starts: [number, string][] = [];
  lines.forEach((l, i) => {
    const m = START.exec(l);
    if (m) starts.push([i, m[1] || m[2] || m[3]]);
  });
  const out: string[] = [];
  starts.forEach(([s, name], k) => {
    const e = k + 1 < starts.length ? starts[k + 1][0] : lines.length;
    const code = lines
      .slice(s, e)
      .filter(l => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    const withComments = lines.slice(Math.max(0, s - 3), e).join('\n');
    if (HEADING.test(code) && LINES.test(code) && !SKIPS.test(withComments)) out.push(`${file}:${s + 1} ${name}`);
  });
  return out;
}

describe('parsers of note headings', () => {
  it('leave the front matter out, or say why they need not', () => {
    const found = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir))).flatMap(path =>
      parsersMissingFrontMatter(relative(ROOT, path), readFileSync(path, 'utf8'))
    );
    expect(found).toEqual([]);
  });

  it('the check finds a parser that reads the front matter, and passes one that skips it', () => {
    const reads = [
      'export function title(content: string) {',
      '  for (const line of content.split(/\\r?\\n/)) {',
      '    const m = /^##\\s+\\[(.*)\\]/.exec(line);',
      '    if (m) return m[1];',
      '  }',
      '}',
    ].join('\n');
    expect(parsersMissingFrontMatter('x.ts', reads)).toEqual(['x.ts:1 title']);
    const skips = reads.replace('content.split(/\\r?\\n/))', 'content.split(/\\r?\\n/).slice(frontMatterLineCountOf(lines)))');
    expect(parsersMissingFrontMatter('x.ts', skips)).toEqual([]);
    const exempt = `// front matter: reads a section body.\n${reads}`;
    expect(parsersMissingFrontMatter('x.ts', exempt)).toEqual([]);
  });
});
