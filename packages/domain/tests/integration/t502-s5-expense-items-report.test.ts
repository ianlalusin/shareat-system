import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-502 S5 (TESTER, red first) - the cost report by category -> sub-category -> item.
 * Spec: docs/tasks/502-expense-item-catalog.md section 4 S5, section 11 (Group -> Category -> Sub-category -> Item, "(none)"), sections 12/14.
 *
 * NAMES FIXED BY THIS FILE (the orchestrator rules; all shape knowledge sits in `report()` / `lines()` below):
 *   expenseItemsReport(tx, actor, { from, to, storeId: string | null }) exported from @shareat/domain ->
 *     { total: Money, groups: [{ group, total, pct, categories: [{ categoryId, category, total, pct, subcategories: [
 *         { subcategoryId: string | null, name, total, pct, items: [
 *           { itemId: string | null, name, baseUnit: string | null, total, pct, timesBought: number, avgUnitPrice: Money | null,
 *             byStore: [{ storeId, total, timesBought }] } ] } ] }] }] }
 *     Money = '1234.50' strings. pct = number 0..100 (of the report total). A sub-category with no id is named "(none)". The money of an expense
 *     that is not an item is the item row named "(unitemised)" (itemId null, avgUnitPrice null, timesBought 0, baseUnit null).
 *     storeId null = every store the actor may see (an actor scoped to some stores gets only those; a named store the actor does not hold is refused).
 *     Authorised inside with view_financial_reports at each store read.
 *   expenseItemLines(tx, actor, { from, to, storeId, itemId }) -> [{ invoiceId, invoiceDate, storeId, lineNo, quantity, unit, lineTotal, attributed }]
 *     the invoice lines behind one item row; `attributed` sums to the item row's total.
 *
 * THE ATTRIBUTION RULE encoded (unit = one invoice + one category, because an expense IS a category part of an invoice):
 *   T = sum of POSTED expenses of that category on that invoice; L = sum of that invoice's lines whose item category is that category.
 *   T <= L: T is shared over those lines pro-rata by line_total; centavos by floor, the remainder to the largest line (so it ties exactly).
 *   T >  L: every line in full, and (T - L) is the "(unitemised)" row under that category (open room: uncategorised lines, fees).
 *   No lines in that category (uncategorised-only part, lineless legacy invoice): all of T is "(unitemised)" under the category, sub-category "(none)".
 *   Lines and the report total come from posted expenses only; the invoice date is the expense business date (createExpense forces it).
 * timesBought = distinct invoice lines attributed (>0). avgUnitPrice = sum(line_total) / sum(quantity x conversion_factor) over those lines, half-up to centavos.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { ap475Fixture, asOrg, actorOf, uid, type Fixture } from './_fixtures/t475-ap';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Tx = Parameters<Parameters<typeof asOrg>[1]>[0];
type StoreRow = { storeId: string; total: string; timesBought: number };
type ItemRow = { itemId: string | null; name: string; baseUnit: string | null; total: string; pct: number; timesBought: number; avgUnitPrice: string | null; byStore: StoreRow[] };
type SubRow = { subcategoryId: string | null; name: string; total: string; pct: number; items: ItemRow[] };
type CatRow = { categoryId: string; category: string; total: string; pct: number; subcategories: SubRow[] };
type GroupRow = { group: string; total: string; pct: number; categories: CatRow[] };
type Report = { total: string; groups: GroupRow[] };
type Args = { from: string; to: string; storeId: string | null };
type LineRow = { invoiceId: string; invoiceDate: string; storeId: string; lineNo: number; quantity: string; unit: string; lineTotal: string; attributed: string };
const reportFn = (domain as unknown as { expenseItemsReport?: (tx: Tx, a: Actor, i: Args) => Promise<Report> }).expenseItemsReport;
const linesFn = (domain as unknown as { expenseItemLines?: (tx: Tx, a: Actor, i: Args & { itemId: string | null }) => Promise<LineRow[]> }).expenseItemLines;

const JAN: Args = { from: '2026-01-01', to: '2026-01-31', storeId: null };
const report = (f: Fixture, actor: Actor, args: Partial<Args> = {}): Promise<Report> => {
  if (!reportFn) throw new Error('expenseItemsReport is not exported from @shareat/domain');
  return asOrg(f.orgId, (tx) => reportFn(tx, actor, { ...JAN, ...args }));
};
const lines = (f: Fixture, actor: Actor, itemId: string | null, args: Partial<Args> = {}): Promise<LineRow[]> => {
  if (!linesFn) throw new Error('expenseItemLines is not exported from @shareat/domain');
  return asOrg(f.orgId, (tx) => linesFn(tx, actor, { ...JAN, ...args, itemId }));
};

const cents = (s: string) => Math.round(Number(s) * 100);
const MONEY = /^\d+\.\d{2}$/;
const allItems = (r: Report) => r.groups.flatMap((g) => g.categories.flatMap((c) => c.subcategories.flatMap((s) => s.items)));
const catOf = (r: Report, categoryId: string) => r.groups.flatMap((g) => g.categories).find((c) => c.categoryId === categoryId);
const itemsOf = (r: Report, categoryId: string) => (catOf(r, categoryId)?.subcategories ?? []).flatMap((s) => s.items);
const named = (r: Report, categoryId: string, name: string) => itemsOf(r, categoryId).find((i) => i.name === name);
const refuses = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (e) {
    if (/is not exported/.test((e as Error).message)) throw e; // a missing function is not a refusal
    return e as Error;
  }
};

interface World {
  f: Fixture;
  boss: Actor; // admin scoped to BOTH stores
  cogsA: string;
  cogsB: string;
  opex: string;
  cashMalvar: string;
  sub: (categoryId: string, name: string) => Promise<string>;
  item: (name: string, o?: { cat?: string | null; sub?: string | null; unit?: string }) => Promise<string>;
}
async function world(hint: string): Promise<World> {
  const f = await ap475Fixture(sql, `s5-${hint}`);
  const [boss] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Boss') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${boss!.id}, ${f.orgId}, 'admin')`;
  for (const s of [f.storeId, f.store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${boss!.id}, ${s})`;
  const [cashMalvar] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${f.store2Id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund2'), idempotencyKey: uid('fund2'), memo: 'fixture funding', postedBy: f.adminId,
      lines: [{ accountCode: cashMalvar!.gl_account_code, storeId: f.store2Id, debit: '100000.00' }, { accountCode: '3900', storeId: f.store2Id, credit: '100000.00' }],
    }),
  );
  const cats = await sql<{ id: string; group: string }[]>`
    select id, "group" from expense_categories where org_id = ${f.orgId} and is_active and account_code is not null order by "group", category`;
  const cogs = cats.filter((c) => c.group === 'COGS');
  const opex = cats.find((c) => c.group === 'OPEX');
  if (cogs.length < 2 || !opex) throw new Error('fixture org needs two mapped COGS categories and one OPEX');
  return {
    f,
    boss: actorOf(f.orgId, boss!.id),
    cogsA: cogs[0]!.id,
    cogsB: cogs[1]!.id,
    opex: opex.id,
    cashMalvar: cashMalvar!.id,
    sub: async (categoryId, name) =>
      (await sql<{ id: string }[]>`insert into expense_subcategories (org_id, category_id, name, created_by) values (${f.orgId}, ${categoryId}, ${name}, ${f.adminId}) returning id`)[0]!.id,
    item: async (name, o = {}) =>
      (await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id, expense_subcategory_id)
        values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', ${o.unit ?? 'kg'}, ${f.adminId}, ${o.cat ?? null}, ${o.sub ?? null}) returning id`)[0]!.id,
  };
}

type Line = { item: string; total: string; qty?: string; cf?: string; unit?: string };
/** A verified (default) or pending invoice with lines; total = lines + `fee`. Store defaults to Lipa. */
async function bill(w: World, o: { lines: Line[]; on?: string; store?: 'lipa' | 'malvar'; status?: 'verified' | 'pending'; fee?: string }): Promise<string> {
  const storeId = o.store === 'malvar' ? w.f.store2Id : w.f.storeId;
  const total = (o.lines.reduce((s, l) => s + cents(l.total), 0) + cents(o.fee ?? '0')) / 100;
  const id = await w.f.invoice({ total: total.toFixed(2), status: o.status ?? 'verified', on: o.on ?? '2026-01-10', storeId, receiptFileId: await w.f.file(storeId) });
  let n = 0;
  for (const l of o.lines) {
    n += 1;
    const qty = l.qty ?? '1';
    await sql`
      insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
      values (${id}, ${n}, ${l.item}, ${qty}, ${l.unit ?? 'pcs'}, ${l.cf ?? '1'}, ${(cents(l.total) / 100 / Number(qty)).toFixed(2)}, ${l.total})`;
  }
  return id;
}
/** A POSTED expense (verified invoice) for one category part. */
async function post(w: World, invoiceId: string, categoryId: string, amount: string, store: 'lipa' | 'malvar' = 'lipa'): Promise<string> {
  const storeId = store === 'malvar' ? w.f.store2Id : w.f.storeId;
  const r = await asOrg(w.f.orgId, (tx) =>
    domain.recordExpenseForInvoice(tx, w.boss, {
      storeId,
      supplierInvoiceId: invoiceId,
      supplierId: w.f.supplierId,
      categoryId,
      particulars: 'T-502 S5',
      payments: [{ method: 'cash', amount, moneyAccountId: store === 'malvar' ? w.cashMalvar : w.f.cashId }],
    }),
  );
  return r.expenseId;
}
/** A DRAFT expense (pending invoice). */
async function draft(w: World, invoiceId: string, categoryId: string, amount: string): Promise<string> {
  return (
    await asOrg(w.f.orgId, (tx) =>
      domain.createExpense(tx, w.boss, {
        storeId: w.f.storeId,
        supplierId: w.f.supplierId,
        supplierInvoiceId: invoiceId,
        businessDate: '2026-01-10',
        categoryId,
        particulars: 'T-502 S5 draft',
        payments: [{ method: 'cash', amount, moneyAccountId: w.f.cashId }],
      }),
    )
  ).id;
}
const postedTotal = async (orgId: string, o: { from: string; to: string; storeId?: string }) =>
  (
    await sql<{ t: string }[]>`
    select coalesce(sum(total_amount), 0)::text as t from expenses
    where org_id = ${orgId} and status = 'posted' and business_date between ${o.from} and ${o.to}
      and (${o.storeId ?? null}::uuid is null or store_id = ${o.storeId ?? null})`
  )[0]!.t;
const money = (s: string) => (cents(s) / 100).toFixed(2);

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S5 / tie-out - the report adds up to the posted expenses, to the centavo', () => {
  it('report total = posted expenses total, and every level adds up to the level above (kills: a level that drops or double counts money)', async () => {
    const w = await world('tie');
    const pork = await w.sub(w.cogsA, 'Pork');
    const kasim = await w.item('Pork kasim', { cat: w.cogsA, sub: pork });
    const ice = await w.item('Ice', { cat: w.cogsA });
    const lettuce = await w.item('Lettuce', { cat: w.cogsB });
    const soap = await w.item('Dish soap', { cat: w.opex });
    const loose = await w.item('Unfiled thing');
    const i1 = await bill(w, { lines: [{ item: kasim, total: '1234.56' }, { item: ice, total: '100.10' }, { item: lettuce, total: '333.33' }] });
    await post(w, i1, w.cogsA, '1000.00'); // partly recorded part of 1,334.66
    await post(w, i1, w.cogsB, '333.33');
    const i2 = await bill(w, { store: 'malvar', lines: [{ item: soap, total: '777.77' }, { item: loose, total: '50.00' }], fee: '10.00' });
    await post(w, i2, w.opex, '777.77', 'malvar');
    await post(w, i2, w.opex, '60.00', 'malvar'); // the uncategorised line + the fee, filed under the same category
    const r = await report(w.f, w.boss);
    expect(r.total).toMatch(MONEY);
    expect(r.total, 'must equal the posted expenses').toBe(await postedTotal(w.f.orgId, { from: '2026-01-01', to: '2026-01-31' }));
    expect(r.total).toBe('2171.10');
    const sum = (xs: string[]) => money(String(xs.reduce((s, x) => s + cents(x), 0) / 100));
    expect(sum(r.groups.map((g) => g.total))).toBe(r.total);
    for (const g of r.groups) {
      expect(sum(g.categories.map((c) => c.total)), `group ${g.group}`).toBe(g.total);
      for (const c of g.categories) {
        expect(sum(c.subcategories.map((s) => s.total)), `category ${c.category}`).toBe(c.total);
        for (const s of c.subcategories) expect(sum(s.items.map((i) => i.total)), `sub ${s.name}`).toBe(s.total);
      }
    }
    for (const i of allItems(r)) expect(sum(i.byStore.map((b) => b.total)), `${i.name} by store`).toBe(i.total);
  });

  it('an empty range is an empty report with total 0.00 (not a throw)', async () => {
    const w = await world('empty');
    const r = await report(w.f, w.boss);
    expect(r.total).toBe('0.00');
    expect(r.groups).toEqual([]);
  });
});

describe('T-502 S5 / what is counted', () => {
  it('DRAFT and VOIDED expenses are excluded; only posted money is in the report', async () => {
    const w = await world('status');
    const a = await w.item('Counted', { cat: w.cogsA });
    const pending = await bill(w, { status: 'pending', lines: [{ item: a, total: '500.00' }] });
    await draft(w, pending, w.cogsA, '500.00');
    const inv = await bill(w, { lines: [{ item: a, total: '800.00' }] });
    const voided = await post(w, inv, w.cogsA, '300.00');
    await asOrg(w.f.orgId, (tx) => domain.voidExpense(tx, w.boss, voided, 'T-502 S5 test'));
    await post(w, inv, w.cogsA, '200.00');
    const r = await report(w.f, w.boss);
    expect(r.total).toBe('200.00');
    expect(named(r, w.cogsA, 'Counted')?.total).toBe('200.00');
    expect(await postedTotal(w.f.orgId, { from: '2026-01-01', to: '2026-01-31' })).toBe('200.00');
  });

  it('the date range is the expense business date (the invoice date), both ends inclusive', async () => {
    const w = await world('dates');
    const a = await w.item('Dated', { cat: w.cogsA });
    await post(w, await bill(w, { on: '2026-01-10', lines: [{ item: a, total: '100.00' }] }), w.cogsA, '100.00');
    await post(w, await bill(w, { on: '2026-01-31', lines: [{ item: a, total: '10.00' }] }), w.cogsA, '10.00');
    await post(w, await bill(w, { on: '2026-02-05', lines: [{ item: a, total: '1.00' }] }), w.cogsA, '1.00');
    expect((await report(w.f, w.boss, { from: '2026-01-01', to: '2026-01-31' })).total).toBe('110.00');
    expect((await report(w.f, w.boss, { from: '2026-01-10', to: '2026-01-10' })).total).toBe('100.00');
    expect((await report(w.f, w.boss, { from: '2026-01-11', to: '2026-02-28' })).total).toBe('11.00');
    expect((await report(w.f, w.boss, { from: '2026-01-01', to: '2026-02-28' })).total).toBe('111.00');
  });

  it('store filter: Lipa only, Malvar only, and null = every store; each ties to the posted expenses of that store', async () => {
    const w = await world('stores');
    const a = await w.item('Both', { cat: w.cogsA });
    await post(w, await bill(w, { lines: [{ item: a, total: '400.00' }] }), w.cogsA, '400.00');
    await post(w, await bill(w, { store: 'malvar', lines: [{ item: a, total: '90.00' }] }), w.cogsA, '90.00', 'malvar');
    for (const [storeId, want] of [[w.f.storeId, '400.00'], [w.f.store2Id, '90.00'], [null, '490.00']] as const) {
      const r = await report(w.f, w.boss, { storeId });
      expect(r.total, String(storeId)).toBe(want);
      expect(r.total).toBe(await postedTotal(w.f.orgId, { from: '2026-01-01', to: '2026-01-31', ...(storeId ? { storeId } : {}) }));
    }
  });
});

describe('T-502 S5 / who may read it (store scope, authorize())', () => {
  async function twoStores() {
    const w = await world('scope');
    const a = await w.item('Scoped', { cat: w.cogsA });
    await post(w, await bill(w, { lines: [{ item: a, total: '400.00' }] }), w.cogsA, '400.00');
    await post(w, await bill(w, { store: 'malvar', lines: [{ item: a, total: '90.00' }] }), w.cogsA, '90.00', 'malvar');
    return w;
  }
  it('a manager held at Lipa reads Lipa; the same manager asking for Malvar is REFUSED (the X test)', async () => {
    const w = await twoStores();
    expect((await report(w.f, w.f.manager, { storeId: w.f.storeId })).total).toBe('400.00');
    const err = await refuses(() => report(w.f, w.f.manager, { storeId: w.f.store2Id }));
    expect(err, 'a store the manager does not hold must refuse').not.toBeNull();
    expect(err!.message).not.toMatch(/is not exported/);
  });
  it('"all stores" for a manager held at Lipa is Lipa only: no Malvar money leaks in (kills: null widening to the whole org)', async () => {
    const w = await twoStores();
    const r = await report(w.f, w.f.manager, { storeId: null });
    expect(r.total).toBe('400.00');
    expect(allItems(r).flatMap((i) => i.byStore.map((b) => b.storeId))).not.toContain(w.f.store2Id);
  });
  it('floor staff (no view_financial_reports) are refused, at a store and for all stores; the drill-down is gated the same way', async () => {
    const w = await twoStores();
    expect(await refuses(() => report(w.f, w.f.staff, { storeId: w.f.storeId }))).not.toBeNull();
    expect(await refuses(() => report(w.f, w.f.staff, { storeId: null }))).not.toBeNull();
    expect(await refuses(() => lines(w.f, w.f.staff, null, { storeId: w.f.storeId }))).not.toBeNull();
    expect(await refuses(() => lines(w.f, w.f.manager, null, { storeId: w.f.store2Id }))).not.toBeNull();
  });
  it('an admin held at both stores reads both', async () => {
    const w = await twoStores();
    expect((await report(w.f, w.boss)).total).toBe('490.00');
  });
});

describe('T-502 S5 / the drill-down tree and the figures on it', () => {
  it('Group -> Category -> Sub-category -> Item nests; items with no sub-category sit under "(none)"; pesos and % of total', async () => {
    const w = await world('tree');
    const pork = await w.sub(w.cogsA, 'Pork');
    const chicken = await w.sub(w.cogsA, 'Chicken');
    const kasim = await w.item('Kasim', { cat: w.cogsA, sub: pork });
    const belly = await w.item('Belly', { cat: w.cogsA, sub: pork });
    const wings = await w.item('Wings', { cat: w.cogsA, sub: chicken });
    const ice = await w.item('Ice', { cat: w.cogsA });
    const lettuce = await w.item('Lettuce', { cat: w.cogsB });
    const dish = await w.item('Dishwashing', { cat: w.opex });
    const i1 = await bill(w, {
      lines: [{ item: kasim, total: '600.00' }, { item: belly, total: '400.00' }, { item: wings, total: '500.00' }, { item: ice, total: '100.00' }, { item: lettuce, total: '400.00' }],
    });
    await post(w, i1, w.cogsA, '1600.00');
    await post(w, i1, w.cogsB, '400.00');
    await post(w, await bill(w, { lines: [{ item: dish, total: '1000.00' }] }), w.opex, '1000.00');
    const r = await report(w.f, w.boss);
    expect(r.total).toBe('3000.00');
    expect(r.groups.map((g) => g.group).sort()).toEqual(['COGS', 'OPEX']);
    const cogs = r.groups.find((g) => g.group === 'COGS')!;
    expect(cogs.total).toBe('2000.00');
    expect(cogs.pct).toBeCloseTo(66.7, 1);
    const meat = catOf(r, w.cogsA)!;
    expect(meat.total).toBe('1600.00');
    expect(meat.pct).toBeCloseTo(53.3, 1);
    const subs = Object.fromEntries(meat.subcategories.map((s) => [s.name, s]));
    expect(Object.keys(subs).sort()).toEqual(['(none)', 'Chicken', 'Pork']);
    expect(subs['Pork']!.subcategoryId).toBe(pork);
    expect(subs['Pork']!.total).toBe('1000.00');
    expect(subs['Pork']!.items.map((i) => i.name), 'items largest first').toEqual(['Kasim', 'Belly']);
    expect(subs['(none)']!.subcategoryId).toBeNull();
    expect(subs['(none)']!.items.map((i) => i.name)).toEqual(['Ice']);
    const k = named(r, w.cogsA, 'Kasim')!;
    expect(k.itemId).toBe(kasim);
    expect(k.total).toBe('600.00');
    expect(k.pct).toBeCloseTo(20, 1);
    expect(catOf(r, w.cogsB)!.subcategories.map((s) => s.name), 'a category with no sub-categories: all under (none)').toEqual(['(none)']);
    expect(named(r, w.opex, 'Dishwashing')!.total).toBe('1000.00');
  });

  it('times bought = invoice lines, average unit price per BASE unit and weighted: 120 + 60 base units for 600 + 360 = 5.33, not 5.50', async () => {
    const w = await world('avg');
    const oil = await w.item('Cooking oil', { cat: w.cogsA, unit: 'ltr' });
    const i1 = await bill(w, { on: '2026-01-05', lines: [{ item: oil, total: '600.00', qty: '10', unit: 'box', cf: '12' }] });
    const i2 = await bill(w, { on: '2026-01-20', lines: [{ item: oil, total: '360.00', qty: '5', unit: 'box', cf: '12' }] });
    await post(w, i1, w.cogsA, '600.00');
    await post(w, i2, w.cogsA, '360.00');
    const row = named(await report(w.f, w.boss), w.cogsA, 'Cooking oil')!;
    expect(row.total).toBe('960.00');
    expect(row.timesBought).toBe(2);
    expect(row.avgUnitPrice).toBe('5.33');
    expect(row.baseUnit).toBe('ltr');
  });

  it('average unit price is the PRICE PAID, not the recorded amount: a half-recorded line keeps its price (kills: avg from the attributed amount)', async () => {
    const w = await world('avg2');
    const rice = await w.item('Rice', { cat: w.cogsA });
    const inv = await bill(w, { lines: [{ item: rice, total: '500.00', qty: '10' }] });
    await post(w, inv, w.cogsA, '250.00');
    const row = named(await report(w.f, w.boss), w.cogsA, 'Rice')!;
    expect(row.total).toBe('250.00');
    expect(row.timesBought).toBe(1);
    expect(row.avgUnitPrice).toBe('50.00');
  });

  it('store vs store per item: Lipa spends 4,000.00 and Malvar 1,000.00 (two bills) on the same dishwashing item', async () => {
    const w = await world('vs');
    const dish = await w.item('Dishwashing liquid', { cat: w.opex, unit: 'ltr' });
    await post(w, await bill(w, { lines: [{ item: dish, total: '4000.00' }] }), w.opex, '4000.00');
    await post(w, await bill(w, { store: 'malvar', lines: [{ item: dish, total: '800.00' }] }), w.opex, '800.00', 'malvar');
    await post(w, await bill(w, { store: 'malvar', lines: [{ item: dish, total: '200.00' }] }), w.opex, '200.00', 'malvar');
    const row = named(await report(w.f, w.boss), w.opex, 'Dishwashing liquid')!;
    expect(row.total).toBe('5000.00');
    const by = Object.fromEntries(row.byStore.map((b) => [b.storeId, b]));
    expect(by[w.f.storeId]).toMatchObject({ total: '4000.00', timesBought: 1 });
    expect(by[w.f.store2Id]).toMatchObject({ total: '1000.00', timesBought: 2 });
  });

  it('the drill-down: the invoice lines behind an item, with the attributed pesos adding up to the item row', async () => {
    const w = await world('drill');
    const a = await w.item('Drilled', { cat: w.cogsA });
    const b = await w.item('Other', { cat: w.cogsA });
    const i1 = await bill(w, { on: '2026-01-05', lines: [{ item: a, total: '600.00', qty: '3', unit: 'kg' }, { item: b, total: '400.00' }] });
    const i2 = await bill(w, { on: '2026-01-20', lines: [{ item: a, total: '100.00' }] });
    await post(w, i1, w.cogsA, '500.00'); // half of 1,000.00 -> 300.00 / 200.00
    await post(w, i2, w.cogsA, '100.00');
    const got = await lines(w.f, w.boss, a);
    expect(got).toHaveLength(2);
    expect(got.map((l) => l.invoiceId).sort()).toEqual([i1, i2].sort());
    const l1 = got.find((l) => l.invoiceId === i1)!;
    expect(l1).toMatchObject({ invoiceDate: '2026-01-05', storeId: w.f.storeId, lineNo: 1, unit: 'kg', lineTotal: '600.00', attributed: '300.00' });
    expect(Number(l1.quantity)).toBe(3);
    expect(got.reduce((s, l) => s + cents(l.attributed), 0)).toBe(cents(named(await report(w.f, w.boss), w.cogsA, 'Drilled')!.total));
    expect((await lines(w.f, w.boss, a, { from: '2026-01-10', to: '2026-01-31' })).map((l) => l.invoiceId)).toEqual([i2]);
  });
});

describe('T-502 S5 / the attribution rule (how a posted expense splits over items)', () => {
  it('a partly recorded part is shared pro-rata over its lines: 500.00 of 600 + 400 -> 300.00 / 200.00', async () => {
    const w = await world('attr1');
    const a = await w.item('Big', { cat: w.cogsA });
    const b = await w.item('Small', { cat: w.cogsA });
    await post(w, await bill(w, { lines: [{ item: a, total: '600.00' }, { item: b, total: '400.00' }] }), w.cogsA, '500.00');
    const r = await report(w.f, w.boss);
    expect(named(r, w.cogsA, 'Big')!.total).toBe('300.00');
    expect(named(r, w.cogsA, 'Small')!.total).toBe('200.00');
  });

  it('the centavo remainder goes to the LARGEST line so it still ties: 100.00 over 100 / 100 / 101 -> 33.22 / 33.22 / 33.56 (kills: plain rounding, which gives 99.99)', async () => {
    const w = await world('attr2');
    const a = await w.item('A', { cat: w.cogsA });
    const b = await w.item('B', { cat: w.cogsA });
    const c = await w.item('C', { cat: w.cogsA });
    await post(w, await bill(w, { lines: [{ item: a, total: '100.00' }, { item: b, total: '100.00' }, { item: c, total: '101.00' }] }), w.cogsA, '100.00');
    const r = await report(w.f, w.boss);
    expect(named(r, w.cogsA, 'A')!.total).toBe('33.22');
    expect(named(r, w.cogsA, 'B')!.total).toBe('33.22');
    expect(named(r, w.cogsA, 'C')!.total).toBe('33.56');
    expect(r.total).toBe('100.00');
  });

  it('no line ever carries more than its own total when T <= L: 2.99 over three 1.00 lines -> 1.00 / 1.00 / 0.99 (kills: the whole remainder on the largest line, which gives 1.01)', async () => {
    const w = await world('attrcap');
    const items = [await w.item('Cap A', { cat: w.cogsA }), await w.item('Cap B', { cat: w.cogsA }), await w.item('Cap C', { cat: w.cogsA })];
    await post(w, await bill(w, { lines: items.map((item) => ({ item, total: '1.00' })) }), w.cogsA, '2.99');
    const r = await report(w.f, w.boss);
    const got = items.map((id) => itemsOf(r, w.cogsA).find((i) => i.itemId === id)!.total);
    expect(got).toEqual(['1.00', '1.00', '0.99']);
    expect(r.total).toBe('2.99');
  });

  it('one invoice + one category is ONE unit whatever the store: the schema forbids an expense at a store other than its invoice (DEF-508), so a Malvar expense on a Lipa bill is refused (guard)', async () => {
    const w = await world('attrstore');
    const a = await w.item('Guard A', { cat: w.cogsA });
    const inv = await bill(w, { lines: [{ item: a, total: '100.00' }] });
    await post(w, inv, w.cogsA, '60.00');
    expect(await refuses(() => post(w, inv, w.cogsA, '40.00', 'malvar'))).not.toBeNull();
    expect((await report(w.f, w.boss)).total).toBe('60.00');
  });

  it('money above the lines of its category (the open room: an uncategorised line, a fee) is the "(unitemised)" row under that category; the lines count in full', async () => {
    const w = await world('attr3');
    const meat = await w.item('Meat line', { cat: w.cogsA });
    const loose = await w.item('Uncategorised line');
    const inv = await bill(w, { lines: [{ item: meat, total: '1000.00' }, { item: loose, total: '150.00' }], fee: '50.00' });
    await post(w, inv, w.cogsA, '1200.00'); // 1,000 of lines + 200 of the open room
    const r = await report(w.f, w.boss);
    expect(named(r, w.cogsA, 'Meat line')!.total).toBe('1000.00');
    const un = named(r, w.cogsA, '(unitemised)')!;
    expect(un.total).toBe('200.00');
    expect(un.itemId).toBeNull();
    expect(un.avgUnitPrice).toBeNull();
    expect(un.timesBought).toBe(0);
    expect(r.total).toBe('1200.00');
  });

  it('two expenses of the same category on one invoice fill the lines FIRST, then the overflow is unitemised (kills: each expense spread pro-rata on its own)', async () => {
    const w = await world('attr4');
    const a = await w.item('First', { cat: w.cogsA });
    const b = await w.item('Second', { cat: w.cogsA });
    const inv = await bill(w, { lines: [{ item: a, total: '600.00' }, { item: b, total: '400.00' }], fee: '100.00' });
    await post(w, inv, w.cogsA, '1000.00');
    await post(w, inv, w.cogsA, '100.00'); // the fee
    const r = await report(w.f, w.boss);
    expect(named(r, w.cogsA, 'First')!.total).toBe('600.00');
    expect(named(r, w.cogsA, 'Second')!.total).toBe('400.00');
    expect(named(r, w.cogsA, '(unitemised)')!.total).toBe('100.00');
  });

  it('a voided expense frees its share: the report then counts only what is still posted', async () => {
    const w = await world('attr5');
    const a = await w.item('One', { cat: w.cogsA });
    const b = await w.item('Two', { cat: w.cogsA });
    const inv = await bill(w, { lines: [{ item: a, total: '600.00' }, { item: b, total: '400.00' }] });
    const e1 = await post(w, inv, w.cogsA, '500.00');
    await post(w, inv, w.cogsA, '500.00');
    await asOrg(w.f.orgId, (tx) => domain.voidExpense(tx, w.boss, e1, 'T-502 S5 test'));
    const r = await report(w.f, w.boss);
    expect(named(r, w.cogsA, 'One')!.total).toBe('300.00');
    expect(named(r, w.cogsA, 'Two')!.total).toBe('200.00');
  });

  it('a category whose lines are all uncategorised (the person picked the category) is all "(unitemised)" under it, sub-category "(none)"', async () => {
    const w = await world('attr6');
    const loose = await w.item('Mystery item');
    const inv = await bill(w, { lines: [{ item: loose, total: '300.00' }] });
    await post(w, inv, w.opex, '300.00');
    const r = await report(w.f, w.boss);
    const cat = catOf(r, w.opex)!;
    expect(cat.subcategories.map((s) => s.name)).toEqual(['(none)']);
    expect(cat.subcategories[0]!.items.map((i) => [i.name, i.total])).toEqual([['(unitemised)', '300.00']]);
  });

  it('a lineless legacy invoice (requireItemised:false) is "(unitemised)" under its category and still ties', async () => {
    const w = await world('attr7');
    const bare = await w.f.invoice({ total: '250.00', status: 'verified' });
    await asOrg(w.f.orgId, (tx) =>
      domain.recordExpenseForInvoice(tx, w.boss, {
        storeId: w.f.storeId,
        supplierInvoiceId: bare,
        supplierId: w.f.supplierId,
        categoryId: w.cogsB,
        particulars: 'legacy',
        requireItemised: false,
        payments: [{ method: 'cash', amount: '250.00', moneyAccountId: w.f.cashId }],
      }),
    );
    const r = await report(w.f, w.boss);
    expect(r.total).toBe('250.00');
    expect(itemsOf(r, w.cogsB).map((i) => [i.name, i.total])).toEqual([['(unitemised)', '250.00']]);
  });

  it("another category's lines on the same invoice are not touched by this expense (Veg money never lands on a Meat item)", async () => {
    const w = await world('attr8');
    const m = await w.item('Meat', { cat: w.cogsA });
    const v = await w.item('Veg', { cat: w.cogsB });
    const inv = await bill(w, { lines: [{ item: m, total: '700.00' }, { item: v, total: '300.00' }] });
    await post(w, inv, w.cogsB, '300.00');
    const r = await report(w.f, w.boss);
    expect(catOf(r, w.cogsA)).toBeUndefined();
    expect(named(r, w.cogsB, 'Veg')!.total).toBe('300.00');
    expect(r.total).toBe('300.00');
  });
});
