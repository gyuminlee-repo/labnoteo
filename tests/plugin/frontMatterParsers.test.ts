/**
 * Front matter is YAML, not Markdown (Obsidian reads it as properties): a `## …` comment in it is
 * no heading. Every function that reads headings must leave it out, through the shared helpers
 * (`frontMatterLineCountOf`, `frontMatterLineCount`, `stripFrontMatter`, `listHeadings`,
 * `findSectionMatches`, `scanLines`, `asNote`), or say why it need not in a `// front matter: …`
 * comment just above or inside it.
 *
 * The check reads the source as TypeScript does: every heading pattern used anywhere (a regex
 * literal or `new RegExp` text starting `^…#`, a `startsWith('#…')`, or a name bound to one of
 * these) is put down to the functions around it, of whatever form (declaration, arrow, method,
 * object member), and one of them must skip the front matter or say why not.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
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

/** A pattern source that matches a heading line: `^`, an optional group or leading space, then `#`. */
const HEADING_SOURCE = /^\^(?:\(\?:|\()?(?:\\s\*|\\s\+|\\s\{0,3\}| \{0,3\}| \*|\[ \\t\]\*|\[ \\t\]\{0,3\})?(?:\(\?:|\()?\\?#/;
/** Names of shared heading patterns and predicates, used across files. */
const SHARED = /^(ANY_HEADING_RE|HEADING_RE|BRACKET_HEADING_RE|UNIT_OP_HEADING_PATTERN|WORKFLOW_HEADING\w*|isWorkflowSectionHeading)$/;
const SKIPS =
  /frontMatterLineCountOf|frontMatterLineCount|listHeadings\(|findSectionMatches\(|scanLines\(|asNote|stripFrontMatter|front matter:/;

function literalText(node: ts.Node): string | undefined {
  if (ts.isRegularExpressionLiteral(node)) return node.text.slice(1, node.text.lastIndexOf('/'));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

/** Whether `node` is itself a heading pattern: a regex, a `RegExp` text, or a `startsWith('#')`. */
function isHeadingPattern(node: ts.Node): boolean {
  if (ts.isRegularExpressionLiteral(node)) return HEADING_SOURCE.test(literalText(node) ?? '');
  // `new RegExp(…)` and `RegExp(…)` alike.
  if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText() === 'RegExp' && node.arguments?.[0]) {
    return HEADING_SOURCE.test(literalText(node.arguments[0]) ?? '');
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'startsWith') {
    return /^#/.test((node.arguments[0] && literalText(node.arguments[0])) ?? '');
  }
  return false;
}

type Fn = ts.FunctionLikeDeclaration;

function isFunction(node: ts.Node): node is Fn {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The node whose leading comment documents `fn`: its statement, member, or property. */
function owner(fn: Fn): ts.Node {
  let n: ts.Node = fn;
  while (
    n.parent &&
    (ts.isVariableDeclaration(n.parent) ||
      ts.isVariableDeclarationList(n.parent) ||
      ts.isVariableStatement(n.parent) ||
      ts.isPropertyAssignment(n.parent) ||
      ts.isPropertyDeclaration(n.parent) ||
      ts.isExportAssignment(n.parent) ||
      ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isSatisfiesExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

function nameOf(fn: Fn): string {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name.text;
  return '<anonymous>';
}

/** `fn`'s text with its leading comment. */
function withComment(fn: Fn, sf: ts.SourceFile): string {
  const o = owner(fn);
  const text = sf.getFullText();
  const notes = (ts.getLeadingCommentRanges(text, o.getFullStart()) ?? []).map(r => text.slice(r.pos, r.end));
  return [...notes, o.getText(sf)].join('\n');
}

/** `name` and line of each function of `source` that reads headings without leaving the front matter out. */
export function parsersMissingFrontMatter(file: string, source: string, shared: ReadonlySet<string> = new Set()): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Names bound at module scope to a heading pattern (here or exported elsewhere): their uses are
  // heading reads too. A binding inside a function holds a pattern used there, found as such.
  const names = new Set([...shared, ...modulePatternNames(sf, false)]);

  const flagged = new Map<Fn, string>();
  const visit = (node: ts.Node): void => {
    const use =
      isHeadingPattern(node) ||
      (ts.isIdentifier(node) && (names.has(node.text) || SHARED.test(node.text)) && !(node.parent && ts.isVariableDeclaration(node.parent) && node.parent.name === node) && !(node.parent && (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent))));
    if (use) {
      const chain: Fn[] = [];
      for (let p = node.parent; p; p = p.parent) if (isFunction(p)) chain.push(p);
      // A pattern bound at module scope is a definition; its uses inside functions are read.
      if (chain.length > 0 && !chain.some(fn => SKIPS.test(withComment(fn, sf)))) {
        const outer = chain[chain.length - 1];
        const line = sf.getLineAndCharacterOfPosition(outer.getStart(sf)).line + 1;
        if (!flagged.has(outer)) flagged.set(outer, `${file}:${line} ${nameOf(outer)} (${node.getText(sf).slice(0, 60)})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(flagged.values())];
}

/** Names a module-scope `const` of `sf` binds to a heading pattern (only exported ones with `exported`). */
function modulePatternNames(sf: ts.SourceFile, exported: boolean): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (exported && !st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      let found = false;
      const look = (n: ts.Node): void => {
        if (found || isFunction(n)) return;
        if (isHeadingPattern(n)) found = true;
        else ts.forEachChild(n, look);
      };
      if (d.initializer) look(d.initializer);
      if (found && ts.isIdentifier(d.name)) out.push(d.name.text);
    }
  }
  return out;
}

/** Names exported as heading patterns by any source file, so their uses elsewhere count. */
function sharedPatternNames(files: readonly string[]): Set<string> {
  return new Set(
    files.flatMap(path => modulePatternNames(ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), true))
  );
}

describe('parsers of note headings', () => {
  it('leave the front matter out, or say why they need not', () => {
    const files = SOURCE_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir)));
    const shared = sharedPatternNames(files);
    const found = files.flatMap(path => parsersMissingFrontMatter(relative(ROOT, path), readFileSync(path, 'utf8'), shared));
    expect(found).toEqual([]);
  });

  describe('the check finds a parser of any form that reads the front matter', () => {
    const forms: [string, string][] = [
      ['declaration', 'export function title(content: string) {\n  for (const line of content.split(/\\r?\\n/)) {\n    const m = /^##\\s+\\[(.*)\\]/.exec(line);\n    if (m) return m[1];\n  }\n}'],
      ['typed arrow', 'export const title: (content: string) => string | undefined = content =>\n  content.split(/\\r?\\n/).find(line => /^##\\s/.test(line));'],
      ['class method', 'class Note {\n  title(content: string) {\n    return content.split(/\\r?\\n/).find(line => line.startsWith("## "));\n  }\n}'],
      ['object method', 'export const reader = {\n  title(content: string) {\n    return content.split(/\\r?\\n/).find(line => new RegExp(`^#{1,6}\\\\s`).test(line));\n  },\n};'],
      ['named pattern', 'const H2 = /^## /;\nexport const title = (content: string) => content.split("\\n").find(l => H2.test(l));'],
      ['RegExp called', 'export function title(content: string) {\n  return content.split("\\n").find(line => RegExp("^#{1,6}\\\\s").test(line));\n}'],
      ['local pattern, exec', 'export function title(content: string) {\n  const re = /^#{1,6}\\s+(.*)/;\n  for (const line of content.split("\\n")) { const m = re.exec(line); if (m) return m[1]; }\n}'],
      ['named pattern, match', 'const H = /^#+\\s/;\nexport function title(content: string) {\n  return content.split("\\n").find(line => line.match(H));\n}'],
      ['whole text, matchAll', 'const H = /^#{2}\\s(.*)$/gm;\nexport function titles(content: string) {\n  return [...content.matchAll(H)].map(m => m[1]);\n}'],
      ['whole text, search', 'export function firstAt(content: string) {\n  return content.search(/^#\\s/m);\n}'],
      ['whole text, replace', 'export function drop(content: string) {\n  return content.replace(/^#+ .*$/gm, "");\n}'],
    ];
    it.each(forms)('%s', (_form, reads) => {
      expect(parsersMissingFrontMatter('x.ts', reads)).toHaveLength(1);
      const skips = reads.replace('content.', 'stripFrontMatter(content).');
      expect(skips).not.toBe(reads);
      expect(parsersMissingFrontMatter('x.ts', skips)).toEqual([]);
      const exempt = reads.replace('content.', '/* front matter: reads a section body. */ content.');
      expect(parsersMissingFrontMatter('x.ts', exempt)).toEqual([]);
    });
  });

  it('names the declaration and its line', () => {
    const reads = 'const a = 1;\n\nexport const title: (c: string) => string | undefined = c =>\n  c.split("\\n").find(l => /^##\\s/.test(l));';
    expect(parsersMissingFrontMatter('x.ts', reads)).toEqual(['x.ts:3 title (/^##\\s/)']);
  });

  it('takes a comment above the next function as that function\'s only', () => {
    const two = 'function a(c: string) {\n  return /^## /.test(c);\n}\n// front matter: one line.\nfunction b(c: string) {\n  return /^## /.test(c);\n}';
    expect(parsersMissingFrontMatter('x.ts', two)).toEqual(['x.ts:1 a (/^## /)']);
  });
});
