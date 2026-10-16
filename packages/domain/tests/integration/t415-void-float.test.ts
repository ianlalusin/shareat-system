import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { cashRequestsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  approveExpense,
  createExpense,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
  cancelCashRequest,
  createSupplier,
  recordInvoice,
  verifyInvoice,
  recordExpenseForInvoice,
  recordPayment,
  voidPayment,
  voidExpense,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fundAccount(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  managerId: string;
  staffFloatId: string;
  officeSafeId: string;
  otherOfficeSafeId: string;
  drawerId: string;
  categoryId: string;
  supplierId: string;
  supplier2Id: string;
  fileId: string;
  holder: string;
  manager: Actor;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t415-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`${name} ${hint}`}) returning id`)[0]!.id;
  const storeId = await mkStore('A');
  const otherStoreId = await mkStore('B');

  const person = async (name: string, role: 'staff' | 'manager') => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const staffId = await person(`${hint} Ana`, 'staff');
  const managerId = await person(`${hint} Manager`, 'manager');
  const grant = async (sid: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${sid}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: sid, employmentId: employment!.id, personId: staffId, setBy: managerId });
  };
  await grant(storeId);
  await grant(otherStoreId);

  const account = async (sid: string, custodian: 'staff' | 'office' | 'cashier') => {
    const [row] = await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${orgId} and store_id = ${sid} and custodian = ${custodian} and instrument = 'cash' order by created_at limit 1`;
    return row!.id;
  };
  await fundAccount(orgId, storeId, '1130', '500000.00');
  await fundAccount(orgId, otherStoreId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actorOf(orgId, managerId);
  const supplier = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  const supplier2 = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier Two`, creditTermsDays: 30 }));
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId}) returning id`;
  return {
    orgId, storeId, otherStoreId, staffId, managerId,
    staffFloatId: await account(storeId, 'staff'),
    officeSafeId: await account(storeId, 'office'),
    otherOfficeSafeId: await account(otherStoreId, 'office'),
    drawerId: await account(storeId, 'cashier'),
    categoryId: category!.id, supplierId: supplier.id, supplier2Id: supplier2.id, fileId: file!.id,
    holder: `${hint} Ana`, manager,
  };
}

/** Request -> approve -> release (from a safe) through the real domain functions. */
async function releasedFloat(f: Fixture, amount: string, storeId = f.storeId, fromSafe = f.officeSafeId, holderId = f.staffId): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createCashRequest(tx, f.manager, { storeId, requestedFor: holderId, purpose: 'Market run', amount, on: '2026-01-05' }),
  );
  await asPerson(f.orgId, (tx) => decideCashRequest(tx, f.manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  await asPerson(f.orgId, (tx) => releaseCashRequest(tx, f.manager, { requestId: id, amount, fromMoneyAccountId: fromSafe, on: '2026-01-05' }));
  return id;
}

async function otherHolder(f: Fixture, name: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
  return p!.id;
}
/** An unrelated 5,000 float at store A: the staff cash account then holds enough in AGGREGATE for any small draw, so only
 *  the per-request check can refuse - the red reason is the right one. */
async function coverFloat(f: Fixture): Promise<void> {
  await releasedFloat(f, '5000.00', f.storeId, f.officeSafeId, await otherHolder(f, 'Cover Holder'));
}

const settle = (f: Fixture, requestId: string, returnedAmount: string, toMoneyAccountId: string, on = '2026-01-08') =>
  asPerson(f.orgId, (tx) => settleCashRequest(tx, f.manager, { requestId, returnedAmount, toMoneyAccountId, on }));
const settleOp = (f: Fixture, requestId: string, returnedAmount: string, toMoneyAccountId: string) => (tx: Tx) =>
  settleCashRequest(tx, f.manager, { requestId, returnedAmount, toMoneyAccountId, on: '2026-01-08' });

const outstandingOf = async (f: Fixture, id: string) =>
  (await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, id))).outstanding;
const requestStatus = async (id: string) => (await sql<{ status: string }[]>`select status from cash_requests where id = ${id}`)[0]!.status;

// ---- expense drawing a float (T-414) ----
async function rawInvoice(f: Fixture): Promise<string> {
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price)
    values (${f.orgId}, ${f.storeId}, ${f.supplierId}, '2026-01-05', '99999999.00', 'verified', ${f.fileId}, ${f.managerId}, now(), ${f.staffId}, true, true, true, true)
    returning id`;
  return inv!.id;
}
/** A DRAFT expense of `amount` drawing the named float through the store's staff cash account. */
async function floatExpenseDraft(f: Fixture, amount: string, cashRequestId: string): Promise<string> {
  const invoiceId = await rawInvoice(f);
  const { id } = await asPerson(f.orgId, (tx) =>
    createExpense(tx, actorOf(f.orgId, f.staffId), {
      storeId: f.storeId,
      businessDate: '2026-01-05',
      categoryId: f.categoryId,
      supplierId: f.supplierId,
      supplierInvoiceId: invoiceId,
      particulars: `T-415 draw ${uid('p')}`,
      payments: [{ method: 'cash' as const, amount, cashRequestId, moneyAccountId: f.staffFloatId }],
    }),
  );
  return id;
}
const approveOp = (f: Fixture, expenseId: string) => (tx: Tx) => approveExpense(tx, f.manager, expenseId);
const approve = (f: Fixture, expenseId: string) => asPerson(f.orgId, approveOp(f, expenseId));
const expenseStatus = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;
const expensePostings = async (id: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where source_id = ${id} and source_type = 'expense_payment'`)[0]!.n);

// ---- AP payments ----
async function apBill(f: Fixture, amount: string, supplierId = f.supplierId): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('ap')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.staffId}) returning id`;
  const created = await asPerson(f.orgId, (tx) =>
    recordInvoice(tx, actorOf(f.orgId, f.staffId), { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: file!.id }),
  );
  await asPerson(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asPerson(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId: f.storeId, supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return exp.expenseId;
}
interface PayOpts {
  amount: string; applied?: string; from: string; cashRequestId?: string | null; creditApplied?: string;
  supplierId?: string; storeId?: string;
}
const payInput = (f: Fixture, expenseId: string, o: PayOpts) => ({
  storeId: o.storeId ?? f.storeId, supplierId: o.supplierId ?? f.supplierId, businessDate: '2026-01-15', amount: o.amount,
  moneyAccountId: o.from,
  ...(o.cashRequestId !== undefined ? { cashRequestId: o.cashRequestId } : {}),
  ...(o.creditApplied ? { creditApplied: o.creditApplied } : {}),
  allocations: [{ expenseId, amountApplied: o.applied ?? o.amount }],
});
const payOp = (f: Fixture, expenseId: string, o: PayOpts) => (tx: Tx) => recordPayment(tx, f.manager, payInput(f, expenseId, o));
const pay = (f: Fixture, expenseId: string, o: PayOpts) => asPerson(f.orgId, payOp(f, expenseId, o));
const voidPaymentOp = (f: Fixture, paymentId: string) => (tx: Tx) => voidPayment(tx, f.manager, { paymentId, reason: 'Wrong supplier' });
const doVoidPayment = (f: Fixture, paymentId: string) => asPerson(f.orgId, voidPaymentOp(f, paymentId));
const apPaymentStatus = async (id: string) => (await sql<{ status: string }[]>`select status from ap_payments where id = ${id}`)[0]!.status;
const apPostedCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from ap_payments where org_id = ${orgId} and status = 'posted'`)[0]!.n);

// ---- messages ----
/** The refusal's `userMessage` (what a person reads); a marker string when the promise RESOLVED (no refusal). */
async function userMessageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `NO userMessage: ${(err as Error).message}`;
  }
  return '<<NO REFUSAL - THE CALL SUCCEEDED>>';
}
// The spec fixes the words, not the peso format: "400" and "400.00" both pass.
const peso = (n: string) => `₱${n.replace(/\./g, '\\.').replace(/\\\.00$/, '')}(\\.00)?`;
const S1 = 'This is a staff cash account. Pick the cash request the money comes from.';
const S2 = "A cash request can only be paid from its store's staff cash account.";
const S3 = (holder: string, status: string) => `${holder}'s cash request is no longer open (${status}). Pick another source.`;
const S4 = (holder: string) => `${holder}'s cash request belongs to another store, so this payment cannot draw from it. Pick another source.`;
const S5 = (holder: string, left: string, drawn: string) =>
  new RegExp(`^${holder}'s cash request has ${peso(left)} left — this payment draws ${peso(drawn)} from it\\. Lower the amount or pay the rest another way\\.$`);
const S6 = (holder: string, status: string) => `${holder}'s cash request is already ${status}, so there is nothing left to settle.`;
const S7 = (holder: string, status: string) => `${holder}'s cash request is ${status}, so this cannot be voided. The request must still be released.`;
const overHold = (left: string) =>
  new RegExp(`^Only ${peso(left)} is still held on this cash request\\. Anything spent is recorded as an expense, not settled here\\.$`);

// ---- concurrency harness (t369-s0 shape) ----
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
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
async function pollForWaitingBackend(bPid: Promise<number>, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000): Promise<boolean> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<boolean> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number }[]>`
        select pid from pg_stat_activity
        where datname = current_database() and pid = ${pid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  })();
  return Promise.race([poll, settled.then(() => false)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
/** A runs and HOLDS its transaction open (uncommitted); B starts; we check B is parked on a lock, then let A commit. */
async function runConcurrencyLeg<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aPromise: Promise<Settled<TA>> = asPerson(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asPerson(orgId, trackedB.op).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  const bWaited = await pollForWaitingBackend(trackedB.pid, ['transactionid', 'tuple'], bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited };
}
const messageOfSettled = (s: Settled<unknown>): string =>
  s.status === 'fulfilled' ? '<<NO REFUSAL - THE CALL SUCCEEDED>>' : ((s.reason as { userMessage?: string }).userMessage ?? `NO userMessage: ${String((s.reason as Error)?.message)}`);
const deadlocked = (...rs: Settled<unknown>[]) =>
  rs.some((r) => r.status === 'rejected' && /deadlock/i.test(String((r.reason as Error)?.message)));

/**
 * T-415 cases 13-15 - a void of spending from a float needs the request still open (`released`), and takes the request
 * row lock AFTER its own document locks and BEFORE it reverses. `docs/tasks/415-cash-request-float-row-locks.md`,
 * ruling 4 (DEF-661).
 *
 * MUTANTS (each turns a NAMED test red; none is planted in the tree):
 *   M13 drop the request lock/check from voidPayment ... case 13 (the control stays green)
 *   M14 drop it from voidExpense ...................... case 14 (the control stays green)
 *   M15 take the request lock AFTER reverseEntry ........ case 15 (the void reverses first; the money goes back onto a
 *                                                         request that the settle is closing)
 *
 * Cases 13 and 15 need an AP payment drawn from a float, which is itself new in T-415 (case 1): until the builder's
 * recordPayment change lands they stop in their own SETUP. Case 14 does not depend on it.
 */

describe('case 13 - voidPayment of float spending is refused once the request is liquidated (M13)', () => {
  it('control: while the request is still released, the void posts and puts the 600 back on the float', async () => {
    const f = await setup('c13c');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const paid = await pay(f, await apBill(f, '600.00'), { amount: '600.00', from: f.staffFloatId, cashRequestId: req });
    expect(await outstandingOf(f, req)).toBe('400.00');
    await doVoidPayment(f, paid.paymentId);
    expect(await apPaymentStatus(paid.paymentId)).toBe('voided');
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('AP 600 from a 1,000 float, settle returns 400 (liquidated), voidPayment -> S7; payment stays posted; outstanding 0.00', async () => {
    const f = await setup('c13');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const paid = await pay(f, await apBill(f, '600.00'), { amount: '600.00', from: f.staffFloatId, cashRequestId: req });
    await settle(f, req, '400.00', f.officeSafeId);
    expect(await requestStatus(req)).toBe('liquidated');

    const msg = await userMessageOf(doVoidPayment(f, paid.paymentId));
    expect(msg).toBe(S7('c13 Ana', 'liquidated'));
    expect(await apPaymentStatus(paid.paymentId)).toBe('posted');
    expect(await requestStatus(req)).toBe('liquidated');
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});

describe('case 14 - voidExpense of float spending is refused once the request is liquidated (M14)', () => {
  it('control: while the request is still released, the void posts and puts the 600 back on the float', async () => {
    const f = await setup('c14c');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const id = await floatExpenseDraft(f, '600.00', req);
    await approve(f, id);
    expect(await outstandingOf(f, req)).toBe('400.00');
    await asPerson(f.orgId, (tx) => voidExpense(tx, f.manager, id, 'Entered twice'));
    expect(await expenseStatus(id)).toBe('voided');
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('an expense paid from the float, settle returns 400 (liquidated), voidExpense -> S7; expense stays posted; outstanding 0.00', async () => {
    const f = await setup('c14');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const id = await floatExpenseDraft(f, '600.00', req);
    await approve(f, id);
    await settle(f, req, '400.00', f.officeSafeId);
    expect(await requestStatus(req)).toBe('liquidated');

    const msg = await userMessageOf(asPerson(f.orgId, (tx) => voidExpense(tx, f.manager, id, 'Entered twice')));
    expect(msg).toBe(S7('c14 Ana', 'liquidated'));
    expect(await expenseStatus(id)).toBe('posted');
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});

describe('case 15 - concurrent: a settle that liquidates (held open) vs voidPayment of the 600 AP payment (M15)', () => {
  it('the void waits on the request row, then is refused with S7; the payment stays posted; outstanding 0.00', async () => {
    const f = await setup('c15');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const paid = await pay(f, await apBill(f, '600.00'), { amount: '600.00', from: f.staffFloatId, cashRequestId: req });

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, settleOp(f, req, '400.00', f.officeSafeId), voidPaymentOp(f, paid.paymentId));

    expect(deadlocked(aResult, bResult), 'a Postgres deadlock is a failure of the lock order').toBe(false);
    expect(bWaited, 'the void must be parked on the request row while the settle is uncommitted').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(messageOfSettled(bResult)).toBe(S7('c15 Ana', 'liquidated'));
    expect(await apPaymentStatus(paid.paymentId)).toBe('posted');
    expect(await requestStatus(req)).toBe('liquidated');
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});
