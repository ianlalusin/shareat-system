import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-596 PR A — prepaid money fixes. `docs/tasks/596-money-prepaid-expense-capex-liability.md`.
 *
 * DEF-882 a write-off after an undo posts nothing (fixed key); DEF-883 amortise and write-off race (no lock);
 * DEF-884 a month reversed on a written-off item. Fixture and concurrency harness are copied from
 * `prepaid.test.ts` and `t366-s1b-liability-reverse-retire-locks.test.ts`, not imported.
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
import { closeDb, prepaidRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  amortisePrepaidItem,
  createPrepaidItem,
  reverseAmortisation,
  undoWriteOff,
  writeOffPrepaidItem,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`pp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  // Two years of open periods — a 12-month policy has to be able to run to the end.
  for (const y of [2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      await sql`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${org!.id}, ${start}, ${end}, 'open')
      `;
    }
  }
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  }
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
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

async function fixture(hint: string) {
  const o = await newOrg(hint);
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  return { ...o, adminId, admin: actor(o.orgId, adminId) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A ₱24,000, 12-month policy starting 2026-01-01 — the spec's own worked example. */
async function policy(f: Fixture, cost = '24000.00', months = 12) {
  return asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId,
      name: 'Fire insurance 2026',
      category: 'insurance',
      coverageStartDate: '2026-01-01',
      coverageMonths: months,
      totalCost: cost,
    }),
  );
}

/** Sum of a code's movement across every posted entry for the org. */
async function netOf(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code}
  `;
  return row!.total;
}


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

/** The item's OWN 1400 movement: credit - debit on 1400 over every non-draft entry sourced from it (reversals copy the source). */
async function itemCredits(orgId: string, itemId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_id = ${itemId} and je.status <> 'draft'
      and je.source_type in ('amortisation', 'prepaid_write_off') and a.code = '1400'
  `;
  return row!.total;
}

const writeOff = (f: Fixture, itemId: string, on = '2026-07-10') =>
  asOrg(f.orgId, (tx) => writeOffPrepaidItem(tx, f.admin, { prepaidItemId: itemId, writtenOffOn: on, reason: 'T-596' }));
const undo = (f: Fixture, itemId: string) =>
  asOrg(f.orgId, (tx) => undoWriteOff(tx, f.admin, { prepaidItemId: itemId, reason: 'T-596 undo' }));
const statusOf = (f: Fixture, itemId: string) =>
  asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, itemId)).then((r) => r!.status);
const keysOf = async (orgId: string, itemId: string) =>
  (
    await sql<{ k: string }[]>`
      select idempotency_key as k from journal_entries
      where org_id = ${orgId} and source_id = ${itemId} and source_type = 'prepaid_write_off'
        and idempotency_key like 'prepaid:%:write-off%'
      order by created_at`
  ).map((r) => r.k);

beforeAll(async () => {
  await sql`
    truncate table
      prepaid_items, money_transfers, money_accounts, sales_day_tenders, sales_day_channels,
      sales_days, sales_channels, expense_payments, expenses, expense_categories,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('DEF-882 — write off, undo, write off again', () => {
  it('posts a second entry under a new key — Mutant: fixed key -> same entry id, red', async () => {
    const f = await fixture('d882');
    const item = await policy(f); // 24,000 over 12 months
    const first = await writeOff(f, item.id);
    await undo(f, item.id);
    const second = await writeOff(f, item.id, '2026-07-12');
    expect(second.entryId).not.toBe(first.entryId);
    expect(await statusOf(f, item.id)).toBe('written_off');
    expect(await itemCredits(f.orgId, item.id)).toBe('24000.00');
    expect((await keysOf(f.orgId, item.id)).at(-1)).toMatch(/write-off#2$/);
  });

  it('a third cycle uses #3', async () => {
    const f = await fixture('d882b');
    const item = await policy(f);
    await writeOff(f, item.id);
    await undo(f, item.id);
    await writeOff(f, item.id);
    await undo(f, item.id);
    await writeOff(f, item.id);
    expect(await itemCredits(f.orgId, item.id)).toBe('24000.00');
    expect((await keysOf(f.orgId, item.id)).at(-1)).toMatch(/write-off#3$/);
  });
});

describe('DEF-883 — amortise and write-off share the item lock', () => {
  it('write-off holding the lock makes amortise wait, then amortise posts nothing — Mutant: no lock in amortiseItemCore -> bWaited false, red', async () => {
    const f = await fixture('d883a');
    const item = await policy(f);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => writeOffPrepaidItem(tx, f.admin, { prepaidItemId: item.id, writtenOffOn: '2026-07-10', reason: 'T-596' }),
      (tx) => amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited).toBe(true);
    expect(bResult.status).toBe('fulfilled');
    expect(bResult.status === 'fulfilled' && bResult.value.posted).toEqual([]);
    expect(await itemCredits(f.orgId, item.id)).toBe('24000.00');
  });

  it('amortise holding the lock makes write-off wait, remaining is re-read — Mutant: no lock in runWriteOff -> credits 30000.00, red', async () => {
    const f = await fixture('d883b');
    const item = await policy(f);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
      (tx) => writeOffPrepaidItem(tx, f.admin, { prepaidItemId: item.id, writtenOffOn: '2026-07-10', reason: 'T-596' }),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
    expect(bWaited).toBe(true);
    // 3 months released + the 9 months left = exactly the cost.
    expect(await itemCredits(f.orgId, item.id)).toBe('24000.00');
  });
});

describe('DEF-884 — a month on a written-off item', () => {
  it('is refused until the write-off is undone — Mutant: delete the check -> a reversal posts, red', async () => {
    const f = await fixture('d884');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) => amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }));
    await writeOff(f, item.id);
    const count = async () =>
      (await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`)[0]!.n;
    const before = await count();

    const caught = await asOrg(f.orgId, (tx) =>
      reverseAmortisation(tx, f.admin, { prepaidItemId: item.id, period: '2026-03', reason: 'T-596' }),
    ).catch((e: unknown) => e);
    expect((caught as { userMessage?: string }).userMessage).toMatch(/Undo the write-off first/);
    expect(await count()).toBe(before);
    expect(await itemCredits(f.orgId, item.id)).toBe('24000.00');

    await undo(f, item.id);
    await asOrg(f.orgId, (tx) =>
      reverseAmortisation(tx, f.admin, { prepaidItemId: item.id, period: '2026-03', reason: 'T-596' }),
    );
    expect(await itemCredits(f.orgId, item.id)).toBe('4000.00'); // 6000 released, the March 2000 reversed
  });
});
