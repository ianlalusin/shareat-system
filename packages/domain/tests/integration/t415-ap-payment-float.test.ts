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
 * T-415 cases 1-9 - a supplier (AP) payment draws a cash-request float the way an expense does: it names the request,
 * locks it, re-reads the live float AFTER the lock, and posts the 1120 credit with the request as the party.
 * `docs/tasks/415-cash-request-float-row-locks.md` (DEF-657).
 *
 * MUTANTS (each turns a NAMED test red; none is planted in the tree):
 *   M1 drop the party on the 1120 leg ......... case 1 (the trigger refuses the entry)
 *   M2 delete the S1 check ................... case 2
 *   M3 delete the S2 check ................... case 3
 *   M4 delete the outstanding compare ......... case 4 (and the S5 leg of case 9)
 *   M5 drop the status check ................. case 5 (liquidated and cancelled)
 *   M6 compare with account.storeId ........... case 6
 *   M7 run checkDraw on float legs ............ case 7
 *   M8 run the float checks when cashPortion = 0 ... case 8
 *   M9 remove lockForSpend from recordPayment ... case 9 (two REAL transactions)
 *
 * Case 9 note: A (an expense approve) and B (an AP payment) use DIFFERENT invoices and DIFFERENT suppliers, so neither
 * `lockInvoiceForRecording`, `lockExpensesForAllocation` nor `lockSupplierCredit` is what serialises them - only the
 * request-row lock can.
 * Cases 1, 4-6 and 9 keep an unrelated 5,000 float on the store's staff cash account (`coverFloat`), so the account
 * holds enough in AGGREGATE and only the per-request check can refuse.
 */

const linesOf = (entryId: string) => sql<{ code: string; party_type: string | null; party_id: string | null; debit: string; credit: string }[]>`
  select a.code, jl.party_type, jl.party_id, jl.debit::text, jl.credit::text
  from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId}`;

/** Credit 1120 against `requestId` with no cash coming from anywhere real: drains the ACCOUNT but not the named request. */
async function drainAccountThrough(f: Fixture, requestId: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-06', ${period!.id}, 'opening_balance', ${uid('drain')}, 'draft') returning id`;
    const [float] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1120'`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${equity!.id}, ${f.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 2, ${float!.id}, ${f.storeId}, '0', ${amount}, 'cash_request', ${requestId})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

describe('case 1 - AP 600 from the staff cash account naming a released 1,000 request posts, party = the request (M1)', () => {
  it('1120 credited with party cash_request; the float falls to 400.00; the payment is posted and carries the request', async () => {
    const f = await setup('c1');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const bill = await apBill(f, '600.00');

    const res = await pay(f, bill, { amount: '600.00', from: f.staffFloatId, cashRequestId: req });

    const lines = await linesOf(res.entryId);
    const credit = lines.find((l) => l.code === '1120');
    expect(credit, 'the entry must credit 1120').toMatchObject({ party_type: 'cash_request', party_id: req, credit: '600.00' });
    expect(lines.find((l) => l.code === '2110')).toMatchObject({ party_type: 'supplier', debit: '600.00' });
    expect(await outstandingOf(f, req)).toBe('400.00');
    expect(await apPaymentStatus(res.paymentId)).toBe('posted');
    const [row] = await sql<{ cash_request_id: string }[]>`select cash_request_id from ap_payments where id = ${res.paymentId}`;
    expect(row!.cash_request_id).toBe(req);
  });
});

describe('case 2 - AP from the staff cash account with no request is refused with S1 (M2)', () => {
  it('S1; nothing posted; the bill is still owed', async () => {
    const f = await setup('c2');
    await coverFloat(f);
    const bill = await apBill(f, '600.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '600.00', from: f.staffFloatId }));
    expect(msg).toBe(S1);
    expect(await apPostedCount(f.orgId)).toBe(0);
  });
});

describe('case 3 - AP naming a request but paid from the office safe is refused with S2 (M3)', () => {
  it('S2; nothing posted; the float is untouched', async () => {
    const f = await setup('c3');
    const req = await releasedFloat(f, '1000.00');
    const bill = await apBill(f, '600.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '600.00', from: f.officeSafeId, cashRequestId: req }));
    expect(msg).toBe(S2);
    expect(await apPostedCount(f.orgId)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('case 4 - AP 1,200 on a 1,000 float is refused with S5, and the boundary is exact (M4)', () => {
  it('1,200 on 1,000 refuses with S5; nothing posted; float intact', async () => {
    const f = await setup('c4');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const bill = await apBill(f, '1200.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '1200.00', from: f.staffFloatId, cashRequestId: req }));
    expect(msg).toMatch(S5('c4 Ana', '1,000', '1,200'));
    expect(await apPostedCount(f.orgId)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('one centavo over what is left is refused (999.99 spent, then 0.02 against 0.01 left)', async () => {
    const f = await setup('c4b');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await pay(f, await apBill(f, '999.99'), { amount: '999.99', from: f.staffFloatId, cashRequestId: req });
    const msg = await userMessageOf(pay(f, await apBill(f, '0.02'), { amount: '0.02', from: f.staffFloatId, cashRequestId: req }));
    expect(msg).toMatch(S5('c4b Ana', '0.01', '0.02'));
    expect(await outstandingOf(f, req)).toBe('0.01');
  });

  it('control: drawing exactly what is left (600 then 400) posts and drains the float to 0.00', async () => {
    const f = await setup('c4c');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await pay(f, await apBill(f, '600.00'), { amount: '600.00', from: f.staffFloatId, cashRequestId: req });
    await pay(f, await apBill(f, '400.00'), { amount: '400.00', from: f.staffFloatId, cashRequestId: req });
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});

describe('case 5 - AP on a request that is no longer open is refused with S3 (M5)', () => {
  it('liquidated', async () => {
    const f = await setup('c5a');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await settle(f, req, '1000.00', f.drawerId);
    expect(await requestStatus(req)).toBe('liquidated');
    const bill = await apBill(f, '100.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '100.00', from: f.staffFloatId, cashRequestId: req }));
    expect(msg).toBe(S3('c5a Ana', 'liquidated'));
    expect(await apPostedCount(f.orgId)).toBe(0);
  });

  it('cancelled (never released)', async () => {
    const f = await setup('c5b');
    await coverFloat(f);
    const { id: req } = await asPerson(f.orgId, (tx) =>
      createCashRequest(tx, actorOf(f.orgId, f.staffId), { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05' }),
    );
    await asPerson(f.orgId, (tx) => cancelCashRequest(tx, actorOf(f.orgId, f.staffId), { requestId: req }));
    const bill = await apBill(f, '100.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '100.00', from: f.staffFloatId, cashRequestId: req }));
    expect(msg).toBe(S3('c5b Ana', 'cancelled'));
    expect(await apPostedCount(f.orgId)).toBe(0);
  });
});

describe('case 6 - AP at store A on a request released at store B is refused with S4 (M6)', () => {
  it("account A's staff cash, request B: S4; the compare is against the OWING store (input.storeId)", async () => {
    const f = await setup('c6');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00', f.otherStoreId, f.otherOfficeSafeId);
    const bill = await apBill(f, '100.00');
    const msg = await userMessageOf(pay(f, bill, { amount: '100.00', from: f.staffFloatId, cashRequestId: req }));
    expect(msg).toBe(S4('c6 Ana'));
    expect(await apPostedCount(f.orgId)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('case 7 - a float payment skips the per-account draw check (M7)', () => {
  it('the request holds 900 but the account holds only 500 (another float was overdrawn): posts, no warning, no checkDraw block', async () => {
    const f = await setup('c7');
    const req = await releasedFloat(f, '1000.00');
    const other = await releasedFloat(f, '500.00', f.storeId, f.officeSafeId, await otherHolder(f, 'Other Holder'));
    // The account now holds 1,500 in total; take 1,000 of it out through the OTHER request, so it holds 500.
    await drainAccountThrough(f, other, '1000.00');
    const bill = await apBill(f, '900.00');
    const res = await pay(f, bill, { amount: '900.00', from: f.staffFloatId, cashRequestId: req });
    expect(res.warning).toBeUndefined();
    expect(await outstandingOf(f, req)).toBe('100.00');
  });
});

describe('case 8 - a payment fully covered by supplier credit draws nothing and gets no float check (M8)', () => {
  it('creditApplied = the whole 600 with a cashRequestId on a LIQUIDATED request: posts, no refusal, no 1120 leg', async () => {
    const f = await setup('c8');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await settle(f, req, '1000.00', f.drawerId);
    expect(await requestStatus(req)).toBe('liquidated');

    // The supplier holds a 600 return credit: an overpayment of 1,600 against a 1,000 bill, from the office safe.
    await pay(f, await apBill(f, '1000.00'), { amount: '1600.00', applied: '1000.00', from: f.officeSafeId });
    const bill2 = await apBill(f, '600.00');
    const res = await pay(f, bill2, { amount: '600.00', from: f.staffFloatId, cashRequestId: req, creditApplied: '600.00' });

    expect(await apPaymentStatus(res.paymentId)).toBe('posted');
    const lines = await linesOf(res.entryId);
    expect(lines.filter((l) => l.code === '1120'), 'no cash left the float, so no 1120 leg').toHaveLength(0);
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});

describe('case 9 - concurrent: an expense approve of 600 (held open) vs an AP payment of 600 on the same 1,000 float (M9, M4)', () => {
  it('the AP payment waits on the request row, then is refused with S5; outstanding 400.00; exactly one posting', async () => {
    const f = await setup('c9');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const draftId = await floatExpenseDraft(f, '600.00', req);
    const apBillId = await apBill(f, '600.00', f.supplier2Id);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      approveOp(f, draftId),
      payOp(f, apBillId, { amount: '600.00', from: f.staffFloatId, cashRequestId: req, supplierId: f.supplier2Id }),
    );

    expect(deadlocked(aResult, bResult), 'a Postgres deadlock is a failure of the lock order').toBe(false);
    expect(bWaited, 'the AP payment must be parked on a lock while the approve is uncommitted').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(messageOfSettled(bResult)).toMatch(S5('c9 Ana', '400', '600'));
    expect(await expenseStatus(draftId)).toBe('posted');
    expect((await expensePostings(draftId)) + (await apPostedCount(f.orgId))).toBe(1);
    expect(await outstandingOf(f, req)).toBe('400.00');
  });
});

describe('case 4b - AP naming a staff cash account of ANOTHER store than the owing store is refused before posting', () => {
  it('request at the owing store A, account = the staff cash account of store B: refused; no journal entry, no payment', async () => {
    const f = await setup('c4b2');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    const [other] = await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${f.orgId} and store_id = ${f.otherStoreId} and custodian = 'staff' and instrument = 'cash' limit 1`;
    expect(other, 'fixture: store B has its own staff cash account').toBeDefined();
    const bill = await apBill(f, '100.00');
    const before = Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${f.orgId} and source_type = 'ap_payment'`)[0]!.n);

    const msg = await userMessageOf(pay(f, bill, { amount: '100.00', from: other!.id, cashRequestId: req }));

    expect(msg, 'a staff cash account at another store must not be drawn').not.toBe('<<NO REFUSAL - THE CALL SUCCEEDED>>');
    const after = Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${f.orgId} and source_type = 'ap_payment'`)[0]!.n);
    expect(after).toBe(before);
    expect(await apPostedCount(f.orgId)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('case 8b - a payment fully covered by supplier credit names a request that is later liquidated: the void still succeeds', () => {
  it('the payment drew no float money, so voiding it is allowed and the row keeps no cashRequestId', async () => {
    const f = await setup('c8b');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await pay(f, await apBill(f, '1000.00'), { amount: '1600.00', applied: '1000.00', from: f.officeSafeId });
    const res = await pay(f, await apBill(f, '600.00'), { amount: '600.00', from: f.staffFloatId, cashRequestId: req, creditApplied: '600.00' });
    await settle(f, req, '1000.00', f.drawerId);
    expect(await requestStatus(req)).toBe('liquidated');

    const msg = await userMessageOf(doVoidPayment(f, res.paymentId));

    expect(msg, 'the void of a credit-only payment must not be refused').toBe('<<NO REFUSAL - THE CALL SUCCEEDED>>');
    expect(await apPaymentStatus(res.paymentId)).toBe('voided');
    const [row] = await sql<{ cash_request_id: string | null }[]>`select cash_request_id from ap_payments where id = ${res.paymentId}`;
    expect(row!.cash_request_id, 'a payment that drew no float money keeps no request').toBeNull();
  });
});
