/**
 * T-602 S5 - the AR/AP sub-ledger CTEs are narrowed to the org and the rows asked for (docs/tasks/602-performance-first-pass.md S5), and DEF-919: the aging
 * buckets are the exact SQL text, not a float round trip.
 *
 *  F1  AP `openItems`, `openItemsForStores` (org-wide and a store subset) and `aging` (one store, org-wide), AR `openItems` and `aging` (one store, org-wide)
 *      return exactly the rows and strings the PRE-change SQL returns (a copy kept below, mapped the way the old repo mapped it), on two orgs that carry partial
 *      payments, allocations, a non-posted payment, write-offs, a voided invoice and a draft expense. The other org's rows must change nothing.
 *  F2  plan: AP `aging` for one store reaches `expense_payments` by `expense_payments_expense_id_idx` and has no Seq Scan on it. MUTANT: delete the `credit`
 *      semi-join -> the assertion goes red (recorded in the commit).
 *  F3  DEF-919: ordinary buckets equal the SQL text to the centavo; the largest legal single bucket survives. The spec's drift fixture (150 invoices of
 *      999,999,999,999.99 + one of 0.51, bucket 149999999999999.01) is pinned as it ACTUALLY behaves - see the STOP-AND-REPORT note on that test.
 *
 * Rows are inserted raw inside a transaction that is ALWAYS rolled back, with `session_replication_role = replica` (the test role is a superuser) so the
 * fixture needs no organisation, person or ledger; the queries under test are pure reads.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { sql as dsql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { apRepo, arRepo, type Tx } from '@shareat/db';
import { pinPlan } from './_fixtures/plan-pins';

// The test URL's role (a superuser) so session_replication_role can be set; the app pool's role may not.
const pg = postgres(url, { max: 1 });
const db = drizzle(pg);
afterAll(async () => {
  await pg.end({ timeout: 5 });
});

class Rollback extends Error {}
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await db.transaction(async (dtx) => {
      const tx = dtx as unknown as Tx;
      await tx.execute(dsql`set local session_replication_role = replica`);
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return value as T;
}

const id = () => randomUUID();
const rowsOf = async (tx: Tx, q: SQL) => (await tx.execute(q)) as unknown as Record<string, string>[];

// ------------------------------------------------------------------------------------------------ fixture
interface Org {
  orgId: string;
  storeA: string;
  storeB: string;
  supS1: string;
  supS2: string;
  custC1: string;
  custC2: string;
}
const newOrg = (): Org => ({ orgId: id(), storeA: id(), storeB: id(), supS1: id(), supS2: id(), custC1: id(), custC2: id() });

/** One AP invoice + posted expense + credit payment(s). Returns the expense id. */
async function expense(
  tx: Tx,
  o: Org,
  x: { supplier: string; store: string; credit: string[]; cash?: string; status?: string; invoiceStatus?: string; date: string; due?: string | null },
): Promise<string> {
  const inv = id();
  const exp = id();
  const total = x.credit.reduce((a, c) => a + Number(c), 0) + Number(x.cash ?? 0);
  await tx.execute(dsql`
    insert into supplier_invoices (id, org_id, store_id, supplier_id, invoice_date, due_date, total_amount, created_by, status, voided_by, voided_at, void_reason)
    values (${inv}, ${o.orgId}, ${x.store}, ${x.supplier}, ${x.date}, ${x.due ?? null}, ${total.toFixed(2)}, ${id()}, ${x.invoiceStatus ?? 'pending'},
            ${x.invoiceStatus === 'voided' ? id() : null}, ${x.invoiceStatus === 'voided' ? new Date().toISOString() : null}, ${x.invoiceStatus === 'voided' ? 'test' : null})`);
  await tx.execute(dsql`
    insert into expenses (id, org_id, store_id, business_date, total_amount, category_id, supplier_id, particulars, created_by, supplier_invoice_id, status)
    values (${exp}, ${o.orgId}, ${x.store}, ${x.date}, ${total.toFixed(2)}, ${id()}, ${x.supplier}, ${'inv ' + exp.slice(0, 4)}, ${id()}, ${inv}, ${x.status ?? 'posted'})`);
  for (const c of x.credit) await tx.execute(dsql`insert into expense_payments (expense_id, method, amount) values (${exp}, 'credit', ${c})`);
  if (x.cash) await tx.execute(dsql`insert into expense_payments (expense_id, method, amount) values (${exp}, 'cash', ${x.cash})`);
  return exp;
}
async function apPayment(tx: Tx, o: Org, supplier: string, store: string, status: string, applied: [string, string][]): Promise<void> {
  const pay = id();
  const amount = applied.reduce((a, [, n]) => a + Number(n), 0).toFixed(2);
  await tx.execute(dsql`
    insert into ap_payments (id, org_id, store_id, supplier_id, business_date, amount, money_account_id, created_by, status)
    values (${pay}, ${o.orgId}, ${store}, ${supplier}, '2026-02-01', ${amount}, ${id()}, ${id()}, ${status})`);
  for (const [exp, n] of applied) await tx.execute(dsql`insert into ap_payment_allocations (ap_payment_id, expense_id, amount_applied) values (${pay}, ${exp}, ${n})`);
}
async function charge(tx: Tx, o: Org, x: { customer: string; store: string; total: string; date: string; due?: string | null; status?: string }): Promise<string> {
  const ch = id();
  await tx.execute(dsql`
    insert into ar_charges (id, org_id, store_id, customer_id, charge_date, due_date, total_amount, revenue_account_code, created_by, status)
    values (${ch}, ${o.orgId}, ${x.store}, ${x.customer}, ${x.date}, ${x.due ?? null}, ${x.total}, '4150', ${id()}, ${x.status ?? 'posted'})`);
  return ch;
}
async function collection(tx: Tx, o: Org, customer: string, store: string, status: string, applied: [string, string][]): Promise<void> {
  const col = id();
  const amount = applied.reduce((a, [, n]) => a + Number(n), 0).toFixed(2);
  await tx.execute(dsql`
    insert into ar_collections (id, org_id, store_id, customer_id, collection_date, amount, money_account_id, created_by, status)
    values (${col}, ${o.orgId}, ${store}, ${customer}, '2026-02-01', ${amount}, ${id()}, ${id()}, ${status})`);
  for (const [ch, n] of applied) await tx.execute(dsql`insert into ar_collection_allocations (ar_collection_id, ar_charge_id, amount_applied) values (${col}, ${ch}, ${n})`);
}
async function writeOff(tx: Tx, o: Org, chargeId: string, amount: string): Promise<void> {
  await tx.execute(dsql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by) values (${o.orgId}, ${chargeId}, ${amount}, 'test', ${id()}, ${id()})`);
}

/** The same shape of books for one org: every case the filters could get wrong. */
async function seedOrg(tx: Tx, o: Org): Promise<void> {
  const e1 = await expense(tx, o, { supplier: o.supS1, store: o.storeA, credit: ['1000.00'], date: '2026-01-05', due: '2026-01-20' });
  await expense(tx, o, { supplier: o.supS1, store: o.storeA, credit: ['300.00', '200.00'], cash: '50.00', date: '2025-12-01' }); // two credit rows, no due date
  const e3 = await expense(tx, o, { supplier: o.supS1, store: o.storeB, credit: ['300.00'], date: '2025-10-01', due: '2025-10-15' }); // fully allocated
  await expense(tx, o, { supplier: o.supS2, store: o.storeA, credit: ['250.50'], date: '2026-02-10', invoiceStatus: 'voided' });
  await expense(tx, o, { supplier: o.supS2, store: o.storeA, credit: ['77.77'], date: '2026-02-11', status: 'draft' });
  await expense(tx, o, { supplier: o.supS2, store: o.storeB, credit: ['999999999999.99'], date: '2025-01-01', due: '2025-02-01' }); // the biggest legal row
  const e7 = await expense(tx, o, { supplier: o.supS2, store: o.storeB, credit: ['10.10', '0.20'], date: '2026-02-12', due: '2026-03-01' });
  await apPayment(tx, o, o.supS1, o.storeA, 'posted', [[e1, '400.00']]);
  await apPayment(tx, o, o.supS1, o.storeA, 'draft', [[e1, '100.00']]); // not posted: must not reduce the balance
  await apPayment(tx, o, o.supS1, o.storeB, 'posted', [[e3, '300.00']]);
  await apPayment(tx, o, o.supS2, o.storeB, 'posted', [[e7, '0.30']]);

  const c1 = await charge(tx, o, { customer: o.custC1, store: o.storeA, total: '1000.00', date: '2026-01-10', due: '2026-01-25' });
  const c2 = await charge(tx, o, { customer: o.custC1, store: o.storeA, total: '500.00', date: '2025-11-01' });
  const c3 = await charge(tx, o, { customer: o.custC1, store: o.storeB, total: '200.00', date: '2025-09-01', due: '2025-09-20' });
  await charge(tx, o, { customer: o.custC2, store: o.storeA, total: '88.88', date: '2026-02-01', status: 'draft' });
  const c5 = await charge(tx, o, { customer: o.custC2, store: o.storeB, total: '1234.56', date: '2026-02-05' });
  await collection(tx, o, o.custC1, o.storeA, 'posted', [[c1, '250.00']]);
  await collection(tx, o, o.custC1, o.storeA, 'draft', [[c1, '999.00']]); // not posted
  await collection(tx, o, o.custC1, o.storeB, 'posted', [[c3, '200.00']]);
  await writeOff(tx, o, c2, '125.25');
  await writeOff(tx, o, c5, '0.06');
}

// ------------------------------------------------------------------------------------------------ the pre-change SQL, kept verbatim
const oldOpenItemsQuery = (orgId: string, filterTail: SQL, extraColumns: SQL): SQL => dsql`
    with credit as (
      select ep.expense_id, sum(ep.amount) as credit_amount
      from expense_payments ep
      where ep.method = 'credit'
      group by ep.expense_id
    ),
    allocated as (
      select apa.expense_id, sum(apa.amount_applied) as allocated_amount
      from ap_payment_allocations apa
      join ap_payments ap on ap.id = apa.ap_payment_id
      where ap.status = 'posted'
      group by apa.expense_id
    )
    select
      e.id as expense_id,
      e.supplier_id,
      e.supplier_invoice_id,
      e.store_id,
      e.business_date::text as business_date,
      e.particulars,
      c.credit_amount::text as credit_amount,
      coalesce(a.allocated_amount, 0)::text as allocated_amount,
      (c.credit_amount - coalesce(a.allocated_amount, 0))::text as outstanding
      ${extraColumns}
    from expenses e
    join credit c on c.expense_id = e.id
    left join allocated a on a.expense_id = e.id
    join supplier_invoices si on si.id = e.supplier_invoice_id
    where e.org_id = ${orgId} ${filterTail}
      and e.status = 'posted' and si.status <> 'voided'
      and (c.credit_amount - coalesce(a.allocated_amount, 0)) > 0.005
    order by e.business_date asc
  `;
const apExtra = dsql`,
      si.invoice_no as invoice_no,
      si.due_date::text as due_date,
      (select sp.name from suppliers sp where sp.id = e.supplier_id) as supplier_name,
      (select t.name from recurring_expense_drafts d
         join recurring_expenses t on t.id = d.recurring_expense_id
        where d.expense_id = e.id limit 1) as recurring_name`;
const bucketSql = (fromRel: string, outerCols: string, groupCols: string) => `
    select ${outerCols},
      coalesce(sum(outstanding) filter (where aging_date >= $ASOF), 0)::text as current,
      coalesce(sum(outstanding) filter (where aging_date < $ASOF and aging_date >= ($ASOF::date - 30)), 0)::text as d1to30,
      coalesce(sum(outstanding) filter (where aging_date < ($ASOF::date - 30) and aging_date >= ($ASOF::date - 60)), 0)::text as d31to60,
      coalesce(sum(outstanding) filter (where aging_date < ($ASOF::date - 60) and aging_date >= ($ASOF::date - 90)), 0)::text as d61to90,
      coalesce(sum(outstanding) filter (where aging_date < ($ASOF::date - 90)), 0)::text as d90plus
    from ${fromRel}
    group by ${groupCols}
    order by ${groupCols}`;
const asOfSql = (text: string, asOf: string) => dsql.raw(text.replaceAll('$ASOF', `'${asOf}'`));
const oldApAging = (orgId: string, asOf: string, storeId?: string): SQL => dsql`
    with credit as (
      select ep.expense_id, sum(ep.amount) as credit_amount
      from expense_payments ep
      where ep.method = 'credit'
      group by ep.expense_id
    ),
    allocated as (
      select apa.expense_id, sum(apa.amount_applied) as allocated_amount
      from ap_payment_allocations apa
      join ap_payments ap on ap.id = apa.ap_payment_id
      where ap.status = 'posted'
      group by apa.expense_id
    ),
    open as (
      select
        e.supplier_id,
        e.store_id,
        coalesce(si.due_date, si.invoice_date) as aging_date,
        (c.credit_amount - coalesce(a.allocated_amount, 0)) as outstanding
      from expenses e
      join credit c on c.expense_id = e.id
      left join allocated a on a.expense_id = e.id
      join supplier_invoices si on si.id = e.supplier_invoice_id
      where e.org_id = ${orgId} and e.status = 'posted'
        and (c.credit_amount - coalesce(a.allocated_amount, 0)) > 0.005
        ${storeId ? dsql`and e.store_id = ${storeId}` : dsql``}
    )
    ${asOfSql(bucketSql('open', 'supplier_id, store_id', 'supplier_id, store_id'), asOf)}
  `;
const oldArOpenItems = (orgId: string, customerId: string, storeId: string): SQL => dsql`
    with allocated as (
      select a.ar_charge_id, sum(a.amount_applied) as amt
      from ar_collection_allocations a
      join ar_collections c on c.id = a.ar_collection_id
      where c.status = 'posted'
      group by a.ar_charge_id
    ),
    written as (
      select ar_charge_id, sum(amount) as amt from ar_write_offs group by ar_charge_id
    ),
    credit_entries as (
      select o.ar_charge_id as charge_id, r.journal_entry_id as entry_id
      from customer_returns r join trade_orders o on o.id = r.trade_order_id
      where o.org_id = ${orgId} and o.ar_charge_id is not null and o.customer_id = ${customerId}
        and r.status = 'posted' and r.journal_entry_id is not null
      union
      select o.ar_charge_id, d.journal_entry_id
      from trade_discrepancies d join trade_orders o on o.id = d.order_id
      where o.org_id = ${orgId} and o.ar_charge_id is not null and o.customer_id = ${customerId}
        and d.disposition = 'franchise_credit' and d.status = 'resolved' and d.journal_entry_id is not null
    ),
    credited as (
      select ce.charge_id as ar_charge_id, sum(jl.credit - jl.debit) as amt
      from credit_entries ce
      join journal_lines jl on jl.entry_id = ce.entry_id
      join accounts a on a.id = jl.account_id
      where a.code = '1210' and a.org_id = ${orgId}
      group by ce.charge_id
    )
    select ch.id as charge_id, ch.customer_id, ch.store_id, ch.charge_date::text as charge_date,
           ch.due_date::text as due_date, ch.reference_no, ch.total_amount::text as total_amount,
           coalesce(al.amt, 0)::text as allocated_amount,
           coalesce(w.amt, 0)::text as written_off_amount,
           coalesce(cr.amt, 0)::text as credited_amount,
           (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0) - coalesce(cr.amt, 0))::text as outstanding
    from ar_charges ch
    left join allocated al on al.ar_charge_id = ch.id
    left join written w on w.ar_charge_id = ch.id
    left join credited cr on cr.ar_charge_id = ch.id
    where ch.org_id = ${orgId} and ch.customer_id = ${customerId} and ch.store_id = ${storeId}
      and ch.status = 'posted'
      and (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0) - coalesce(cr.amt, 0)) > 0.005
    order by ch.charge_date asc
  `;
const oldArAging = (orgId: string, asOf: string, storeId?: string): SQL => dsql`
    with allocated as (
      select a.ar_charge_id, sum(a.amount_applied) as amt
      from ar_collection_allocations a
      join ar_collections c on c.id = a.ar_collection_id
      where c.status = 'posted'
      group by a.ar_charge_id
    ),
    written as (
      select ar_charge_id, sum(amount) as amt from ar_write_offs group by ar_charge_id
    ),
    credit_entries as (
      select o.ar_charge_id as charge_id, r.journal_entry_id as entry_id
      from customer_returns r join trade_orders o on o.id = r.trade_order_id
      where o.org_id = ${orgId} and o.ar_charge_id is not null ${storeId ? dsql`and o.store_id = ${storeId}` : dsql``}
        and r.status = 'posted' and r.journal_entry_id is not null
      union
      select o.ar_charge_id, d.journal_entry_id
      from trade_discrepancies d join trade_orders o on o.id = d.order_id
      where o.org_id = ${orgId} and o.ar_charge_id is not null ${storeId ? dsql`and o.store_id = ${storeId}` : dsql``}
        and d.disposition = 'franchise_credit' and d.status = 'resolved' and d.journal_entry_id is not null
    ),
    credited as (
      select ce.charge_id as ar_charge_id, sum(jl.credit - jl.debit) as amt
      from credit_entries ce
      join journal_lines jl on jl.entry_id = ce.entry_id
      join accounts a on a.id = jl.account_id
      where a.code = '1210' and a.org_id = ${orgId}
      group by ce.charge_id
    ),
    open as (
      select ch.customer_id, ch.store_id,
             coalesce(ch.due_date, ch.charge_date) as aging_date,
             (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0) - coalesce(cr.amt, 0)) as outstanding
      from ar_charges ch
      left join allocated al on al.ar_charge_id = ch.id
      left join written w on w.ar_charge_id = ch.id
      left join credited cr on cr.ar_charge_id = ch.id
      where ch.org_id = ${orgId} and ch.status = 'posted'
        and (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0) - coalesce(cr.amt, 0)) > 0.005
        ${storeId ? dsql`and ch.store_id = ${storeId}` : dsql``}
    )
    ${asOfSql(bucketSql('open', 'customer_id, store_id', 'customer_id, store_id'), asOf)}
  `;

// The pre-change repo mapping: every figure through a float and back (kept so the comparison is "what the old code returned").
const f2 = (v: unknown) => Number(v).toFixed(2);
const oldBuckets = (r: Record<string, string>) => ({ current: f2(r.current), d1to30: f2(r.d1to30), d31to60: f2(r.d31to60), d61to90: f2(r.d61to90), d90plus: f2(r.d90plus) });

const ASOF = '2026-03-31';
/** The SQL text of a sum, at scale 2 (an empty bucket is the text `0`, which `money()` writes as `0.00`, as the old float mapping did). */
const scale2 = (t: string) => (t.includes('.') ? t : `${t}.00`);
const buckets = (r: Record<string, string>) => [r.current, r.d1to30, r.d31to60, r.d61to90, r.d90plus].map((t) => scale2(t!));

describe('T-602 S5 - the narrowed CTEs return what the old SQL returned', () => {
  it('F1: AP openItems / openItemsForStores / aging and AR openItems / aging equal the pre-change SQL on two orgs', async () => {
    await rolledBack(async (tx) => {
      const a = newOrg();
      const b = newOrg();
      await seedOrg(tx, a);
      await seedOrg(tx, b); // another org with the same shape: nothing of it may leak into a's figures
      let compared = 0;

      for (const [sup, store] of [[a.supS1, a.storeA], [a.supS1, a.storeB], [a.supS2, a.storeA], [a.supS2, a.storeB]] as const) {
        const old = await rowsOf(tx, oldOpenItemsQuery(a.orgId, dsql`and e.supplier_id = ${sup} and e.store_id = ${store}`, dsql`, si.invoice_no as invoice_no, si.due_date::text as due_date`));
        const now = await apRepo.openItems(tx, a.orgId, sup, store);
        expect(now).toEqual(old.map((r) => ({
          expenseId: String(r.expense_id), supplierId: String(r.supplier_id), supplierInvoiceId: String(r.supplier_invoice_id), storeId: String(r.store_id),
          businessDate: String(r.business_date), particulars: String(r.particulars), creditAmount: f2(r.credit_amount), allocatedAmount: f2(r.allocated_amount), outstanding: f2(r.outstanding),
          invoiceNo: r.invoice_no ?? null, dueDate: r.due_date ?? null,
        })));
        compared += old.length;
      }
      for (const stores of [undefined, [a.storeA], [a.storeA, a.storeB], []] as (string[] | undefined)[]) {
        const tail = stores === undefined ? dsql`` : stores.length === 0 ? dsql`and false` : dsql`and e.store_id in (${dsql.join(stores.map((s) => dsql`${s}`), dsql`, `)})`;
        const old = await rowsOf(tx, oldOpenItemsQuery(a.orgId, tail, apExtra));
        const now = await apRepo.openItemsForStores(tx, a.orgId, stores);
        expect(now).toEqual(old.map((r) => ({
          expenseId: String(r.expense_id), supplierId: String(r.supplier_id), supplierName: String(r.supplier_name ?? ''), supplierInvoiceId: String(r.supplier_invoice_id),
          invoiceNo: r.invoice_no ?? null, storeId: String(r.store_id), dueDate: r.due_date ?? null, particulars: String(r.particulars), outstanding: String(r.outstanding), recurringName: r.recurring_name ?? null,
        })));
        compared += old.length;
      }
      for (const store of [undefined, a.storeA, a.storeB]) {
        const old = await rowsOf(tx, oldApAging(a.orgId, ASOF, store));
        const now = await apRepo.aging(tx, a.orgId, ASOF, store);
        expect(now).toEqual(old.map((r) => ({ supplierId: String(r.supplier_id), storeId: String(r.store_id), ...oldBuckets(r) })));
        compared += old.length;
      }
      for (const [cust, store] of [[a.custC1, a.storeA], [a.custC1, a.storeB], [a.custC2, a.storeA], [a.custC2, a.storeB]] as const) {
        const old = await rowsOf(tx, oldArOpenItems(a.orgId, cust, store));
        const now = await arRepo.openItems(tx, a.orgId, cust, store);
        expect(now).toEqual(old.map((r) => ({
          chargeId: String(r.charge_id), customerId: String(r.customer_id), storeId: String(r.store_id), chargeDate: String(r.charge_date), dueDate: r.due_date ? String(r.due_date) : null,
          referenceNo: r.reference_no ? String(r.reference_no) : null, totalAmount: f2(r.total_amount), allocatedAmount: f2(r.allocated_amount), writtenOffAmount: f2(r.written_off_amount),
          creditedAmount: f2(r.credited_amount), outstanding: f2(r.outstanding),
        })));
        compared += old.length;
      }
      for (const store of [undefined, a.storeA, a.storeB]) {
        const old = await rowsOf(tx, oldArAging(a.orgId, ASOF, store));
        const now = await arRepo.aging(tx, a.orgId, ASOF, store);
        expect(now).toEqual(old.map((r) => ({ customerId: String(r.customer_id), storeId: String(r.store_id), ...oldBuckets(r) })));
        compared += old.length;
      }
      expect(compared, 'the fixture must actually exercise rows, or equality proves nothing').toBeGreaterThan(20);
    });
  });

  it('F2: AP aging for one store reaches expense_payments by its index and never scans it sequentially (mutant: drop the credit semi-join)', async () => {
    await rolledBack(async (tx) => {
      const a = newOrg();
      await seedOrg(tx, a);
      // T-624: 1,000 credit payments of OTHER expenses (foreign keys are off in this tx), so walking expense_payments end to end is decisively dearer than
      // probing it per expense of the store. Without them the table holds a handful of rows and the planner's choice is a coin toss that moves with CI's shared data.
      await tx.execute(dsql`insert into expense_payments (expense_id, method, amount) select gen_random_uuid(), 'credit', 1.00 from generate_series(1, 1000)`);
      await pinPlan((s) => tx.execute(dsql.raw(s)), ['expense_payments', 'expenses']);
      // The exact text apRepo.aging runs, with a store, EXPLAINed. Captured by wrapping the executor so the test cannot drift from the repo.
      const seen: string[] = [];
      const spy = new Proxy(tx, {
        get(target, prop, recv) {
          if (prop === 'execute') {
            return (q: SQL) => {
              const { sql: text, params } = (target as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } } }).dialect.sqlToQuery(q);
              seen.push(`${text}\u0000${JSON.stringify(params)}`);
              return target.execute(q);
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }) as Tx;
      await apRepo.aging(spy, a.orgId, ASOF, a.storeA);
      expect(seen).toHaveLength(1);
      const [text, params] = seen[0]!.split('\u0000');
      const literal = (JSON.parse(params!) as unknown[]).map((p) => (typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : String(p)));
      const inlined = text!.replace(/\$(\d+)/g, (_m, n) => literal[Number(n) - 1]!);
      const plan = (await rowsOf(tx, dsql.raw(`explain ${inlined}`))).map((r) => r['QUERY PLAN']).join('\n');
      // Narrowed: the index is probed BY expense id (an Index Cond), once per expense of the store. Un-narrowed it is walked end to end with no Index Cond.
      expect(plan).toMatch(/Index Scan using expense_payments_expense_id_idx on expense_payments ep[^\n]*\n\s+Index Cond: \(expense_id = /);
      expect(plan).not.toMatch(/Seq Scan on expense_payments/);
    });
  });
});

describe('T-602 S5 / DEF-919 - aging buckets are exact', () => {
  it('F3a: ordinary and the largest legal single buckets equal the SQL text to the centavo, AP and AR', async () => {
    await rolledBack(async (tx) => {
      const a = newOrg();
      await seedOrg(tx, a);
      const raw = await rowsOf(tx, oldApAging(a.orgId, ASOF));
      const now = await apRepo.aging(tx, a.orgId, ASOF);
      expect(now.map((r) => [r.current, r.d1to30, r.d31to60, r.d61to90, r.d90plus])).toEqual(raw.map(buckets));
      expect(now.some((r) => r.d90plus === '999999999999.99'), 'the biggest legal row survives as text').toBe(true);
      const rawAr = await rowsOf(tx, oldArAging(a.orgId, ASOF));
      const nowAr = await arRepo.aging(tx, a.orgId, ASOF);
      expect(nowAr.map((r) => [r.current, r.d1to30, r.d31to60, r.d61to90, r.d90plus])).toEqual(rawAr.map(buckets));
    });
  });

  /**
   * ⛔ STOP-AND-REPORT (T-602 spec S5, "If a CHECK or domain rule refuses an amount that size, stop and report it"). The spec's fixture is 150 invoices of
   * 999,999,999,999.99 + one of 0.51 in one bucket: the SQL sum is exactly 149999999999999.01 (15 integer digits), which numeric(14,2) cannot hold, so
   * `money()` (the ruled replacement for `Number(...).toFixed(2)`) refuses it with a RangeError. Below that limit the float round trip was already exact
   * (a 2-decimal value under 10^12 is within 1.2e-4 of its double), so DEF-919's drift lives ONLY in the range `money()` refuses. This test pins what the
   * code now does: the figure is exact in SQL, and the repo REFUSES it loudly instead of returning a bucket 0.01 short ('149999999999999.00' before).
   * If BOSS rules the exact string must be returned (String(r.current), no range check), flip the final expectations to the string and nothing else changes.
   */
  it('F3b: the spec drift fixture (bucket 149999999999999.01) is exact in SQL; the repo now refuses it with a RangeError instead of drifting', async () => {
    await rolledBack(async (tx) => {
      const a = newOrg();
      for (let i = 0; i < 150; i++) await expense(tx, a, { supplier: a.supS1, store: a.storeA, credit: ['999999999999.99'], date: '2026-03-31', due: '2026-04-15' });
      await expense(tx, a, { supplier: a.supS1, store: a.storeA, credit: ['0.51'], date: '2026-03-31', due: '2026-04-15' });
      const [sqlRow] = await rowsOf(tx, oldApAging(a.orgId, ASOF));
      expect(sqlRow!.current).toBe('149999999999999.01');
      expect(f2(sqlRow!.current), 'the old float mapping drifted by a centavo').toBe('149999999999999.00');
      await expect(apRepo.aging(tx, a.orgId, ASOF)).rejects.toThrow(RangeError);

      for (let i = 0; i < 151; i++) await charge(tx, a, { customer: a.custC1, store: a.storeA, total: '999999999999.99', date: '2026-03-31', due: '2026-04-15' });
      await charge(tx, a, { customer: a.custC1, store: a.storeA, total: '0.51', date: '2026-03-31', due: '2026-04-15' });
      const [arRow] = await rowsOf(tx, oldArAging(a.orgId, ASOF));
      expect(arRow!.current, 'AR: 151 x 999999999999.99 + 0.51 is a whole number of pesos, so the float happens to survive; the range is what refuses it').toBe('150999999999999.00');
      await expect(arRepo.aging(tx, a.orgId, ASOF)).rejects.toThrow(RangeError);
    });
  });
});
