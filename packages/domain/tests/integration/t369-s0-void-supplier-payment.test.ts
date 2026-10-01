import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S0 (DEF-550) — voiding a supplier payment. `docs/tasks/369-unwired-money-screens.md` §S0,
 * tests T1–T8 (T9/T10 are the web file).
 *
 *   voidPayment(tx, actor, { paymentId, reason, voidOn? }) -> { entryId }
 *
 * ⛔ TESTER, not BUILDER. Every red leg asserts the TARGET behaviour of the approved Contract —
 * the sentence, the refusal, the lock, the date — never "the symbol exists". `voidOn` is passed
 * where the contract takes it; today's `voidPayment` ignores it, so those legs red on the
 * assertion that matters. Every refusal has a positive control that posts.
 *
 * Fixture (`fixture`, `fund`, `receiptFile`, `verifiedInvoice`, `creditExpense`) is `ap.test.ts`'s;
 * the gated two-connection harness is `t366-s1-cash-custody-locks.test.ts`'s (`deferred`,
 * `trackPid`, `pollForWaitingBackend`, `runConcurrencyLeg`).
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
  recordPayment,
  voidPayment,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
// Concurrency harness (verbatim shape from t366-s1-cash-custody-locks.test.ts)
// -----------------------------------------------------------------------------------------------

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
async function pollForWaitingBackend(
  bPid: Promise<number>,
  waitEvents: string[],
  settleWatch: Promise<unknown>,
  timeoutMs = 5000,
): Promise<{ pid: number; query: string } | null> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid = ${pid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  return Promise.race([poll, settled.then(() => null)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function runConcurrencyLeg<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
  waitEvents: string[],
): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
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
  }).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  const waiting = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}
const ADVISORY = ['advisory'];

// -----------------------------------------------------------------------------------------------
// Fixture: one org, Lipa (the store everything is billed at), January + February 2026 OPEN.
//   manager — manager, scoped to Lipa ONLY.   staff — staff at Lipa (record_ap_payment ✗).
//   admin   — admin, scoped to Lipa AND Malvar.
// -----------------------------------------------------------------------------------------------

async function fund(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
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

async function fixture(hint: string) {
  const code = uid(`t369s0-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Lipa') returning id`;
  const storeId = store!.id;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}m`)}, 'Malvar') returning id`;
  const malvarId = malvar!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager', [storeId]);
  const staffId = await mk('Staff', 'staff', [storeId]);
  const adminId = await mk('Admin', 'admin', [storeId, malvarId]);
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: managerId });

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [malvarSafe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${malvarId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fund(orgId, storeId, '1110', '500000.00');
  await fund(orgId, malvarId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actor(orgId, managerId);
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));

  return {
    orgId, storeId, malvarId, managerId, staffId, adminId, supplierId: supplier.id,
    manager, staff: actor(orgId, staffId), admin: actor(orgId, adminId),
    drawerId: drawer!.id, malvarSafeId: malvarSafe!.id, categoryId: category!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A verified invoice + one posted credit expense for `amount` — returns both ids. */
async function bill(f: Fixture, amount: string, supplierId = f.supplierId): Promise<{ invoiceId: string; expenseId: string }> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: fileId }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId: f.storeId, supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}

interface PayOpts { amount: string; applied?: string; from?: string; on?: string; creditApplied?: string; supplierId?: string; by?: Actor }
const payInput = (f: Fixture, expenseId: string, o: PayOpts) => ({
  storeId: f.storeId, supplierId: o.supplierId ?? f.supplierId, businessDate: o.on ?? '2026-01-15', amount: o.amount,
  moneyAccountId: o.from ?? f.drawerId, ...(o.creditApplied ? { creditApplied: o.creditApplied } : {}),
  allocations: [{ expenseId, amountApplied: o.applied ?? o.amount }],
});
const pay = (f: Fixture, expenseId: string, o: PayOpts) => asOrg(f.orgId, (tx) => recordPayment(tx, o.by ?? f.manager, payInput(f, expenseId, o)));
const payOp = (f: Fixture, expenseId: string, o: PayOpts) => (tx: Tx) => recordPayment(tx, o.by ?? f.manager, payInput(f, expenseId, o));
const voidOp = (f: Fixture, who: Actor, paymentId: string, reason = 'Bounced cheque', voidOn?: string) => (tx: Tx) =>
  voidPayment(tx, who, { paymentId, reason, ...(voidOn ? { voidOn } : {}) } as never);
const doVoid = (f: Fixture, who: Actor, paymentId: string, reason = 'Bounced cheque', voidOn?: string) =>
  asOrg(f.orgId, voidOp(f, who, paymentId, reason, voidOn));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} posted instead (the defect this leg targets)`);
}

const position = (f: Fixture, supplierId = f.supplierId) => asOrg(f.orgId, (tx) => apRepo.advancesPositionOf(tx, f.orgId, supplierId));
const openItems = (f: Fixture) => asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
async function reversalsOf(entryId: string): Promise<{ id: string; entry_date: string; memo: string }[]> {
  return sql`select id, entry_date::text, memo from journal_entries where reversal_of_entry_id = ${entryId}`;
}
async function paymentRow(paymentId: string) {
  const [r] = await sql<{ status: string; voided_by: string | null; void_reason: string | null; journal_entry_id: string }[]>`
    select status, voided_by, void_reason, journal_entry_id from ap_payments where id = ${paymentId}`;
  return r!;
}
async function entryStatus(entryId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`;
  return r!.status;
}
async function netByAccount(entryIds: string[]): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, sum(jl.debit - jl.credit)::numeric(14,2)::text as net
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = any(${entryIds}) group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}
async function totalReversals(orgId: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and reversal_of_entry_id is not null`;
  return Number(r!.n);
}
const closeJanuary = (orgId: string) => sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on = '2026-01-01'`;

// -----------------------------------------------------------------------------------------------
// T1 — positive control for every refusal below
// -----------------------------------------------------------------------------------------------

describe('T1 — a ₱3,000 bill paid in full in an open month; the manager voids it (positive control)', () => {
  it('one reversal; every account nets to 0.00; original reversed; payment voided by the actor with the reason; the bill is owed again; THEN voidInvoice succeeds', async () => {
    const f = await fixture('t1');
    const { invoiceId, expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00' });
    expect(await openItems(f)).toHaveLength(0);

    // DEF-550's own chain: while the payment stands, the bill cannot be voided.
    const blocked = await rejection(
      asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong supplier' })),
      'a bill with a posted payment against it',
    );
    expect(blocked.userMessage ?? blocked.message).toMatch(/Void that payment first/);

    const result = await doVoid(f, f.manager, paid.paymentId);

    const reversals = await reversalsOf(paid.entryId);
    expect(reversals, 'exactly one reversal entry').toHaveLength(1);
    expect(reversals[0]!.id).toBe(result.entryId);
    const net = await netByAccount([paid.entryId, result.entryId]);
    expect(net['2110'], 'AP control nets to zero').toBe('0.00');
    expect(net['1110'], 'the cash account nets to zero').toBe('0.00');
    const [apLine] = await sql<{ party_type: string; party_id: string }[]>`
      select party_type, party_id from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} and a.code = '2110'`;
    expect(apLine).toMatchObject({ party_type: 'supplier', party_id: f.supplierId });
    expect(await entryStatus(paid.entryId)).toBe('reversed');
    const row = await paymentRow(paid.paymentId);
    expect(row).toMatchObject({ status: 'voided', voided_by: f.managerId, void_reason: 'Bounced cheque' });

    const open = await openItems(f);
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe('3000.00');

    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong supplier' }));
  });
});

// -----------------------------------------------------------------------------------------------
// T2 / T3 / T4 — who, why, how many times
// -----------------------------------------------------------------------------------------------

describe('T2 (✗) — a staff member cannot void a payment', () => {
  it('AuthorizationError; the payment stays posted; no reversal — positive control: the manager (T1) voids the same payment', async () => {
    const f = await fixture('t2');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00' });

    const refused = await rejection(doVoid(f, f.staff, paid.paymentId), 'a void by a staff member');
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
    expect(await totalReversals(f.orgId)).toBe(0);

    await doVoid(f, f.manager, paid.paymentId);
    expect((await paymentRow(paid.paymentId)).status).toBe('voided');
  });
});

describe('T3 — a reason is required, by the domain', () => {
  it('blank and whitespace-only reasons are refused with "Say why this payment is being voided."; nothing written', async () => {
    const f = await fixture('t3');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00' });

    for (const reason of ['', '   ']) {
      const refused = await rejection(doVoid(f, f.manager, paid.paymentId, reason), `a void with reason ${JSON.stringify(reason)}`);
      expect(refused.userMessage).toBe('Say why this payment is being voided.');
    }
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
    expect(await totalReversals(f.orgId)).toBe(0);

    await doVoid(f, f.manager, paid.paymentId, 'Bounced cheque'); // control
    expect((await paymentRow(paid.paymentId)).status).toBe('voided');
  });
});

describe('T4 — voiding twice', () => {
  it('the second is refused "This payment has already been voided."; still exactly one reversal', async () => {
    const f = await fixture('t4');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00' });
    await doVoid(f, f.manager, paid.paymentId);

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId, 'Again'), 'a second void of the same payment');
    expect(refused.userMessage).toBe('This payment has already been voided.');
    expect(await reversalsOf(paid.entryId)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// T5 (S0·N1) — a payment in a closed month: a sentence, and a dated reversal
// -----------------------------------------------------------------------------------------------

describe('T5 (S0·N1) — a payment in a month that is now closed', () => {
  const CLOSED_SENTENCE = 'This payment is in a closed month. Pick a date in an open month for the reversal.';
  const NOT_OPEN_SENTENCE = 'That date is not in an open month. Pick a date in an open month for the reversal.';

  it('(a) no voidOn -> refused with the closed-month sentence (no id, no parameter name); nothing written', async () => {
    const f = await fixture('t5a');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });
    await closeJanuary(f.orgId);

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId), 'a void of a closed-month payment with no reversal date');
    expect(refused.userMessage, `raw reverseEntry text leaked instead: ${refused.message}`).toBe(CLOSED_SENTENCE);
    expect(refused.userMessage).not.toMatch(UUID);
    expect(refused.userMessage).not.toMatch(/reversalDate/);
    expect(await reversalsOf(paid.entryId)).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
  });

  it('(b) voidOn in an open month -> one reversal dated voidOn, memo starts "[prior period] ", payment voided', async () => {
    const f = await fixture('t5b');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });
    await closeJanuary(f.orgId);

    await doVoid(f, f.manager, paid.paymentId, 'Bounced cheque', '2026-02-10');

    const reversals = await reversalsOf(paid.entryId);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.entry_date).toBe('2026-02-10');
    expect(reversals[0]!.memo.startsWith('[prior period] ')).toBe(true);
    expect((await paymentRow(paid.paymentId)).status).toBe('voided');
    expect((await netByAccount([paid.entryId, reversals[0]!.id]))['2110']).toBe('0.00');
  });

  it('(c) voidOn in a CLOSED month -> refused with the second sentence; nothing written', async () => {
    const f = await fixture('t5c');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });
    await closeJanuary(f.orgId);

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId, 'Bounced cheque', '2026-01-20'), 'a reversal dated in a closed month');
    expect(refused.userMessage, `raw text leaked instead: ${refused.message}`).toBe(NOT_OPEN_SENTENCE);
    expect(await reversalsOf(paid.entryId)).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
  });

  it('(d) a malformed voidOn -> "Pick a valid date for the reversal."; nothing written', async () => {
    const f = await fixture('t5d');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });
    await closeJanuary(f.orgId);

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId, 'Bounced cheque', 'not-a-date'), 'a reversal with a malformed date');
    expect(refused.userMessage).toBe('Pick a valid date for the reversal.');
    expect(await reversalsOf(paid.entryId)).toHaveLength(0);
  });

  it('positive control: a payment in an OPEN month ignores voidOn — the reversal keeps the original date, no "[prior period]" prefix', async () => {
    const f = await fixture('t5pc');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });

    await doVoid(f, f.manager, paid.paymentId, 'Bounced cheque', '2026-02-10');

    const reversals = await reversalsOf(paid.entryId);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.entry_date).toBe('2026-01-15');
    expect(reversals[0]!.memo.startsWith('[prior period]')).toBe(false);
  });
});

// -----------------------------------------------------------------------------------------------
// T6 (S0·N2) — an overpayment whose credit was already spent cannot be voided out from under it
// -----------------------------------------------------------------------------------------------

/** Bill A ₱1,000 paid with ₱1,500 (₱500 to 1240); bill B ₱500 paid entirely from that credit. */
async function creditSpent(f: Fixture) {
  const a = await bill(f, '1000.00');
  const payA = await pay(f, a.expenseId, { amount: '1500.00', applied: '1000.00' });
  const b = await bill(f, '500.00');
  const payB = await pay(f, b.expenseId, { amount: '500.00', creditApplied: '500.00' });
  expect(await position(f), 'fixture: the credit is fully spent').toBe('0.00');
  return { a, b, payA, payB };
}

describe('T6 (S0·N2) — voiding an overpayment whose credit was already spent', () => {
  it('voiding the first payment is refused ("₱500.00 of this payment\'s overpayment has already been used…"); the supplier credit stays 0.00, never negative', async () => {
    const f = await fixture('t6');
    const { payA } = await creditSpent(f);

    const refused = await rejection(doVoid(f, f.manager, payA.paymentId), "a void whose ₱500 overpayment credit was already spent");
    expect(refused.userMessage).toMatch(/^₱500\.00 of this payment's overpayment has already been used to pay later bills\. Void those payments first\.$/);
    expect(refused.userMessage).not.toMatch(UUID);
    expect(await position(f)).toBe('0.00');
    expect((await paymentRow(payA.paymentId)).status).toBe('posted');
    expect(await totalReversals(f.orgId)).toBe(0);
  });

  it('positive control: void the later payment (B) first, then the overpayment (A) — both succeed, the credit ends at 0.00, both bills are owed again', async () => {
    const f = await fixture('t6pc');
    const { payA, payB } = await creditSpent(f);

    await doVoid(f, f.manager, payB.paymentId);
    expect(await position(f), "B's credit is handed back").toBe('500.00');
    await doVoid(f, f.manager, payA.paymentId);
    expect(await position(f)).toBe('0.00');

    const open = await openItems(f);
    expect(open.map((o) => o.outstanding).sort()).toEqual(['1000.00', '500.00']);
  });
});

// -----------------------------------------------------------------------------------------------
// T7 (S0·N3) — the credit check and the credit draw serialise on the supplier
// -----------------------------------------------------------------------------------------------

/** One supplier-credit of ₱500 sitting on payment P (bill 1,000 paid with 1,500), plus a ₱500 bill to draw it on. */
async function creditAndABill(f: Fixture, supplierId = f.supplierId) {
  const a = await bill(f, '1000.00', supplierId);
  const p = await pay(f, a.expenseId, { amount: '1500.00', applied: '1000.00', supplierId });
  const b = await bill(f, '500.00', supplierId);
  expect(await position(f, supplierId), 'fixture: ₱500 of credit').toBe('500.00');
  return { p, b };
}

describe('T7 (S0·N3) — void vs draw on one supplier credit', () => {
  it('A voids P (holds), B draws the ₱500 -> B is observed waiting on `advisory`; exactly one succeeds; the credit is never below 0.00 — Mutant: remove the lock from either function -> −500.00, red', async () => {
    const f = await fixture('t7a');
    const { p, b } = await creditAndABill(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      voidOp(f, f.manager, p.paymentId),
      payOp(f, b.expenseId, { amount: '500.00', creditApplied: '500.00' }),
      ADVISORY,
    );

    expect(bWaited, 'B never waited: no per-supplier advisory lock').toBe(true);
    expect([aResult, bResult].filter((o) => o.status === 'fulfilled').length, 'exactly one succeeds').toBe(1);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('rejected');
    expect(String(((bResult as { reason: Error }).reason).message)).toMatch(/holds only ₱0\.00 of return credit/);
    expect(Number(await position(f))).toBeGreaterThanOrEqual(0);
  });

  it('reverse order: A draws the ₱500 (holds), B voids P -> B waits, then is refused (the credit is spent); position 0.00', async () => {
    const f = await fixture('t7b');
    const { p, b } = await creditAndABill(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      payOp(f, b.expenseId, { amount: '500.00', creditApplied: '500.00' }),
      voidOp(f, f.manager, p.paymentId),
      ADVISORY,
    );

    expect(bWaited, 'B never waited: no per-supplier advisory lock').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status, 'the void must be refused once the credit is spent').toBe('rejected');
    expect(String(((bResult as { reason: Error }).reason).message)).toMatch(/overpayment has already been used|₱500\.00 of this payment/);
    expect(await position(f)).toBe('0.00');
    expect((await paymentRow(p.paymentId)).status).toBe('posted');
  });

  it('positive control: a DIFFERENT supplier never contends — voiding supplier 1\'s credit does not block supplier 2\'s draw', async () => {
    const f = await fixture('t7pc');
    const s2 = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Second Supplier', creditTermsDays: 30 }));
    const one = await creditAndABill(f);
    const two = await creditAndABill(f, s2.id);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      voidOp(f, f.manager, one.p.paymentId),
      payOp(f, two.b.expenseId, { amount: '500.00', creditApplied: '500.00', supplierId: s2.id }),
      ADVISORY,
    );

    expect(bWaited, 'a different supplier must never block B').toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
    expect(await position(f, s2.id)).toBe('0.00');
  });
});

describe('T7b (S0·N3, the existing race) — two concurrent draws on one ₱500 credit', () => {
  it('exactly one posts; the other is refused "holds only ₱0.00 of return credit"; the credit is 0.00, not −500.00 — Mutant: remove the lock from recordPayment -> both post, red', async () => {
    const f = await fixture('t7b2');
    const a = await bill(f, '1000.00');
    await pay(f, a.expenseId, { amount: '1500.00', applied: '1000.00' });
    const b1 = await bill(f, '500.00');
    const b2 = await bill(f, '500.00');
    expect(await position(f)).toBe('500.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      payOp(f, b1.expenseId, { amount: '500.00', creditApplied: '500.00' }),
      payOp(f, b2.expenseId, { amount: '500.00', creditApplied: '500.00' }),
      ADVISORY,
    );

    expect(bWaited, 'B never waited: the draw takes no lock').toBe(true);
    expect([aResult, bResult].filter((o) => o.status === 'fulfilled').length, 'exactly one draw posts').toBe(1);
    const rejected = [aResult, bResult].find((o) => o.status === 'rejected') as { reason: Error } | undefined;
    expect(String(rejected?.reason?.message)).toMatch(/holds only ₱0\.00 of return credit/);
    expect(await position(f)).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T8 (S0·N4) — putting money back into another store's account needs transfer_funds THERE
// -----------------------------------------------------------------------------------------------

describe("T8 (S0·N4) — voiding a payment funded from Malvar's safe", () => {
  it('a Lipa-only manager voids -> AuthorizationError; nothing written — Mutant: remove the cross-store authorize -> posts, red', async () => {
    const f = await fixture('t8');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', from: f.malvarSafeId, by: f.admin });

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId), "a void that puts money back into Malvar's safe by a manager with no rights at Malvar");
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
    expect(await totalReversals(f.orgId)).toBe(0);
  });

  it('positive control: the admin (transfer_funds at both stores) voids the same payment', async () => {
    const f = await fixture('t8pc');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', from: f.malvarSafeId, by: f.admin });

    await doVoid(f, f.admin, paid.paymentId);
    expect((await paymentRow(paid.paymentId)).status).toBe('voided');
    expect(await reversalsOf(paid.entryId)).toHaveLength(1);
  });

  it("same-store control: the Lipa manager voids a payment drawn on Lipa's own drawer", async () => {
    const f = await fixture('t8same');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00' });
    await doVoid(f, f.manager, paid.paymentId);
    expect((await paymentRow(paid.paymentId)).status).toBe('voided');
  });
});

// -----------------------------------------------------------------------------------------------
// S0 AUDIT legs (A, B, C, and the locked-period leg of E) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

import { refundSupplierCredit, recordReturn, voidReturn, setInvoiceLines, receiveDelivery, quantity } from '@shareat/domain';

const succeeded = (s: Settled<unknown>) => s.status === 'fulfilled' && (s.value as { ok?: boolean } | undefined)?.ok !== false;

describe('AUDIT A1 — voidPayment vs refundSupplierCredit serialise on the supplier credit', () => {
  const refundOp = (f: Fixture) => (tx: Tx) =>
    refundSupplierCredit(tx, { storeId: f.storeId, supplierId: f.supplierId, moneyAccountId: f.drawerId, amount: '500.00', businessDate: '2026-01-20', actor: f.manager });

  it('A refunds the ₱500 (holds), B voids P -> B waits on `advisory`, is refused (the credit is gone); the credit is 0.00, never −500 — Mutant: no lock in refundSupplierCredit -> −500, red', async () => {
    const f = await fixture('aA1a');
    const { p } = await creditAndABill(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, refundOp(f), voidOp(f, f.manager, p.paymentId), ADVISORY);

    expect(aResult.status, 'the refund itself').toBe('fulfilled');
    expect(succeeded(aResult)).toBe(true);
    expect(bWaited, "B never waited: refundSupplierCredit takes no supplier-credit lock").toBe(true);
    expect(bResult.status, 'the void must be refused once the credit is refunded').toBe('rejected');
    expect(await position(f)).toBe('0.00');
    expect((await paymentRow(p.paymentId)).status).toBe('posted');
  });

  it('reverse order: A voids P (holds), B refunds the ₱500 -> B waits, then is refused ("only 0.00 of credit is available"); the credit is 0.00', async () => {
    const f = await fixture('aA1b');
    const { p } = await creditAndABill(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, voidOp(f, f.manager, p.paymentId), refundOp(f), ADVISORY);

    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited: the refund reads the credit without the lock').toBe(true);
    expect(succeeded(bResult), 'the refund must be refused (ok:false) once the void took the credit').toBe(false);
    expect(await position(f)).toBe('0.00');
  });
});

// A return that credits 1240: receive 30 kg, mark the layer invoiced, return 10 kg at `unitCost` (credit = 10 × unitCost).
async function returnCredit(f: Fixture, unitCost: string): Promise<string> {
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, ${uid('STK')}, 'Stockroom') returning id`;
  const [location] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, ${uid('R')}, 'Room R', ${type!.id}, 'operating', true, ${f.managerId}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${f.managerId}) returning id`;
  // The stock movement of a return is dated NOW: make sure an OPEN period covers today.
  const today = new Date().toISOString().slice(0, 7);
  const [has] = await sql<{ n: string }[]>`select count(*)::text as n from fiscal_periods where org_id = ${f.orgId} and starts_on <= current_date and ends_on >= current_date`;
  if (Number(has!.n) === 0) {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${f.orgId}, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date, 'open')`;
  }
  void today;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('rf')}.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${f.managerId}) returning id`;
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, '2026-01-05', ${file!.id}, ${f.managerId}) returning id`;
  const [dl] = await sql<{ id: string }[]>`
    insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
    values (${d!.id}, '1', ${item!.id}, '30.000', '30.000', 'kg', '1', ${unitCost}, ${location!.id}) returning id`;
  const received = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-05',
      locations: [{ id: location!.id, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }], receivedBy: f.managerId,
      lines: [{ lineId: '1', itemId: item!.id, itemKind: 'raw_material', receivedQuantity: quantity('30.000'), conversionFactor: '1', unitCost, locationId: location!.id }],
    }),
  );
  if (!received.ok) throw new Error(`returnCredit setup (receive) failed: ${received.reason}`);
  const inv = await asOrg(f.orgId, (tx) => recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-01', totalAmount: '1000.00' }));
  await asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.manager, inv.id, [{ itemId: item!.id, quantity: '10.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100.00', lineTotal: '1000.00' }]));
  const [line] = await sql<{ id: string }[]>`select id from supplier_invoice_lines where supplier_invoice_id = ${inv.id}`;
  await sql`update stock_layers set is_provisional = false, invoice_line_id = ${line!.id} where id = ${received.layers[0]!.layerId}`;
  const ret = await asOrg(f.orgId, (tx) =>
    recordReturn(tx, {
      storeId: f.storeId, supplierId: f.supplierId, deliveryId: d!.id, returnedOn: '2026-01-06', reason: 'credit setup',
      lines: [{ itemId: item!.id, itemKind: 'raw_material', locationId: location!.id, quantity: quantity('10.000'), deliveryLineId: dl!.id }],
      actor: f.manager,
    }),
  );
  if (!ret.ok) throw new Error(`returnCredit setup (return) failed: ${ret.reason}`);
  return ret.returnId;
}

describe('AUDIT A2 — voidPayment vs voidReturn serialise on the supplier credit', () => {
  /** Pool = P's overpay 500 + R's return credit 500 − a draw of 500 = 500: either void alone is fine, BOTH would drive it to −500. */
  async function poolOf500(f: Fixture) {
    const { p, b } = await creditAndABill(f); // P overpay 500, bill b 500
    const returnId = await returnCredit(f, '50.0000'); // +500
    await pay(f, b.expenseId, { amount: '500.00', creditApplied: '500.00' }); // draw 500
    expect(await position(f), 'fixture: a pool of exactly 500').toBe('500.00');
    return { p, returnId };
  }
  const voidReturnOp = (f: Fixture, returnId: string) => (tx: Tx) => voidReturn(tx, f.manager, returnId, 'Sent back by mistake');

  it('A voids the return (holds), B voids P -> B waits on `advisory`; exactly one succeeds; the credit is never below 0.00 — Mutant: no lock in voidReturn -> both pass, −500, red', async () => {
    const f = await fixture('aA2a');
    const { p, returnId } = await poolOf500(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, voidReturnOp(f, returnId), voidOp(f, f.manager, p.paymentId), ADVISORY);

    expect(succeeded(aResult), `the return void itself: ${JSON.stringify((aResult as { value?: unknown }).value ?? '')}`).toBe(true);
    expect(bWaited, 'B never waited: voidReturn takes no supplier-credit lock').toBe(true);
    expect([aResult, bResult].filter(succeeded).length, 'exactly one of the two voids succeeds').toBe(1);
    expect(Number(await position(f))).toBeGreaterThanOrEqual(0);
    expect(await position(f)).toBe('0.00');
  });

  it('reverse order: A voids P (holds), B voids the return -> B waits, then is refused (ok:false); the credit is 0.00', async () => {
    const f = await fixture('aA2b');
    const { p, returnId } = await poolOf500(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, voidOp(f, f.manager, p.paymentId), voidReturnOp(f, returnId), ADVISORY);

    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited: voidReturn reads the credit without the lock').toBe(true);
    expect(succeeded(bResult), 'the return void must be refused once the payment void took the credit').toBe(false);
    expect(await position(f)).toBe('0.00');
  });
});

describe('AUDIT B — N2 counts the credit the payment itself APPLIED (net, not gross)', () => {
  /** P0 gives a ₱400 credit. Q pays 1,000: 600 to a bill, 400 of credit applied, so 400 is left unallocated (1240: DR 400, CR 400). */
  async function qWithCreditApplied(f: Fixture, creditApplied: string) {
    const x = await bill(f, '1000.00');
    await pay(f, x.expenseId, { amount: '1400.00', applied: '1000.00' }); // P0: overpay 400
    const y = await bill(f, '600.00');
    const q = await pay(f, y.expenseId, { amount: '1000.00', applied: '600.00', creditApplied });
    return { q };
  }
  const spend = async (f: Fixture, amount: string) => {
    const z = await bill(f, amount);
    await pay(f, z.expenseId, { amount, creditApplied: amount });
  };

  it('ALLOWED: Q nets 0 on 1240 (overpay 400, applied 400); a later draw leaves held 0 < 400, yet the void posts and the credit stays 0.00 — positive control for N2', async () => {
    const f = await fixture('aB1');
    const { q } = await qWithCreditApplied(f, '400.00');
    await spend(f, '400.00'); // the pool (400) is fully drawn
    expect(await position(f), 'fixture: held 0').toBe('0.00');

    await doVoid(f, f.manager, q.paymentId);
    expect((await paymentRow(q.paymentId)).status).toBe('voided');
    expect(await position(f)).toBe('0.00');
  });

  it('the genuinely-spent case is still refused: Q applied only 100 (nets +300 on 1240) and the pool was then drawn to 0 -> the void is refused, the credit stays 0.00', async () => {
    const f = await fixture('aB2');
    const x = await bill(f, '1000.00');
    await pay(f, x.expenseId, { amount: '1100.00', applied: '1000.00' }); // P0: overpay 100
    const y = await bill(f, '600.00');
    const q = await pay(f, y.expenseId, { amount: '1000.00', applied: '600.00', creditApplied: '100.00' }); // overpay 400, applied 100: net +300
    await spend(f, '400.00'); // pool 400 -> 0
    expect(await position(f)).toBe('0.00');

    const refused = await rejection(doVoid(f, f.manager, q.paymentId), "a void of Q whose net 1240 credit was already spent");
    expect(refused.userMessage).toMatch(/has already been used to pay later bills/);
    expect(refused.userMessage).not.toMatch(UUID);
    expect((await paymentRow(q.paymentId)).status).toBe('posted');
    expect(await position(f)).toBe('0.00');
  });
});

describe('AUDIT C — a concurrent double-submit of an overpayment void', () => {
  it('A voids P (holds); B submits the SAME void -> B waits, then reads status AFTER the lock: "This payment has already been voided." — not "already been used" — Mutant: status read before the lock -> the N2 message, red', async () => {
    const f = await fixture('aC');
    const { p } = await creditAndABill(f); // pool 500, all of it P's overpayment

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, voidOp(f, f.manager, p.paymentId), voidOp(f, f.manager, p.paymentId, 'Double click'), ADVISORY);

    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited').toBe(true);
    expect(bResult.status).toBe('rejected');
    expect((bResult as { reason: { userMessage?: string } }).reason.userMessage).toBe('This payment has already been voided.');
    expect(await reversalsOf((await paymentRow(p.paymentId)).journal_entry_id)).toHaveLength(1);
  });
});

describe('AUDIT E (domain half) — a void whose reversal date lands in a LOCKED month is refused', () => {
  it('payment in January; the whole of 2026 locked; voidOn in a locked February -> "That date is not in an open month…"; nothing written', async () => {
    const f = await fixture('aE');
    const { expenseId } = await bill(f, '3000.00');
    const paid = await pay(f, expenseId, { amount: '3000.00', on: '2026-01-15' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;

    const refused = await rejection(doVoid(f, f.manager, paid.paymentId, 'Bounced cheque', '2026-02-10'), 'a void dated in a locked month');
    expect(refused.userMessage).toBe('That date is not in an open month. Pick a date in an open month for the reversal.');
    expect(await reversalsOf(paid.entryId)).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('posted');
  });
});
