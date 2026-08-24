import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-120 — org isolation, proven against real PostgreSQL with two organizations seeded.
 *
 * The measure of success: **delete a `WHERE org_id` clause from any query and nothing leaks.**
 * Invariant 5 is that test, and it is the reason this feature exists rather than a coding
 * convention.
 */
config({ path: '../../../.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 3 });

let orgA: string;
let orgB: string;

/** One transaction, acting as the app role with `org` as the principal. */
async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  // The cast is postgres.js's `UnwrapPromiseArray` return type, which does not reduce to a
  // plain T for a generic caller. Narrowed here once rather than at every call site.
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

beforeEach(async () => {
  await sql`
    truncate table journal_lines, journal_entries, audit_log, fiscal_periods,
      accounts, person_identities, persons, stores, organizations restart identity cascade
  `;
  const [a] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
  orgA = a!.id;
  orgB = b!.id;
  await sql`insert into stores (org_id, code, name) values
    (${orgA}, 'A1', 'A One'), (${orgA}, 'A2', 'A Two'), (${orgB}, 'B1', 'B One')`;
  await sql`insert into persons (org_id, display_name) values (${orgA}, 'Alice'), (${orgB}, 'Bob')`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-120 — RLS org isolation', () => {
  it('invariant 4 — staff of org A see only org A rows', async () => {
    const n = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c);
    expect(n).toBe(2);
    const m = await asOrg(orgB, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c);
    expect(m).toBe(1);
  });

  it('⭐ invariant 5 — a query with NO org filter still returns only the principal’s rows', async () => {
    // This is the whole point. The forgotten filter is harmless because the filter was never
    // what was protecting anything.
    const rows = await asOrg(orgA, async (tx) => tx<{ code: string }[]>`select code from stores order by code`);
    expect(rows.map((r) => r.code)).toEqual(['A1', 'A2']);
  });

  it('invariant 6 — org A cannot INSERT a row carrying org B’s id', async () => {
    await expect(
      asOrg(orgA, async (tx) => tx`insert into stores (org_id, code, name) values (${orgB}, 'X', 'Smuggled')`),
    ).rejects.toThrow(/row-level security/i);
    // And nothing was written.
    const [r] = await sql<{ c: number }[]>`select count(*)::int c from stores where code = 'X'`;
    expect(r!.c).toBe(0);
  });

  it('invariant 7 — org B rows are unreachable for UPDATE and DELETE, not merely hidden', async () => {
    const updated = await asOrg(orgA, async (tx) => tx`update stores set name = 'Hijacked' where code = 'B1'`);
    expect(updated.count).toBe(0);
    const deleted = await asOrg(orgA, async (tx) => tx`delete from stores where code = 'B1'`);
    expect(deleted.count).toBe(0);
    const [still] = await sql<{ name: string }[]>`select name from stores where code = 'B1'`;
    expect(still!.name).toBe('B One');
  });

  it('⭐ invariant 8 — NO principal returns ZERO rows, never everything', async () => {
    // Default deny falls out of NULL semantics: current_setting(..., true) is NULL when unset,
    // and every comparison against NULL is NULL. The failure direction is a broken feature,
    // not a leak.
    const n = await asOrg(null, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c);
    expect(n).toBe(0);
  });

  it('invariant 9 — FORCE ROW LEVEL SECURITY is on for every RLS table', async () => {
    // A table's owner bypasses RLS by DEFAULT. Without FORCE, the role that created the
    // tables ignores every policy while all of these tests still pass — the most commonly
    // missed step in a Postgres RLS setup, and silent when missed.
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
        and relname not like '%drizzle%'
    `;
    const notEnabled = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    const notForced = rows.filter((r) => r.relrowsecurity && !r.relforcerowsecurity).map((r) => r.relname);
    expect(notEnabled, `RLS not enabled: ${notEnabled.join(', ')}`).toEqual([]);
    expect(notForced, `RLS enabled but NOT forced — the owner still bypasses: ${notForced.join(', ')}`).toEqual([]);
  });

  it('invariant 10 — the system principal (the owner) still sees everything', async () => {
    // Otherwise the migrator, the ETL and the audit all break.
    const [r] = await sql<{ c: number }[]>`select count(*)::int c from stores`;
    expect(r!.c).toBe(3);
  });

  it('journal_lines is scoped through its entry, with no org_id of its own', async () => {
    const [cash] = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable)
      values (${orgB}, '1110', 'Cash', 'asset', 'debit', true) returning id
    `;
    const [period] = await sql<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgB}, '2026-01-01', '2026-01-31', 'open') returning id
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, status)
        values (${orgB}, '2026-01-15', ${period!.id}, 'x', 'y', 'k-b', 'draft') returning id
      `;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit)
               values (${e!.id}, 1, ${cash!.id}, '5.00', '0'), (${e!.id}, 2, ${cash!.id}, '0', '5.00')`;
    });

    // Org A must not see org B's lines even though journal_lines carries no org_id.
    const seen = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from journal_lines`)[0]!.c);
    expect(seen).toBe(0);
    const own = await asOrg(orgB, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from journal_lines`)[0]!.c);
    expect(own).toBe(2);
  });

  it('system_only tables are invisible to a tenant', async () => {
    await sql`insert into etl_runs (source_system, mode, status) values ('erp_v1','capture','succeeded')`;
    const seen = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from etl_runs`)[0]!.c);
    expect(seen, 'captured production PII must be invisible to every tenant').toBe(0);
  });

  it('⭐ invariants 11 and 12 — the principal does not survive onto the next transaction', async () => {
    // A pooled connection outlives a request. If the role or the GUC were session-scoped, the
    // next request would run under the previous user's identity: silent, intermittent, and a
    // breach rather than a bug. Two sequential transactions, same pool.
    const first = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c);
    expect(first).toBe(2);

    // A transaction that THROWS must also leave nothing behind.
    await expect(
      asOrg(orgB, async (tx) => {
        await tx`select 1`;
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const after = await asOrg(null, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c);
    expect(after, 'no principal set — must be 0, not org B leftovers').toBe(0);

    // And the owner connection is unaffected by any of it.
    const [owner] = await sql<{ c: number }[]>`select count(*)::int c from stores`;
    expect(owner!.c).toBe(3);
  });
});
