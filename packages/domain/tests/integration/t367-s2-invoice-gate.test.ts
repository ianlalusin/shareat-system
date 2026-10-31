import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-367 S2 (DEF-396 + DEF-508, +DEF-518/519) — the supplier-invoice gate: lock the invoice before
 * recording or voiding against it (R4), a paid bill cannot be voided (R6), a store mismatch reads
 * as not-found (R7). `docs/tasks/367-ap-ar-money.md` §S2, legs V1-V7, X1-X2, plus refusals with
 * controls. Two-connection harness copied from `t367-s1-write-off-once.test.ts` (pid-tracked
 * barrier, `Lock`/`transactionid|tuple` wait events).
 *
 * ⛔ TESTER, not BUILDER. None of R4/R6/R7's NEW guards exist yet — `voidInvoice` takes no lock,
 * `createExpense` never compares `invoice.storeId` to `input.storeId`, and `voidExpense` never
 * checks whether the expense has already been paid. Every domain function this file calls
 * (`voidInvoice`, `createExpense`, `recordExpenseForInvoice`, `approveExpense`, `voidExpense`,
 * `recordPayment`, `voidPayment`) already exists — S2 only tightens what runs inside them — so
 * every call here is against the real, current surface; nothing is reached through a stand-in.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  voidInvoice,
  recordExpenseForInvoice,
  createExpense,
  editExpense,
  approveExpense,
  voidExpense,
  recordPayment,
  voidPayment,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture — copied shape, ap.test.ts (`fixture`, `fixtureWithSupplier`, `verifiedInvoice`), with a
// SECOND store (B) for X1/X2's cross-store legs.
// -----------------------------------------------------------------------------------------------

async function mkStorePeople(orgId: string, storeId: string, label: string) {
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${`Manager ${label}`}) returning id`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${`Staff ${label}`}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staff!.id, setBy: manager!.id });
  return { managerId: manager!.id, manager: actor(orgId, manager!.id), staffId: staff!.id, staff: actor(orgId, staff!.id) };
}

async function fixture(hint: string) {
  const code = uid(`t367s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-A`)}, ${`Store A ${hint}`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-B`)}, ${`Store B ${hint}`}) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open')`;

  const a = await mkStorePeople(orgId, storeA!.id, `${hint}-A`);
  const b = await mkStorePeople(orgId, storeB!.id, `${hint}-B`);

  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, a.manager, { name: `Supplier ${code}`, creditTermsDays: 30 }));
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  const [drawerA] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeA!.id} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fund(orgId, storeA!.id, '1130', '500000.00');
  await fund(orgId, storeB!.id, '1130', '500000.00');

  return {
    orgId, storeA: storeA!.id, storeB: storeB!.id,
    managerA: a.manager, staffA: a.staff, managerB: b.manager, staffB: b.staff,
    supplierId: supplier.id, categoryId: category!.id, drawerA: drawerA!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fund(orgId: string, storeId: string, code: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2027-02-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id`;
  return row!.id;
}

/** Records at `storeId` (staff) + verifies (the OTHER store's manager where noted, or the same
 *  store's manager by default — segregation of duties only requires a DIFFERENT person, not a
 *  different store). */
async function verifiedInvoice(f: Fixture, storeId: string, staff: Actor, manager: Actor, totalAmount: string, invoiceDate = '2027-02-03'): Promise<string> {
  const fileId = await receiptFile(f.orgId, storeId, staff.personId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, staff, { storeId, supplierId: f.supplierId, invoiceDate, totalAmount, receiptFileId: fileId }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  return created.id;
}

async function creditExpense(f: Fixture, storeId: string, manager: Actor, invoiceId: string, amount: string, particulars = 'Stock purchase') {
  return asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, manager, { storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars, payments: [{ method: 'credit', amount }] }),
  );
}

async function openItemsFor(f: Fixture, storeId: string) {
  return asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, storeId));
}
async function control2110(orgId: string, storeId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(l.credit - l.debit), 0)::text as total
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.status <> 'draft' and a.code = '2110' and l.store_id = ${storeId}`;
  return Number(row!.total).toFixed(2);
}

// -----------------------------------------------------------------------------------------------
// Two-connection concurrency harness — copied from t367-s1-write-off-once.test.ts
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function trackPid<T>(op: (tx: Tx) => Promise<T>): { op: (tx: Tx) => Promise<T>; pid: Promise<number> } {
  const pid = deferred<number>();
  return {
    pid: pid.promise,
    op: async (tx) => {
      const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
      pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
      return op(tx);
    },
  };
}
async function pollForWaitingBackend(bPid: Promise<number>, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000): Promise<{ pid: number; query: string } | null> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  return Promise.race([poll, settled.then(() => null)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function runConcurrencyLeg<TA, TB>(orgId: string, opA: (tx: Tx) => Promise<TA>, opB: (tx: Tx) => Promise<TB>, waitEvents: string[]): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aPromise: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  const waiting = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}
function settledError(s: Settled<unknown>): unknown {
  if (s.status === 'fulfilled') throw new Error('expected rejected, got fulfilled');
  return s.reason;
}
const ROW_LOCK = ['transactionid', 'tuple'];

// -----------------------------------------------------------------------------------------------
// V1/V2 — the DEF-396 race
// -----------------------------------------------------------------------------------------------

describe('V1 — void first, record second', () => {
  it('B waits, then is refused as voided; no posted expense on I; openItems empty; 2110 = 0.00 — Mutant: voidInvoice takes no lock (HEAD), B never waits and posts, red', async () => {
    const f = await fixture('v1');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'wrong invoice' }),
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars: 'race', payments: [{ method: 'credit', amount: '400.00' }] }),
      ROW_LOCK,
    );
    expect(bWaited, 'today: voidInvoice takes no lock, so B never waits').toBe(true);
    expect(bResult.status, 'B must be refused, not post against a soon-to-be-voided invoice').toBe('rejected');
    if (bResult.status === 'rejected') {
      // DEF-396/userMessage: RefusalError.message is always the raw diagnostic (refusal.ts:15);
      // the sentence a person would see is .userMessage.
      expect((settledError(bResult) as { userMessage?: string }).userMessage).toMatch(/has been voided, so nothing more can be recorded against it/);
    }
    const [posted] = await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId} and status = 'posted'`;
    expect(posted!.n).toBe('0');
    expect(await openItemsFor(f, f.storeA)).toHaveLength(0);
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
  });
});

describe('V2 — record first, void second', () => {
  it('B waits, then voids the invoice AND the new expense (a reversal exists); openItems empty; 2110 = 0.00 — Mutant: voidInvoice lock-first removed, red', async () => {
    const f = await fixture('v2');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars: 'race', payments: [{ method: 'credit', amount: '400.00' }] }),
      (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'wrong invoice' }),
      ROW_LOCK,
    );
    expect(bWaited, 'today: voidInvoice reads liveExpensesForInvoice with no lock, so it never waits for A').toBe(true);
    expect(bResult.status).toBe('fulfilled');
    const [row] = await sql<{ status: string }[]>`select status from expenses where supplier_invoice_id = ${invoiceId}`;
    expect(row!.status, 'the expense A posted must be voided too, by B\'s cascade').toBe('voided');
    expect(await openItemsFor(f, f.storeA)).toHaveLength(0);
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// V3 — openItems' second layer (R5)
// -----------------------------------------------------------------------------------------------

describe('V3 — a voided invoice (raw SQL, simulating legacy/ETL data) is excluded from openItems', () => {
  it('not listed, recordPayment refused as not open, nothing written — Mutant: R5 join absent (HEAD), listed and payment posts, red', async () => {
    const f = await fixture('v3');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');
    // Simulate legacy/ETL data: the invoice voided by raw SQL — the trigger is on `expenses`, so
    // this update never fires it.
    await sql`update supplier_invoices set status = 'voided', voided_by = ${f.managerA.personId}, voided_at = now(), void_reason = 'legacy data' where id = ${invoiceId}`;

    const open = await openItemsFor(f, f.storeA);
    expect(open, 'today: openItems has no join on supplier_invoices at all').toHaveLength(0);

    const [expenseRow] = await sql<{ id: string }[]>`select id from expenses where supplier_invoice_id = ${invoiceId}`;
    const err = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId: expenseRow!.id, amountApplied: '400.00' }] }),
    ).catch((e) => e);
    expect(err, 'today: the payment posts because openItems still lists it').toBeInstanceOf(Error);
    const [paidCount] = await sql<{ n: string }[]>`select count(*)::text as n from ap_payments where org_id = ${f.orgId}`;
    expect(paidCount!.n).toBe('0');
  });

  it('+control: the same shape but VERIFIED is listed, and the payment posts Dr 2110 400 / Cr cash 400', async () => {
    const f = await fixture('v3-pc');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');
    const open = await openItemsFor(f, f.storeA);
    expect(open).toHaveLength(1);
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }),
    );
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// V4 — capacity race
// -----------------------------------------------------------------------------------------------

describe('V4 — two recordings racing the same invoice capacity', () => {
  it('exactly one succeeds; the other gets the capacity sentence; recorded <= 1,000.00 — Mutant: no lock (HEAD), both fulfil, recorded 1,300.00, red', async () => {
    const f = await fixture('v4');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars: 'A', payments: [{ method: 'credit', amount: '700.00' }] }),
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars: 'B', payments: [{ method: 'credit', amount: '600.00' }] }),
      ROW_LOCK,
    );
    expect(bWaited, 'today: assertOpenForRecording takes no lock, so B never waits').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one must fulfil').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    if (rejected) expect((settledError(rejected) as { userMessage?: string }).userMessage).toMatch(/doesn't fit/);
    const [row] = await sql<{ recorded: string }[]>`select coalesce(sum(ep.amount), 0)::text as recorded from expenses e join expense_payments ep on ep.expense_id = e.id where e.supplier_invoice_id = ${invoiceId} and ep.method = 'credit'`;
    expect(Number(row!.recorded)).toBeLessThanOrEqual(1000);
  });

  it('+control: two DIFFERENT invoices, both succeed, B never waits', async () => {
    const f = await fixture('v4-pc');
    const invoice1 = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const invoice2 = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoice1, categoryId: f.categoryId, particulars: 'A', payments: [{ method: 'credit', amount: '400.00' }] }),
      (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoice2, categoryId: f.categoryId, particulars: 'B', payments: [{ method: 'credit', amount: '400.00' }] }),
      ROW_LOCK,
    );
    expect(bWaited).toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
  });
});

// -----------------------------------------------------------------------------------------------
// V5 — a paid bill cannot be voided (R6, DEF-519)
// -----------------------------------------------------------------------------------------------

describe('V5 — a paid bill', () => {
  it('voidInvoice refused with R6\'s sentence; I stays verified, expense posted, 2110 = 0.00, no reversal — Mutant: R6 guard absent (HEAD), voids, 2110 = -400.00, red', async () => {
    const f = await fixture('v5');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');
    await asOrg(f.orgId, (tx) => recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }));

    const err = await asOrg(f.orgId, (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'no longer needed' })).catch((e) => e);
    expect(err, 'today: voidExpense has no paid-check at all, so this succeeds').toBeInstanceOf(Error);
    // Builder's audit fix names the EXPENSE (particulars + date), not "this bill" — update to match.
    const msgV5 = (err as { userMessage?: string }).userMessage;
    expect(msgV5).toMatch(/has already been paid against Stock purchase/);
    expect(msgV5).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const [inv] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(inv!.status).toBe('verified');
    const [exp] = await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`;
    expect(exp!.status).toBe('posted');
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
  });

  it('voidExpense directly on the paid expense: same refusal', async () => {
    const f = await fixture('v5b');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');
    await asOrg(f.orgId, (tx) => recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }));
    const err = await asOrg(f.orgId, (tx) => voidExpense(tx, f.managerA, expenseId, 'no longer needed')).catch((e) => e);
    expect(err, 'today: no such guard').toBeInstanceOf(Error);
    const msgV5b = (err as { userMessage?: string }).userMessage;
    expect(msgV5b).toMatch(/has already been paid against Stock purchase/);
    expect(msgV5b).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('+control: void the PAYMENT first, then voidInvoice succeeds; 2110 = 0.00, 1110 back to its opening', async () => {
    const f = await fixture('v5-pc');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');
    const paid = await asOrg(f.orgId, (tx) => recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }));
    await asOrg(f.orgId, (tx) => voidPayment(tx, f.managerA, { paymentId: paid.paymentId, reason: 'bounced' }));
    await expect(asOrg(f.orgId, (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'no longer needed' }))).resolves.toBeUndefined();
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// V6 — payment vs void, concurrently (DEF-519's race)
// -----------------------------------------------------------------------------------------------

describe('V6 — payment vs void', () => {
  it('A pays, B voids (voidExpense): B waits, then is refused with R6\'s sentence; expense stays posted, 2110 = 0.00, exactly one payment — Mutant: voidExpense lock removed (HEAD), B never waits and voids, 2110 = -400.00, red', async () => {
    const f = await fixture('v6a');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }),
      (tx) => voidExpense(tx, f.managerA, expenseId, 'race'),
      ROW_LOCK,
    );
    expect(bWaited, 'today: voidExpense takes no row lock at all').toBe(true);
    expect(bResult.status).toBe('rejected');
    if (bResult.status === 'rejected') {
      const msgV6 = (settledError(bResult) as { userMessage?: string }).userMessage;
      expect(msgV6).toMatch(/has already been paid against Stock purchase/);
      expect(msgV6).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
    const [exp] = await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`;
    expect(exp!.status).toBe('posted');
    expect(await control2110(f.orgId, f.storeA)).toBe('0.00');
    const [payCount] = await sql<{ n: string }[]>`select count(*)::text as n from ap_payments where org_id = ${f.orgId} and status = 'posted'`;
    expect(payCount!.n).toBe('1');
  });

  it('reverse order: B (void) held, A (payment) waits, then is refused as not an open item; nothing written', async () => {
    const f = await fixture('v6b');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const { expenseId } = await creditExpense(f, f.storeA, f.managerA, invoiceId, '400.00');

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => voidExpense(tx, f.managerA, expenseId, 'race'),
      (tx) => recordPayment(tx, f.managerA, { requestId: crypto.randomUUID(), storeId: f.storeA, supplierId: f.supplierId, businessDate: '2027-02-05', amount: '400.00', moneyAccountId: f.drawerA, allocations: [{ expenseId, amountApplied: '400.00' }] }),
      ROW_LOCK,
    );
    expect(bWaited, 'today: recordPayment / voidExpense share no lock').toBe(true);
    expect(bResult.status).toBe('rejected');
    const [payCount] = await sql<{ n: string }[]>`select count(*)::text as n from ap_payments where org_id = ${f.orgId}`;
    expect(payCount!.n).toBe('0');
  });
});

// -----------------------------------------------------------------------------------------------
// V7 — double approve, concurrently
// -----------------------------------------------------------------------------------------------

describe('V7 — double approve', () => {
  it('B waits on the invoice lock, re-reads, returns created:false with A\'s journalEntryId — NOT a refusal; exactly one expense journal entry — Mutant: re-read removed (HEAD, no lock at all), B posts a second entry, red', async () => {
    const f = await fixture('v7');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const draft = await asOrg(f.orgId, (tx) => createExpense(tx, f.staffA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, particulars: 'double approve', payments: [{ method: 'credit', amount: '400.00' }] }));

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => approveExpense(tx, f.managerA, draft.id),
      (tx) => approveExpense(tx, f.managerA, draft.id),
      ROW_LOCK,
    );
    expect(bWaited, 'today: approveExpense takes no lock on the invoice').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status, 'a double approve must never be a raw throw/refusal, only a retry').toBe('fulfilled');
    if (aResult.status === 'fulfilled' && bResult.status === 'fulfilled') {
      expect((bResult.value as { created: boolean }).created).toBe(false);
      expect((bResult.value as { journalEntryId: string }).journalEntryId).toBe((aResult.value as { journalEntryId: string }).journalEntryId);
    }
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'expense_payment' and source_id = ${draft.id}`;
    expect(n!.n).toBe('1');
  });
});

// -----------------------------------------------------------------------------------------------
// V8 — editExpense vs voidInvoice, concurrently (DEF-396 continued)
// -----------------------------------------------------------------------------------------------

describe('V8 — editExpense races voidInvoice on the same invoice', () => {
  it('A voids X (its cascade deletes the live draft); B\'s edit waits on the invoice lock, then settles WITHOUT a raw driver error — no 40P01 — Mutant: editExpense without the up-front lockInvoiceForRecording, the two writers take the invoice/expense pair in opposite orders (edit: expense-then-invoice; void: invoice-then-expense) and deadlock instead of serialising, red', async () => {
    const f = await fixture('v8');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const draft = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staffA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, particulars: 'race', payments: [{ method: 'credit', amount: '400.00' }] }),
    );

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'race' }),
      (tx) => editExpense(tx, f.managerA, draft.id, { particulars: 'edited during the race' }),
      ROW_LOCK,
    );
    expect(bWaited, 'editExpense\'s lockInvoiceForRecording call must serialise behind voidInvoice\'s FOR UPDATE on the same invoice row').toBe(true);
    if (bResult.status === 'rejected') {
      // Measured: B is refused RecordGoneError("...expense...is no longer a draft") — the void's
      // own cascade hard-deletes the live draft before B re-reads, so editExpense never gets far
      // enough to name the INVOICE as voided. Real, domain-level refusal (not a raw 40P01) either
      // way, so this leg only pins "no deadlock" — see the T367-S2 report for the sentence gap.
      const err = settledError(bResult) as { code?: string; message?: string };
      expect(err.code, `B must settle through the domain, not a raw driver exception: ${err.message}`).not.toBe('40P01');
    }
    const [invoiceRow] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(invoiceRow!.status, 'A must still have gone through — this leg is about ORDERING, not refusing the void').toBe('voided');
  });

  it('+control: editExpense on a draft whose invoice nobody else holds proceeds without waiting', async () => {
    const f = await fixture('v8-pc');
    const invoiceA = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const draftA = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staffA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceA, particulars: 'no contention A', payments: [{ method: 'credit', amount: '400.00' }] }),
    );
    const invoiceB = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '500.00');
    const draftB = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staffA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceB, particulars: 'no contention B', payments: [{ method: 'credit', amount: '100.00' }] }),
    );

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => editExpense(tx, f.managerA, draftA.id, { particulars: 'edited A' }),
      (tx) => editExpense(tx, f.managerA, draftB.id, { particulars: 'edited B' }),
      ROW_LOCK,
    );
    expect(bWaited, 'different invoices — no shared row to lock, B must not wait').toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
  });
});

// -----------------------------------------------------------------------------------------------
// X1/X2 — cross-store (DEF-508)
// -----------------------------------------------------------------------------------------------

describe('X1 — cross-store recording', () => {
  it('M_A createExpense(storeId A, J = store B\'s invoice): refused gone(supplier invoice), byte-equal to a random uuid, names nothing, writes nothing — Mutant: no store check exists at all (HEAD), succeeds; red', async () => {
    const f = await fixture('x1');
    const invoiceJ = await verifiedInvoice(f, f.storeB, f.staffB, f.managerB, '1000.00');

    const errReal = await asOrg(f.orgId, (tx) => createExpense(tx, f.managerA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceJ, particulars: 'cross-store', payments: [{ method: 'credit', amount: '100.00' }] })).catch((e) => e);
    const errFake = await asOrg(f.orgId, (tx) => createExpense(tx, f.managerA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: randomUUID(), particulars: 'cross-store', payments: [{ method: 'credit', amount: '100.00' }] })).catch((e) => e);
    expect(errReal, 'today: no store check exists, so createExpense succeeds against store B\'s invoice').toBeInstanceOf(Error);
    expect(errFake).toBeInstanceOf(Error);
    expect((errReal as { userMessage?: string }).userMessage).toBe((errFake as { userMessage?: string }).userMessage);
    const detail = (errReal as { userMessage?: string; message: string }).userMessage ?? (errReal as Error).message;
    expect(detail).not.toContain(f.storeB);
    expect(detail).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceJ}`;
    expect(n!.n).toBe('0');
  });

  it('J at B verified-and-full, and J voided: both still give the same not-found sentence', async () => {
    const f = await fixture('x1b');
    const invoiceFull = await verifiedInvoice(f, f.storeB, f.staffB, f.managerB, '100.00');
    await creditExpense(f, f.storeB, f.managerB, invoiceFull, '100.00');
    const invoiceVoided = await verifiedInvoice(f, f.storeB, f.staffB, f.managerB, '1000.00');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.managerB, { invoiceId: invoiceVoided, reason: 'x' }));

    const errFull = await asOrg(f.orgId, (tx) => createExpense(tx, f.managerA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceFull, particulars: 'x', payments: [{ method: 'credit', amount: '1.00' }] })).catch((e) => e);
    const errVoided = await asOrg(f.orgId, (tx) => createExpense(tx, f.managerA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceVoided, particulars: 'x', payments: [{ method: 'credit', amount: '1.00' }] })).catch((e) => e);
    expect((errFull as { userMessage?: string }).userMessage).toBe((errVoided as { userMessage?: string }).userMessage);
  });

  it('the same through recordExpenseForInvoice', async () => {
    const f = await fixture('x1c');
    const invoiceJ = await verifiedInvoice(f, f.storeB, f.staffB, f.managerB, '1000.00');
    const err = await asOrg(f.orgId, (tx) => recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceJ, categoryId: f.categoryId, particulars: 'x', payments: [{ method: 'credit', amount: '100.00' }] })).catch((e) => e);
    expect(err, 'today: no store check exists here either').toBeInstanceOf(Error);
  });

  it('+control: M_A with I (store A) succeeds', async () => {
    const f = await fixture('x1-pc');
    const invoiceI = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    await expect(asOrg(f.orgId, (tx) => createExpense(tx, f.managerA, { storeId: f.storeA, businessDate: '2027-02-03', categoryId: f.categoryId, supplierId: f.supplierId, supplierInvoiceId: invoiceI, particulars: 'ok', payments: [{ method: 'credit', amount: '100.00' }] }))).resolves.toBeDefined();
  });
});

describe('X2 — trigger backstop', () => {
  it('as the owner, inserting a draft expense at A on J (store B\'s invoice) raises the store message; the same at B succeeds', async () => {
    const f = await fixture('x2');
    const invoiceJ = await verifiedInvoice(f, f.storeB, f.staffB, f.managerB, '1000.00');
    const [category2] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and category = 'Cost of Goods Sold — General'`;
    const errA = await sql`
      insert into expenses (org_id, store_id, business_date, category_id, supplier_id, supplier_invoice_id, particulars, total_amount, status, created_by)
      values (${f.orgId}, ${f.storeA}, '2027-02-03', ${category2!.id}, ${f.supplierId}, ${invoiceJ}, 'x2', '10.00', 'draft', ${f.managerA.personId})
    `.catch((e) => e);
    expect(errA, 'today: the trigger does not compare store_id at all').toBeInstanceOf(Error);
    expect(String((errA as Error).message)).toMatch(/different store/i);

    await expect(sql`
      insert into expenses (org_id, store_id, business_date, category_id, supplier_id, supplier_invoice_id, particulars, total_amount, status, created_by)
      values (${f.orgId}, ${f.storeB}, '2027-02-03', ${category2!.id}, ${f.supplierId}, ${invoiceJ}, 'x2-ok', '10.00', 'draft', ${f.managerB.personId})
    `).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------------------------
// Refusals paired with controls
// -----------------------------------------------------------------------------------------------

describe('Refusals', () => {
  it('staff (no void_supplier_invoice) is refused without waiting on a held lock', async () => {
    const f = await fixture('ref-staff');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(f.orgId, async (tx) => {
      // Hold SOME lock-worthy operation open — a payment allocation on this store, to prove staff's
      // refusal never even queues behind it.
      await creditExpenseInTx(tx, f, invoiceId, '10.00');
      aReady.resolve();
      await gate.promise;
    });
    await aReady.promise;
    const startedAt = Date.now();
    let rejected: unknown;
    try {
      await asOrg(f.orgId, (tx) => voidInvoice(tx, f.staffA, { invoiceId, reason: 'x' }));
    } catch (err) {
      rejected = err;
    }
    const elapsedMs = Date.now() - startedAt;
    gate.resolve();
    await aPromise;
    expect(rejected).toBeInstanceOf(AuthorizationError);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('a second voidInvoice is refused as already voided', async () => {
    const f = await fixture('ref-double-void');
    const invoiceId = await verifiedInvoice(f, f.storeA, f.staffA, f.managerA, '1000.00');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'first' }));
    await expect(asOrg(f.orgId, (tx) => voidInvoice(tx, f.managerA, { invoiceId, reason: 'second' }))).rejects.toThrow(/voided/);
  });
});

async function creditExpenseInTx(tx: Tx, f: Fixture, invoiceId: string, amount: string) {
  return recordExpenseForInvoice(tx, f.managerA, { storeId: f.storeA, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId, particulars: 'hold', payments: [{ method: 'credit', amount }] });
}
