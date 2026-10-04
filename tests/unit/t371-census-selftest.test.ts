import { describe, expect, it } from 'vitest';
import * as schema from '../../packages/db/schema';
import {
  censusFromSource,
  constrainedColumns,
  findComparisons,
  findForgeries,
  findRawSqlWriters,
  findWrites,
  finiteCheckGaps,
} from './lib/numeric-write-census';

/**
 * T-371 S0 — the census's SELF-TESTS (audit M4b). `t371-numeric-write-guard.test.ts` can only be trusted if each detector is shown able to
 * FAIL, so every case below is a tiny in-memory program (`censusFromSource`) that the detector MUST flag, plus positive controls that it must
 * NOT flag. Without these, a detector that silently saw nothing would make the guard green for the wrong reason (the audit's "silent green").
 *
 * The snippets name real schema exports (`moneyAccounts.overdraftLimit` is (14,2); `stockLayers.remainingQuantity` and
 * `tradeOrderLines.quantity` are (14,3)); the first test pins that they still exist, so a rename fails HERE, loudly, not by flagging nothing.
 */
const PRELUDE = `
type Decimal<S extends string> = string & { readonly __decimal: S };
type Money = string & { readonly __brand: 'Money' };
declare class PgInsertBuilder { values(v: unknown): unknown }
declare class PgUpdateBuilder { set(v: unknown): unknown }
declare const db: { insert(t: unknown): PgInsertBuilder; update(t: unknown): PgUpdateBuilder };
declare const moneyAccounts: unknown;
declare const stockLayers: unknown;
declare const tradeOrderLines: unknown;
declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
declare const tx: { execute(q: unknown): unknown };
export {};
`;
const file = (name: string) => `packages/domain/src/selftest/${name}.ts`;
const src = (name: string, body: string): [string, string] => [file(name), `${PRELUDE}\n${body}\n`];

const cases: [string, string][] = [
  src('unbranded', `declare const s: string; db.insert(moneyAccounts).values({ overdraftLimit: s });`),
  src('cast', `declare const s: string; db.insert(moneyAccounts).values({ overdraftLimit: s as never });`),
  src('any', `declare const a: any; db.insert(moneyAccounts).values({ overdraftLimit: a });`),
  src('wrongshape', `declare const d: Decimal<'14,3'>; db.insert(moneyAccounts).values({ overdraftLimit: d });`),
  src('ok', `declare const d: Decimal<'14,2'>; db.insert(moneyAccounts).values({ overdraftLimit: d });`),
  src('mixedunion', `declare const m: Decimal<'14,2'> | string; db.insert(moneyAccounts).values({ overdraftLimit: m });`),
  src('sqlunbranded', `declare const q: string; db.update(stockLayers).set({ remainingQuantity: sql\`x - \${q}::numeric\` });`),
  src('sqlok', `declare const q: Decimal<'14,3'>; db.update(stockLayers).set({ remainingQuantity: sql\`x - \${q}::numeric\` });`),
  src('bulkliteral', `declare const s: string; db.insert(tradeOrderLines).values([{ quantity: s }]);`),
  src('bulkmap', `declare const rows: { q: string }[]; db.insert(tradeOrderLines).values(rows.map((r) => ({ quantity: r.q })));`),
  src('bulkmapblock', `declare const rows: { q: string }[]; db.insert(tradeOrderLines).values(rows.map((r) => { return { quantity: r.q }; }));`),
  src('bulktyped', `declare const rows: { quantity: string }[]; db.insert(tradeOrderLines).values(rows);`),
  src('bulkok', `declare const d: Decimal<'14,3'>; db.insert(tradeOrderLines).values([{ quantity: d }]);`),
  src('computedkey', `declare const k: string; declare const d: Decimal<'14,2'>; db.insert(moneyAccounts).values({ [k]: d });`),
  src('splitchain', `declare const s: string; const q = db.insert(moneyAccounts); q.values({ overdraftLimit: s });`),
  src('rawunbranded', `declare const s: string; tx.execute(sql\`insert into money_accounts (overdraft_limit) values (\${s})\`);`),
  src('rawwith', `declare const s: string; tx.execute(sql\`with t as (select 1) insert into public.money_accounts (overdraft_limit) values (\${s})\`);`),
  src('rawupdate', `declare const s: string; tx.execute(sql\`update money_accounts set overdraft_limit = \${s} where true\`);`),
  src('rawok', `declare const d: Decimal<'14,2'>; tx.execute(sql\`insert into money_accounts (overdraft_limit) values (\${d})\`);`),
  src('rawdynamic', `declare const t: string; declare const d: Decimal<'14,2'>; tx.execute(sql\`insert into \${t} (overdraft_limit) values (\${d})\`);`),
  src('forgery', `declare const x: string; export const a = x as Money; export const b = [x] as Money[]; export const c = {} as Record<string, Money>; export const d = {} as { amount: Money }; export const e = x as Decimal<'14,2'>; export const fine = x as string;`),
  src('cmpresidual', `
    export function acc(xs: string[]) { let t = 0; for (const x of xs) { t += Number(x); } return t > 5; }
    export function red(xs: { x: string }[]) { return xs.reduce((n, l) => n + Number(l.x), 0) > 6; }
    export function prop(x: string) { const p = { n: Number(x) }; return p.n > 0; }
    export function reassigned(x: string) { let v = 0; v = Number(x); return v > 1; }
    export function anyop(a: any, b: number) { return a > b; }
    export function brandedStr(m: Money) { return Number(m) > 0; }
    declare function compare(a: Money, b: Money): number;
    export function safeCompare(a: Money, b: Money) { return compare(a, b) < 0; }
    export function plainAccumulator() { let c = 0; for (const n of [1, 2]) { c += n; } return c > 1; }
  `),
  src('rawmulti', `declare const a: string; declare const b: string; tx.execute(sql\`insert into money_accounts (overdraft_limit) values (\${a}), (\${b})\`);`),
  src('rawschematable', `declare const s: string; tx.execute(sql\`update \${moneyAccounts} set overdraft_limit = \${s}\`);`),
  src('cmp', `
    export function abs(x: string) { return Math.abs(Number(x)) > 0.005; }
    export function orZero(x: string | null) { return (Number(x) || 0) > 1; }
    export function nullish(x?: string | null) { return (x == null ? 0 : Number(x)) > 1; }
    export function parse(x: string) { return Number.parseFloat(x) >= 2; }
    export function maxed(x: string) { return Math.max(Number(x), 0) < 3; }
    export function destruct(o: { a: string }) { const { a } = o; const n = Number(a); return n > 4; }
    export async function awaited(f: () => Promise<string>) { return Number(await f()) > 5; }
    export function helper(x: string) { const toNum = (v: string) => Number(v); return toNum(x) > 6; }
    export function strings() { return 'abc' > '0'; }
    export function plain(n: number) { return n > 0; }
    export function parsedInt(n: number) { return Math.abs(n) > 1; }
  `),
];

const census = censusFromSource(Object.fromEntries(cases));
const writes = findWrites(census);
const raw = findRawSqlWriters(census);
const comparisons = findComparisons(census);
const forgeries = findForgeries(census);
const pairsOf = (name: string) => writes.pairs.filter((p) => p.file === file(name));

describe('the fixtures name real schema exports', () => {
  it('moneyAccounts / stockLayers / tradeOrderLines exist and the columns used have the shapes the snippets assume', () => {
    for (const name of ['moneyAccounts', 'stockLayers', 'tradeOrderLines']) expect(Object.keys(schema), name).toContain(name);
    const shape = (table: string, key: string) => constrainedColumns().find((c) => c.table === table && c.key === key)?.shape;
    expect(shape('money_accounts', 'overdraftLimit')).toBe('14,2');
    expect(shape('stock_layers', 'remainingQuantity')).toBe('14,3');
    expect(shape('trade_order_lines', 'quantity')).toBe('14,3');
  });
});

describe('G1 can fail: each unsafe write shape is flagged', () => {
  it.each([
    ['unbranded', 'unbranded'],
    ['cast', 'cast'],
    ['any', 'any'],
    ['wrongshape', 'wrong-shape'],
    ['mixedunion', 'unbranded'], // L6: `Decimal | string` must NOT read as branded
    ['sqlunbranded', 'sql-unbranded'],
  ] as const)('%s -> %s', (name, status) => {
    expect(pairsOf(name).map((p) => p.status), `${name} was not flagged ${status}`).toContain(status);
  });

  it('bulk inserts are unwrapped: an array literal, a .map(arrow), a .map(block) and an array-typed value each yield a flagged pair AND a bulk site', () => {
    for (const name of ['bulkliteral', 'bulkmap', 'bulkmapblock', 'bulktyped']) {
      expect(pairsOf(name).map((p) => `${p.key}:${p.status}`), `${name}: the row's quantity was never judged (a bulk insert read as nothing)`).toEqual(['quantity:unbranded']);
      expect(writes.sites.some((s) => s.file === file(name) && s.bulk), `${name}: not marked bulk`).toBe(true);
    }
  });

  it('computed keys and split chains are COUNTED as unresolved (a new one fails closed)', () => {
    expect(writes.unresolved.filter((u) => u.file === file('computedkey')).map((u) => u.why)).toEqual(['computed-key']);
    expect(writes.unresolved.filter((u) => u.file === file('splitchain')).map((u) => u.why)).toEqual(['split-chain']);
  });

  it('POSITIVE CONTROLS: a same-shape branded value, a branded bulk row and a branded SQL value are NOT flagged', () => {
    expect(pairsOf('ok').map((p) => p.status)).toEqual(['ok']);
    expect(pairsOf('bulkok').map((p) => p.status)).toEqual(['ok']);
    expect(pairsOf('sqlok').map((p) => p.status)).toEqual(['ok']);
  });
});

describe('raw SQL detector can fail', () => {
  const inFile = (name: string) => raw.writers.filter((w) => w.file === file(name));
  it.each(['rawunbranded', 'rawwith', 'rawupdate'])('%s: the writer is found and its unbranded numeric parameter is reported by BRAND, not by name', (name) => {
    const w = inFile(name);
    expect(w.length, `${name}: no raw writer found`).toBe(1);
    expect(w[0]!.unbranded.join(' '), `${name}: the unbranded parameter was not reported`).toContain('overdraft_limit');
  });
  it('a schema-qualified table (`public.money_accounts`) and a `with … insert` are both seen', () => {
    expect(inFile('rawwith')[0]?.table).toBe('money_accounts');
  });
  it('a dynamic table name (`insert into ${t}`) is COUNTED as unresolved', () => {
    expect(raw.unresolved.filter((u) => u.file === file('rawdynamic')).map((u) => u.why)).toEqual(['dynamic-table']);
  });
  it('POSITIVE CONTROL: a branded same-shape parameter is not reported', () => {
    expect(inFile('rawok')[0]?.unbranded).toEqual([]);
  });
});

describe('G2 can fail: each NaN-blind comparison spelling is flagged', () => {
  const flagged = comparisons.filter((c) => c.file === file('cmp')).map((c) => c.fn);
  it.each(['abs', 'orZero', 'nullish', 'parse', 'maxed', 'destruct', 'awaited', 'helper', 'strings'])('%s', (fn) => {
    expect(flagged, `${fn} was not flagged`).toContain(fn);
  });
  it('POSITIVE CONTROLS: a plain number comparison is not flagged', () => {
    expect(flagged).not.toContain('plain');
    expect(flagged).not.toContain('parsedInt');
  });
});

describe('G2 residual spellings (re-audit): accumulators, reduce, property carry, reassigned lets, any operands, branded strings', () => {
  const flagged = comparisons.filter((c) => c.file === file('cmpresidual'));
  const reasonOf = (fn: string) => flagged.find((c) => c.fn === fn)?.reason;
  it.each(['acc', 'red', 'prop', 'reassigned', 'brandedStr'])('%s is flagged derived-from-string', (fn) => {
    expect(reasonOf(fn), `${fn} was not flagged`).toBe('derived-from-string');
  });
  it('an any-typed operand is flagged (fail closed: the checker cannot know)', () => {
    expect(reasonOf('anyop')).toBe('any-operand');
  });
  it('POSITIVE CONTROLS: the core-style compare(a, b) and a numeric-only accumulator are NOT flagged', () => {
    const fns = flagged.map((c) => c.fn);
    expect(fns).not.toContain('safeCompare');
    expect(fns).not.toContain('plainAccumulator');
  });
});

describe('raw SQL limits are recorded, not hidden', () => {
  it("a MULTI-ROW values is recorded as a writer (so it must be registered); only the first row's parameter is judged", () => {
    const w = raw.writers.filter((x) => x.file === file('rawmulti'));
    expect(w.length, 'a multi-row insert was not recorded as a writer').toBe(1);
    expect(w[0]!.unbranded.join(' ')).toContain('overdraft_limit');
    expect(w[0]!.unbranded.length, 'only the FIRST row is judged').toBe(1);
  });
  it('an interpolated schema-table identifier (`update ${moneyAccounts} set …`) is resolved to its table and judged', () => {
    const w = raw.writers.filter((x) => x.file === file('rawschematable'));
    expect(w.map((x) => x.table)).toEqual(['money_accounts']);
    expect(w[0]!.unbranded.join(' ')).toContain('overdraft_limit');
  });
});

describe('G3 can fail: brands inside containers are forgeries too', () => {
  const found = forgeries.filter((f) => f.file === file('forgery')).map((f) => f.text);
  it.each([['as Money'], ['as Money[]'], ['as Record<string, Money>'], ['as { amount: Money }'], ["as Decimal<'14,2'>"]])('%s', (needle) => {
    expect(found.some((t) => t.includes(needle)), `${needle} was not flagged`).toBe(true);
  });
  it('POSITIVE CONTROL: `as string` is not a forgery', () => {
    expect(found.some((t) => t.includes('as string'))).toBe(false);
  });
});

describe('G4 can fail', () => {
  it('a column list with one finite check removed is reported by finiteCheckGaps(list) — the mutant is not a tautology', () => {
    const cols = constrainedColumns();
    expect(finiteCheckGaps(cols)).toEqual([]);
    const mutated = cols.map((c, i) => (i === 0 ? { ...c, hasFiniteCheck: false } : c));
    expect(finiteCheckGaps(mutated).map((c) => `${c.table}.${c.sqlName}`)).toEqual([`${cols[0]!.table}.${cols[0]!.sqlName}`]);
  });
  it('the finite-check form is the REAL one (both -Infinity and Infinity bounds), derived from the schema, for every column', () => {
    expect(constrainedColumns().every((c) => c.hasFiniteCheck)).toBe(true);
  });
});
