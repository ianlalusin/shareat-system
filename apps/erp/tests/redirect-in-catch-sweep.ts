/**
 * redirect-in-catch-sweep.ts — the analyzer behind `redirect-in-catch-sweep.test.ts`.
 *
 * The shape this looks for: a server action calls `redirect(...)` (Next.js `next/navigation`),
 * directly or through a locally-defined wrapper (e.g. `back()`), from INSIDE a `try` block whose
 * `catch` does not tell a real error apart from `redirect()`'s own control-flow signal. Next's
 * `redirect()` works by THROWING a special "NEXT_REDIRECT" digest that must propagate uncaught all
 * the way up for the framework to act on it — a `catch` sitting in the way intercepts that throw
 * exactly like any other error and reports it as one (T-344/DEF-422, `createMissingClosedPeriodAction`
 * — confirmed on screen: a successful write, followed by a "NEXT_REDIRECT" banner instead of the
 * intended success message).
 *
 * A `catch` is SAFE from this if it either:
 *   - calls `isRedirectError(...)` (Next's own way to tell the signal apart from a real error), or
 *   - re-throws the caught error unconditionally (`throw <the catch binding>;`), directly or nested
 *     one level inside an `if`.
 * Anything else — including this codebase's common `back({ error: ... })` catch, which is safe ONLY
 * because nothing in the corresponding `try` block ever calls `redirect`/`back` on its own success
 * path — is flagged the moment the try block DOES call a redirecting function.
 *
 * Real TypeScript AST (`typescript`), not text/regex — same choice `touch-target-geometry.ts` made
 * and for the same reason: brace-counting or line-scanning cannot reliably tell "inside this specific
 * try block" from "inside the file somewhere", and a wrapper like `back()` needs real call-graph
 * reachability (which local functions eventually call `redirect`), not a literal string match.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface RedirectInCatchFinding {
  /** The exported/named function the try/catch lives in ('(anonymous)' if it cannot be named). */
  functionName: string;
  /** 1-based line of the `try` keyword. */
  line: number;
  /** The redirect-reaching identifier actually called inside the try block. */
  via: string;
}

/** True if `node`'s subtree contains a CallExpression whose callee is the bare identifier `name`
 *  (`name(...)`) — not `x.name(...)`, which is a different function under an unrelated import. */
function containsCallTo(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The LOCAL names of every redirect-reaching import in this file, or `[]` if it has none (the whole
 *  analysis is a no-op for those files): the `next/navigation` `redirect` (handles a rename via
 *  `redirect as foo`) AND, from T-380 S1a, `redirectWithFlash` from the flash module. Once every action
 *  moves to the flash helper, no action file imports `next/navigation` at all, so a sweep rooted only
 *  there would silently check nothing - the flash import is a second root (REV-10). */
function importedRedirectNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const exportName =
      spec === 'next/navigation' ? 'redirect' : /^(?:@\/lib\/flash|(?:\.{1,2}\/)+(?:lib\/)?flash)$/.test(spec) ? 'redirectWithFlash' : undefined;
    if (!exportName) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === exportName) names.push(el.name.text);
      }
    }
  }
  return names;
}

interface LocalFn {
  name: string;
  body: ts.Node;
}

/** Every top-level `function name(...) {}` and `const name = (...) => {}` / `function expr` in the
 *  file — the only shapes a local `back()`-style wrapper is written as here. */
function topLevelFunctions(sourceFile: ts.SourceFile): LocalFn[] {
  const fns: LocalFn[] = [];
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      fns.push({ name: stmt.name.text, body: stmt.body });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          fns.push({ name: decl.name.text, body: decl.initializer.body });
        }
      }
    }
  }
  return fns;
}

/** Fixed-point over the file's own top-level functions: which ones call `redirect` themselves, or
 *  call another function that (transitively) does. */
function functionsReachingRedirect(fns: LocalFn[], redirectNames: string[]): Set<string> {
  const reaches = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of fns) {
      if (reaches.has(fn.name)) continue;
      if (redirectNames.some((r) => containsCallTo(fn.body, r))) {
        reaches.add(fn.name);
        changed = true;
        continue;
      }
      for (const already of reaches) {
        if (containsCallTo(fn.body, already)) {
          reaches.add(fn.name);
          changed = true;
          break;
        }
      }
    }
  }
  return reaches;
}

/** Walks up from `node` to the nearest enclosing named function/arrow, for a readable finding. */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    cur = cur.parent;
  }
  return '(anonymous)';
}

/** A catch clause is safe from the redirect-signal shape iff it calls `isRedirectError(...)`, or
 *  unconditionally re-throws its own caught binding (directly, or nested one `if` deep — the only
 *  shapes a defensive rethrow is written as in this codebase). */
function isSafeCatch(catchClause: ts.CatchClause): boolean {
  const paramName =
    catchClause.variableDeclaration && ts.isIdentifier(catchClause.variableDeclaration.name)
      ? catchClause.variableDeclaration.name.text
      : undefined;
  let safe = false;
  const visit = (n: ts.Node): void => {
    if (safe) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'isRedirectError') {
      safe = true;
      return;
    }
    if (ts.isThrowStatement(n) && paramName && n.expression) {
      let expr: ts.Expression = n.expression;
      while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isIdentifier(expr) && expr.text === paramName) {
        safe = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  if (catchClause.block) visit(catchClause.block);
  return safe;
}

/** Every `try { ...redirect-reaching call... } catch (...) { ...no isRedirectError/rethrow... }`
 *  shape in one source file. `[]` for a file that never imports `redirect` at all. */
export function findUnsafeRedirectInCatch(source: string, fileNameForParsing = 'file.ts'): RedirectInCatchFinding[] {
  const sourceFile = ts.createSourceFile(fileNameForParsing, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const roots = importedRedirectNames(sourceFile);
  if (roots.length === 0) return [];

  const reaches = functionsReachingRedirect(topLevelFunctions(sourceFile), roots);
  const redirectingNames = [...roots, ...reaches];

  const findings: RedirectInCatchFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause) {
      const via = redirectingNames.find((name) => containsCallTo(node.tryBlock, name));
      if (via && !isSafeCatch(node.catchClause)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ functionName: enclosingFunctionName(node), line: line + 1, via });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function findUnsafeRedirectInCatchForFile(filePath: string): RedirectInCatchFinding[] {
  return findUnsafeRedirectInCatch(readFileSync(filePath, 'utf8'), filePath);
}
