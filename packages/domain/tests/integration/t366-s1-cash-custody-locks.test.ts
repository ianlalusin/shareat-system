import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S1 (DEF-374) — lock before reading the cap. `docs/tasks/366-remittance-floats.md` §S1.
 * Two concurrent handovers/payouts must not both pass one cap: `createRemittance`,
 * `distributeServiceCharge` and `payLiability` each take a lock (transaction-scoped advisory for
 * the first two, a row `for update` for the third) immediately after `authorize()` and before the
 * first read of the cap they enforce. Harness/fixture copied from `remittance.test.ts` (till/safe
 * accounts, `tillMovement`, `verifiedDay`), `service-charge-distribution.test.ts` (`fund`,
 * `accrue`, two-store shape), and `liabilities.test.ts` (`fund`, `createLiability`,
 * `chargeLiability`, `positionOf`).
 *
 * T4 (charge vs reversal) needs S2's `resolveRemittanceVariance` charge action, which does not
 * exist yet — per the task doc's own instruction ("the tester adds it to this file when S2
 * lands"), it is deliberately NOT written here.
 *
 * Every leg below must be red today because no lock exists yet: without one, the second caller
 * reads the cap under READ COMMITTED before the first commits, so both pass a cap only one should
 * — `bWaited` stays false and both operations fulfil, failing this file's own assertions on the
 * TARGET (not a missing module).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, liabilitiesRepo, remittanceRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createRemittance, chargeLiability, createLiability, payLiability } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { distributeServiceCharge } from '../../src/service-charge';

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
// Concurrency harness
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Wraps B's operation so its transaction first reports its own backend pid. The poll below is then
 * pinned to exactly that pid, so a parallel test file on the same DB can neither add a second
 * "waiting" row nor be mistaken for B waiting (mutant: drop the `pid = bPid` filter -> a stranger's
 * Lock wait reads as "B waited" / throws "found N", red under parallel files). */
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

/** Polls `pg_stat_activity` (up to `timeoutMs`, default 5s per the task doc) for B's OWN backend
 * (`bPid`) waiting on one of `waitEvents` under `wait_event_type = 'Lock'`. Races against
 * `settleWatch` so a caller that never contends does not pay the full timeout. */
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

/**
 * Tx A runs `opA` inside a held-open transaction (its own advisory/row lock stays taken until the
 * caller resolves the returned `release`); Tx B then runs `opB` concurrently. A third connection
 * (this file's own `sql`) polls for B blocking on `waitEvents`. Returns both outcomes and whether B
 * was actually observed waiting — never a `Promise.all` race (register: `ap.test.ts:712-724`
 * passed once without its lock).
 */
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

function settledValue<T>(s: Settled<T>): T {
  if (s.status === 'rejected') throw new Error(`expected fulfilled, got rejected: ${String((s.reason as Error)?.message ?? s.reason)}`);
  return s.value;
}
function settledError(s: Settled<unknown>): unknown {
  if (s.status === 'fulfilled') throw new Error('expected rejected, got fulfilled');
  return s.reason;
}

const ADVISORY = ['advisory'];
const ROW_LOCK = ['transactionid', 'tuple'];

// -----------------------------------------------------------------------------------------------
// T1 — createRemittance
// -----------------------------------------------------------------------------------------------

async function remittanceFixture(hint: string) {
  const code = uid(`t366t1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { orgId, storeId, admin: actor(orgId, admin!.id), adminId: admin!.id, staff: actor(orgId, staff!.id), till: till!.id, safe: safe!.id };
}
type RemittanceFixture = Awaited<ReturnType<typeof remittanceFixture>>;

async function verifiedDay(f: RemittanceFixture, date: string) {
  await sql`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})`;
}
async function tillMovement(f: RemittanceFixture, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
  const [sales] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${sales!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
async function remittedTotalFor(storeId: string, date: string): Promise<string> {
  const [row] = await sql<{ n: string }[]>`
    select coalesce(sum(ra.amount), 0)::text as n from remittance_allocations ra
    join remittances r on r.id = ra.remittance_id where r.store_id = ${storeId} and ra.business_date = ${date}`;
  return row!.n;
}
async function remittancesCount(storeId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from remittances where store_id = ${storeId}`;
  return Number(row!.n);
}

const remitOp = (f: RemittanceFixture, date: string, amount: string) => (tx: Tx) =>
  createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: date, lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount }] });

describe('T1 — createRemittance: two handovers cannot both pass one cap', () => {
  it('exactly one fulfils; the other is refused (check-2); allocations total 6,000; day owed 4,000; one remittances row — Mutant: remove the lock -> both fulfil, 12,000 allocated, red', async () => {
    const f = await remittanceFixture('t1');
    const date = '2026-01-10';
    await verifiedDay(f, date);
    await tillMovement(f, date, '10000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, remitOp(f, date, '6000.00'), remitOp(f, date, '6000.00'), ADVISORY);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    const outcomes = [aResult, bResult];
    const fulfilledCount = outcomes.filter((o) => o.status === 'fulfilled').length;
    const rejectedCount = outcomes.filter((o) => o.status === 'rejected').length;
    expect(fulfilledCount, 'exactly one fulfilled').toBe(1);
    expect(rejectedCount, 'exactly one rejected').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected')!;
    expect(String((settledError(rejected) as Error).message)).toMatch(/settleable days owe only/);

    expect(await remittedTotalFor(f.storeId, date)).toBe('6000.00');
    expect(await remittancesCount(f.storeId)).toBe(1);
  });

  it('positive control: two DIFFERENT stores never contend — both fulfil, B never waits — Mutant: a fixed global key makes B wait, red', async () => {
    const fA = await remittanceFixture('t1pcA');
    const fB = await remittanceFixture('t1pcB');
    const date = '2026-01-10';
    await verifiedDay(fA, date);
    await tillMovement(fA, date, '10000.00');
    await verifiedDay(fB, date);
    await tillMovement(fB, date, '10000.00');

    // Two different orgs (and stores) can't share `runConcurrencyLeg`'s single asOrg(orgId, ...)
    // call, so this leg drives A and B by hand, on their own orgs, with the same barrier shape.
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(fA.orgId, async (tx) => {
      const value = await remitOp(fA, date, '6000.00')(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    });
    await aReady.promise;
    const trackedB = trackPid(remitOp(fB, date, '6000.00'));
    const bPromise = asOrg(fB.orgId, trackedB.op);
    const waiting = await pollForWaitingBackend(trackedB.pid, ADVISORY, bPromise, 5000);
    gate.resolve();
    const [, bValue] = await Promise.all([aPromise, bPromise]);

    expect(waiting, 'a different store must never block B').toBeNull();
    expect(bValue.handedOver).toBe('6000.00');
    expect(await remittedTotalFor(fB.storeId, date)).toBe('6000.00');
  });

  it('a single uncontended call still succeeds with the same figures as today', async () => {
    const f = await remittanceFixture('t1solo');
    const date = '2026-01-10';
    await verifiedDay(f, date);
    await tillMovement(f, date, '10000.00');
    const result = await asOrg(f.orgId, remitOp(f, date, '6000.00'));
    expect(result.handedOver).toBe('6000.00');
    expect(await remittedTotalFor(f.storeId, date)).toBe('6000.00');
  });
});

describe('Refusal — a non-holder is refused at once, without waiting, while A holds the lock', () => {
  it('staff is refused immediately (authorize runs before the lock)', async () => {
    const f = await remittanceFixture('t1refuse');
    const date = '2026-01-10';
    await verifiedDay(f, date);
    await tillMovement(f, date, '10000.00');

    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(f.orgId, async (tx) => {
      await remitOp(f, date, '6000.00')(tx);
      aReady.resolve();
      await gate.promise;
    });
    await aReady.promise;

    const startedAt = Date.now();
    let rejected: unknown;
    try {
      await asOrg(f.orgId, (tx) => createRemittance(tx, f.staff, { storeId: f.storeId, remittedOn: date, lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '1000.00' }] }));
    } catch (err) {
      rejected = err;
    }
    const elapsedMs = Date.now() - startedAt;
    gate.resolve();
    await aPromise;

    expect(rejected).toBeInstanceOf(AuthorizationError);
    expect(elapsedMs, `refusal took ${elapsedMs}ms — a lock-waiting refusal would take ~5000ms`).toBeLessThan(2000);
  });
});

// -----------------------------------------------------------------------------------------------
// T2 — distributeServiceCharge
// -----------------------------------------------------------------------------------------------

async function serviceChargeFixture(hint: string) {
  const code = uid(`t366t2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [officeCash] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and gl_account_code = '1130' and custodian = 'office' and is_foundation`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;

  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate: '2026-01-01',
      sourceType: 'manual_journal',
      sourceId: uid('fund'),
      idempotencyKey: uid('fund'),
      memo: 'fixture funding',
      postedBy: adminId,
      lines: [
        { accountCode: '1130', storeId, debit: '1000000.00' },
        { accountCode: '3900', storeId, credit: '1000000.00' },
      ],
    }),
  );
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate: '2026-01-01',
      sourceType: 'manual_journal',
      sourceId: uid('accrue'),
      idempotencyKey: uid('accrue'),
      memo: 'fixture accrual',
      postedBy: adminId,
      lines: [
        { accountCode: '1110', storeId, debit: '1000.00' },
        { accountCode: '2160', storeId, credit: '1000.00' },
      ],
    }),
  );

  return { orgId, storeId, admin: actor(orgId, adminId), staff: actor(orgId, staff!.id), officeCashId: officeCash!.id };
}
type ServiceChargeFixture = Awaited<ReturnType<typeof serviceChargeFixture>>;

async function serviceChargeBalance(orgId: string, storeId: string): Promise<number> {
  const [row] = await sql<{ balance: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2160' and jl.store_id = ${storeId}`;
  return Number(row!.balance);
}

const distributeOp = (f: ServiceChargeFixture, amount: string, paidOn: string) => (tx: Tx) =>
  distributeServiceCharge(tx, f.admin, { storeId: f.storeId, moneyAccountId: f.officeCashId, amount, paidOn });

describe('T2 — distributeServiceCharge: two payouts cannot both pass one float cap', () => {
  it('exactly one fulfils; the residual is 300.00 or 400.00, never negative — Mutant: remove the lock -> balance -300.00, red', async () => {
    const f = await serviceChargeFixture('t2');
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, distributeOp(f, '700.00', '2026-01-05'), distributeOp(f, '600.00', '2026-01-06'), ADVISORY);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one fulfilled').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected')!;
    expect(String((settledError(rejected) as Error).message)).toMatch(/only ₱|service charge float only holds/);

    const balance = await serviceChargeBalance(f.orgId, f.storeId);
    expect([300, 400]).toContain(balance);
    expect(balance).toBeGreaterThanOrEqual(0);
  });

  it('positive control: two DIFFERENT stores never contend', async () => {
    const fA = await serviceChargeFixture('t2pcA');
    const fB = await serviceChargeFixture('t2pcB');

    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(fA.orgId, async (tx) => {
      const value = await distributeOp(fA, '700.00', '2026-01-05')(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    });
    await aReady.promise;
    const trackedB = trackPid(distributeOp(fB, '600.00', '2026-01-06'));
    const bPromise = asOrg(fB.orgId, trackedB.op);
    const waiting = await pollForWaitingBackend(trackedB.pid, ADVISORY, bPromise, 5000);
    gate.resolve();
    const [, bValue] = await Promise.all([aPromise, bPromise]);

    expect(waiting, 'a different store must never block B').toBeNull();
    expect(bValue.created).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T3 — payLiability
// -----------------------------------------------------------------------------------------------

async function liabilityFixture(hint: string) {
  const code = uid(`t366t3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;

  const managerActor = actor(orgId, manager!.id);
  await sql.begin(async (tx) => {
    const [period] = await tx<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in ('1130', '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1130')!}, ${storeId}, '200000.00', '0'), (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', '200000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });

  const { id: liabilityId } = await asOrg(orgId, (tx) => createLiability(tx, managerActor, { storeId, name: 'Accrued rent — January', category: 'accrued_expenses' }));
  await asOrg(orgId, (tx) => chargeLiability(tx, managerActor, { liabilityId, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-15' }));

  return { orgId, storeId, manager: managerActor, staff: actor(orgId, staff!.id), liabilityId, till: till!.id };
}
type LiabilityFixture = Awaited<ReturnType<typeof liabilityFixture>>;

const positionOf = (f: LiabilityFixture) => asOrg(f.orgId, (tx) => liabilitiesRepo.positionOf(tx, f.orgId, f.liabilityId));

const payOp = (f: LiabilityFixture, amount: string) => (tx: Tx) =>
  payLiability(tx, f.manager, { liabilityId: f.liabilityId, amount, fromMoneyAccountId: f.till, on: '2026-01-20' });

describe('T3 — payLiability: two payments cannot both pass one outstanding cap', () => {
  it('exactly one fulfils; outstanding is 300.00 or 400.00, never negative — Mutant: remove the lock -> outstanding -300.00, red', async () => {
    const f = await liabilityFixture('t3');
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, payOp(f, '700.00'), payOp(f, '600.00'), ROW_LOCK);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one fulfilled').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected')!;
    expect(String((settledError(rejected) as Error).message)).toMatch(/more than the ₱.* still owed/);

    const outstanding = Number((await positionOf(f)).outstanding);
    expect([300, 400]).toContain(outstanding);
    expect(outstanding).toBeGreaterThanOrEqual(0);
  });

  it('positive control: two DIFFERENT liabilities never contend', async () => {
    const fA = await liabilityFixture('t3pcA');
    const fB = await liabilityFixture('t3pcB');

    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(fA.orgId, async (tx) => {
      const value = await payOp(fA, '700.00')(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    });
    await aReady.promise;
    const trackedB = trackPid(payOp(fB, '600.00'));
    const bPromise = asOrg(fB.orgId, trackedB.op);
    const waiting = await pollForWaitingBackend(trackedB.pid, ROW_LOCK, bPromise, 5000);
    gate.resolve();
    const [, bValue] = await Promise.all([aPromise, bPromise]);

    expect(waiting, 'a different liability must never block B').toBeNull();
    expect(bValue.outstanding).toBe('400.00');
  });

  it('a single uncontended call still succeeds with the same figures as today', async () => {
    const f = await liabilityFixture('t3solo');
    const result = await asOrg(f.orgId, payOp(f, '700.00'));
    expect(result.outstanding).toBe('300.00');
  });
});
