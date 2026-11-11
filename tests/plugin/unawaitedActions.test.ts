/**
 * A user action (a button, a menu item, a setting, a command, a DOM event) whose work no one
 * awaits must say its failure: through `run` (the plugin's or a feature's), `guardScanAction`,
 * or a `catch` of its own. Otherwise a failed read or write ends as an unhandled rejection the
 * user never sees. The check reads the source as TypeScript does: every `async` function handed
 * to an event registration or a command property, and every `void <promise>` statement, must
 * catch, or say why it need not in a `// unawaited: …` comment on its line or the line above.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Notice } from '../stubs/obsidian';
import { sayFailure, logFailure } from '../../src/unawaited';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Methods and properties that take a handler the user's action calls, unawaited. */
const HANDLERS = /^(onClick|onChange|onSubmit|addEventListener|registerDomEvent|setOnClick|callback|checkCallback|editorCallback|editorCheckCallback|onChooseItem|onChooseSuggestion|selectSuggestion)$/;
/** Calls that catch a rejection and say it. */
const CATCHES = /\b(run|guardScanAction|catch|sayFailure|logFailure)\(/;

function exempt(sf: ts.SourceFile, node: ts.Node): boolean {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.getFullText().split('\n');
  return [lines[line], lines[line - 1] ?? ''].some(l => /\/\/ unawaited: \S/.test(l));
}

/** Whether an async function's body catches what it awaits: its statements in one try with a catch. */
function bodyCatches(fn: ts.FunctionLikeDeclaration): boolean {
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return CATCHES.test(body.getText());
  return body.statements.length > 0 && body.statements.every(st => (ts.isTryStatement(st) && !!st.catchClause) || !/\bawait\b/.test(st.getText()));
}

/** `file:line what` of each user action that may reject unsaid. */
export function unsaidRejections(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node, what: string): void => {
    if (!exempt(sf, n)) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${what}`);
  };
  const isAsyncFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
    (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !!n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
  const visit = (n: ts.Node): void => {
    // An async handler passed to an event registration, or set as a command's callback.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HANDLERS.test(n.expression.name.text)) {
      for (const a of n.arguments) if (isAsyncFn(a) && !bodyCatches(a)) at(a, `async ${n.expression.name.text} handler`);
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && HANDLERS.test(n.name.text) && isAsyncFn(n.initializer) && !bodyCatches(n.initializer)) {
      at(n.initializer, `async ${n.name.text}`);
    }
    // A promise dropped with `void`: fine when it is caught on the spot.
    if (ts.isVoidExpression(n) && !ts.isLiteralExpression(n.expression) && !CATCHES.test(n.expression.getText())) {
      at(n, `void ${n.expression.getText().slice(0, 50).replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('user actions no one awaits', () => {
  it('say their failure, or say why they need not', () => {
    const found = sourceFiles(join(ROOT, 'src')).flatMap(path => unsaidRejections(relative(ROOT, path), readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the check finds an async handler and a dropped promise, and passes caught or explained ones', () => {
    expect(unsaidRejections('x.ts', 'b.onClick(async () => { await save(); });')).toEqual(['x.ts:1 async onClick handler']);
    expect(unsaidRejections('x.ts', 'el.addEventListener("click", () => void save());')).toEqual(['x.ts:1 void save()']);
    expect(unsaidRejections('x.ts', 'menu.onClick(() => void this.flag(file));')).toEqual(['x.ts:1 void this.flag(file)']);
    expect(unsaidRejections('x.ts', 'const c = { callback: async () => { await go(); } };')).toEqual(['x.ts:1 async callback']);
    expect(unsaidRejections('x.ts', 'b.onClick(async () => { try { await save(); } catch (e) { say(e); } });')).toEqual([]);
    expect(unsaidRejections('x.ts', 'b.onClick(() => this.run(() => save()));')).toEqual([]);
    expect(unsaidRejections('x.ts', 'el.on("x", () => void save().catch(say));')).toEqual([]);
    expect(unsaidRejections('x.ts', '// unawaited: a refresh, which catches inside.\nel.on("x", () => void refresh());')).toEqual([]);
  });
});

describe('sayFailure and logFailure', () => {
  it('say a failed action in a notice, and log a failed background task, rejecting nothing', async () => {
    const before = Notice.shown.length;
    sayFailure(async () => {
      throw new Error('EACCES registry.json');
    });
    sayFailure(Promise.reject(new Error('EACCES README.labnote.md')));
    const logged: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args[0]);
    logFailure('sample sync', Promise.reject(new Error('EBUSY')));
    await new Promise(r => setTimeout(r, 0));
    console.error = error;
    expect(Notice.shown.slice(before).map(m => m.replace(/^.*?:\s*/, ''))).toEqual(['EACCES registry.json', 'EACCES README.labnote.md']);
    expect(logged).toContain('[labnoteo] sample sync failed:');
  });
});
