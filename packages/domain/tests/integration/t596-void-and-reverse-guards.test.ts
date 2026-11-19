import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-596 PR B - expense void, CAPEX below the threshold, liability reversal.
 * `docs/tasks/596-money-prepaid-expense-capex-liability.md`.
 *
 * DEF-890 a reimbursed expense could be voided; DEF-891 CAPEX under the threshold sat in 1510 with no register row;
 * DEF-892 voiding a CAPEX expense whose asset was disposed credited 1510 twice; DEF-893 reversing a paid-down charge
 * took 2500 negative. Fixture is copied from `fixed-assets.test.ts` (`setup`, `expenseWithInvoice`), the liability
 * calls from `t366-s1b-...`, the two-connection harness from the same file. Each org is unique, so no truncate.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, fixedAssetsRepo, liabilitiesRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  approveExpense,
  chargeLiability,
  createExpense,
  createLiability,
  disposeAsset,
  payLiability,
  payReimbursement,
  reverseLiabilityEntry,
  voidExpense,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 10 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface Fixture {
  orgId: string;
  storeId: string;
  staffId: string;
  managerId: string;
  adminId: string;
  till: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t596-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')
    `;
  }
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id
  `;
  const storeId = store!.id;

  const mkPerson = async (name: string, role: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
    `;
    await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
    return r!.id;
  };
  const staffId = await mkPerson(`${hint} Staff`, 'staff');
  const managerId = await mkPerson(`${hint} Manager`, 'manager');
  const adminId = await mkPerson(`${hint} Admin`, 'admin');

  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId,
  });

  // The office safe for the liability calls, funded 200,000 (opening balance against 3900).
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in ('1130', '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1130')!}, ${storeId}, '200000.00', '0'), (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', '200000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });

  return { orgId, storeId, staffId, managerId, adminId, till: till!.id };
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** credit - debit on one account across every non-draft entry whose source is `sourceId`. */
async function ledgerTotal(orgId: string, sourceId: string, code: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_id = ${sourceId} and a.code = ${code} and je.status <> 'draft'
  `;
  return row!.total;
}

async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit, jl.credit
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no
  `;
}

/** What the store owes one person on 2130 at this store, straight from the ledger. */
async function owedAt(orgId: string, storeId: string, employeeId: string): Promise<string> {
  const [row] = await sql<{ n: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as n
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2130'
      and jl.store_id = ${storeId} and jl.party_type = 'employee' and jl.party_id = ${employeeId}`;
  return row!.n;
}

/** Every refusal carries its sentence in `userMessage`; this returns it (or fails the test if nothing was thrown). */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { userMessage?: string; message?: string }).userMessage ?? (err as Error).message);
  }
  throw new Error('expected a refusal, but the call succeeded');
}

/** A drafted expense against a verified supplier invoice, paid from a funded cashier drawer (or reimbursable). */
async function expenseWithInvoice(
  f: Fixture,
  amount: string,
  opts: { categoryName?: string; particulars?: string; reimbursable?: boolean } = {},
): Promise<string> {
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and category = ${opts.categoryName ?? 'Capital Expenditure'}
  `;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, 'T596 Supplier', ${f.staffId})
    on conflict (org_id, name) do update set updated_at = now()
    returning id
  `;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo',
            ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/t596-${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id
  `;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${f.orgId}, ${f.storeId}, ${supplier!.id}, '2026-01-20', '99999999.00', 'verified',
      ${file!.id}, ${f.managerId}, now(), ${f.staffId}, true, true, true, true
    )
    returning id
  `;
  const [drawer] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Cashier drawer', 'cash', '1110', 'cashier')
    on conflict (org_id, store_id, name) do update set updated_at = now()
    returning id
  `;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-19', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft')
      returning id
    `;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, '500000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '500000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });

  const created = await asOrg(f.orgId, (tx) =>
    createExpense(tx, actor(f.orgId, f.staffId), {
      requireItemised: false /* legacy fixture: lineless invoice */,
      storeId: f.storeId,
      supplierId: supplier!.id,
      supplierInvoiceId: invoice!.id,
      businessDate: '2026-01-20',
      categoryId: cat!.id,
      particulars: opts.particulars ?? 'Commercial deep fryer',
      payments: opts.reimbursable
        ? [{ method: 'reimbursable', amount, staffId: f.staffId }]
        : [{ method: 'cash', amount, moneyAccountId: drawer!.id }],
    }),
  );
  return created.id;
}

const drawerOf = async (f: Fixture) =>
  (await sql<{ id: string }[]>`select id from money_accounts where org_id = ${f.orgId} and name = 'Cashier drawer'`)[0]!.id;

const approve = (f: Fixture, expenseId: string) =>
  asOrg(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), expenseId));
const voidIt = (f: Fixture, expenseId: string) =>
  asOrg(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), expenseId, 'T-596'));
const payBack = (f: Fixture, amount: string) =>
  asOrg(f.orgId, async (tx) =>
    payReimbursement(tx, actor(f.orgId, f.managerId), {
      storeId: f.storeId, employeeId: f.staffId, amount, payoutId: crypto.randomUUID(),
      fromMoneyAccountId: await drawerOf(f), on: '2026-01-25',
    }),
  );

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

async function pollForWaitingBackend(bPid: Promise<number>, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000): Promise<{ pid: number; query: string } | null> {
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
function settledError(s: Settled<unknown>): unknown {
  if (s.status === 'fulfilled') throw new Error('expected rejected, got fulfilled');
  return s.reason;
}

const ROW_LOCK = ['transactionid', 'tuple'];
const ADVISORY = ['advisory'];

// =========================================================================================
// DEF-893 - reversing a charge that payments already cover
// =========================================================================================

describe('DEF-893 - a paid-down charge cannot be reversed', () => {
  const newLiability = (f: Fixture, name: string) =>
    asOrg(f.orgId, (tx) => createLiability(tx, actor(f.orgId, f.managerId), { storeId: f.storeId, name })).then((r) => r.id);
  const charge = (f: Fixture, liabilityId: string, amount: string) =>
    asOrg(f.orgId, (tx) =>
      chargeLiability(tx, actor(f.orgId, f.managerId), { requestId: crypto.randomUUID(), liabilityId, amount, againstAccountCode: '6200', on: '2026-01-05' }),
    );
  const pay = (f: Fixture, liabilityId: string, amount: string) =>
    asOrg(f.orgId, (tx) =>
      payLiability(tx, actor(f.orgId, f.managerId), { requestId: crypto.randomUUID(), liabilityId, amount, fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );
  const reverse = (f: Fixture, liabilityId: string, entryId: string) =>
    asOrg(f.orgId, (tx) => reverseLiabilityEntry(tx, actor(f.orgId, f.managerId), { liabilityId, entryId, reason: 'T-596' }));
  const outstanding = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => liabilitiesRepo.positionOf(tx, f.orgId, id)).then((p) => p.outstanding);

  it('charge 1,000, pay 600, reverse the charge -> refused, still owing 400 - Mutant: delete the guard -> outstanding -600.00, red', async () => {
    const f = await setup('d893');
    const id = await newLiability(f, 'Loan from landlord');
    const c = await charge(f, id, '1000.00');
    await pay(f, id, '600.00');
    const sentence = await refusal(reverse(f, id, c.entryId));
    expect(sentence).toMatch(/Reversing this .*1,000\.00 charge would leave Loan from landlord owing -₱600\.00, because payments already cover it\. Reverse a payment first\./);
    expect(await outstanding(f, id)).toBe('400.00');
  });

  it('a charge with nothing paid reverses, and so does a payment', async () => {
    const f = await setup('d893ok');
    const a = await newLiability(f, 'Unpaid');
    const ca = await charge(f, a, '1000.00');
    await reverse(f, a, ca.entryId);
    expect(await outstanding(f, a)).toBe('0.00');

    const b = await newLiability(f, 'Part paid');
    await charge(f, b, '1000.00');
    const pb = await pay(f, b, '600.00');
    await reverse(f, b, pb.entryId); // a payment's net is negative, so it always passes
    expect(await outstanding(f, b)).toBe('1000.00');
  });

  it('a charge can still be reversed when the other charges cover what was paid', async () => {
    const f = await setup('d893two');
    const id = await newLiability(f, 'Two charges');
    const c1 = await charge(f, id, '1000.00');
    await charge(f, id, '1000.00');
    await pay(f, id, '600.00');
    await reverse(f, id, c1.entryId); // 1,400 owed, removing 1,000 leaves 400
    expect(await outstanding(f, id)).toBe('400.00');
  });
});

// =========================================================================================
// DEF-890 - a reimbursed expense cannot be voided
// =========================================================================================

describe('DEF-890 - voiding an expense already paid back to the person', () => {
  it('800 reimbursable, 800 paid -> void refused, nothing reversed - Mutant: delete the guard -> 2130 goes to -800.00, red', async () => {
    const f = await setup('d890');
    const e = await expenseWithInvoice(f, '800.00', { categoryName: 'Utilities', reimbursable: true });
    await approve(f, e);
    await payBack(f, '800.00');
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');

    const sentence = await refusal(voidIt(f, e));
    expect(sentence).toMatch(/has already been paid back to .* as a reimbursement\. Void the reimbursement payment first, then void the expense\./);
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');
    const [row] = await sql<{ status: string }[]>`select status from expenses where id = ${e}`;
    expect(row!.status).toBe('posted');
  });

  it('unpaid -> voids; pooled: two 500 expenses, 500 paid -> one voids, the second then refuses', async () => {
    const f = await setup('d890pool');
    const solo = await expenseWithInvoice(f, '300.00', { categoryName: 'Utilities', reimbursable: true });
    await approve(f, solo);
    await voidIt(f, solo);
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');

    const a = await expenseWithInvoice(f, '500.00', { categoryName: 'Utilities', reimbursable: true });
    const b = await expenseWithInvoice(f, '500.00', { categoryName: 'Utilities', reimbursable: true });
    await approve(f, a);
    await approve(f, b);
    await payBack(f, '500.00');
    await voidIt(f, a); // 500 still owed covers a's 500
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');
    await refusal(voidIt(f, b)); // nothing left owed
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');
  });

  it('a payout holding the payee lock makes the void wait, then refuse - Mutant: drop the lock -> the void does not wait and succeeds, red', async () => {
    const f = await setup('d890race');
    const e = await expenseWithInvoice(f, '800.00', { categoryName: 'Utilities', reimbursable: true });
    await approve(f, e);
    const drawer = await drawerOf(f);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) =>
        payReimbursement(tx, actor(f.orgId, f.managerId), {
          storeId: f.storeId, employeeId: f.staffId, amount: '800.00', payoutId: crypto.randomUUID(), fromMoneyAccountId: drawer, on: '2026-01-25',
        }),
      (tx) => voidExpense(tx, actor(f.orgId, f.managerId), e, 'T-596'),
      ADVISORY,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'the void never waited for the payout').toBe(true);
    expect(bResult.status).toBe('rejected');
    expect(await owedAt(f.orgId, f.storeId, f.staffId)).toBe('0.00');
  });
});

// =========================================================================================
// DEF-892 - voiding a CAPEX expense whose asset was disposed
// =========================================================================================

describe('DEF-892 - a bill for a disposed asset cannot be voided', () => {
  it('refused, and 1510 is not credited twice - Mutant: delete the guard -> 1510 for the bill nets -90000.00, red', async () => {
    const f = await setup('d892');
    const e = await expenseWithInvoice(f, '45000.00');
    const posted = await approve(f, e);
    expect(posted.assetId).toBeTruthy();
    await asOrg(f.orgId, (tx) =>
      disposeAsset(tx, actor(f.orgId, f.adminId), { assetId: posted.assetId!, disposedOn: '2026-03-15', reason: 'Beyond repair' }),
    );
    const before = await ledgerTotal(f.orgId, posted.assetId!, '1510');

    expect(await refusal(voidIt(f, e))).toBe("This asset was already disposed, so this bill can't be voided.");
    expect(await ledgerTotal(f.orgId, posted.assetId!, '1510')).toBe(before);
    expect(await ledgerTotal(f.orgId, e, '1510')).toBe('-45000.00'); // the bill's own credit side is untouched: not reversed
    const [row] = await sql<{ status: string }[]>`select status from expenses where id = ${e}`;
    expect(row!.status).toBe('posted');
  });

  it('an ACTIVE asset still retires on void (DEF-160 stays green)', async () => {
    const f = await setup('d892ok');
    const e = await expenseWithInvoice(f, '45000.00');
    const posted = await approve(f, e);
    await voidIt(f, e);
    const asset = await asOrg(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, posted.assetId!));
    expect(asset!.status).toBe('disposed');
    expect(await ledgerTotal(f.orgId, e, '1510')).toBe('0.00');
  });

  it('a disposal holding the asset lock makes the void wait, then refuse - Mutant: read the asset without the lock -> the void is not refused, red', async () => {
    const f = await setup('d892race');
    const e = await expenseWithInvoice(f, '45000.00');
    const posted = await approve(f, e);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => disposeAsset(tx, actor(f.orgId, f.adminId), { assetId: posted.assetId!, disposedOn: '2026-03-15', reason: 'Beyond repair' }),
      (tx) => voidExpense(tx, actor(f.orgId, f.managerId), e, 'T-596'),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'the void never waited for the disposal').toBe(true);
    expect(bResult.status).toBe('rejected');
    expect(String((settledError(bResult) as { userMessage?: string }).userMessage)).toMatch(/already disposed/);
  });
});

// =========================================================================================
// DEF-891 - CAPEX under the threshold is expensed, not parked in 1510
// =========================================================================================

describe('DEF-891 - CAPEX under the capitalisation threshold posts to 6510', () => {
  it('4,999.99 -> DR 6510 / CR 1110, nothing in 1510, no asset; the void reverses 6510 - Mutant: route the category account (1510) -> red', async () => {
    const f = await setup('d891');
    const e = await expenseWithInvoice(f, '4999.99');
    const posted = await approve(f, e);
    expect(posted.assetId).toBeNull();
    expect((await linesFor(posted.journalEntryId)).map((l) => `${l.code} ${l.debit}/${l.credit}`).sort()).toEqual([
      '1110 0.00/4999.99',
      '6510 4999.99/0.00',
    ]);
    expect(await ledgerTotal(f.orgId, e, '1510')).toBe('0');
    const assets = await asOrg(f.orgId, (tx) => fixedAssetsRepo.listAssets(tx, f.orgId, {}));
    expect(assets).toHaveLength(0);

    await voidIt(f, e);
    expect(await ledgerTotal(f.orgId, e, '6510')).toBe('0.00');
  });

  it('5,000.00 still posts to 1510 and registers the asset', async () => {
    const f = await setup('d891at');
    const e = await expenseWithInvoice(f, '5000.00');
    const posted = await approve(f, e);
    expect(posted.assetId).toBeTruthy();
    expect((await linesFor(posted.journalEntryId)).map((l) => l.code).sort()).toEqual(['1110', '1510']);
    expect(await ledgerTotal(f.orgId, e, '6510')).toBe('0');
  });
});
