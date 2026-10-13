import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-392 S4b (TESTER) - the v2 document reader and R9 wired into the run. docs/tasks/392-dual-run-comparator.md "S4b spec",
 * invariants 38 (v2 side), 39-44, plus the orchestrator's end-to-end channel case. Real Postgres; NO migration in S4b.
 *
 * ---- PINNED CONTRACT (the spec names rules; the builder follows these or reports the one it cannot) ----
 * dualRunRepo.v2Documents(tx, orgId, { storeId, weekStart, through }): Promise<V2Doc[]>   (db package, exported through dualRunRepo)
 *   V2Doc = { id: string; kind; glCode; partyType: string | null; partyId: string | null; categoryId?: string; date: 'YYYY-MM-DD';
 *             amount: 2dp string (v2Figures' sign rule: debit - credit, 2110 credit - debit); state: 'posted' | 'unposted';
 *             receiptNo: string | null }
 *   window [weekStart-7, through+7]; store- and org-scoped; unassigned_store and a voided document never emitted; a doc whose
 *   amount nets to 0 is not emitted. POSTED docs: the same per-kind filters and dating as v2Figures, grouped by (kind, gl, party,
 *   category, root source, day), id `v2:<root type>:<root id>:<kind>:<gl>:<party id or ''>:<day>`; receiptNo = invoice_no of the
 *   supplier_invoices row for root 'stock_receipt_invoice' (id = source_id) or root 'expense_payment' (expenses.supplier_invoice_id).
 *   UNPOSTED docs (ids unpinned, but unique): draft expense on a non-inventory category -> expense_category total_amount (category id);
 *   its 'credit' payment rows -> ap_supplier 2110 supplier party (+amount); its 'cash'/'online' payment rows -> -amount on the money
 *   account's gl (party money_account when that gl is 1140; kind staff_cash when the gl is one of the store's custodian='staff'
 *   codes, else cash_bank); pending supplier_invoices -> ap_supplier 2110 +total_amount, invoice_date, receiptNo = invoice_no;
 *   draft ap_payments -> ap_supplier 2110 -amount; sales_days open|submitted -> sales_tender: cash_collected on 1110 (no party), each
 *   sales_day_tenders row on 1140 (money_account party), each NON-remitted sales_day_channels row with amount > 0 on the channel's
 *   receivable_account_code (channel party).
 * runDualRun passes v1Documents / v2Documents to compareStoreWeek (R9 wired); compare.ts `empty` stops reading docs.
 *
 * Red today: dualRunRepo.v2Documents does not exist (the repo tests), and runDualRun passes empty docs (the run tests: classes stay
 * UNEXPLAINED / the pairs never form). Each test names its killing mutant.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { randomUUID } from 'node:crypto';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import * as db from '@shareat/db';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { postEntry, reverseEntry } from '@shareat/domain';
import { serialiseKeysCsv, type KeyRow } from '../../../etl/src/dual-run/keys';
import { v1SalesDay } from '../../../etl/tests/fixtures/t392-v1-sales-day';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const PADRE = 'y1DMgfisuTHBF57cNL6i';
const W19 = { weekStart: '2026-10-19', through: '2026-10-25' };

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface V2Doc {
  id: string;
  kind: string;
  glCode: string;
  partyType: string | null;
  partyId: string | null;
  categoryId?: string;
  date: string;
  amount: string;
  state: 'posted' | 'unposted';
  receiptNo: string | null;
}
type Repo = {
  v2Documents(tx: Tx, orgId: string, i: { storeId: string; weekStart: string; through: string }): Promise<V2Doc[]>;
  v2Figures(tx: Tx, orgId: string, i: { storeId: string; weekStart: string; through: string }): Promise<{ lines: Any[] }>;
};
const repo = (): Repo => (db as unknown as { dualRunRepo: Repo }).dualRunRepo;

interface Fx {
  orgId: string;
  storeA: { id: string; code: string };
  storeB: { id: string; code: string };
  admin: Actor;
  personId: string;
  verifierId: string;
  supId: string;
  cash: string;
  gcash: string;
  staff: string;
}

async function moneyAcct(orgId: string, storeId: string, name: string, instrument: string, gl: string, custodian: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, ${name}, ${instrument}, ${gl}, ${custodian}) returning id`;
  return r!.id;
}

async function fixture(hint: string): Promise<Fx> {
  const code = uid(`T392S4B${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open')`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
  const mkStore = async (n: string) => {
    const c = uid(n);
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${c}, ${`Store ${n}`}) returning id`;
    return { id: s!.id, code: c };
  };
  const storeA = await mkStore('LP');
  const storeB = await mkStore('MV');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  for (const s of [storeA, storeB]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s.id})`;
  const [v] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('Acme')}, ${p!.id}) returning id`;
  await sql`insert into v1_master_links (org_id, entity, v1_store_id, v1_id, v2_id, created_by) values (${orgId}, 'supplier', ${L}, 'sup1', ${sup!.id}, ${p!.id})`;
  const cash = await moneyAcct(orgId, storeA.id, uid('Till'), 'cash', '1110', 'cashier');
  const gcash = await moneyAcct(orgId, storeA.id, uid('GCash'), 'ewallet', '1140', 'cashier');
  const staff = await moneyAcct(orgId, storeA.id, uid('Float'), 'cash', '1120', 'staff');
  return { orgId, storeA, storeB, admin: { orgId, personId: p!.id } as Actor, personId: p!.id, verifierId: v!.id, supId: sup!.id, cash, gcash, staff };
}

interface LineIn { accountCode: string; storeId?: string | null; partyType?: string; partyId?: string; debit?: string; credit?: string }
const post = (f: Fx, i: { date: string; sourceType: string; sourceId: string; lines: LineIn[] }) =>
  withOrgPrincipal(f.orgId, (tx) =>
    postEntry(tx, { orgId: f.orgId, entryDate: i.date, sourceType: i.sourceType, sourceId: i.sourceId, idempotencyKey: uid('k'), lines: i.lines }),
  );
const saleLines = (storeId: string | null, cash: string, wallet?: { id: string; amount: string }): LineIn[] => {
  const lines: LineIn[] = [{ accountCode: '1110', storeId, debit: cash }];
  let total = Number(cash);
  if (wallet) {
    lines.push({ accountCode: '1140', storeId, partyType: 'money_account', partyId: wallet.id, debit: wallet.amount });
    total += Number(wallet.amount);
  }
  lines.push({ accountCode: '4100', storeId, credit: total.toFixed(2) });
  return lines;
};
const postCashSale = (f: Fx, date: string, amount: string, storeId: string | null = f.storeA.id) =>
  post(f, { date, sourceType: 'sale', sourceId: uid('s'), lines: saleLines(storeId, amount) });

/** A DRAFT journal entry by raw SQL (postEntry only posts). */
async function rawDraft(f: Fx, date: string, storeId: string, amount: string) {
  return sql.begin(async (t) => {
    const [pe] = await t<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and ${date}::date between starts_on and ends_on`;
    const [e] = await t<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${pe!.id}, 'sale', ${uid('draft')}, 'draft') returning id`;
    const acct = async (code: string) => (await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${code}`)[0]!.id;
    await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${await acct('1110')}, ${storeId}, ${amount}, 0)`;
    await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${await acct('4100')}, ${storeId}, 0, ${amount})`;
  });
}

async function realDay(f: Fx, storeId: string, date: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${storeId}, ${date}, 'verified', '1000.00', '1000.00', '0.00', ${f.personId}) returning id`;
  const feed = async (n: number) =>
    (await sql<{ id: string }[]>`
      insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
      values (${f.orgId}, ${storeId}, ${date}, 'sales', 'recheck', ${randomUUID()}, 'pos-x', '{"found":true}', '{"found":true}'::jsonb,
        ${String(n).repeat(64)}, now(), ${f.personId}) returning id`)[0]!.id;
  return { dayId: d!.id, storeId, date, fromFeed: await feed(1), toFeed: await feed(2) };
}
async function posCorrection(f: Fx, day: Awaited<ReturnType<typeof realDay>>, entryDate: string, amount: string) {
  const correctionId = randomUUID();
  const e = await post(f, {
    date: entryDate, sourceType: 'sale', sourceId: correctionId,
    lines: [{ accountCode: '4100', storeId: day.storeId, debit: amount }, { accountCode: '1110', storeId: day.storeId, credit: amount }],
  });
  await sql`
    insert into sales_day_pos_corrections (id, org_id, store_id, sales_day_id, from_feed_id, to_feed_id, entry_date, journal_entry_id, reason, posted_by)
    values (${correctionId}, ${f.orgId}, ${day.storeId}, ${day.dayId}, ${day.fromFeed}, ${day.toFeed}, ${entryDate}, ${e.entryId}, 'POS changed', ${f.personId})`;
  return { correctionId, entryId: e.entryId };
}

const INV_CODES = ['1310', '1320', '1330', '1340', '5100', '5110', '5120', '5130', '5140', '5150', '5160', '5170', '5175', '5200', '5300', '5400', '5450'];
/** n seeded NON-COGS categories with DISTINCT non-null account codes outside the inventory list. */
async function categories(f: Fx, n: number) {
  return sql<{ id: string; account_code: string }[]>`
    select id, account_code from expense_categories
    where org_id = ${f.orgId} and account_code is not null and "group" <> 'COGS'
      and not (account_code = any(${sql.array(INV_CODES)}))
      and account_code in (select account_code from expense_categories where org_id = ${f.orgId} and account_code is not null group by 1 having count(*) = 1)
    order by account_code limit ${n}`;
}
async function cogsCategory(f: Fx): Promise<string> {
  const [c] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and "group" = 'COGS' and account_code is not null order by account_code limit 1`;
  return c!.id;
}

async function invoiceRow(
  f: Fx,
  o: { storeId?: string; supplierId?: string; no: string | null; date: string; total: string; status: 'pending' | 'verified' | 'voided' },
): Promise<string> {
  const storeId = o.storeId ?? f.storeA.id;
  const supplierId = o.supplierId ?? f.supId;
  if (o.status === 'verified') {
    const [r] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, verified_by, verified_at,
        attested_supplier, attested_invoice, attested_items, attested_price, created_by)
      values (${f.orgId}, ${storeId}, ${supplierId}, ${o.no}, ${o.date}, ${o.total}, 'verified', ${f.verifierId}, now(), true, true, true, true, ${f.personId}) returning id`;
    return r!.id;
  }
  if (o.status === 'voided') {
    const [r] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, voided_by, voided_at, void_reason, created_by)
      values (${f.orgId}, ${storeId}, ${supplierId}, ${o.no}, ${o.date}, ${o.total}, 'voided', ${f.verifierId}, now(), 'fixture void', ${f.personId}) returning id`;
    return r!.id;
  }
  const [r] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, created_by)
    values (${f.orgId}, ${storeId}, ${supplierId}, ${o.no}, ${o.date}, ${o.total}, 'pending', ${f.personId}) returning id`;
  return r!.id;
}

/** An expenses row. A verified invoice backs it (the trigger demands one); `invoiceNo` names that invoice's number. */
async function expenseRow(
  f: Fx,
  o: { categoryId: string; date: string; amount: string; status: 'draft' | 'posted'; storeId?: string; invoiceNo?: string | null },
): Promise<string> {
  const storeId = o.storeId ?? f.storeA.id;
  const inv = await invoiceRow(f, { storeId, no: o.invoiceNo ?? null, date: o.date, total: o.amount, status: 'verified' });
  const [x] = await sql<{ id: string }[]>`
    insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
    values (${f.orgId}, ${storeId}, ${o.date}, ${o.amount}, ${o.categoryId}, ${f.supId}, ${inv}, 'fixture', ${o.status}, ${f.personId}) returning id`;
  return x!.id;
}
const paymentRow = (expenseId: string, method: 'cash' | 'online' | 'credit', amount: string, moneyAccountId: string | null) =>
  sql`insert into expense_payments (expense_id, method, amount, money_account_id) values (${expenseId}, ${method}, ${amount}, ${moneyAccountId})`;

/** A posted expense: the row plus its entry (Dr category account, Cr 1110), exactly the shape S3's F4a uses. */
async function postedExpense(f: Fx, categoryId: string, code: string, date: string, amount: string, invoiceNo: string | null = null) {
  const id = await expenseRow(f, { categoryId, date, amount, status: 'posted', invoiceNo });
  await post(f, {
    date, sourceType: 'expense_payment', sourceId: id,
    lines: [{ accountCode: code, storeId: f.storeA.id, debit: amount }, { accountCode: '1110', storeId: f.storeA.id, credit: amount }],
  });
  return id;
}

const docsOf = (f: Fx, storeId: string, w = W19, asOrgId = f.orgId, forOrg = f.orgId): Promise<V2Doc[]> =>
  asOrg(asOrgId, (tx) => repo().v2Documents(tx, forOrg, { storeId, ...w }));
const cents = (s: string): number => Math.round(Number(s) * 100);
const gk = (d: { kind: string; glCode: string; partyType: string | null; partyId: string | null; categoryId?: string | null }): string =>
  `${d.kind}|${d.glCode}|${d.partyType ?? ''}|${d.partyId ?? ''}|${d.categoryId ?? ''}`;

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ======================================================================================================
// inv 38 - the v2 reader's documents add up to v2Figures
// ======================================================================================================
interface Big {
  f: Fx;
  ids: Record<string, string>;
  cat: { id: string; account_code: string };
}
let bigMemo: Promise<Big> | undefined;
function big(): Promise<Big> {
  bigMemo ??= (async () => {
    const f = await fixture('big');
    const ids: Record<string, string> = {};
    const [cat] = await categories(f, 1);
    ids.s1 = uid('s1');
    await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: ids.s1, lines: saleLines(f.storeA.id, '1000.00') });
    await post(f, { date: '2026-10-21', sourceType: 'sale', sourceId: uid('s2'), lines: saleLines(f.storeA.id, '400.00', { id: f.gcash, amount: '300.00' }) });
    // a reversal pair: sale on 21 Oct, reversed on 23 Oct
    const s2b = await post(f, { date: '2026-10-21', sourceType: 'sale', sourceId: uid('s2b'), lines: saleLines(f.storeA.id, '500.00') });
    await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: s2b.entryId, reason: 'void', reversalDate: '2026-10-23' }));
    // a real POS day on 24 Oct and its re-dated correction, entered on 28 Oct (through + 3)
    const day = await realDay(f, f.storeA.id, '2026-10-24');
    ids.pos = day.dayId;
    await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: day.dayId, lines: saleLines(f.storeA.id, '1000.00') });
    const corr = await posCorrection(f, day, '2026-10-28', '50.00');
    ids.corr = corr.correctionId;
    await postCashSale(f, '2026-10-16', '200.00'); // week - 3
    await postCashSale(f, '2026-10-28', '400.00'); // through + 3
    await postCashSale(f, '2026-10-10', '11.00'); // before the window
    await postCashSale(f, '2026-11-03', '12.00'); // after the window
    await rawDraft(f, '2026-10-22', f.storeA.id, '77.00'); // a draft ENTRY: nothing
    await postCashSale(f, '2026-10-22', '33.00', null); // no store: unassigned_store, never emitted
    await postCashSale(f, '2026-10-22', '44.00', f.storeB.id); // another store
    ids.exp = await postedExpense(f, cat!.id, cat!.account_code, '2026-10-22', '300.00', 'EXP-INV-9');
    const ch = randomUUID();
    ids.ch = ch;
    await post(f, {
      date: '2026-10-21', sourceType: 'sale', sourceId: uid('chs'),
      lines: [{ accountCode: '1220', storeId: f.storeA.id, partyType: 'channel', partyId: ch, debit: '250.00' }, { accountCode: '4100', storeId: f.storeA.id, credit: '250.00' }],
    });
    await post(f, {
      date: '2026-10-22', sourceType: 'ar_charge', sourceId: uid('chg'),
      lines: [{ accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: randomUUID(), debit: '150.00' }, { accountCode: '4100', storeId: f.storeA.id, credit: '150.00' }],
    });
    ids.inv = await invoiceRow(f, { no: 'SI-00123', date: '2026-10-23', total: '800.00', status: 'verified' });
    await post(f, {
      date: '2026-10-23', sourceType: 'stock_receipt_invoice', sourceId: ids.inv,
      lines: [{ accountCode: '1310', storeId: f.storeA.id, debit: '800.00' }, { accountCode: '2110', storeId: f.storeA.id, partyType: 'supplier', partyId: f.supId, credit: '800.00' }],
    });
    return { f, ids, cat: cat! };
  })();
  return bigMemo;
}

describe('inv 38 (v2 side) - the posted documents add up to the v2 figures', () => {
  // Mutants: v2Documents' status filter differs from v2Figures' (a reversed original or its reversal lost); a correction dated by its
  // entry date (the 24 Oct tender would read 1000.00, and the 28 Oct docs would carry the -50.00); unassigned_store emitted.
  it(
    'per (kind, gl, party, category), the posted docs dated in the week sum to the v2Figures line, over a reversal pair, a re-dated POS correction, a draft entry and docs at week-3 and through+3. Red today: v2Documents does not exist',
    async () => {
      const { f } = await big();
      const docs = await docsOf(f, f.storeA.id);
      const figures = await asOrg(f.orgId, (tx) => repo().v2Figures(tx, f.orgId, { storeId: f.storeA.id, ...W19 }));
      const inWeek = (d: V2Doc): boolean => d.date >= W19.weekStart && d.date <= W19.through;
      const got = new Map<string, number>();
      for (const d of docs.filter((x) => x.state === 'posted' && inWeek(x))) got.set(gk(d), (got.get(gk(d)) ?? 0) + cents(d.amount));
      const want = new Map<string, number>();
      for (const l of figures.lines.filter((x) => x.kind !== 'unassigned_store')) want.set(gk(l), cents(l.amount));
      expect(want.size, 'the fixture must exercise many figure lines').toBeGreaterThanOrEqual(8);
      for (const [k, v] of want) expect(got.get(k) ?? 0, `Σ docs of ${k}`).toBe(v);
      for (const [k, v] of got) if (v !== 0) expect(want.get(k), `a doc group ${k} that v2Figures does not have`).toBe(v);
    },
    120_000,
  );

  it(
    'dating, window, exclusions: the correction is dated 24 Oct on sales_tender, a reversal pair under one root emits nothing on sales_tender, the 16 Oct and 28 Oct docs are present, 10 Oct / 3 Nov / the store-less / the other store / the draft entry are not. Red today: v2Documents does not exist',
    async () => {
      const { f, ids } = await big();
      const docs = await docsOf(f, f.storeA.id);
      const corr = docs.find((d) => d.id.startsWith(`v2:sale:${ids.corr}:sales_tender:`));
      expect(corr, 'the correction is its own sales_tender doc').toMatchObject({ kind: 'sales_tender', glCode: '1110', date: '2026-10-24', amount: '-50.00', state: 'posted' });
      expect(docs.find((d) => d.kind === 'cash_bank' && d.date === '2026-10-28' && d.amount === '-50.00'), 'cash keeps the entry date').toBeDefined();
      expect(docs.filter((d) => d.kind === 'sales_tender' && d.date === '2026-10-21' && d.glCode === '1110').map((d) => d.amount), 'the 500.00 sale and its reversal net to nothing').toEqual(['400.00']);
      expect(docs.find((d) => d.kind === 'cash_bank' && d.date === '2026-10-16')?.amount).toBe('200.00');
      expect(docs.find((d) => d.kind === 'cash_bank' && d.date === '2026-10-28' && d.amount === '400.00')).toBeDefined();
      for (const gone of ['2026-10-10', '2026-11-03']) expect(docs.some((d) => d.date === gone), gone).toBe(false);
      expect(docs.some((d) => d.kind === 'unassigned_store')).toBe(false);
      expect(docs.some((d) => d.amount === '77.00' || d.amount === '33.00' || d.amount === '44.00' || d.amount === '-77.00'), 'draft entry, store-less line, other store').toBe(false);
      expect(docs.every((d) => d.date >= '2026-10-12' && d.date <= '2026-11-01')).toBe(true);
      expect(docs.every((d) => d.state === 'posted'), 'a posted expense and sales days leave no unposted twin').toBe(true);
      expect(new Set(docs.map((d) => d.id)).size, 'ids are unique').toBe(docs.length);
    },
    120_000,
  );

  it(
    'ids and fields are as pinned, and the receipt number is the supplier invoice number for BOTH roots (stock_receipt_invoice and expense_payment); a sale root has none. Red today: v2Documents does not exist',
    async () => {
      const { f, ids, cat } = await big();
      const docs = await docsOf(f, f.storeA.id);
      const sale = docs.find((d) => d.id === `v2:sale:${ids.s1}:cash_bank:1110::2026-10-20`);
      expect(sale, JSON.stringify(docs.map((d) => d.id))).toMatchObject({ kind: 'cash_bank', glCode: '1110', partyType: null, partyId: null, date: '2026-10-20', amount: '1000.00', state: 'posted', receiptNo: null });
      const ap = docs.find((d) => d.kind === 'ap_supplier');
      expect(ap).toMatchObject({ glCode: '2110', partyType: 'supplier', partyId: f.supId, date: '2026-10-23', amount: '800.00', receiptNo: 'SI-00123' });
      expect(ap!.id).toBe(`v2:stock_receipt_invoice:${ids.inv}:ap_supplier:2110:${f.supId}:2026-10-23`);
      const ex = docs.find((d) => d.kind === 'expense_category');
      expect(ex).toMatchObject({ glCode: cat.account_code, categoryId: cat.id, date: '2026-10-22', amount: '300.00', receiptNo: 'EXP-INV-9' });
      expect(ex!.id).toBe(`v2:expense_payment:${ids.exp}:expense_category:${cat.account_code}::2026-10-22`);
      const wallet = docs.find((d) => d.kind === 'cash_bank' && d.glCode === '1140');
      expect(wallet).toMatchObject({ partyType: 'money_account', partyId: f.gcash, amount: '300.00' });
      expect(docs.find((d) => d.kind === 'sales_tender' && d.glCode === '1220')).toMatchObject({ partyType: 'channel', amount: '250.00' });
      expect(docs.find((d) => d.kind === 'sales_tender' && d.glCode === '1210')).toMatchObject({ amount: '150.00' });
      expect(typeof sale!.amount).toBe('string');
    },
    120_000,
  );
});

// ======================================================================================================
// inv 39 / 42 - unposted documents
// ======================================================================================================
describe('inv 39 (repo) - unposted documents', () => {
  it(
    'draft expenses: the category doc, the credit row as 2110 (supplier party), the cash/online/staff funding rows as negative money docs; a COGS draft emits no category doc; a posted expense emits no unposted twin. Mutants: drafts emitted as posted; drafts not emitted; draft funding side not emitted. Red today: v2Documents does not exist',
    async () => {
      const f = await fixture('u1');
      const [cat] = await categories(f, 1);
      const cogs = await cogsCategory(f);
      const x1 = await expenseRow(f, { categoryId: cat!.id, date: '2026-10-23', amount: '300.00', status: 'draft' });
      await paymentRow(x1, 'cash', '200.00', f.cash);
      await paymentRow(x1, 'online', '100.00', f.gcash);
      const x2 = await expenseRow(f, { categoryId: cat!.id, date: '2026-10-23', amount: '400.00', status: 'draft' });
      await paymentRow(x2, 'credit', '400.00', null);
      const x3 = await expenseRow(f, { categoryId: cat!.id, date: '2026-10-24', amount: '50.00', status: 'draft' });
      await paymentRow(x3, 'cash', '50.00', f.staff);
      await expenseRow(f, { categoryId: cogs, date: '2026-10-23', amount: '77.00', status: 'draft' });
      await postedExpense(f, cat!.id, cat!.account_code, '2026-10-22', '111.00');
      const docs = await docsOf(f, f.storeA.id);
      const un = docs.filter((d) => d.state === 'unposted');
      const shape = (d: V2Doc): string => `${d.kind}|${d.glCode}|${d.partyType ?? ''}|${d.partyId ?? ''}|${d.categoryId ?? ''}|${d.date}|${d.amount}`;
      expect(un.map(shape).sort()).toEqual(
        [
          `expense_category|${cat!.account_code}|||${cat!.id}|2026-10-23|300.00`,
          `cash_bank|1110||||2026-10-23|-200.00`,
          `cash_bank|1140|money_account|${f.gcash}||2026-10-23|-100.00`,
          `expense_category|${cat!.account_code}|||${cat!.id}|2026-10-23|400.00`,
          `ap_supplier|2110|supplier|${f.supId}||2026-10-23|400.00`,
          `expense_category|${cat!.account_code}|||${cat!.id}|2026-10-24|50.00`,
          `staff_cash|1120||||2026-10-24|-50.00`,
        ].sort(),
      );
      expect(new Set(un.map((d) => d.id)).size, 'unposted ids are unique').toBe(un.length);
      expect(docs.filter((d) => d.state === 'posted' && d.amount === '111.00').length, 'the posted expense stays posted').toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    'pending supplier invoice, draft ap_payment, open and submitted sales days (cash, wallet, non-remitted channel only, amount > 0); a verified day, a remitted channel and a zero channel emit nothing. Red today: v2Documents does not exist',
    async () => {
      const f = await fixture('u2');
      await invoiceRow(f, { no: 'SI-00123', date: '2026-10-21', total: '8000.00', status: 'pending' });
      await sql`insert into ap_payments (org_id, store_id, supplier_id, business_date, amount, money_account_id, status, created_by)
                values (${f.orgId}, ${f.storeA.id}, ${f.supId}, '2026-10-22', '90.00', ${f.gcash}, 'draft', ${f.personId})`;
      const chNon = (await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
        values (${f.orgId}, ${f.storeA.id}, ${uid('Grab')}, false, '1220') returning id`)[0]!.id;
      const chRem = (await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily)
        values (${f.orgId}, ${f.storeA.id}, ${uid('Walk')}, true) returning id`)[0]!.id;
      const chZero = (await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
        values (${f.orgId}, ${f.storeA.id}, ${uid('Panda')}, false, '1221') returning id`)[0]!.id;
      const day = async (date: string, status: string, cashCollected: string) =>
        (await sql<{ id: string }[]>`
          insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by, submitted_by, submitted_at)
          values (${f.orgId}, ${f.storeA.id}, ${date}, ${status}, '1200.00', '1200.00', '0.00', ${cashCollected}, ${f.personId},
                  ${status === 'submitted' ? f.personId : null}, ${status === 'submitted' ? new Date() : null}) returning id`)[0]!.id;
      const open = await day('2026-10-22', 'open', '700.00');
      await sql`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${open}, ${f.gcash}, '300.00')`;
      await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${open}, ${chNon}, '200.00')`;
      await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${open}, ${chRem}, '150.00')`;
      await sql`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${open}, ${chZero}, '0.00', true)`;
      await day('2026-10-23', 'submitted', '50.00');
      await day('2026-10-24', 'verified', '999.00');
      const un = (await docsOf(f, f.storeA.id)).filter((d) => d.state === 'unposted');
      const shape = (d: V2Doc): string => `${d.kind}|${d.glCode}|${d.partyType ?? ''}|${d.partyId ?? ''}|${d.date}|${d.amount}|${d.receiptNo ?? ''}`;
      expect(un.map(shape).sort()).toEqual(
        [
          `ap_supplier|2110|supplier|${f.supId}|2026-10-21|8000.00|SI-00123`,
          `ap_supplier|2110|supplier|${f.supId}|2026-10-22|-90.00|`,
          `sales_tender|1110|||2026-10-22|700.00|`,
          `sales_tender|1140|money_account|${f.gcash}|2026-10-22|300.00|`,
          `sales_tender|1220|channel|${chNon}|2026-10-22|200.00|`,
          `sales_tender|1110|||2026-10-23|50.00|`,
        ].sort(),
      );
    },
    120_000,
  );
});

describe('inv 42 - another store, another org, a voided invoice', () => {
  // Mutant: no store filter (store B's draft and pending invoice would appear under store A).
  it(
    "store B's draft expense, pending invoice and open day never appear under store A; a voided invoice never appears; principal B sees nothing of org A; store A's own pending invoice does appear. Red today: v2Documents does not exist",
    async () => {
      const f = await fixture('i42');
      const [cat] = await categories(f, 1);
      const mine = await invoiceRow(f, { no: 'MINE-1', date: '2026-10-21', total: '123.00', status: 'pending' });
      await invoiceRow(f, { no: 'VOIDED-1', date: '2026-10-21', total: '222.00', status: 'voided' });
      const bAcct = await moneyAcct(f.orgId, f.storeB.id, uid('BTill'), 'cash', '1110', 'cashier');
      await invoiceRow(f, { storeId: f.storeB.id, no: 'B-1', date: '2026-10-21', total: '321.00', status: 'pending' });
      const bx = await expenseRow(f, { categoryId: cat!.id, date: '2026-10-22', amount: '456.00', status: 'draft', storeId: f.storeB.id });
      await paymentRow(bx, 'cash', '456.00', bAcct);
      await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
                values (${f.orgId}, ${f.storeB.id}, '2026-10-22', 'open', '654.00', '654.00', '0.00', '654.00', ${f.personId})`;
      const a = await docsOf(f, f.storeA.id);
      expect(a.map((d) => d.amount), JSON.stringify(a)).toEqual(['123.00']);
      expect(a[0]).toMatchObject({ kind: 'ap_supplier', state: 'unposted', receiptNo: 'MINE-1' });
      expect(mine).toBeTruthy();
      const b = await docsOf(f, f.storeB.id);
      expect(b.map((d) => d.amount).sort()).toEqual(['-456.00', '321.00', '456.00', '654.00'].sort());
      // an actor of another organisation reads nothing of org A (RLS), even when it names org A's ids
      const other = await fixture('i42x');
      expect(await docsOf(f, f.storeA.id, W19, other.orgId, f.orgId)).toEqual([]);
    },
    120_000,
  );
});

// ======================================================================================================
// the run
// ======================================================================================================
const keyRows = (f: Fx, extra: KeyRow[] = []): KeyRow[] => [
  { section: 'store', v1Store: '', v1Key: L, v1Label: 'SharEat Lipa', v2Key: f.storeA.code, ticked: true },
  { section: 'store', v1Store: '', v1Key: M, v1Label: 'SharEat Malvar', v2Key: f.storeB.code, ticked: true },
  ...extra,
];
const cashKey: KeyRow = { section: 'money', v1Store: L, v1Key: 'cash__cashier', v1Label: 'cash cashier', v2Key: '1110', ticked: true };
const catKey = (entry: string, catId: string): KeyRow => ({ section: 'category', v1Store: L, v1Key: entry, v1Label: entry, v2Key: catId, ticked: true });

interface SnapOpts { expenses?: Any[]; journal?: Any[]; salesDays?: Any[]; receipts?: Any[]; extractedAt?: string; through?: string }
const snap = (o: SnapOpts = {}): Any => ({
  version: 1, from: '2026-10-19', through: o.through ?? '2026-10-25', window: { from: '2026-10-12', through: '2026-11-08' },
  extractedAt: o.extractedAt ?? '2026-10-26T01:00:00.000Z',
  stores: [{ id: L, name: 'SharEat Lipa' }, { id: M, name: 'SharEat Malvar' }],
  excludedStores: [{ id: PADRE, name: 'SharEat Padre Garcia', reason: 'not operating yet' }],
  suppliers: [{ id: 'sup1', name: 'Acme' }], paymentAccounts: [],
  journal: o.journal ?? [], expenses: o.expenses ?? [], salesDays: o.salesDays ?? [], receipts: o.receipts ?? [],
});
let legSeq = 0;
const v1Leg = (over: Any): Any => {
  legSeq += 1;
  return { id: `leg${legSeq}`, storeId: L, businessDate: '2026-10-20', sourceType: 'sale', sourceId: `src${legSeq}`, legKey: `k${legSeq}`, accountId: 'cash__cashier', direction: 'in', amount: 0, status: 'posted', ...over };
};
const v1CashSale = (date: string): Any => v1Leg({ businessDate: date, sourceId: `sale-${date}`, amount: 1000 });
const v1Expense = (id: string, group: string, amount: number, date: string, over: Any = {}): Any => ({
  id, storeId: L, dayKey: date, totalAmount: amount, status: 'posted', supplierId: 'sup1', expenseEntryId: `ent-${id}`, expenseEntryGroup: group, category: 'X', payments: [], ...over,
});
const verifiedDay = (f: Fx, date: string) =>
  sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeA.id}, ${date}, 'verified', '1000.00', '1000.00', '0.00', ${f.personId})`;
/** A trading day tied on both sides: verified v2 day + posted cash sale 1000.00; the v1 half is `v1CashSale` + `v1SalesDay`. */
async function tiedDay(f: Fx, date: string) {
  await verifiedDay(f, date);
  await postCashSale(f, date, '1000.00');
}

interface RunOver { snapshot?: Any; keysText?: string; apply?: boolean; storeCodes?: string[] }
const run = (f: Fx, o: RunOver = {}): Promise<Any> => {
  const fn = (domain as Any).runDualRun as (tx: Tx | null, actor: Actor, input: Any) => Promise<Any>;
  return asOrg(f.orgId, (tx) =>
    fn(tx, f.admin, {
      snapshot: o.snapshot ?? snap(),
      snapshotSha: uid('file').toLowerCase().padEnd(64, '0'),
      keysText: o.keysText ?? serialiseKeysCsv(keyRows(f)),
      storeCodes: o.storeCodes ?? [f.storeA.code],
      apply: o.apply ?? false,
    }),
  );
};
const weekOf = (out: Any, f: Fx, weekStart = '2026-10-19'): Any => out.weeks.find((w: Any) => w.storeCode === f.storeA.code && w.weekStart === weekStart);
const lineOf = (w: Any, kind: string, key: string): Any => {
  const l = w.lines.find((x: Any) => x.kind === kind && x.key === key);
  if (!l) throw new Error(`no line ${kind}/${key}; have ${w.lines.map((x: Any) => `${x.kind}/${x.key}=${x.class}`).join(', ')}`);
  return l;
};

describe('inv 39 (run) - NOT_DOUBLE_ENTERED, PENDING_V2 and the age rule, end to end', () => {
  async function scenario(dayKey: string, draft: boolean) {
    const f = await fixture('r39');
    const [cat] = await categories(f, 1);
    await tiedDay(f, '2026-10-20');
    if (draft) {
      const x = await expenseRow(f, { categoryId: cat!.id, date: dayKey, amount: '500.00', status: 'draft' });
      await paymentRow(x, 'cash', '500.00', f.cash);
    }
    const snapshot = snap({
      journal: [v1CashSale('2026-10-20'), v1Leg({ businessDate: dayKey, sourceType: 'expense_payment', sourceId: 'e1', amount: 500, direction: 'out' })],
      expenses: [v1Expense('e1', 'OPEX', 500, dayKey)],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000)],
    });
    const out = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [cashKey, catKey('ent-e1', cat!.id)])) });
    return { w: weekOf(out, f), cat: cat! };
  }

  // Mutant: R9 not wired (the lines stay UNEXPLAINED).
  it('a v1 posted expense of 500.00 with nothing in v2: the category line and the cash line are NOT_DOUBLE_ENTERED and the week is open. Red today: classes are UNEXPLAINED', async () => {
    const { w, cat } = await scenario('2026-10-24', false);
    expect(lineOf(w, 'expense_category', cat.id)).toMatchObject({ v1: 50000, v2: 0, class: 'NOT_DOUBLE_ENTERED' });
    expect(lineOf(w, 'cash_bank', '1110')).toMatchObject({ delta: 50000, class: 'NOT_DOUBLE_ENTERED' });
    expect(w.verdict).toBe('open');
  }, 120_000);

  // Mutants: drafts emitted as posted (the pair is silently exact and the delta stays unexplained); drafts not emitted; the draft funding side not emitted.
  it('a v2 DRAFT expense with the same category, date and amount and a matching cash payment row: both lines PENDING_V2; 1 day before through the week is explained, 3 days it is open. Red today: classes are UNEXPLAINED', async () => {
    const near = await scenario('2026-10-24', true);
    expect(lineOf(near.w, 'expense_category', near.cat.id)).toMatchObject({ class: 'PENDING_V2', paired: false });
    expect(lineOf(near.w, 'cash_bank', '1110')).toMatchObject({ class: 'PENDING_V2', paired: false });
    expect(near.w).toMatchObject({ verdict: 'explained', comparedDays: 1 });
    const far = await scenario('2026-10-22', true);
    expect(lineOf(far.w, 'expense_category', far.cat.id).class).toBe('PENDING_V2');
    expect(far.w.verdict).toBe('open');
  }, 180_000);
});

describe('inv 40 (run) - DATE_SHIFT across the week boundary, both weeks', () => {
  async function scenario(v1Receipt: string | null, v2InvoiceNo: string | null) {
    const f = await fixture('r40');
    const [cat] = await categories(f, 1);
    await tiedDay(f, '2026-10-20');
    await tiedDay(f, '2026-10-27');
    await postedExpense(f, cat!.id, cat!.account_code, '2026-10-26', '500.00', v2InvoiceNo);
    const snapshot = snap({
      through: '2026-11-01',
      journal: [v1CashSale('2026-10-20'), v1CashSale('2026-10-27'), v1Leg({ businessDate: '2026-10-25', sourceType: 'expense_payment', sourceId: 'e40', amount: 500, direction: 'out' })],
      expenses: [v1Expense('e40', 'OPEX', 500, '2026-10-25', v1Receipt ? { receiptId: 'rc40' } : {})],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000), v1SalesDay(L, '2026-10-27', 1000)],
      receipts: v1Receipt ? [{ id: 'rc40', storeId: L, receiptNo: v1Receipt }] : [],
    });
    const out = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [cashKey, catKey('ent-e40', cat!.id)])) });
    return { w19: weekOf(out, f, '2026-10-19'), w26: weekOf(out, f, '2026-10-26'), cat: cat! };
  }

  // Mutant: the doc window is the week only.
  it('no receipt number: the Sunday expense and the Monday expense (and their cash lines) are DATE_SHIFT, paired, in both weeks, and both weeks are explained. Red today: UNEXPLAINED', async () => {
    const { w19, w26, cat } = await scenario(null, null);
    for (const w of [w19, w26]) {
      expect(lineOf(w, 'expense_category', cat.id)).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(lineOf(w, 'cash_bank', '1110')).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(w.verdict).toBe('explained');
    }
  }, 120_000);

  it('the same number once normalised ("si-00200" / "SI 00200") pairs; two different numbers never do. Red today: UNEXPLAINED', async () => {
    const same = await scenario('si-00200', 'SI 00200');
    for (const w of [same.w19, same.w26]) {
      expect(lineOf(w, 'expense_category', same.cat.id)).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(w.verdict).toBe('explained');
    }
    const diff = await scenario('SI-00201', 'SI-00200');
    for (const w of [diff.w19, diff.w26]) {
      expect(lineOf(w, 'expense_category', diff.cat.id).class).not.toBe('DATE_SHIFT');
      expect(w.verdict).toBe('open');
    }
  }, 180_000);
});

describe('inv 41 (run) - AP_AT_INVOICE by receipt number', () => {
  async function scenario(v1Receipt: string, v2InvoiceNo: string) {
    const f = await fixture('r41');
    await tiedDay(f, '2026-10-20');
    const inv = await invoiceRow(f, { no: v2InvoiceNo, date: '2026-10-27', total: '8000.00', status: 'verified' });
    await post(f, {
      date: '2026-10-27', sourceType: 'stock_receipt_invoice', sourceId: inv,
      lines: [{ accountCode: '1310', storeId: f.storeA.id, debit: '8000.00' }, { accountCode: '2110', storeId: f.storeA.id, partyType: 'supplier', partyId: f.supId, credit: '8000.00' }],
    });
    const snapshot = snap({
      journal: [v1CashSale('2026-10-20'), v1Leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex41', accountId: 'ap__sup1', amount: 8000, supplierId: 'sup1' })],
      expenses: [v1Expense('ex41', 'COGS', 8000, '2026-10-21', { receiptId: 'rc41' })],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000)],
      receipts: [{ id: 'rc41', storeId: L, receiptNo: v1Receipt }],
    });
    const out = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [cashKey])) });
    return { w: weekOf(out, f), f };
  }

  // Mutants: receiptId ignored (the pair falls to DATE_SHIFT); no normalisation.
  it('v1 credit expense 8,000.00 on 21 Oct with receipt "SI-00123", v2 stock_receipt_invoice "si00123" on 27 Oct: the week of 19 Oct has AP_AT_INVOICE, paired, and is explained. Red today: UNEXPLAINED', async () => {
    const { w, f } = await scenario('SI-00123', 'si00123');
    expect(lineOf(w, 'ap_supplier', f.supId)).toMatchObject({ v1: 800000, v2: 0, class: 'AP_AT_INVOICE', paired: true });
    expect(w.verdict).toBe('explained');
  }, 120_000);

  it('invoice "SI-00124" is not AP_AT_INVOICE: the line is NOT_DOUBLE_ENTERED and the week open. Red today: UNEXPLAINED', async () => {
    const { w, f } = await scenario('SI-00123', 'SI-00124');
    const l = lineOf(w, 'ap_supplier', f.supId);
    expect(l.class).not.toBe('AP_AT_INVOICE');
    expect(l.class).toBe('NOT_DOUBLE_ENTERED');
    expect(w.verdict).toBe('open');
  }, 120_000);

  // Mutant: "--" normalises to "" and is linked as "rn:" - it would pair as AP_AT_INVOICE and link every such document to every other.
  it('a receipt number of "--" on both sides links nothing: the pair falls back to DATE_SHIFT, never AP_AT_INVOICE. Red today: UNEXPLAINED', async () => {
    const { w, f } = await scenario('--', '--');
    const l = lineOf(w, 'ap_supplier', f.supId);
    expect(l.class).toBe('DATE_SHIFT');
    expect(l.paired).toBe(true);
  }, 120_000);
});

describe('inv 43 (run) - documents outside the week do not make data', () => {
  // Mutant: docs counted in `empty`. (Green on HEAD only because no docs are passed yet; it kills the mutant once they are.)
  it('a week with no figures on either side whose only docs fall at week-2 and through+2 stays no_data with no lines', async () => {
    const f = await fixture('r43');
    const [cat] = await categories(f, 1);
    await postCashSale(f, '2026-10-27', '1000.00'); // through + 2: a posted v2 doc outside the week
    await expenseRow(f, { categoryId: cat!.id, date: '2026-10-27', amount: '700.00', status: 'draft' });
    await invoiceRow(f, { no: 'LATE-1', date: '2026-10-17', total: '90.00', status: 'pending' }); // week - 2
    const snapshot = snap({ expenses: [v1Expense('old', 'OPEX', 123, '2026-10-17')] }); // v1 doc at week - 2
    const out = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [cashKey, catKey('ent-old', cat!.id)])) });
    expect(weekOf(out, f)).toMatchObject({ verdict: 'no_data', comparedDays: 0, lineCount: 0 });
  }, 120_000);
});

describe('inv 44 (run) - documents are in the R8 identity', () => {
  // Mutant: insertion-order docs / docs left out of the fingerprint (the draft would be invisible to the identity).
  it('a v2 draft appearing after a report exists changes ONLY the documents, and that is a NEW version (the old one intact); the next identical apply is unchanged. Red today: the second apply says unchanged', async () => {
    const f = await fixture('r44');
    const [cat] = await categories(f, 1);
    await tiedDay(f, '2026-10-20');
    const snapshot = snap({ journal: [v1CashSale('2026-10-20')], salesDays: [v1SalesDay(L, '2026-10-20', 1000)] });
    const keysText = serialiseKeysCsv(keyRows(f, [cashKey]));
    const first = await run(f, { snapshot, keysText, apply: true });
    expect(weekOf(first, f)).toMatchObject({ status: 'inserted', verdict: 'ties' });
    const id1 = weekOf(first, f).reportId;
    const linesBefore = await sql<Any[]>`select kind, line_key, v1_amount::text a, v2_amount::text b from dual_run_lines where report_id = ${id1} order by kind, line_key`;
    const x = await expenseRow(f, { categoryId: cat!.id, date: '2026-10-23', amount: '500.00', status: 'draft' });
    await paymentRow(x, 'cash', '500.00', f.cash);
    const second = await run(f, { snapshot, keysText, apply: true });
    expect(weekOf(second, f).status).toBe('inserted');
    const id2 = weekOf(second, f).reportId;
    expect(id2).not.toBe(id1);
    const third = await run(f, { snapshot, keysText, apply: true });
    expect(weekOf(third, f)).toMatchObject({ status: 'unchanged', reportId: id2 });
    const linesAfter = await sql<Any[]>`select kind, line_key, v1_amount::text a, v2_amount::text b from dual_run_lines where report_id = ${id1} order by kind, line_key`;
    expect(linesAfter).toEqual(linesBefore);
    const [{ n }] = await sql<Any[]>`select count(*)::int n from dual_run_reports where org_id = ${f.orgId} and store_id = ${f.storeA.id}`;
    expect(n).toBe(2);
  }, 180_000);
});

describe('orchestrator request - a ticked keys-sheet row channel__grab1 -> channel:<uuid> ties end to end', () => {
  // Proves the domain's private keyMapFor maps a parsed `money` row onto sales_tender. (Green on HEAD: S1b already built the pieces.)
  // Mutant: keyMapFor ignoring channel__ rows (the v1 line would stay v1:channel__grab1, UNMAPPED_KEY, and the v2 line UNEXPLAINED).
  it('the v1 channel charge leg 1,250.00 and the v2 1220 debit of that channel on the same day are ONE line keyed channel:<uuid>, delta 0, TIES', async () => {
    const f = await fixture('chan');
    const ch = randomUUID();
    await post(f, {
      date: '2026-10-21', sourceType: 'sale', sourceId: uid('chs'),
      lines: [{ accountCode: '1220', storeId: f.storeA.id, partyType: 'channel', partyId: ch, debit: '1250.00' }, { accountCode: '4100', storeId: f.storeA.id, credit: '1250.00' }],
    });
    const chargeLeg = v1Leg({ businessDate: '2026-10-21', sourceType: 'sale', sourceId: 'ch_grab1_2026-10-21', legKey: 'ar:channel_grab1', accountId: 'ar__channel_grab1', amount: 1250 });
    const row: KeyRow = { section: 'money', v1Store: L, v1Key: 'channel__grab1', v1Label: 'Grab Lipa', v2Key: `channel:${ch}`, ticked: true };
    const out = await run(f, { snapshot: snap({ journal: [chargeLeg] }), keysText: serialiseKeysCsv(keyRows(f, [row])) });
    const w = weekOf(out, f);
    const tender = w.lines.filter((l: Any) => l.kind === 'sales_tender');
    expect(tender.map((l: Any) => l.key), JSON.stringify(tender)).toEqual([`channel:${ch}`]);
    expect(tender[0]).toMatchObject({ v1: 125000, v2: 125000, delta: 0, class: 'TIES' });
  }, 120_000);
});
