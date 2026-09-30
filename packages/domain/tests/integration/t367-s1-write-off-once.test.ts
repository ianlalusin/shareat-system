import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-367 S1 (DEF-201 + DEF-517 + DEF-520) — one write-off decision makes exactly one subledger row,
 * and two write-offs on one charge can never clear more than is owed.
 * `docs/tasks/367-ap-ar-money.md` §S1, legs W1-W4. Harness copied from `t366-s1-cash-custody-
 * locks.test.ts` (pid-tracked two-connection barrier). Fixture copied from `ar.test.ts` (`fixture`,
 * `recordCharge` shape), extended with a third admin (X, the charge's author) since Y and Z do the
 * writing off.
 *
 * ⛔ TESTER, not BUILDER. `writeOffCharge` (`packages/domain/src/ar/index.ts:495-568`) today: takes
 * no lock (DEF-517), never looks up its own idempotency key before posting (DEF-201 — it calls
 * `arRepo.insertWriteOff` unconditionally, so a double-click makes TWO `ar_write_offs` rows even
 * though `postEntry` itself dedupes the underlying journal ENTRY by key), and parses the amount
 * with bare `Number()` (DEF-520 — NaN-blind). `openItems` sums `ar_write_offs.amount` directly
 * (`packages/db/src/repo/ar.ts:216`), so two rows for one real posting silently double-counts the
 * derived "outstanding" even while the real ledger balance (1210) stays correct — that split is
 * exactly what invariant 6 (subledger == control) exists to catch.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { arRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createCustomer, recordCharge, recordCollection, writeOffCharge } from '@shareat/domain';

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
// Fixture — copied shape, ar.test.ts, extended with a third admin (X, the charge's author)
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string) {
  const code = uid(`t367s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  // A second store nobody writing off ever holds — the out-of-reach half of the E15-twin oracle
  // pair (T-367 S1 audit finding 2) needs a REAL charge the caller has no scope at, not just a
  // fake id, so the two refusal paths (not-found vs out-of-scope) are actually exercised.
  const [otherStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-other`)}, ${`Store ${hint} other`}) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open')`;
  const mk = async (name: string, role: string, scopeStoreId: string = storeId) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${scopeStoreId})`;
    return p!.id;
  };
  const xId = await mk('X (author)', 'admin');
  const yId = await mk('Y', 'admin');
  const zId = await mk('Z', 'admin');
  const staffId = await mk('Staff', 'staff');
  const outsiderId = await mk('Outsider', 'admin', otherStore!.id);
  const [drawer] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const x = actor(orgId, xId);
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, x, { name: `Resto ${code}` }));
  return {
    orgId, storeId, x, y: actor(orgId, yId), z: actor(orgId, zId), staff: actor(orgId, staffId), outsider: actor(orgId, outsiderId),
    xId, yId, customerId: customer.id, drawerId: drawer!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function charge(f: Fixture, amount = '1000.00', date = '2027-02-03') {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.x, { storeId: f.storeId, customerId: f.customerId, chargeDate: date, dueDate: null, totalAmount: amount, revenueAccountCode: '4150' }),
  );
}
async function rowsFor(chargeId: string): Promise<{ count: number; total: string }> {
  const [row] = await sql<{ n: string; total: string }[]>`select count(*)::text as n, coalesce(sum(amount), 0)::text as total from ar_write_offs where ar_charge_id = ${chargeId}`;
  return { count: Number(row!.n), total: Number(row!.total).toFixed(2) };
}
async function entriesFor(orgId: string, chargeId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'ar_write_off' and source_id = ${chargeId}`;
  return Number(row!.n);
}
async function balance1210(orgId: string, customerId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as total
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.status <> 'draft' and a.code = '1210' and l.party_type = 'customer' and l.party_id = ${customerId}`;
  return Number(row!.total).toFixed(2);
}
async function outstandingFor(f: Fixture, chargeId: string): Promise<string> {
  const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
  return open.find((o) => o.chargeId === chargeId)?.outstanding ?? '0.00';
}

// -----------------------------------------------------------------------------------------------
// Concurrency harness — copied from t366-s1-cash-custody-locks.test.ts
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
/**
 * Narrows a call expected to REJECT to its typed error, instead of unioning the catch handler's
 * return with the promise's resolve type (which is what made `.catch((e) => e as Error & {...})`
 * fail typecheck: the property access below type-checked against a union that still included the
 * success shape). Fails the test explicitly if the call resolves instead.
 */
async function rejection<E = Error & { userMessage?: string; code?: string }>(p: Promise<unknown>): Promise<E> {
  return p.then(
    () => {
      throw new Error('expected a refusal, but the call resolved');
    },
    (e: unknown) => e as E,
  );
}
const ROW_LOCK = ['transactionid', 'tuple'];
const writeOffOp = (f: Fixture, who: Actor, chargeId: string, amount: string) => (tx: Tx) => writeOffCharge(tx, who, { chargeId, amount, reason: 'bad debt' });

// -----------------------------------------------------------------------------------------------
// W1 — the double-click
// -----------------------------------------------------------------------------------------------

describe('W1 — the same write-off twice, concurrently', () => {
  it('B resolves with alreadyRecorded true and A\'s ids; 1 row, 1 entry, 1210=600.00, outstanding=600.00 — Mutant: guard removed & index absent -> 2 rows (HEAD\'s measured shape: subledger disagrees with control), red', async () => {
    const f = await fixture('w1');
    const c = await charge(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, writeOffOp(f, f.y, c.chargeId, '400.00'), writeOffOp(f, f.y, c.chargeId, '400.00'), ROW_LOCK);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status, 'a double-click must be harmless, never a throw').toBe('fulfilled');
    if (aResult.status === 'fulfilled' && bResult.status === 'fulfilled') {
      const a = aResult.value as { writeOffId: string; entryId: string; alreadyRecorded?: boolean };
      const b = bResult.value as { writeOffId: string; entryId: string; alreadyRecorded?: boolean };
      expect(b.alreadyRecorded, 'B must report the retry, not a fresh write-off').toBe(true);
      expect(b.writeOffId).toBe(a.writeOffId);
      expect(b.entryId).toBe(a.entryId);
    }

    const rows = await rowsFor(c.chargeId);
    expect(rows.count, 'exactly one ar_write_offs row').toBe(1);
    expect(rows.total).toBe('400.00');
    expect(await entriesFor(f.orgId, c.chargeId)).toBe(1);
    expect(await balance1210(f.orgId, f.customerId)).toBe('600.00');
    expect(await outstandingFor(f, c.chargeId), 'openItems must not double-count the retry row').toBe('600.00');
  });
});

describe('W1b — the double-click that exceeds half (R1 order)', () => {
  it('B waits, then resolves alreadyRecorded true (NOT the cap sentence); 1 row, 1 entry, 1210=300.00=outstanding — Mutant: key lookup after the cap -> B refused with the cap sentence, red', async () => {
    const f = await fixture('w1b');
    const c = await charge(f);

    const { bResult, bWaited } = await runConcurrencyLeg(f.orgId, writeOffOp(f, f.y, c.chargeId, '700.00'), writeOffOp(f, f.y, c.chargeId, '700.00'), ROW_LOCK);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect(bResult.status, 'a retry must resolve, never be refused by the cap').toBe('fulfilled');
    if (bResult.status === 'fulfilled') {
      expect((bResult.value as { alreadyRecorded?: boolean }).alreadyRecorded).toBe(true);
    }
    const rows = await rowsFor(c.chargeId);
    expect(rows.count).toBe(1);
    expect(await entriesFor(f.orgId, c.chargeId)).toBe(1);
    expect(await balance1210(f.orgId, f.customerId)).toBe('300.00');
    expect(await outstandingFor(f, c.chargeId)).toBe('300.00');
  });
});

// -----------------------------------------------------------------------------------------------
// W2 — two DIFFERENT write-offs (DEF-517)
// -----------------------------------------------------------------------------------------------

describe('W2 — two different write-offs, concurrently (DEF-517)', () => {
  it('exactly one fulfils; the other refused with the outstanding sentence, writes nothing; 1210 is 300.00 or 400.00, never negative — Mutant: lock removed -> both fulfil, 1210 = -300.00, red', async () => {
    const f = await fixture('w2');
    const c = await charge(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, writeOffOp(f, f.y, c.chargeId, '700.00'), writeOffOp(f, f.z, c.chargeId, '600.00'), ROW_LOCK);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one fulfilled').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    if (rejected) expect(String((settledError(rejected) as Error).message)).toMatch(/is outstanding/);

    const balance = Number(await balance1210(f.orgId, f.customerId));
    expect([300, 400]).toContain(balance);
    expect(balance).toBeGreaterThanOrEqual(0);
    const rows = await rowsFor(c.chargeId);
    expect(rows.count).toBe(await entriesFor(f.orgId, c.chargeId));
  });
});

// -----------------------------------------------------------------------------------------------
// W3 — sequential retry
// -----------------------------------------------------------------------------------------------

describe('W3 — sequential retry', () => {
  it('Y writes off 400, repeats -> second returns alreadyRecorded; 1 row', async () => {
    const f = await fixture('w3');
    const c = await charge(f);
    const first = (await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '400.00'))) as { writeOffId: string; alreadyRecorded?: boolean };
    // Audit finding 2 (S1 audit of step 1, item 2): a REAL first write-off must report
    // alreadyRecorded false — asserted nowhere before this, so a mutant returning `true`
    // unconditionally (ar/index.ts:609) passed every red here.
    expect(first.alreadyRecorded).toBe(false);
    const second = (await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '400.00'))) as { writeOffId: string; alreadyRecorded?: boolean };
    expect(second.alreadyRecorded).toBe(true);
    expect(second.writeOffId).toBe(first.writeOffId);
    expect((await rowsFor(c.chargeId)).count).toBe(1);
  });

  // Audit finding 7: the cleanest proof of R1's ordering — after a FULL write-off, outstanding is
  // exactly zero, so a retry would hit the cap refusal ("nothing outstanding") if the key lookup
  // (R1) ran AFTER the cap check instead of before it. It must not: it has to be recognised as the
  // same write-off and return alreadyRecorded, never refused.
  it('a FULL write-off (1,000.00), repeated -> alreadyRecorded true, not the cap refusal; 1 row', async () => {
    const f = await fixture('w3-full');
    const c = await charge(f);
    const first = (await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '1000.00'))) as { writeOffId: string; alreadyRecorded?: boolean };
    expect(first.alreadyRecorded).toBe(false);
    expect(await outstandingFor(f, c.chargeId)).toBe('0.00');
    const second = (await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '1000.00'))) as { writeOffId: string; alreadyRecorded?: boolean };
    expect(second.alreadyRecorded, 'R1 (key lookup) must run before the cap check, or this is refused as over the (zero) outstanding').toBe(true);
    expect(second.writeOffId).toBe(first.writeOffId);
    expect((await rowsFor(c.chargeId)).count).toBe(1);
    expect(await entriesFor(f.orgId, c.chargeId)).toBe(1);
    expect(await balance1210(f.orgId, f.customerId)).toBe('0.00');
    expect(await outstandingFor(f, c.chargeId)).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// Positive controls
// -----------------------------------------------------------------------------------------------

describe('Positive controls', () => {
  it('two REAL tranches (300 then 200): 2 rows, 2 entries, 1210=500.00, outstanding=500.00', async () => {
    const f = await fixture('pc-tranches');
    const c = await charge(f);
    await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '300.00'));
    await asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '200.00'));
    const rows = await rowsFor(c.chargeId);
    expect(rows.count).toBe(2);
    expect(await entriesFor(f.orgId, c.chargeId)).toBe(2);
    expect(await balance1210(f.orgId, f.customerId)).toBe('500.00');
    expect(await outstandingFor(f, c.chargeId)).toBe('500.00');
  });

  it('two DIFFERENT charges written off concurrently: both fulfil, B never waits (lock is per charge)', async () => {
    const f = await fixture('pc-diffcharge');
    const c1 = await charge(f, '1000.00');
    const c2 = await charge(f, '1000.00');
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, writeOffOp(f, f.y, c1.chargeId, '400.00'), writeOffOp(f, f.z, c2.chargeId, '400.00'), ROW_LOCK);
    expect(bWaited, 'a different charge must never block B').toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
  });

  it('recordCollection on the charge while A holds a write-off open: it waits, then allocates only what is left — Mutant: no shared lock, B never waits, red', async () => {
    const f = await fixture('pc-collection');
    const c = await charge(f);

    const { bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      writeOffOp(f, f.y, c.chargeId, '400.00'),
      (tx) => recordCollection(tx, f.x, { storeId: f.storeId, customerId: f.customerId, collectionDate: '2027-02-04', amount: '1000.00', moneyAccountId: f.drawerId, allocations: [{ chargeId: c.chargeId, amountApplied: '1000.00' }] }),
      ROW_LOCK,
    );

    expect(bWaited, 'B never waited: no lock shared with writeOffCharge').toBe(true);
    expect(bResult.status, 'over-allocating against the post-write-off remainder must be refused').toBe('rejected');
  });
});

// -----------------------------------------------------------------------------------------------
// W4 — refusals write nothing, each paired with a success control
// -----------------------------------------------------------------------------------------------

describe('W4 — refusals', () => {
  it('staff is refused immediately (without waiting) while A holds the lock', async () => {
    const f = await fixture('w4-staff');
    const c = await charge(f);
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(f.orgId, async (tx) => {
      await writeOffOp(f, f.y, c.chargeId, '400.00')(tx);
      aReady.resolve();
      await gate.promise;
    });
    await aReady.promise;
    const startedAt = Date.now();
    let rejected: unknown;
    try {
      await asOrg(f.orgId, writeOffOp(f, f.staff, c.chargeId, '100.00'));
    } catch (err) {
      rejected = err;
    }
    const elapsedMs = Date.now() - startedAt;
    gate.resolve();
    await aPromise;
    expect(rejected).toBeInstanceOf(AuthorizationError);
    // Audit finding 6: a lock-waiting mutant does not settle at ~5000ms — it hangs on A's still-held
    // gate until vitest's own test timeout kills the run. The 2000ms budget here is just generous
    // headroom over a real, non-waiting refusal; it is not a race against a timed mutant.
    expect(elapsedMs, `took ${elapsedMs}ms — a refusal that waited on the lock would hang past this and fail on vitest's timeout, not settle near 5000ms`).toBeLessThan(2000);
  });

  // Audit finding 1 (2026-10-01 auditor pass on t367-s1-write-off-once.test.ts): the sequential
  // "X is refused" test below proves X is EVENTUALLY refused, but not that the refusal happens
  // BEFORE the lock — ar/index.ts:543-544 claims "W4 pins this" and it does not, since no existing
  // leg holds the lock while X is refused. Mirrors the staff leg above exactly, swapping the actor.
  it('the charge\'s own author (X) is refused immediately (without waiting) while A holds the lock', async () => {
    const f = await fixture('w4-author-locked');
    const c = await charge(f);
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(f.orgId, async (tx) => {
      await writeOffOp(f, f.y, c.chargeId, '400.00')(tx);
      aReady.resolve();
      await gate.promise;
    });
    await aReady.promise;
    const startedAt = Date.now();
    let rejected: unknown;
    try {
      await asOrg(f.orgId, writeOffOp(f, f.x, c.chargeId, '100.00'));
    } catch (err) {
      rejected = err;
    }
    const elapsedMs = Date.now() - startedAt;
    gate.resolve();
    await aPromise;
    // Mutant this catches: the self-author check moved back to AFTER `lockChargesForAllocation`
    // (ar/index.ts:552-554) — X would then wait on A's lock and this would time out past 2000ms
    // instead of refusing immediately with a plain Error.
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toBeInstanceOf(AuthorizationError);
    expect(String((rejected as Error).message)).toMatch(/you recorded this charge/);
    expect(elapsedMs, `took ${elapsedMs}ms — a self-author check after the lock would wait on A instead`).toBeLessThan(2000);
    expect((await rowsFor(c.chargeId)).count, 'only A\'s write-off, nothing from the refused X').toBe(1);
  });

  it('the charge\'s own author (X) is refused; Y succeeds', async () => {
    const f = await fixture('w4-author');
    const c = await charge(f);
    await expect(asOrg(f.orgId, writeOffOp(f, f.x, c.chargeId, '100.00'))).rejects.toThrow(/you recorded this charge/);
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '100.00'))).resolves.toBeDefined();
  });

  it('"abc" is refused with parseMoneyInput\'s sentence, never a raw 23514/22P02 — Mutant: Number() back -> a DB error, red', async () => {
    const f = await fixture('w4-abc');
    const c = await charge(f);
    const err = await rejection(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, 'abc')));
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code, 'must not be a raw Postgres error code').toBeUndefined();
    // Audit finding 5: this claimed to assert parseMoneyInput's sentence but never checked any
    // text — a mutant swallowing the message and throwing something else generic passed. Assert
    // both the raw diagnostic and the presentable one, exactly as writeOffCharge calls it
    // (ar/index.ts:570: `parseMoneyInput(input.amount, 'writeOffCharge: the amount', 'The write-off amount')`).
    expect(err.message).toBe('writeOffCharge: the amount — "abc" is not a valid amount. Use at most two decimal places.');
    expect(err.userMessage).toBe('The write-off amount — "abc" is not a valid amount. Use at most two decimal places.');
    expect((await rowsFor(c.chargeId)).count).toBe(0);
  });

  it('"0" and "-5" are refused; nothing written', async () => {
    const f = await fixture('w4-nonpositive');
    const c = await charge(f);
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '0'))).rejects.toThrow();
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '-5'))).rejects.toThrow();
    expect((await rowsFor(c.chargeId)).count).toBe(0);
  });

  it('1,000.01 is refused (over the outstanding); 1,000.00 succeeds', async () => {
    const f = await fixture('w4-boundary');
    const c = await charge(f);
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '1000.01'))).rejects.toThrow();
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '1000.00'))).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------------------------
// R7/E15-twin — one oracle for "does not exist" and "out of reach" (T-367 S1 audit finding 2)
// -----------------------------------------------------------------------------------------------

// The exact sentence writeOffCharge gives for BOTH a nonexistent chargeId and a real charge the
// caller has no store scope at (ar/index.ts's own CHARGE_OUT_OF_REACH, not exported — copied here
// the same way t364-adjustment-employment-reach.test.ts's own oracle test copies its `O`).
const CHARGE_OUT_OF_REACH = 'That charge does not exist, or it is not at a store where you may write off receivables.';

describe('R7/E15-twin — oracle pair, a real out-of-scope charge vs a nonexistent id', () => {
  it('both reject AuthorizationError with the SAME userMessage; no uuid or "no charge" leaks through', async () => {
    const f = await fixture('e15');
    const c = await charge(f);
    const errReal = await rejection<AuthorizationError>(asOrg(f.orgId, writeOffOp(f, f.outsider, c.chargeId, '100.00')));
    const errFake = await rejection<AuthorizationError>(asOrg(f.orgId, writeOffOp(f, f.y, randomUUID(), '100.00')));
    expect(errReal, String(errReal)).toBeInstanceOf(AuthorizationError);
    expect(errFake, String(errFake)).toBeInstanceOf(AuthorizationError);
    expect(errReal.userMessage).toBe(CHARGE_OUT_OF_REACH);
    expect(errReal.userMessage).toBe(errFake.userMessage);
    // Mutant this catches: either arm reworded to include the id, or to say "no charge" /
    // "not found" for the missing-row case specifically — either would break the agreement or
    // leak which branch fired.
    expect(errReal.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect((errReal.userMessage ?? '').toLowerCase()).not.toContain('no charge');
    expect((errFake.userMessage ?? '').toLowerCase()).not.toContain('no charge');
  });

  it('positive control: an in-scope admin on the SAME real charge succeeds', async () => {
    const f = await fixture('e15-pc');
    const c = await charge(f);
    await expect(asOrg(f.orgId, writeOffOp(f, f.y, c.chargeId, '100.00'))).resolves.toBeDefined();
  });
});
