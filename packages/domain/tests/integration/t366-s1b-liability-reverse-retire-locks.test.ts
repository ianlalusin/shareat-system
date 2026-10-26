import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S1b (DEF-529) — `reverseLiabilityEntry` and `retireLiability` (`packages/domain/src/
 * liabilities/index.ts:226,255`) take no lock, unlike `payLiability` (T-366 S1, already fixed). A
 * payment racing a charge reversal can drive a liability negative; a charge landing during a
 * retire leaves a retired liability that still owes. Fix (builder's): `lockForPayment` after
 * `authorize` in both. Harness copied from `t366-s1-cash-custody-locks.test.ts` (pid-tracked
 * two-connection barrier: `trackPid`, poll keyed on B's OWN backend pid only) — not editing that
 * file, per instruction.
 *
 * ⚠️ **R2 scope flag, not silently resolved:** for B (`chargeLiability`) to ever WAIT on A's lock,
 * `chargeLiability` itself would have to also call `lockForPayment` — it does not today, and the
 * briefing names only `reverseLiabilityEntry`/`retireLiability` as the builder's two touched
 * functions. `chargeLiability` also has no `retiredAt` check at all (it posts unconditionally), so
 * even with ordering forced, "a retired liability ends owing nothing" does not hold unless a charge
 * that lands can be refused once retired. R2 is written to the letter of the briefing; if
 * `chargeLiability` is not also touched, R2's `bWaited` half will still be red after the stated fix
 * lands — flagged in the RED report, not assumed away.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, liabilitiesRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { chargeLiability, createLiability, payLiability, reverseLiabilityEntry, retireLiability } from '@shareat/domain';

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
// Fixture — copied shape, liabilities.test.ts
// -----------------------------------------------------------------------------------------------

async function fund(orgId: string, storeId: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in ('1130', '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1130')!}, ${storeId}, ${amount}, '0'), (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function fixture(hint: string) {
  const code = uid(`t366s1b-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fund(orgId, storeId, '200000.00');
  return { orgId, storeId, manager: actor(orgId, p!.id), till: till!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const positionOf = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => liabilitiesRepo.positionOf(tx, f.orgId, id));
const newLiability = (f: Fixture, name: string) => asOrg(f.orgId, (tx) => createLiability(tx, f.manager, { storeId: f.storeId, name })).then((r) => r.id);

// -----------------------------------------------------------------------------------------------
// Concurrency harness — copied from t366-s1-cash-custody-locks.test.ts, not shared/imported
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

// -----------------------------------------------------------------------------------------------
// R1 — a payment racing a charge reversal
// -----------------------------------------------------------------------------------------------

describe('R1 — payLiability racing reverseLiabilityEntry on the same liability', () => {
  it('B waits; outstanding never negative; exactly one outcome writes — Mutant: no lock on reverseLiabilityEntry -> both proceed, outstanding -1000.00, red', async () => {
    const f = await fixture('r1');
    const liabilityId = await newLiability(f, 'R1 obligation');
    const charge = await asOrg(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-05' }));
    expect(charge.outstanding).toBe('1000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => reverseLiabilityEntry(tx, f.manager, { liabilityId, entryId: charge.entryId, reason: 'T-366 S1b R1' }),
      (tx) => payLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
      ROW_LOCK,
    );

    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect(aResult.status, 'the reversal itself has no cap to fail — it always succeeds').toBe('fulfilled');
    expect(bResult.status, 'once the reversal has landed, nothing is left to pay').toBe('rejected');
    expect(String((settledError(bResult) as Error).message)).toMatch(/more than the ₱0\.00 still owed/);

    const outstanding = Number((await positionOf(f, liabilityId)).outstanding);
    expect(outstanding).toBeGreaterThanOrEqual(0);
    expect(outstanding).toBe(0);
  });

  it('positive control: a DIFFERENT liability never contends', async () => {
    const f = await fixture('r1pc');
    const liabilityId = await newLiability(f, 'R1pc obligation A');
    const otherLiabilityId = await newLiability(f, 'R1pc obligation B');
    const charge = await asOrg(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-05' }));
    await asOrg(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: otherLiabilityId, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-05' }));

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => reverseLiabilityEntry(tx, f.manager, { liabilityId, entryId: charge.entryId, reason: 'T-366 S1b R1pc' }),
      (tx) => payLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: otherLiabilityId, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
      ROW_LOCK,
    );

    expect(bWaited, 'a different liability must never block B').toBe(false);
    expect(bResult.status).toBe('fulfilled');
  });

  it('a single uncontended reversal still succeeds with the same result as today', async () => {
    const f = await fixture('r1solo');
    const liabilityId = await newLiability(f, 'R1solo obligation');
    const charge = await asOrg(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-05' }));
    await asOrg(f.orgId, (tx) => reverseLiabilityEntry(tx, f.manager, { liabilityId, entryId: charge.entryId, reason: 'solo' }));
    expect((await positionOf(f, liabilityId)).outstanding).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// R2 — a charge landing during a retire
// -----------------------------------------------------------------------------------------------

describe('R2 — chargeLiability racing retireLiability on the same liability', () => {
  it('B waits; a retired liability ends owing nothing, or the charge is refused — Mutant: no lock on retireLiability -> both proceed, a retired liability owes 500.00, red', async () => {
    const f = await fixture('r2');
    const liabilityId = await newLiability(f, 'R2 obligation');
    expect((await positionOf(f, liabilityId)).outstanding).toBe('0.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => retireLiability(tx, f.manager, { liabilityId }),
      (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId, amount: '500.00', againstAccountCode: '6200', on: '2026-01-06' }),
      ROW_LOCK,
    );

    // See the file header: chargeLiability isn't known to take this lock today, so bWaited may
    // stay false even after the stated (reverse+retire-only) fix — recorded, not assumed away.
    expect(bWaited, 'B never waited: no lock (see file header re: chargeLiability scope)').toBe(true);
    expect(aResult.status).toBe('fulfilled');

    const position = await positionOf(f, liabilityId);
    if (bResult.status === 'fulfilled') {
      expect(position.outstanding, 'a retired liability must end owing nothing').toBe('0.00');
    } else {
      expect(String((settledError(bResult) as Error).message)).toMatch(/retired/i);
    }
  });

  it('positive control: a DIFFERENT liability never contends', async () => {
    const f = await fixture('r2pc');
    const liabilityId = await newLiability(f, 'R2pc obligation A');
    const otherLiabilityId = await newLiability(f, 'R2pc obligation B');

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => retireLiability(tx, f.manager, { liabilityId }),
      (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: otherLiabilityId, amount: '500.00', againstAccountCode: '6200', on: '2026-01-06' }),
      ROW_LOCK,
    );

    expect(bWaited, 'a different liability must never block B').toBe(false);
    expect(bResult.status).toBe('fulfilled');
  });

  it('a single uncontended retire still succeeds with the same result as today', async () => {
    const f = await fixture('r2solo');
    const liabilityId = await newLiability(f, 'R2solo obligation');
    await asOrg(f.orgId, (tx) => retireLiability(tx, f.manager, { liabilityId }));
    expect((await positionOf(f, liabilityId)).outstanding).toBe('0.00');
  });
});
