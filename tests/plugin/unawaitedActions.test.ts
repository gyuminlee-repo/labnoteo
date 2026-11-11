/**
 * A user action (a button, a menu item, a setting, a command, a DOM event) whose work no one
 * awaits must say its failure: through `run` (the plugin's or a feature's), `guardScanAction`,
 * `sayFailure`/`logFailure`, or a `catch` of its own. Otherwise a failed read or write ends as an
 * unhandled rejection the user never sees. The check reads the source with TypeScript's type
 * checker: in every function handed to an event registration or a command property, each call
 * that returns a promise (or whose type is not known) must be caught, and so must every
 * `void <promise>` anywhere. A `// unawaited: …` comment on the line or the line above says why
 * one need not.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Notice } from '../stubs/obsidian';
import { sayFailure, logFailure } from '../../src/unawaited';

const ROOT = join(__dirname, '..', '..');

/** Methods and properties that take a handler the user's action calls, unawaited. */
const HANDLERS = /^(onClick|onChange|onSubmit|addEventListener|registerDomEvent|setOnClick|callback|checkCallback|editorCallback|editorCheckCallback|onChooseItem|onChooseSuggestion|selectSuggestion)$/;
/** Calls that take a promise (or the function making it) and say its rejection. */
const CATCHERS = /^(run|guardScanAction|sayFailure|logFailure)$/;

const isFunction = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

const calleeName = (call: ts.CallExpression): string =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';

/** `file:line what` of each user action of `sf` that may reject unsaid. */
export function unsaidRejections(checker: ts.TypeChecker, sf: ts.SourceFile, file = sf.fileName): string[] {
  const out: string[] = [];
  const lines = sf.getFullText().split('\n');
  const at = (n: ts.Node, what: string): void => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    if ([lines[line], lines[line - 1] ?? ''].some(l => /\/\/ unawaited: \S/.test(l))) return;
    out.push(`${file}:${line + 1} ${what}`);
  };
  /** Whether `e` gives a promise: its type has `then`; 'unknown' when its type is not known. */
  const promise = (e: ts.Expression): boolean | 'unknown' => {
    const t = checker.getTypeAtLocation(e);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'unknown';
    // A promise, not a builder with a `then` of its own (Obsidian's components have one).
    return (t.isUnion() ? t.types : [t]).some(
      p => /^(Promise|PromiseLike)$/.test(p.getSymbol()?.getName() ?? '') || (!!checker.getPropertyOfType(p, 'then') && !!checker.getPropertyOfType(p, 'catch'))
    );
  };
  /**
   * Whether the value of a call of unknown type is used as a promise would be: awaited, returned,
   * dropped with `void`, chained, or an arrow's whole body. A bare statement call of unknown type
   * is taken for a plain method call.
   */
  const used = (e: ts.Expression): boolean => {
    const p = e.parent;
    return ts.isAwaitExpression(p) || ts.isReturnStatement(p) || ts.isVoidExpression(p) || ts.isPropertyAccessExpression(p) || (ts.isArrowFunction(p) && p.body === e);
  };
  /** Whether the promise `e` gives is caught where it is. */
  const caught = (e0: ts.Expression, fn: ts.Node): boolean => {
    // Through a choice or parentheses, to where the value goes.
    let e: ts.Expression = e0;
    while (ts.isConditionalExpression(e.parent) || ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent)) e = e.parent as ts.Expression;
    const parent = e.parent;
    // `e.catch(…)`; `e.then(…)` or `e.finally(…)`, a promise judged itself.
    if (ts.isPropertyAccessExpression(parent) && parent.expression === e && ts.isCallExpression(parent.parent)) {
      if (parent.name.text === 'catch') return true;
      if (parent.name.text === 'then' || parent.name.text === 'finally') return true;
    }
    // Handed to a call that says it, or into another promise (judged itself).
    if (ts.isCallExpression(parent) && parent.arguments.includes(e)) return CATCHERS.test(calleeName(parent)) || promise(parent) === true;
    if (ts.isArrayLiteralExpression(parent)) return true;
    // Awaited inside a `try` with a `catch`, within the handler.
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent) || ts.isVariableDeclaration(parent)) {
      for (let p: ts.Node = parent; p && p !== fn; p = p.parent) {
        if (ts.isTryStatement(p.parent) && p.parent.tryBlock === p && p.parent.catchClause) return true;
      }
    }
    return false;
  };
  /** Whether a `.catch(…)` stands in the chain `e` ends (`p.then(…).catch(…).finally(…)`). */
  const chainCatches = (e: ts.Expression): boolean => {
    for (let x: ts.Expression = e; ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression); x = x.expression.expression) {
      if (x.expression.name.text === 'catch') return true;
    }
    return false;
  };
  const handler = (fn: ts.ArrowFunction | ts.FunctionExpression, what: string): void => {
    const visit = (n: ts.Node): void => {
      if (n !== fn && isFunction(n)) return;
      if (
        ts.isCallExpression(n) &&
        !CATCHERS.test(calleeName(n)) &&
        !(ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then' && n.arguments.length >= 2) &&
        !chainCatches(n) &&
        (promise(n) === true || (promise(n) === 'unknown' && used(n))) &&
        !caught(n, fn)
      ) {
        at(n, `${what}: ${n.getText(sf).slice(0, 50).replace(/\s+/g, ' ')}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HANDLERS.test(n.expression.name.text)) {
      for (const a of n.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) handler(a, `${n.expression.name.text} handler`);
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && HANDLERS.test(n.name.text) && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      handler(n.initializer, n.name.text);
    }
    // A promise dropped with `void`, anywhere.
    if (ts.isVoidExpression(n) && !ts.isLiteralExpression(n.expression) && promise(n.expression) !== false && !caught(n.expression, sf)) {
      if (ts.isCallExpression(n.expression) && CATCHERS.test(calleeName(n.expression))) return ts.forEachChild(n, visit);
      if (!chainCatches(n.expression)) {
        at(n, `void ${n.expression.getText(sf).slice(0, 50).replace(/\s+/g, ' ')}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The project as tsconfig.json makes it, for its type checker. */
function projectProgram(): ts.Program {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  return ts.createProgram(parsed.fileNames.filter(f => /\/src\//.test(f)), parsed.options);
}

/** A program of one fixture file, with `save()` and `say()` declared. */
function fixture(source: string): { checker: ts.TypeChecker; sf: ts.SourceFile } {
  const name = join(ROOT, 'x.ts');
  const text = `declare function save(): Promise<void>; declare function say(e: unknown): void; declare function go(): Promise<number>;
declare function run(f: () => Promise<unknown>): void; declare const b: { onClick(f: () => unknown): void };
declare const el: { addEventListener(t: string, f: () => unknown): void };\n${source}`;
  const host = ts.createCompilerHost({ strict: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'] });
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v) => (f === name ? ts.createSourceFile(f, text, v, true) : get(f, v));
  const program = ts.createProgram([name], { strict: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], noLib: false }, host);
  return { checker: program.getTypeChecker(), sf: program.getSourceFile(name)! };
}
const check = (source: string): string[] => {
  const { checker, sf } = fixture(source);
  return unsaidRejections(checker, sf, 'x.ts').map(l => l.replace(/^x\.ts:(\d+)/, (_m, n) => `x.ts:${Number(n) - 3}`));
};

describe('user actions no one awaits', () => {
  it('say their failure, or say why they need not', () => {
    const program = projectProgram();
    const checker = program.getTypeChecker();
    const found = program
      .getSourceFiles()
      .filter(sf => sf.fileName.startsWith(join(ROOT, 'src')) && !/\.(test|d)\.ts$/.test(sf.fileName))
      .flatMap(sf => unsaidRejections(checker, sf, relative(ROOT, sf.fileName)));
    expect(found).toEqual([]);
  });

  it('the check finds every form of a dropped promise, and passes caught or explained ones', () => {
    expect(check('b.onClick(async () => { await save(); });')).toEqual(['x.ts:1 onClick handler: save()']);
    expect(check('b.onClick(async () => { return save(); });')).toEqual(['x.ts:1 onClick handler: save()']);
    expect(check('b.onClick(async () => save());')).toEqual(['x.ts:1 onClick handler: save()']);
    expect(check('b.onClick(() => save());')).toEqual(['x.ts:1 onClick handler: save()']);
    expect(check('b.onClick(() => { save().then(() => 1); });')).toEqual(['x.ts:1 onClick handler: save().then(() => 1)']);
    expect(check('el.addEventListener("click", () => void save());')).toEqual(['x.ts:1 addEventListener handler: save()', 'x.ts:1 void save()']);
    expect(check('const c = { callback: async () => { await go(); } };')).toEqual(['x.ts:1 callback: go()']);
    expect(check('b.onClick(async () => { try { await save(); } catch (e) { say(e); } });')).toEqual([]);
    expect(check('b.onClick(() => run(() => save()));')).toEqual([]);
    expect(check('b.onClick(() => void save().catch(say));')).toEqual([]);
    expect(check('b.onClick(() => save().then(() => 1, say));')).toEqual([]);
    expect(check('b.onClick(() => void save().catch(say).finally(() => 1));')).toEqual([]);
    expect(check('b.onClick(() => say(1));')).toEqual([]);
    expect(check('// unawaited: a refresh, which catches inside.\nb.onClick(() => void save());')).toEqual([]);
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
