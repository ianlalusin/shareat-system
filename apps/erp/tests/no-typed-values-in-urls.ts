/**
 * no-typed-values-in-urls.ts - the analyzer behind `no-typed-values-in-urls.test.ts` (T-380 S1a,
 * DEF-476, docs/tasks/380-no-typed-values-in-urls.md G1a / G1b / G2 / G3).
 *
 * Real TypeScript AST, modelled on `redirect-in-catch-sweep.ts`. Three rules over `apps/erp/src`:
 *
 *  G1a  `redirect` from `next/navigation` may only be called with a string literal, or a template
 *       whose literal parts contain no `?` or `&`. Nothing typed can ride in a URL built any other
 *       way. (A literal that spells a banner or refill key, `?error=...`, is flagged too: R1 moves
 *       ALL banner text out of the URL, fixed sentences included.)
 *  G1b  Every call to `redirectWithFlash` is `return await redirectWithFlash(...)` (REV-1), is made
 *       from inside a top-level exported action and not from a local function, arrow or wrapper
 *       (REV-10), is found through its import binding (an `as` alias, or a namespace import), and is
 *       never re-exported or aliased.
 *  G2   A `page.tsx` that reads a flash or keep key off its search params must have got them from
 *       `withFlash(...)`, not from the bare `searchParams`.
 *
 * Exemptions are NOT applied by `findingsForFile` / `findingsForSource`: a slice asserts that its own
 * files are clean with no PENDING cover. They are applied by `scanTree()`, which is what the tree test
 * and the stale-entry check (G3) use.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type Rule = 'G1a' | 'G1b' | 'G2';

export interface Finding {
  rule: Rule;
  /** Path relative to `apps/erp/src`, forward slashes (or whatever was passed to findingsForSource). */
  file: string;
  line: number;
  detail: string;
}

export const FLASH_KEYS = ['ok', 'error', 'warning', 'notice', 'confirm', 'plan', 'ran', 'failed', 'posted', 'needsConfirmation'] as const;
export const KEEP_KEYS = ['reason', 'refundAmount', 'refundAccountCode', 'writtenOffOn', 'inServiceOn', 'mode', 'openingDate', 'separationDate'] as const;
const BANNER_AND_REFILL = new Set<string>([...FLASH_KEYS, ...KEEP_KEYS]);

export const SRC_ROOT = resolve(__dirname, '..', 'src');

/** Pre-session redirects that keep `?error=` / `?next=` by design (spec N2). */
export const PRE_SESSION: readonly string[] = [
  'app/sign-in/actions.ts',
  'app/setup/actions.ts',
  'app/setup/page.tsx',
  'lib/session.ts',
  // Spec gap found by the tester: the sign-in PAGE redirects an already-signed-in visitor (a computed
  // `redirect(safeNext(...))` target) and reads the `preSessionMessage` banner from `?error=`. It is a
  // pre-session screen exactly like the actions beside it (N2), but the spec's list omits it.
  'app/sign-in/page.tsx',
];

/**
 * Not converted yet: every in-scope action file and page in the T-380 census (the BUILDER lists of
 * S2-S5), plus `app/items/**` (N1, another lane). S2-S5 do not edit this list; each slice's own
 * guard test asserts its files are clean. S6 cuts it down to `app/items/**`. An entry ending in `/**`
 * is a prefix.
 */
export const PENDING: readonly string[] = [
  // S4 carve-out (S4-R1): T-382 converts these
  'app/settings/pos-link/actions.ts', 'app/settings/pos-link/page.tsx',
  // S5
  'app/inventory/counts/actions.ts', 'app/inventory/deliveries/actions.ts', 'app/inventory/locations/actions.ts',
  'app/inventory/low-stock/actions.ts', 'app/inventory/pos-map/actions.ts', 'app/inventory/pos-usage/actions.ts',
  'app/inventory/production/actions.ts', 'app/inventory/returns/actions.ts', 'app/inventory/usage/actions.ts',
  'app/attendance/lane/actions.ts', 'app/attendance/terminals/actions.ts', 'app/attendance/[dayId]/actions.ts',
  'app/staff/actions.ts', 'app/staff/[employmentId]/credentials/actions.ts', 'app/wastage/actions.ts',
  'app/inventory/counts/page.tsx', 'app/inventory/counts/[id]/page.tsx', 'app/inventory/deliveries/page.tsx',
  'app/inventory/deliveries/[id]/page.tsx', 'app/inventory/locations/page.tsx', 'app/inventory/low-stock/page.tsx',
  'app/inventory/pos-map/page.tsx', 'app/inventory/pos-usage/page.tsx', 'app/inventory/production/page.tsx',
  'app/inventory/production/[id]/page.tsx', 'app/inventory/returns/page.tsx', 'app/inventory/usage/page.tsx',
  'app/inventory/usage/[id]/page.tsx', 'app/attendance/[dayId]/page.tsx', 'app/attendance/lane/page.tsx',
  'app/attendance/terminals/page.tsx', 'app/staff/page.tsx', 'app/staff/hire/page.tsx',
  'app/staff/[employmentId]/page.tsx', 'app/staff/[employmentId]/credentials/page.tsx', 'app/wastage/page.tsx',
  'app/wastage/[id]/page.tsx',
  // N1: another lane
  'app/items/**',
];

/** The one file that may call `redirect` with a query and re-export nothing. */
export const FLASH_HELPER = 'lib/flash.ts';

export function isPending(rel: string): boolean {
  return PENDING.some((p) => (p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : p === rel));
}

export function isExempt(rel: string): boolean {
  return rel === FLASH_HELPER || PRE_SESSION.includes(rel) || isPending(rel);
}

// ------------------------------------------------------------------------------------------------
// helpers

const FLASH_MODULE = /^(?:@\/lib\/flash|(?:\.{1,2}\/)+(?:lib\/)?flash)$/;

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

interface Bindings {
  /** Local names bound to the imported function. */
  names: Set<string>;
  /** Local names of `import * as ns` from the same module. */
  namespaces: Set<string>;
}

function bindingsFor(sf: ts.SourceFile, moduleMatches: (spec: string) => boolean, exportName: string[]): Bindings {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!moduleMatches(stmt.moduleSpecifier.text)) continue;
    const nb = stmt.importClause?.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    else for (const el of nb.elements) if (exportName.includes((el.propertyName ?? el.name).text)) names.add(el.name.text);
  }
  return { names, namespaces };
}

/** Is `callee` a call of one of the bound functions, directly or as `ns.fn`? */
function isBoundCallee(callee: ts.Expression, b: Bindings, exportName: string[]): boolean {
  const c = unwrap(callee);
  if (ts.isIdentifier(c)) return b.names.has(c.text);
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
    return b.namespaces.has(c.expression.text) && exportName.includes(c.name.text);
  }
  return false;
}

/** Every Identifier in `sf` that names a bound function but is not (the callee of a call | an import specifier). */
function aliasReferences(sf: ts.SourceFile, b: Bindings, exportName: string[]): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    const hit =
      (ts.isIdentifier(n) && b.names.has(n.text)) ||
      (ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        b.namespaces.has(n.expression.text) &&
        exportName.includes(n.name.text));
    if (hit) {
      const parent = n.parent;
      const isImportSpec = parent && (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent));
      const isCallee = parent && ts.isCallExpression(parent) && parent.expression === n;
      // `ns.fn` as the identifier-child of its own PropertyAccess is covered by the PropertyAccess case.
      const isNsChild = parent && ts.isPropertyAccessExpression(parent) && parent.expression === n;
      const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
      if (!isImportSpec && !isCallee && !isNsChild && !isMemberName && !(parent && ts.isExportSpecifier(parent))) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ------------------------------------------------------------------------------------------------
// G1a

function g1a(sf: ts.SourceFile, file: string, out: Finding[]): void {
  const nav = bindingsFor(sf, (s) => s === 'next/navigation', ['redirect', 'permanentRedirect']);
  if (nav.names.size === 0 && nav.namespaces.size === 0) return;
  const exportNames = ['redirect', 'permanentRedirect'];

  for (const ref of aliasReferences(sf, nav, exportNames)) {
    out.push({ rule: 'G1a', file, line: lineOf(sf, ref), detail: 'redirect referenced without being called (an alias hides the call from the guard)' });
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isBoundCallee(n.expression, nav, exportNames)) {
      const arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
      const line = lineOf(sf, n);
      if (!arg) {
        out.push({ rule: 'G1a', file, line, detail: 'redirect() with no argument' });
      } else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        const m = /[?&](\w+)=/.exec(arg.text);
        if (m && BANNER_AND_REFILL.has(m[1]!)) {
          out.push({ rule: 'G1a', file, line, detail: `literal redirect carries a banner/refill key (${m[1]}=)` });
        }
      } else if (ts.isTemplateExpression(arg)) {
        const parts = [arg.head.text, ...arg.templateSpans.map((s) => s.literal.text)];
        if (parts.some((p) => p.includes('?') || p.includes('&'))) {
          out.push({ rule: 'G1a', file, line, detail: 'template redirect builds a query string' });
        }
      } else {
        out.push({ rule: 'G1a', file, line, detail: `redirect() target is not a literal or a template (${ts.SyntaxKind[arg.kind]})` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ------------------------------------------------------------------------------------------------
// G1b

const FLASH_EXPORTS = ['redirectWithFlash'];

/** The nearest enclosing function-like of `node`, or undefined at module level. */
function enclosingFn(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isMethodDeclaration(cur)) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Is `fn` a top-level exported action: `export [async] function f`, `export default function`, or
 *  `export const f = [async] () => ...` at the file's top level? */
function isTopLevelExportedFn(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): boolean {
  if (ts.isFunctionDeclaration(fn)) {
    return fn.parent === sf && !!ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const decl = fn.parent;
    if (!decl || !ts.isVariableDeclaration(decl)) return false;
    const list = decl.parent;
    const stmt = list?.parent;
    return !!stmt && ts.isVariableStatement(stmt) && stmt.parent === sf && !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

function g1b(sf: ts.SourceFile, file: string, out: Finding[]): void {
  const fl = bindingsFor(sf, (s) => FLASH_MODULE.test(s), FLASH_EXPORTS);

  // Re-exports: no file but lib/flash.ts may re-export it (REV-10).
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) && FLASH_MODULE.test(stmt.moduleSpecifier.text)) {
      out.push({ rule: 'G1b', file, line: lineOf(sf, stmt), detail: 're-exports from the flash module' });
      continue;
    }
    if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (fl.names.has((el.propertyName ?? el.name).text)) {
          out.push({ rule: 'G1b', file, line: lineOf(sf, el), detail: 're-exports redirectWithFlash' });
        }
      }
    }
  }
  if (fl.names.size === 0 && fl.namespaces.size === 0) return;

  for (const ref of aliasReferences(sf, fl, FLASH_EXPORTS)) {
    out.push({ rule: 'G1b', file, line: lineOf(sf, ref), detail: 'redirectWithFlash referenced without being called (an alias hides the call from the guard)' });
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isBoundCallee(n.expression, fl, FLASH_EXPORTS)) {
      const line = lineOf(sf, n);
      // Walk up past parentheses to the AwaitExpression, then to the ReturnStatement.
      let up: ts.Node = n;
      while (up.parent && ts.isParenthesizedExpression(up.parent)) up = up.parent;
      const aw = up.parent;
      let ok = false;
      if (aw && ts.isAwaitExpression(aw)) {
        let top: ts.Node = aw;
        while (top.parent && ts.isParenthesizedExpression(top.parent)) top = top.parent;
        ok = !!top.parent && ts.isReturnStatement(top.parent);
      }
      if (!ok) {
        out.push({ rule: 'G1b', file, line, detail: 'redirectWithFlash must be `return await redirectWithFlash(...)`' });
      }
      const fn = enclosingFn(n);
      if (!fn || !isTopLevelExportedFn(fn, sf)) {
        out.push({ rule: 'G1b', file, line, detail: 'redirectWithFlash called outside a top-level exported action (local function, arrow, wrapper or module level)' });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ------------------------------------------------------------------------------------------------
// G2

function g2(sf: ts.SourceFile, file: string, out: Finding[]): void {
  const fl = bindingsFor(sf, (s) => FLASH_MODULE.test(s), ['withFlash']);
  const bare = new Set<string>(); // variables holding the bare, unflashed search params

  const isSearchParamsRef = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return (ts.isIdentifier(x) && x.text === 'searchParams') || (ts.isPropertyAccessExpression(x) && x.name.text === 'searchParams');
  };
  const awaitedBare = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return ts.isAwaitExpression(x) && isSearchParamsRef(x.expression);
  };

  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (awaitedBare(n.initializer)) {
        if (ts.isIdentifier(n.name)) bare.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const key = (el.propertyName ?? el.name) as ts.Node;
            if (ts.isIdentifier(key) && BANNER_AND_REFILL.has(key.text)) {
              out.push({ rule: 'G2', file, line: lineOf(sf, el), detail: `reads ${key.text} from the bare searchParams` });
            }
          }
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const keyOf = (n: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(n)) return n.name.text;
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const key = keyOf(n);
      if (key && BANNER_AND_REFILL.has(key)) {
        const target = unwrap(n.expression);
        const viaVar = ts.isIdentifier(target) && bare.has(target.text);
        const direct = awaitedBare(target);
        if (viaVar || direct) {
          out.push({ rule: 'G2', file, line: lineOf(sf, n), detail: `reads ${key} from the bare searchParams, not withFlash(searchParams)` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  void fl; // `withFlash` binding is what makes the other path clean; nothing to flag for it.
}

// ------------------------------------------------------------------------------------------------
// public API

/** Raw findings for a source string. `file` is the path used in findings and decides whether the G2
 *  (page.tsx) rule runs. No exemption is applied except the flash helper itself. */
export function findingsForSource(source: string, file: string): Finding[] {
  const norm = file.replace(/\\/g, '/');
  if (norm === FLASH_HELPER) return [];
  const sf = ts.createSourceFile(norm, source, ts.ScriptTarget.Latest, true, norm.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Finding[] = [];
  g1a(sf, norm, out);
  g1b(sf, norm, out);
  if (norm.endsWith('page.tsx')) g2(sf, norm, out);
  return out.sort((a, b) => a.line - b.line);
}

/** Raw findings for a file on disk (path absolute, or relative to `apps/erp/src`). */
export function findingsForFile(path: string): Finding[] {
  const abs = resolve(SRC_ROOT, path);
  const rel = relative(SRC_ROOT, abs).replace(/\\/g, '/');
  return findingsForSource(readFileSync(abs, 'utf8'), rel);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export interface TreeScan {
  filesScanned: number;
  /** Every finding, exempt or not. */
  all: Finding[];
  /** Findings in files that are neither PRE_SESSION, PENDING nor the flash helper: the ones that fail the build. */
  violations: Finding[];
  /** Files with findings, by exemption. */
  pendingWithFindings: string[];
  /** PENDING entries (not prefixes) that do not exist on disk. */
  missingPending: string[];
  /** PENDING files that exist but have zero findings: stale, red from S6 on (G3). */
  stalePending: string[];
}

export function scanTree(): TreeScan {
  const files = walk(SRC_ROOT);
  const all: Finding[] = [];
  const byFile = new Map<string, number>();
  for (const f of files) {
    const rel = relative(SRC_ROOT, f).replace(/\\/g, '/');
    const found = findingsForSource(readFileSync(f, 'utf8'), rel);
    byFile.set(rel, found.length);
    all.push(...found);
  }
  const violations = all.filter((f) => !isExempt(f.file));
  const pendingWithFindings = [...byFile].filter(([rel, n]) => n > 0 && isPending(rel)).map(([rel]) => rel);
  const missingPending = PENDING.filter((p) => !p.endsWith('/**') && !byFile.has(p));
  const stalePending = [...byFile].filter(([rel, n]) => n === 0 && isPending(rel) && (rel.endsWith('actions.ts') || rel.endsWith('page.tsx'))).map(([rel]) => rel);
  return { filesScanned: files.length, all, violations, pendingWithFindings, missingPending, stalePending };
}
