/**
 * T-374 S2 / DEF-577 - the scanner behind `tests/unit/t374-s2-no-utc-today.test.ts`.
 *
 * `findUtcToday(source)` is PURE: a string in, findings out. Helper precedent:
 * `tests/unit/lib/throw-census.ts` (a real `ts.createSourceFile` walk, no `describe`/`it` of its own, so
 * importing it into more than one test file never registers a suite twice).
 *
 * Two kinds of finding:
 *   - `current`  : a date taken from a CURRENT instant in a UTC or server-local calendar. Never allowed.
 *       `new Date()` / `new Date(Date.now())` / a parameter named `now` / a LOCAL `const x = new Date()`,
 *       then `.toISOString()` chained to `.slice`/`.split`/`.substring`, or `.getFullYear/Month/Date()`,
 *       or `.getUTCFullYear/Month/Date()` (R2 + R2-review).
 *   - `extract`  : a calendar date lifted out of ANY other instant by `.toISOString().slice(0, 7|10|16)`
 *       (also `.substring(0, 7|10)` and `.split('T')`). Legitimate for a `Date.UTC(...)`-built date, wrong for
 *       a stored instant shown to a person; the allowlist decides which.
 *   - `offset`   : the hard-coded Manila offset `8 * 3_600_000`. Correct today; ratcheted so no new one appears.
 *
 * STATED BLIND SPOTS (the spec's R2 limit, kept honest):
 *   - a `new Date()` passed INTO a helper that calls `getUTC*` on its own parameter
 *     (`statutory-discounts/page.tsx` `monthBounds(d)`) is invisible to a shape scan;
 *   - an instant stringified first (`const iso = new Date().toISOString(); iso.slice(0, 10)`) is invisible;
 *   - a bare `new Date().toISOString()` with no date extraction is NOT flagged: it is a timestamp, which is
 *     correct (`api/health/route.ts`).
 */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type FindingKind = 'current' | 'extract' | 'offset';

export interface UtcTodayFinding {
  line: number;
  kind: FindingKind;
  text: string;
}

const CURRENT_METHODS = new Set([
  'getFullYear',
  'getMonth',
  'getDate',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
]);
const EXTRACTORS = new Set(['slice', 'substring', 'substr', 'split']);

/** `new Date()` or `new Date(Date.now())`. Anything else (`new Date(Date.now() + 8 * 3_600_000)`) is not "now". */
function isCurrentConstructor(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isNewExpression(e) || e.expression.getText() !== 'Date') return false;
  const args = e.arguments ?? [];
  if (args.length === 0) return true;
  if (args.length !== 1) return false;
  const a = args[0]!;
  return (
    ts.isCallExpression(a) &&
    a.arguments.length === 0 &&
    ts.isPropertyAccessExpression(a.expression) &&
    a.expression.getText() === 'Date.now'
  );
}

/** Walk up from an identifier to its nearest binding: a parameter (current iff named `now`) or a local const/let/var. */
function identifierIsCurrent(id: ts.Identifier): boolean {
  const name = id.text;
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return name === 'now';
      }
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
      for (const st of n.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return d.initializer !== undefined && isCurrentConstructor(d.initializer);
          }
        }
      }
    }
  }
  return false;
}

function isCurrentInstant(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (isCurrentConstructor(e)) return true;
  return ts.isIdentifier(e) && identifierIsCurrent(e);
}

const isIntLit = (n: ts.Node | undefined, v: number): boolean =>
  !!n && ts.isNumericLiteral(n) && Number(n.text.replace(/_/g, '')) === v;

/** `<x>.toISOString().<slice|substring|split>(...)` -> the extractor call, or null. */
function dateExtraction(call: ts.CallExpression): { receiver: ts.Expression; narrow: boolean } | null {
  // call is the EXTRACTOR call: <recv>.toISOString().slice(0, 10)
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (!EXTRACTORS.has(call.expression.name.text)) return null;
  const inner = call.expression.expression;
  if (!ts.isCallExpression(inner) || !ts.isPropertyAccessExpression(inner.expression)) return null;
  if (inner.expression.name.text !== 'toISOString') return null;
  const m = call.expression.name.text;
  const a = call.arguments;
  let narrow = false;
  if (m === 'split') narrow = a.length === 1 && ts.isStringLiteral(a[0]!) && a[0]!.text === 'T';
  else narrow = a.length === 2 && isIntLit(a[0], 0) && (isIntLit(a[1], 7) || isIntLit(a[1], 10) || isIntLit(a[1], 16));
  return { receiver: inner.expression.expression, narrow };
}

function isManilaOffset(b: ts.BinaryExpression): boolean {
  return (
    b.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    isIntLit(b.left, 8) &&
    ts.isNumericLiteral(b.right) &&
    Number(b.right.text.replace(/_/g, '')) === 3_600_000
  );
}

export function findUtcToday(source: string, fileName = 'fixture.ts'): UtcTodayFinding[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: UtcTodayFinding[] = [];
  const add = (n: ts.Node, k: FindingKind) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    out.push({ line, kind: k, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 90) });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const ex = dateExtraction(n);
      if (ex) {
        if (isCurrentInstant(ex.receiver)) add(n, 'current');
        else if (ex.narrow) add(n, 'extract');
      } else if (
        ts.isPropertyAccessExpression(n.expression) &&
        CURRENT_METHODS.has(n.expression.name.text) &&
        isCurrentInstant(n.expression.expression)
      ) {
        add(n, 'current');
      }
    } else if (ts.isBinaryExpression(n) && isManilaOffset(n)) {
      add(n, 'offset');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

/** Every non-test `.ts`/`.tsx` file under `dir`, repo-relative with forward slashes. */
export function sourceFiles(repoRoot: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'tests') continue;
      const a = join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(r);
    }
  };
  walk(join(repoRoot, dir), dir);
  return out.sort();
}

export function scanTree(repoRoot: string, dir: string): Map<string, UtcTodayFinding[]> {
  const out = new Map<string, UtcTodayFinding[]>();
  for (const f of sourceFiles(repoRoot, dir)) {
    const found = findUtcToday(readFileSync(join(repoRoot, f), 'utf8'), f);
    if (found.length) out.set(f, found);
  }
  return out;
}
