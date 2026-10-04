/**
 * T-371 S0 — the NaN census as code. `docs/tasks/371-nan-sweep.md` §S0 ("The census as code, red first").
 *
 * Keyed on the COLUMN, not on how a value is read (§"Why T-327 and T-328 missed sites"): the constrained numeric columns are
 * derived at runtime from the Drizzle schema (`getTableConfig`), every write that targets one is found with the TypeScript
 * type checker anywhere in `packages/**`, `apps/**` and `scripts/**`, and each write's argument property is asked whether it
 * carries a branded `Decimal` (`__decimal`). There is no list of spellings to go stale.
 *
 * Pure `fs` + the TypeScript compiler API + drizzle's table metadata. The library never shells out to grep or git and has no
 * `describe`/`it` of its own (importing it from several test files must never re-register a suite — see `document-facts.ts`).
 *
 * Four instruments, one per guard leg (each is proved able to FAIL by `t371-census-selftest.test.ts`):
 *   G1 `findWrites()` / `findRawSqlWriters()` — every (write × constrained column) pair and whether its argument property is branded;
 *                                              bulk inserts (`.values([…])`, `.values(rows.map(…))`, array-typed args) are unwrapped to
 *                                              their element rows; targets the checker cannot resolve are COUNTED (`unresolved`) so a
 *                                              new split chain / computed key / aliased table fails closed.
 *   G2 `findComparisons()`    — relational comparisons on a value that derives from a (possibly nullable) string, followed through
 *                               helpers, `Math.*`, `||`/`??`/ternaries, `await`, destructuring and `const` aliases.
 *   G3 `findForgeries()`      — type assertions onto a brand, or onto a container of one (`Money[]`, `Record<string, Money>`,
 *                               `{ amount: Money }`), outside `packages/core/src`.
 *   G4 `finiteCheckGaps(cols)`— numeric columns with no `*_finite_check` (takes the column list so its mutant is not a tautology).
 * plus `schemaNumericOccurrences()` for the step-0 reconciliation of the `numeric(` count against the column count.
 *
 * ⚠️ What the raw-SQL detector does NOT judge (said plainly, so a green leg is never read as more than it is): SQL built from plain strings, string
 * concatenation or `.unsafe('…')` (no template literal), and the parameters of the SECOND AND LATER rows of a multi-row `values (…), (…)` or of an
 * `insert … select` — such a statement is still RECORDED as a writer (so it must be registered) but only its first row's parameters are checked.
 * Table identifiers interpolated as schema tables (`update ${tradeOrders} set …`) ARE resolved; other dynamic names are enumerated in the guard.
 *
 * ⚠️ Scope note (L9): `scripts/*.mjs` / `*.js` are NOT compiled, so the type checker never sees them; `rawScriptWriters()` reads them
 * as text and the guard fails if any writes a constrained table. `scripts/*.ts` ARE in the program.
 *
 * SPEC VS MEASURED — first recorded at HEAD c49a407 (2026-10-03), approved by the orchestrator; the figures marked (v2) are what the
 * hardened instrument measures after the audit (H1/H2/M3/M4 widened it). The guard, not this comment, is the measure from now on:
 *
 *   columns            spec 160 / 65 tables / 110 keys / nine shapes      measured the same (107 x (14,2), 27 x (14,3), 9 x (4,2),
 *                                                                         7 x (14,4), 4 x (8,4), 3 x (14,6), one each (5,2) (6,3) (6,2))
 *   finite checks      spec 160 of 160                                    measured 160 of 160 (G4 is green; shown red only by its mutant)
 *   `numeric(` in schema   spec 170                                       measured 184 = 160 pgTable columns + 12 pgView column
 *                                                                         definitions + 12 `::numeric(14,2)` view casts (views.ts); the
 *                                                                         reviewer's 119 (14,2) = 107 + the 12 casts
 *   write sites        spec 155 in repo/ (151 Drizzle + 4 raw)            v1 measured 159 Drizzle sites = 158 in packages/db/src/repo
 *                                                                         across 41 files + 1 outside (domain production/index.ts
 *                                                                         reverseOwnLayer); raw SQL 4 in repo/items.ts (+ 4 in
 *                                                                         scripts/dev-seed-inventory.ts, exempt: dev-only seed). v1
 *                                                                         MISSED every bulk insert (trade.ts:180, sales-days.ts:668/:717,
 *                                                                         stock-usage.ts:92, production.ts:109): see the (v2) numbers in
 *                                                                         the hand-off.
 *   comparisons        spec 152 (local-spelling scan)                     v1 108 under the first checker (domain only); v2 widens the
 *                                                                         derivation and the scope. Different methods, deliberately NOT
 *                                                                         reconciled to 152
 *   forgeries          spec 6 `as Money` + 7+ `as Quantity`               v1 16 = 6 as Money + 10 as Quantity (including the mint
 *                                                                         stock/quantity.ts:71 and :94 and packages/etl/src/audit/compare.ts:99)
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { PgDialect, PgNumeric, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../packages/db/schema';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const norm = (f: string) => f.split(sep).join('/');
const rel = (f: string) => norm(relative(ROOT, f));

// -----------------------------------------------------------------------------------------------
// A. The columns
// -----------------------------------------------------------------------------------------------

export interface NumericColumn {
  /** The schema export name of the table (`moneyAccounts`). */
  tableExport: string;
  /** The SQL table name (`money_accounts`). */
  table: string;
  /** The TypeScript key (`overdraftLimit`) — how a writer spells it. */
  key: string;
  /** The SQL column name. */
  sqlName: string;
  /** `'14,2'` — precision,scale, as the brand literal spells it. */
  shape: string;
  notNull: boolean;
  hasDefault: boolean;
  hasFiniteCheck: boolean;
}

let columnCache: NumericColumn[] | null = null;
export function constrainedColumns(): NumericColumn[] {
  if (columnCache) return columnCache;
  const dialect = new PgDialect();
  const out: NumericColumn[] = [];
  for (const [tableExport, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    // the real form is `col > '-Infinity'::numeric and col < 'Infinity'::numeric`; require BOTH signs of infinity, not just the name
    const finite = cfg.checks
      .filter((c) => /_finite_check$/.test(c.name))
      .map((c) => dialect.sqlToQuery(c.value).sql)
      .filter((sql) => /'-Infinity'/.test(sql) && /'Infinity'/.test(sql));
    for (const [key, col] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (!is(col, PgNumeric)) continue;
      const c = col as unknown as { name: string; precision?: number; scale?: number; notNull: boolean; hasDefault: boolean };
      out.push({
        tableExport,
        table: cfg.name,
        key,
        sqlName: c.name,
        shape: `${c.precision ?? '?'},${c.scale ?? '?'}`,
        notNull: c.notNull,
        hasDefault: c.hasDefault,
        hasFiniteCheck: finite.some((sql) => sql.includes(`"${c.name}"`)),
      });
    }
  }
  columnCache = out;
  return out;
}

/** The step-0 reconciliation: every `numeric(` in `packages/db/schema/*.ts`, classified. */
export function schemaNumericOccurrences(): { total: number; pgTableColumns: number; viewCasts: number; other: { file: string; line: number; text: string }[] } {
  const dir = join(ROOT, 'packages', 'db', 'schema');
  let total = 0;
  let viewCasts = 0;
  let columns = 0;
  const other: { file: string; line: number; text: string }[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const _m of text.matchAll(/numeric\(/g)) {
        total++;
        if (/::numeric\(/.test(text)) viewCasts++;
        else if (/numeric\('/.test(text)) columns++;
        else other.push({ file: `packages/db/schema/${f}`, line: i + 1, text: text.trim().slice(0, 90) });
      }
    });
  }
  return { total, pgTableColumns: columns, viewCasts, other };
}

/** Columns with no finite check. Takes the list so the guard's mutant can pass a MUTATED list (no tautology). */
export function finiteCheckGaps(cols: NumericColumn[] = constrainedColumns()): NumericColumn[] {
  return cols.filter((c) => !c.hasFiniteCheck);
}

// -----------------------------------------------------------------------------------------------
// The program
// -----------------------------------------------------------------------------------------------

export interface Census {
  program: ts.Program;
  checker: ts.TypeChecker;
  files: ts.SourceFile[];
}

let censusCache: Census | null = null;
const SKIP = /(^|\/)(node_modules|\.next|dist|coverage)(\/|$)/;
const TESTISH = /(\/tests?\/|\.test\.tsx?$|\.spec\.tsx?$|\/__tests__\/)/;
const inScope = (f: string) => !f.startsWith('..') && !SKIP.test(f) && /^(packages|apps|scripts)\//.test(f) && !TESTISH.test(`/${f}`);

/** The type-checked program over the root tsconfig. Built once per process (a few hundred MB — never call per test). */
export function loadCensus(): Census {
  if (censusCache) return censusCache;
  const cfgPath = join(ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true, incremental: false, plugins: undefined } });
  const files = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && inScope(rel(sf.fileName)));
  censusCache = { program, checker: program.getTypeChecker(), files };
  return censusCache;
}

/**
 * A census over in-memory source (the self-tests). Paths are repo-relative (`packages/domain/src/x.ts`); `lib` files come from the
 * installed TypeScript, node_modules types are not loaded. Cheap: a handful of tiny files.
 */
export function censusFromSource(sources: Record<string, string>): Census {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts'],
  };
  const virtual = new Map(Object.entries(sources).map(([k, v]) => [norm(join(ROOT, k)), v]));
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = virtual.get(norm(fileName));
    return text === undefined ? getSourceFile(fileName, languageVersion, ...rest) : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.fileExists = (f) => virtual.has(norm(f)) || fileExists(f);
  host.readFile = (f) => virtual.get(norm(f)) ?? readFile(f);
  const program = ts.createProgram({ rootNames: [...virtual.keys()], options, host });
  const files = program.getSourceFiles().filter((sf) => virtual.has(norm(sf.fileName)));
  return { program, checker: program.getTypeChecker(), files };
}

/** `packages/domain/src/<dir>/…` -> `<dir>`; `packages/db/src/repo/<x>.ts` -> `repo:<x>`; `apps/erp/src/app/<dir>/…` -> `app:<dir>`; else the top two path parts. */
export function moduleOf(file: string): string {
  let m = /^packages\/domain\/src\/([^/]+)/.exec(file);
  if (m) return m[1]!.replace(/\.tsx?$/, '');
  m = /^packages\/db\/src\/repo\/([^/]+?)\.tsx?$/.exec(file);
  if (m) return `repo:${m[1]}`;
  m = /^apps\/erp\/src\/app\/([^/]+)/.exec(file);
  if (m) return `app:${m[1]!.replace(/\.tsx?$/, '')}`;
  return file.split('/').slice(0, 3).join('/');
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
  }
  return '<module>';
}

const peel = (e: ts.Expression): ts.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
};

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
const nonNullish = (t: ts.Type): ts.Type[] => (t.isUnion() ? t.types.filter((x) => !(x.flags & NULLISH)) : (t.flags & NULLISH ? [] : [t]));

// -----------------------------------------------------------------------------------------------
// Brands
// -----------------------------------------------------------------------------------------------

export interface Brand {
  kind: 'decimal' | 'legacy';
  /** The `'p,s'` literal for a decimal brand; `'mixed'` when union members disagree. */
  shape?: string;
}

/**
 * `decimal` for a `__decimal` brand (the target), `legacy` for today's `Money` / `Quantity` brands, else null. A UNION is branded only if
 * EVERY non-nullish member is (L6: `Money | string` must not read as ok); an intersection is branded if it carries the brand property.
 */
export function brandOf(checker: ts.TypeChecker, type: ts.Type): Brand | null {
  if (type.isUnion()) {
    const members = nonNullish(type);
    if (members.length === 0) return null;
    const bs = members.map((m) => brandOf(checker, m));
    if (bs.some((b) => b === null)) return null;
    const all = bs as Brand[];
    if (all.every((b) => b.kind === 'decimal')) {
      const shapes = new Set(all.map((b) => b.shape));
      return { kind: 'decimal', shape: shapes.size === 1 ? [...shapes][0] : 'mixed' };
    }
    return { kind: 'legacy' };
  }
  const d = type.getProperty('__decimal');
  if (d) {
    const lit = checker.getTypeOfSymbol(d);
    return { kind: 'decimal', shape: lit.isStringLiteral() ? lit.value : undefined };
  }
  const b = type.getProperty('__brand');
  if (b) {
    const lit = checker.getTypeOfSymbol(b);
    if (lit.isStringLiteral() && (lit.value === 'Money' || lit.value === 'Quantity')) return { kind: 'legacy' };
  }
  return null;
}

/** Does this type BE a brand or CONTAIN one (array element, type argument, tuple member, object property, to a shallow depth)? */
export function typeMentionsBrand(checker: ts.TypeChecker, type: ts.Type, depth = 0, seen = new Set<ts.Type>()): boolean {
  if (depth > 4 || seen.has(type)) return false;
  seen.add(type);
  if (brandOf(checker, type)) return true;
  if (type.isUnionOrIntersection()) return type.types.some((t) => typeMentionsBrand(checker, t, depth + 1, seen));
  if (checker.isArrayType(type) || checker.isTupleType(type) || (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.some((t) => typeMentionsBrand(checker, t, depth + 1, seen))) return true;
  }
  if (type.flags & ts.TypeFlags.Object) {
    const props = checker.getPropertiesOfType(type).slice(0, 24);
    if (props.some((p) => typeMentionsBrand(checker, checker.getTypeOfSymbol(p), depth + 1, seen))) return true;
    const idx = checker.getIndexInfosOfType(type);
    if (idx.some((i) => typeMentionsBrand(checker, i.type, depth + 1, seen))) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------------------------
// G1. Writes
// -----------------------------------------------------------------------------------------------

export type WriteStatus = 'ok' | 'unbranded' | 'wrong-shape' | 'cast' | 'any' | 'sql-unbranded';

export interface WritePair {
  file: string;
  line: number;
  module: string;
  fn: string;
  table: string;
  key: string;
  shape: string;
  status: WriteStatus;
  /** The argument property's source text (or `<spread>` / the cast), for the failure message. */
  text: string;
}

export interface WriteSite {
  file: string;
  line: number;
  module: string;
  fn: string;
  table: string;
  kind: 'insert' | 'update' | 'onConflict';
  /** True when the argument was a bulk shape (array literal, `.map(…)`, or an array-typed value) and was unwrapped to its rows. */
  bulk: boolean;
  /** Constrained columns the argument provides (shorthand, assignment, or a spread of a known type). */
  provided: string[];
}

export interface UnresolvedWrite {
  file: string;
  line: number;
  module: string;
  fn: string;
  why: 'split-chain' | 'unresolved-table' | 'computed-key';
  text: string;
}

const tableNameOfExport = new Map<string, string>();
function tableExports() {
  if (tableNameOfExport.size) return tableNameOfExport;
  for (const [exp, value] of Object.entries(schema)) if (is(value, PgTable)) tableNameOfExport.set(exp, getTableConfig(value).name);
  return tableNameOfExport;
}

function targetTable(checker: ts.TypeChecker, arg: ts.Expression): string | null {
  const exp = peel(arg);
  const names = tableExports();
  if (ts.isIdentifier(exp)) {
    let sym = checker.getSymbolAtLocation(exp);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const name = sym?.escapedName ? String(sym.escapedName) : exp.text;
    return names.get(name) ?? null;
  }
  if (ts.isPropertyAccessExpression(exp)) {
    const sym = checker.getSymbolAtLocation(exp.name);
    return names.get(sym ? String(sym.escapedName) : exp.name.text) ?? null;
  }
  return null;
}

interface FoundWrite {
  sf: ts.SourceFile;
  call: ts.CallExpression;
  table: string;
  kind: WriteSite['kind'];
  arg: ts.Expression | undefined;
}

function* writeCalls(census: Census, unresolved: UnresolvedWrite[]): Generator<FoundWrite> {
  const { checker, files } = census;
  const note = (sf: ts.SourceFile, node: ts.Node, why: UnresolvedWrite['why']) => {
    const file = rel(sf.fileName);
    unresolved.push({ file, line: lineOf(sf, node), module: moduleOf(file), fn: enclosingFunctionName(node), why, text: squash(node.getText()).slice(0, 90) });
  };
  for (const sf of files) {
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) continue;
      const method = node.expression.name.text;
      // `<db>.insert(T).values(arg)` and `<db>.update(T).set(arg)`: the target table is the argument of the INNER call.
      if (method === 'values' || method === 'set') {
        const inner = peel(node.expression.expression);
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && (inner.expression.name.text === 'insert' || inner.expression.name.text === 'update') && inner.arguments[0]) {
          const table = targetTable(checker, inner.arguments[0]);
          if (table) yield { sf, call: node, table, kind: inner.expression.name.text === 'insert' ? 'insert' : 'update', arg: node.arguments[0] };
          else if (!isSchemaTableWithoutNumeric(checker, inner.arguments[0])) note(sf, node, 'unresolved-table');
        } else {
          // a split chain: `.values(` / `.set(` on a builder that is NOT a direct `.insert(T)` / `.update(T)` call
          const sym = checker.getTypeAtLocation(node.expression.expression).symbol?.name ?? '';
          if (/^Pg(Insert|Update)/.test(sym)) note(sf, node, 'split-chain');
        }
      }
      // `.onConflictDoUpdate({ target, set: arg })` writes the same table as the chain it hangs off.
      if (method === 'onConflictDoUpdate' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const setProp = node.arguments[0].properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'set');
        let chain: ts.Expression = node.expression.expression;
        let table: string | null = null;
        for (let depth = 0; depth < 6 && !table; depth++) {
          const c = peel(chain);
          if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression)) {
            if (c.expression.name.text === 'insert' && c.arguments[0]) table = targetTable(checker, c.arguments[0]);
            chain = c.expression.expression;
          } else break;
        }
        if (table && setProp && ts.isPropertyAssignment(setProp)) yield { sf, call: node, table, kind: 'onConflict', arg: setProp.initializer };
      }
    }
  }
}

/** `.insert(T)` where T is a real schema table that simply has no constrained numeric column: fine to ignore (anything else we cannot name is "unresolved"). */
function isSchemaTableWithoutNumeric(checker: ts.TypeChecker, arg: ts.Expression): boolean {
  const exp = peel(arg);
  const sym = ts.isIdentifier(exp) ? checker.getSymbolAtLocation(exp) : ts.isPropertyAccessExpression(exp) ? checker.getSymbolAtLocation(exp.name) : undefined;
  const aliased = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const decl = aliased?.valueDeclaration ?? aliased?.declarations?.[0];
  return !!decl && /packages\/db\/schema\//.test(norm(decl.getSourceFile().fileName));
}

const isSqlTag = (e: ts.Expression) => ts.isTaggedTemplateExpression(e) && /^(sql|drizzleSql|dsql)$/.test(e.tag.getText());

interface RowTarget {
  /** The object literal for this row, when the source has one (so properties are read by name). */
  literal: ts.ObjectLiteralExpression | null;
  /** The expression (for casts) and its type (for properties read through the checker). */
  node: ts.Expression | null;
  type: ts.Type;
}

/** Unwrap an argument to the ROW(S) it carries: array literals, `.map(cb)` returns, array-typed values, spreads of arrays. */
function rowTargets(checker: ts.TypeChecker, arg: ts.Expression, out: RowTarget[] = [], depth = 0): { rows: RowTarget[]; bulk: boolean } {
  const e = peel(arg);
  let bulk = false;
  if (depth > 5) {
    out.push({ literal: null, node: e, type: checker.getTypeAtLocation(e) });
    return { rows: out, bulk };
  }
  if (ts.isArrayLiteralExpression(e)) {
    bulk = true;
    for (const el of e.elements) {
      if (ts.isSpreadElement(el)) {
        const t = checker.getTypeAtLocation(el.expression);
        const elem = checker.isArrayType(t) ? checker.getTypeArguments(t as ts.TypeReference)[0] : undefined;
        out.push({ literal: null, node: el.expression, type: elem ?? t });
      } else rowTargets(checker, el, out, depth + 1);
    }
    return { rows: out, bulk };
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && /^(map|flatMap)$/.test(e.expression.name.text) && e.arguments[0] && (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0]))) {
    bulk = true;
    const cb = e.arguments[0];
    const returned: ts.Expression[] = [];
    if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) returned.push(cb.body);
    else {
      const visit = (n: ts.Node) => {
        if (ts.isReturnStatement(n) && n.expression) returned.push(n.expression);
        if (!ts.isFunctionLike(n) || n === cb) n.forEachChild(visit);
      };
      cb.body.forEachChild(visit);
    }
    if (returned.length === 0) out.push({ literal: null, node: e, type: checker.getTypeAtLocation(e) });
    for (const r of returned) rowTargets(checker, r, out, depth + 1);
    return { rows: out, bulk };
  }
  const t = checker.getTypeAtLocation(e);
  if (checker.isArrayType(t)) {
    bulk = true;
    const elem = checker.getTypeArguments(t as ts.TypeReference)[0];
    out.push({ literal: null, node: e, type: elem ?? t });
    return { rows: out, bulk };
  }
  out.push({ literal: ts.isObjectLiteralExpression(e) ? e : null, node: e, type: t });
  return { rows: out, bulk };
}

/** Every (write × constrained column the argument provides), judged against the column's brand shape. */
export function findWrites(census: Census = loadCensus()): { sites: WriteSite[]; pairs: WritePair[]; unresolved: UnresolvedWrite[] } {
  const { checker } = census;
  const cols = constrainedColumns();
  const byTable = new Map<string, NumericColumn[]>();
  for (const c of cols) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
  const sites: WriteSite[] = [];
  const pairs: WritePair[] = [];
  const unresolved: UnresolvedWrite[] = [];

  for (const w of writeCalls(census, unresolved)) {
    const tcols = byTable.get(w.table);
    if (!tcols || !w.arg) continue;
    const file = rel(w.sf.fileName);
    const fn = enclosingFunctionName(w.call);
    const base = { file, line: lineOf(w.sf, w.call), module: moduleOf(file), fn, table: w.table };
    const provided = new Set<string>();

    const judge = (col: NumericColumn, valueNode: ts.Expression | null, type: ts.Type, text: string, spread: boolean) => {
      provided.add(col.key);
      let status: WriteStatus;
      const peeled = valueNode ? peel(valueNode) : null;
      if (peeled && isSqlTag(peeled)) {
        const tagged = peeled as ts.TaggedTemplateExpression;
        const bad = ts.isTemplateExpression(tagged.template)
          ? tagged.template.templateSpans.some((s) => {
              const t = checker.getTypeAtLocation(s.expression);
              const b = brandOf(checker, t);
              const isColumn = !!t.getProperty('columnType') || !!t.getProperty('dataType');
              return !(isColumn || (b?.kind === 'decimal' && b.shape === col.shape));
            })
          : false;
        status = bad ? 'sql-unbranded' : 'ok';
      } else if (peeled && (ts.isAsExpression(peeled) || ts.isTypeAssertionExpression(peeled))) status = 'cast';
      else if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) status = 'any';
      else {
        const brand = brandOf(checker, type);
        status = brand?.kind === 'decimal' ? (brand.shape === col.shape ? 'ok' : 'wrong-shape') : 'unbranded';
      }
      pairs.push({ ...base, key: col.key, shape: col.shape, status, text: spread ? '<spread>' : text });
    };

    const { rows, bulk } = rowTargets(checker, w.arg);
    for (const row of rows) {
      if (row.literal) {
        for (const p of row.literal.properties) {
          if (ts.isSpreadAssignment(p)) {
            const st = checker.getTypeAtLocation(p.expression);
            if (st.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
              for (const col of tcols) judge(col, null, st, '<spread of any>', true);
              continue;
            }
            for (const col of tcols) {
              const prop = st.getProperty(col.key);
              if (prop) judge(col, null, checker.getTypeOfSymbol(prop), '', true);
            }
            continue;
          }
          if (p.name && ts.isComputedPropertyName(p.name)) {
            unresolved.push({ file: base.file, line: base.line, module: base.module, fn: base.fn, why: 'computed-key', text: squash(p.getText()).slice(0, 90) });
            continue;
          }
          const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
          const col = name ? tcols.find((c) => c.key === name) : undefined;
          if (!col) continue;
          if (ts.isShorthandPropertyAssignment(p)) judge(col, p.name, checker.getTypeAtLocation(p.name), squash(p.getText()), false);
          else if (ts.isPropertyAssignment(p)) judge(col, p.initializer, checker.getTypeAtLocation(p.initializer), squash(p.getText()).slice(0, 110), false);
        }
      } else if (row.node && (ts.isAsExpression(peel(row.node)) || ts.isTypeAssertionExpression(peel(row.node)))) {
        for (const col of tcols) judge(col, row.node, row.type, squash(row.node.getText()).slice(0, 80), false);
      } else if (row.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
        for (const col of tcols) judge(col, null, row.type, row.node ? squash(row.node.getText()).slice(0, 80) : '<row>', true);
      } else {
        for (const col of tcols) {
          const prop = row.type.getProperty(col.key);
          if (prop) judge(col, null, checker.getTypeOfSymbol(prop), row.node ? squash(row.node.getText()).slice(0, 80) : '<row>', true);
        }
      }
    }
    sites.push({ ...base, kind: w.kind, bulk, provided: [...provided].sort() });
  }
  return { sites, pairs, unresolved };
}

export interface RawSqlWriter {
  file: string;
  line: number;
  module: string;
  fn: string;
  table: string;
  verb: 'insert' | 'update';
  /** `column: <expression>` for every constrained column whose bound parameter carries no `__decimal` brand of that column's shape. */
  unbranded: string[];
}

export interface UnresolvedRawSql {
  file: string;
  line: number;
  fn: string;
  why: 'dynamic-table' | 'sql.raw';
}

/** The text of a template with each `${…}` replaced by `$n`, and the expressions in order. */
function templateParts(node: ts.TemplateLiteral): { text: string; exprs: ts.Expression[] } {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, exprs: [] };
  let text = node.head.text;
  const exprs: ts.Expression[] = [];
  node.templateSpans.forEach((sp, i) => {
    exprs.push(sp.expression);
    text += `$${i + 1}${sp.literal.text}`;
  });
  return { text, exprs };
}

/** The text inside the FIRST balanced parenthesised group of `s` (`(a, b), (c, d)` -> `a, b`). Only the first row of a multi-row VALUES is judged. */
const firstGroup = (s: string): string => {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (s[i] === ')') {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i);
    }
  }
  return s.slice(start < 0 ? 0 : start);
};

const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
};

/**
 * `insert into <t>` / `update <t>` inside a template literal (also `with … insert`, schema-qualified and quoted names), where <t> has a
 * constrained numeric column. Numeric PARAMETERS are judged by BRAND, not by name: the bound expression for each constrained column is
 * resolved from the column list / `set col = $n` and its type must carry a same-shape `__decimal`.
 */
export function findRawSqlWriters(census: Census = loadCensus()): { writers: RawSqlWriter[]; unresolved: UnresolvedRawSql[] } {
  const cols = constrainedColumns();
  const byTable = new Map<string, NumericColumn[]>();
  for (const c of cols) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
  const writers: RawSqlWriter[] = [];
  const unresolved: UnresolvedRawSql[] = [];
  const TABLE = /\b(insert\s+into|update)\s+(?:"?[a-z_][a-z_0-9]*"?\.)?"?([a-z_][a-z_0-9]*|\$\d+)"?/gi;
  for (const sf of census.files) {
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      const file = rel(sf.fileName);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'raw' && /^(sql|drizzleSql|dsql)$/.test(node.expression.expression.getText())) {
        unresolved.push({ file, line: lineOf(sf, node), fn: enclosingFunctionName(node), why: 'sql.raw' });
      }
      if (!ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) continue;
      const { text, exprs } = templateParts(node as ts.TemplateLiteral);
      for (const m of text.matchAll(TABLE)) {
        const verb = /^insert/i.test(m[1]!) ? 'insert' : 'update';
        const t = m[2]!.toLowerCase();
        let tableName = t;
        if (/^\$\d+$/.test(t)) {
          const ex = exprs[Number(t.slice(1)) - 1];
          const resolved = ex ? targetTable(census.checker, ex) : null;
          if (!resolved) {
            // a schema table whose columns are not numeric is fine; anything else we cannot name is enumerated by the guard
            if (!(ex && isSchemaTableWithoutNumeric(census.checker, ex))) unresolved.push({ file, line: lineOf(sf, node), fn: enclosingFunctionName(node), why: 'dynamic-table' });
            continue;
          }
          tableName = resolved;
        }
        const tcols = byTable.get(tableName);
        if (!tcols) continue;
        const rest = text.slice((m.index ?? 0) + m[0].length);
        const unbranded: string[] = [];
        const check = (colName: string, placeholder: string) => {
          const col = tcols.find((c) => c.sqlName === colName.replace(/"/g, '').toLowerCase());
          const idx = Number(/\$(\d+)/.exec(placeholder)?.[1]);
          if (!col || !idx || !exprs[idx - 1]) return;
          const t2 = census.checker.getTypeAtLocation(exprs[idx - 1]!);
          const b = brandOf(census.checker, t2);
          if (!(b?.kind === 'decimal' && b.shape === col.shape)) unbranded.push(`${col.sqlName}: ${squash(exprs[idx - 1]!.getText()).slice(0, 60)}`);
        };
        if (verb === 'insert') {
          const cm = /^\s*\(([^)]*)\)\s*(?:overriding[^v]*)?values\s*(\([\s\S]*)/i.exec(rest);
          if (cm) {
            const names = splitTop(cm[1]!);
            const vals = splitTop(firstGroup(cm[2]!));
            names.forEach((n, i) => { if (vals[i]) check(n, vals[i]!); });
          }
        } else {
          const setMatch = /\bset\b([\s\S]*?)(?:\bwhere\b|\bfrom\b|\breturning\b|$)/i.exec(rest);
          if (setMatch) {
            for (const part of splitTop(setMatch[1]!)) {
              const eq = /^"?([a-z_0-9]+)"?\s*=\s*([\s\S]+)$/i.exec(part);
              if (eq) check(eq[1]!, eq[2]!);
            }
          }
        }
        writers.push({ file, line: lineOf(sf, node), module: moduleOf(file), fn: enclosingFunctionName(node), table: tableName, verb, unbranded });
      }
    }
  }
  return { writers, unresolved };
}

/** `scripts/*.mjs` / `*.js` are not compiled (L9): read them as text and report any that write a constrained table. */
export function rawScriptWriters(): string[] {
  const dir = join(ROOT, 'scripts');
  if (!existsSync(dir)) return [];
  const tables = new Set(constrainedColumns().map((c) => c.table));
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/\b(?:insert\s+into|update)\s+(?:"?[a-z_][a-z_0-9]*"?\.)?"?([a-z_][a-z_0-9]*)"?/gi)) {
          if (tables.has(m[1]!.toLowerCase())) hits.push(`${rel(p)}: ${m[0]}`);
        }
      }
    }
  };
  walk(dir);
  return hits;
}

// -----------------------------------------------------------------------------------------------
// G2. Comparisons
// -----------------------------------------------------------------------------------------------

export interface Comparison {
  file: string;
  module: string;
  fn: string;
  /** Normalised expression text — the EXEMPT key is (file, fn, text), never a line number. */
  text: string;
  line: number;
  reason: 'string-vs-string' | 'derived-from-string' | 'any-operand';
}

const REL = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken]);
/** String, or a union of string and null/undefined (`fee?: string | null`): the NON-nullish members are all string-like and at least one exists. */
/** A member is string-like when it IS (a literal counts) or is an intersection that contains a string — a BRANDED string (`Money`, `Decimal<…>`) is still a string. */
const memberIs = (x: ts.Type, flag: ts.TypeFlags): boolean => (x.flags & flag) !== 0 || (x.isIntersection() && x.types.some((y) => (y.flags & flag) !== 0));
const isStringish = (t: ts.Type) => {
  const m = nonNullish(t);
  return m.length > 0 && m.every((x) => memberIs(x, ts.TypeFlags.StringLike));
};
const isNumberish = (t: ts.Type) => {
  const m = nonNullish(t);
  return m.length > 0 && m.every((x) => memberIs(x, ts.TypeFlags.NumberLike));
};
const MATH_PASSTHROUGH = /^(abs|max|min|round|floor|ceil|trunc|sign|fround)$/;

/**
 * Does this number-typed expression derive from a string-typed value? Follows `const`/destructured initialisers, `Math.*`, `||` / `??` /
 * `&&`, ternaries, `await`, `Number.parseFloat`, and calls of functions whose parameter is a string and whose result is a number
 * (helpers such as `toNum`), across functions.
 */
/** symbol -> every expression ASSIGNED to it (`x = e`, `x += e`, `x ??= e`, property assignments) — accumulators and reassigned lets. Built once per program. */
const assignmentsCache = new WeakMap<ts.TypeChecker, Map<ts.Symbol, ts.Expression[]>>();
const ASSIGN_OPS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken]);
function assignmentsOf(census: { checker: ts.TypeChecker; files: ts.SourceFile[] }): Map<ts.Symbol, ts.Expression[]> {
  const cached = assignmentsCache.get(census.checker);
  if (cached) return cached;
  const map = new Map<ts.Symbol, ts.Expression[]>();
  for (const sf of census.files) {
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      if (!ts.isBinaryExpression(node) || !ASSIGN_OPS.has(node.operatorToken.kind)) continue;
      const left = peel(node.left);
      const sym = ts.isIdentifier(left) ? census.checker.getSymbolAtLocation(left) : ts.isPropertyAccessExpression(left) ? census.checker.getSymbolAtLocation(left.name) : undefined;
      if (sym) map.set(sym, [...(map.get(sym) ?? []), node.right]);
    }
  }
  assignmentsCache.set(census.checker, map);
  return map;
}
let currentAssignments: Map<ts.Symbol, ts.Expression[]> = new Map();

function derivesFromString(checker: ts.TypeChecker, expr: ts.Expression, depth = 0, seen = new Set<ts.Node>()): boolean {
  if (depth > 8) return false;
  const e = peel(expr);
  if (seen.has(e)) return false;
  seen.add(e);
  if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) return derivesFromString(checker, e.expression, depth + 1, seen);
  if (ts.isAwaitExpression(e)) return derivesFromString(checker, e.expression, depth + 1, seen);
  if (ts.isConditionalExpression(e)) return derivesFromString(checker, e.whenTrue, depth + 1, seen) || derivesFromString(checker, e.whenFalse, depth + 1, seen);
  if (ts.isPrefixUnaryExpression(e)) {
    if (e.operator === ts.SyntaxKind.PlusToken && isStringish(checker.getTypeAtLocation(e.operand))) return true;
    return derivesFromString(checker, e.operand, depth + 1, seen);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(op)) {
      return derivesFromString(checker, e.left, depth + 1, seen) || derivesFromString(checker, e.right, depth + 1, seen);
    }
    return false;
  }
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    const owner = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : '';
    const coerce = (ts.isIdentifier(callee) && /^(Number|parseFloat|parseInt)$/.test(name)) || (owner === 'Number' && /^(parseFloat|parseInt)$/.test(name));
    if (coerce) {
      const a = e.arguments[0];
      return !!a && (isStringish(checker.getTypeAtLocation(a)) || derivesFromString(checker, a, depth + 1, seen));
    }
    if (owner === 'Math' && MATH_PASSTHROUGH.test(name)) return e.arguments.some((a) => derivesFromString(checker, a, depth + 1, seen));
    if (name === 'toNumber' && ts.isPropertyAccessExpression(callee)) return true;
    // `.reduce((n, l) => n + Number(l.x), 0)`: derived when the accumulator callback's result is, or the seed is
    if (name === 'reduce' && ts.isPropertyAccessExpression(callee) && e.arguments[0] && (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0]))) {
      const cb = e.arguments[0];
      const returned: ts.Expression[] = [];
      if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) returned.push(cb.body);
      else {
        const visit = (n: ts.Node) => {
          if (ts.isReturnStatement(n) && n.expression) returned.push(n.expression);
          if (!ts.isFunctionLike(n) || n === cb) n.forEachChild(visit);
        };
        cb.body.forEachChild(visit);
      }
      if (returned.some((r) => derivesFromString(checker, r, depth + 1, seen))) return true;
      return !!e.arguments[1] && derivesFromString(checker, e.arguments[1], depth + 1, seen);
    }
    // a helper: any function whose result is a number and which takes a (possibly nullable) string argument
    if (isNumberish(checker.getTypeAtLocation(e)) && e.arguments.some((a) => isStringish(checker.getTypeAtLocation(a)))) {
      const decl = checker.getResolvedSignature(e)?.getDeclaration();
      // the SAFE comparisons (core `compare*` / `isZero` / `equals` on branded values) are the TARGET shape, never a finding
      const declFile = norm(decl?.getSourceFile().fileName ?? '');
      if (decl && !/node_modules|lib\.[a-z0-9.]*d\.ts/.test(declFile) && !declFile.includes('/packages/core/src/') && !/^(compare|compareDecimal|compareQuantity|isZero|equals)$/.test(name)) return true;
    }
    return false;
  }
  const viaDeclaration = (sym: ts.Symbol | undefined): boolean => {
    const decl = sym?.valueDeclaration;
    if (!decl) return false;
    // a `let` / property that is EVER assigned from a flagged expression is itself flagged (accumulators, reassignment)
    if (sym && (currentAssignments.get(sym) ?? []).some((rhs) => derivesFromString(checker, rhs, depth + 1, seen))) return true;
    if (ts.isVariableDeclaration(decl) && decl.initializer) return derivesFromString(checker, decl.initializer, depth + 1, seen);
    // property carry: `const p = { n: Number(x) }; p.n > 0`
    if (ts.isPropertyAssignment(decl)) return derivesFromString(checker, decl.initializer, depth + 1, seen);
    // `const { a } = expr` / `const [a] = expr`: the binding element belongs to a declaration whose initializer is the source
    if (ts.isBindingElement(decl)) {
      let p: ts.Node | undefined = decl.parent;
      while (p && !ts.isVariableDeclaration(p)) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer) return derivesFromString(checker, p.initializer, depth + 1, seen);
    }
    return false;
  };
  if (ts.isIdentifier(e)) return viaDeclaration(checker.getSymbolAtLocation(e));
  if (ts.isPropertyAccessExpression(e)) return viaDeclaration(checker.getSymbolAtLocation(e.name));
  return false;
}

export const COMPARISON_SCOPE = /^(packages\/(domain|db)\/src|apps\/erp\/src)\//;

/** Relational comparisons on a value derived from a (possibly nullable) string, or between two strings. */
export function findComparisons(census: Census = loadCensus(), scope: RegExp = COMPARISON_SCOPE): Comparison[] {
  const { checker, files } = census;
  currentAssignments = assignmentsOf(census);
  const out: Comparison[] = [];
  for (const sf of files) {
    const file = rel(sf.fileName);
    if (!scope.test(file)) continue;
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      if (!ts.isBinaryExpression(node) || !REL.has(node.operatorToken.kind)) continue;
      const lt = checker.getTypeAtLocation(node.left);
      const rt = checker.getTypeAtLocation(node.right);
      let reason: Comparison['reason'] | null = null;
      if (isStringish(lt) && isStringish(rt)) reason = 'string-vs-string';
      else if ((lt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (rt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) reason = 'any-operand';
      else if ((isNumberish(lt) && derivesFromString(checker, node.left)) || (isNumberish(rt) && derivesFromString(checker, node.right))) reason = 'derived-from-string';
      if (!reason) continue;
      out.push({ file, module: moduleOf(file), fn: enclosingFunctionName(node), text: squash(node.getText()), line: lineOf(sf, node), reason });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// G3. Forgeries
// -----------------------------------------------------------------------------------------------

export interface Forgery {
  file: string;
  line: number;
  module: string;
  fn: string;
  text: string;
  brand: 'decimal' | 'legacy' | 'container';
}

/** A type assertion onto a brand, or onto a CONTAINER of one (`Money[]`, `Record<string, Money>`, `{ amount: Money }`), outside `packages/core/src`. */
export function findForgeries(census: Census = loadCensus()): Forgery[] {
  const { checker, files } = census;
  const out: Forgery[] = [];
  for (const sf of files) {
    const file = rel(sf.fileName);
    if (file.startsWith('packages/core/src/')) continue;
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) continue;
      const target = checker.getTypeFromTypeNode(node.type);
      const b = brandOf(checker, target);
      const mentions = b ? true : typeMentionsBrand(checker, target);
      if (!mentions) continue;
      out.push({ file, line: lineOf(sf, node), module: moduleOf(file), fn: enclosingFunctionName(node), text: squash(node.getText()).slice(0, 120), brand: b ? b.kind : 'container' });
    }
  }
  return out;
}

/** How many type assertions the G3 scan looked at — its population floor (an empty scan must not pass). */
export function countTypeAssertions(census: Census = loadCensus()): number {
  let n = 0;
  for (const sf of census.files) {
    if (rel(sf.fileName).startsWith('packages/core/src/')) continue;
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const node = stack.pop()!;
      node.forEachChild((c) => { stack.push(c); });
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) n++;
    }
  }
  return n;
}

/** Group any list by module (stable order). */
export function byModule<T extends { module: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(i.module, [...(m.get(i.module) ?? []), i]);
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}
