import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S1c — DEF-534 + DEF-535. reverseLiabilityEntry must (a) only reverse an entry that is a
 * liability_* posting for THIS liability, and (b) refuse on a retired liability.
 *
 * Mutants (each must turn a named leg red):
 *  - delete the sourceType/sourceId binding check        -> B1, B2 red
 *  - bind on sourceType only (not sourceId = liability)   -> B1 red
 *  - bind on sourceId only (allow any sourceType)         -> B2 red only if ids collide; B1 red still
 *  - delete the retiredAt check                           -> B3 red
 *  - refuse EVERYTHING                                    -> both positive controls red
 *  - re-check retiredAt on the pre-lock row (not after the lock) -> B4 red
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { liabilitiesRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  chargeLiability,
  createLiability,
  payLiability,
  retireLiability,
  reverseLiabilityEntry,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`liab-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  await fund(orgId, storeId, '200000.00');
  return { orgId, storeId, managerId: p!.id, manager: actor(orgId, p!.id), till: till!.id };
}

/** ⚠️ Credits 3900 Opening balance equity — the counterpart to putting cash on the books. */
async function fund(orgId: string, storeId: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft')
      returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in ('1130', '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1130')!}, ${storeId}, ${amount}, '0'),
             (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function liability(f: Fixture, over: Record<string, unknown> = {}) {
  const created = await asOrg(f.orgId, (tx) =>
    createLiability(tx, f.manager, {
      storeId: f.storeId,
      name: 'Accrued rent — January',
      category: 'accrued_expenses',
      ...over,
    }),
  );
  return created.id;
}

const positionOf = (f: Fixture, id: string) =>
  asOrg(f.orgId, (tx) => liabilitiesRepo.positionOf(tx, f.orgId, id));

const notRaw = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  expect(m, 'a plain domain refusal, not a raw database error').not.toMatch(
    /violates|constraint|relation ".*" does not exist|syntax error|duplicate key/i,
  );
};

async function attempt(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

const reversalsOf = async (entryId: string) =>
  Number(
    (
      await sql<{ n: string }[]>`
        select count(*)::text as n from journal_entries where reversal_of_entry_id = ${entryId}
      `
    )[0]!.n,
  );

/** A second store in the same org, its own manager (scoped there only), its own funded till. */
async function otherStore(f: Fixture) {
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${f.orgId}, ${uid('storeB')}, 'Store B') returning id
  `;
  const storeId = store!.id;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${f.orgId}, 'Manager B') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  await fund(f.orgId, storeId, '200000.00');
  return { storeId, manager: actor(f.orgId, p!.id), till: till!.id };
}

async function chargeAndPay(f: Fixture, who: Actor, storeId: string, till: string, amount: string) {
  const created = await asOrg(f.orgId, (tx) =>
    createLiability(tx, who, { storeId, name: uid('Obligation'), category: 'accrued_expenses' }),
  );
  const id = created.id;
  const charge = await asOrg(f.orgId, (tx) =>
    chargeLiability(tx, who, { requestId: crypto.randomUUID(), liabilityId: id, amount, againstAccountCode: '6200', on: '2026-01-10' }),
  );
  const pay = await asOrg(f.orgId, (tx) =>
    payLiability(tx, who, { requestId: crypto.randomUUID(), liabilityId: id, amount, fromMoneyAccountId: till, on: '2026-01-20' }),
  );
  return { id, chargeEntryId: charge.entryId, payEntryId: pay.entryId };
}

// ---- Two-connection barrier harness (copied from t366-s1b-liability-reverse-retire-locks.test.ts) ----
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
const ROW_LOCK = ['transactionid', 'tuple'];

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-366 S1c — a reversal is bound to the liability it names', () => {
  it('B1 ⛔ (DEF-534) another store liability entry cannot be reversed through liability A', async () => {
    const f = await fixture('b1');
    const b = await otherStore(f);
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');
    const B = await chargeAndPay(f, b.manager, b.storeId, b.till, '700.00');

    const err = await attempt(() =>
      asOrg(f.orgId, (tx) =>
        reverseLiabilityEntry(tx, f.manager, {
          liabilityId: A.id,
          entryId: B.payEntryId,
          reason: 'wrong entry on purpose',
        }),
      ),
    );
    expect(err, "reversing B's payment through A must be refused").not.toBeNull();
    notRaw(err);
    expect(await reversalsOf(B.payEntryId), "B's payment was NOT reversed").toBe(0);
    expect((await positionOf(f, B.id)).outstanding).toBe('0.00');
    expect((await positionOf(f, A.id)).outstanding).toBe('0.00');
    expect(await reversalsOf(A.payEntryId)).toBe(0);
  });

  it('B2 ⛔ (DEF-534) a posted journal entry that is not a liability entry cannot be reversed', async () => {
    const f = await fixture('b2');
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');
    const [ob] = await sql<{ id: string }[]>`
      select id from journal_entries where org_id = ${f.orgId} and source_type = 'opening_balance'
    `;

    const err = await attempt(() =>
      asOrg(f.orgId, (tx) =>
        reverseLiabilityEntry(tx, f.manager, {
          liabilityId: A.id,
          entryId: ob!.id,
          reason: 'not a liability entry',
        }),
      ),
    );
    expect(err, 'reversing the opening-balance entry through a liability must be refused').not.toBeNull();
    notRaw(err);
    expect(await reversalsOf(ob!.id), 'the unrelated entry was NOT reversed').toBe(0);
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${ob!.id}`;
    expect(row!.status).toBe('posted');
  });

  it('B3 ⛔ (DEF-535) a retired liability payment cannot be reversed — it would owe money while hidden', async () => {
    const f = await fixture('b3');
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');
    await asOrg(f.orgId, (tx) => retireLiability(tx, f.manager, { liabilityId: A.id }));

    const err = await attempt(() =>
      asOrg(f.orgId, (tx) =>
        reverseLiabilityEntry(tx, f.manager, {
          liabilityId: A.id,
          entryId: A.payEntryId,
          reason: 'reverse after retire',
        }),
      ),
    );
    expect(err, 'a reversal on a retired liability must be refused').not.toBeNull();
    notRaw(err);
    expect(await reversalsOf(A.payEntryId), 'the payment was NOT reversed').toBe(0);
    expect((await positionOf(f, A.id)).outstanding).toBe('0.00');
    const [row] = await sql<{ retired_at: Date | null }[]>`
      select retired_at from liabilities where id = ${A.id}
    `;
    expect(row!.retired_at, 'still retired').not.toBeNull();
  });

  it('CONTROL ✅ reversing A own payment on an active liability restores what is owed', async () => {
    const f = await fixture('c1');
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');
    expect((await positionOf(f, A.id)).outstanding).toBe('0.00');
    await asOrg(f.orgId, (tx) =>
      reverseLiabilityEntry(tx, f.manager, {
        liabilityId: A.id,
        entryId: A.payEntryId,
        reason: 'paid from the wrong till',
      }),
    );
    expect(await reversalsOf(A.payEntryId)).toBe(1);
    expect((await positionOf(f, A.id)).outstanding).toBe('1000.00');
  });

  it('CONTROL ✅ reversing A own charge on an active liability nets it to zero', async () => {
    const f = await fixture('c2');
    const id = await liability(f);
    const { entryId } = await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(),
        liabilityId: id,
        amount: '2500.00',
        againstAccountCode: '6200',
        on: '2026-01-10',
      }),
    );
    expect((await positionOf(f, id)).outstanding).toBe('2500.00');
    await asOrg(f.orgId, (tx) =>
      reverseLiabilityEntry(tx, f.manager, { liabilityId: id, entryId, reason: 'billed in error' }),
    );
    expect(await reversalsOf(entryId)).toBe(1);
    expect((await positionOf(f, id)).outstanding).toBe('0.00');
  });

  it('B4 ⛔ (DEF-535) a reversal that queued behind a retire is refused once the lock frees — the retired check must not use the pre-lock row', async () => {
    const f = await fixture('b4');
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => retireLiability(tx, f.manager, { liabilityId: A.id }),
      (tx) => reverseLiabilityEntry(tx, f.manager, { liabilityId: A.id, entryId: A.payEntryId, reason: 'T-366 S1c B4' }),
      ROW_LOCK,
    );

    expect(bWaited, 'B must queue behind the retire lock').toBe(true);
    expect(aResult.status, 'the retire itself succeeds').toBe('fulfilled');
    expect(bResult.status, 'B must be refused: the liability was retired while B waited').toBe('rejected');
    const msg = String(((bResult as { reason: unknown }).reason as Error)?.message ?? '');
    expect(msg).toMatch(/retired/i);
    notRaw((bResult as { reason: unknown }).reason);
    expect(await reversalsOf(A.payEntryId), 'no reversal entry exists').toBe(0);
    expect((await positionOf(f, A.id)).outstanding, 'the retired liability owes nothing').toBe('0.00');
    const [row] = await sql<{ retired_at: Date | null }[]>`select retired_at from liabilities where id = ${A.id}`;
    expect(row!.retired_at, 'still retired').not.toBeNull();
  });

  it('CONTROL ✅ B4 sequence without a retire: A holds a DIFFERENT liability lock -> B reverses, no wait', async () => {
    const f = await fixture('b4c');
    const A = await chargeAndPay(f, f.manager, f.storeId, f.till, '1000.00');
    const other = await liability(f);

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      async (tx) => {
        await liabilitiesRepo.lockForPayment(tx, f.orgId, other);
      },
      (tx) => reverseLiabilityEntry(tx, f.manager, { liabilityId: A.id, entryId: A.payEntryId, reason: 'T-366 S1c B4 control' }),
      ROW_LOCK,
    );

    expect(bWaited, 'an unrelated liability lock must not block B').toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status, 'B reverses an active liability').toBe('fulfilled');
    expect(await reversalsOf(A.payEntryId)).toBe(1);
    expect((await positionOf(f, A.id)).outstanding).toBe('1000.00');
  });
});
