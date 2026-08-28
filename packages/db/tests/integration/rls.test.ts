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
let alice: string;
let bob: string;

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
    truncate table person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods,
      accounts, person_identities, persons, stores, organizations restart identity cascade
  `;
  const [a] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
  orgA = a!.id;
  orgB = b!.id;
  await sql`insert into stores (org_id, code, name) values
    (${orgA}, 'A1', 'A One'), (${orgA}, 'A2', 'A Two'), (${orgB}, 'B1', 'B One')`;
  const [aliceRow] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, 'Alice') returning id`;
  const [bobRow] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgB}, 'Bob') returning id`;
  alice = aliceRow!.id;
  bob = bobRow!.id;
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

  describe('T-121 invariant 13 — org A cannot read org B\'s roles, grants or scope', () => {
    // person_roles is org_column (carries org_id directly); person_store_scope and
    // person_grants are derived through the person they name (registry.ts). Both
    // mechanisms are exercised here, against the same two-org fixture the rest of this
    // file already seeds.
    beforeEach(async () => {
      await sql`insert into person_roles (person_id, org_id, role) values (${alice}, ${orgA}, 'manager'), (${bob}, ${orgB}, 'admin')`;
      const [storeA1] = await sql<{ id: string }[]>`select id from stores where org_id = ${orgA} and code = 'A1'`;
      const [storeB1] = await sql<{ id: string }[]>`select id from stores where org_id = ${orgB} and code = 'B1'`;
      await sql`insert into person_store_scope (person_id, store_id) values (${alice}, ${storeA1!.id}), (${bob}, ${storeB1!.id})`;
      await sql`insert into person_grants (person_id, grant_name) values (${alice}, 'manage_users'), (${bob}, 'manage_price_lists')`;
    });

    it('person_roles — org A sees only Alice\'s role, never Bob\'s', async () => {
      const rows = await asOrg(orgA, async (tx) => tx<{ role: string }[]>`select role from person_roles`);
      expect(rows.map((r) => r.role)).toEqual(['manager']);
      const seen = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_roles where org_id = ${orgB}`)[0]!.c);
      expect(seen, 'org B\'s role row must be unreachable even by an explicit org_id filter').toBe(0);
    });

    it('person_store_scope — derived via person, org A cannot see Bob\'s store scope', async () => {
      const seen = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_store_scope`)[0]!.c);
      expect(seen).toBe(1); // Alice's row only
      const ownedByBob = await asOrg(orgA, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_store_scope where person_id = ${bob}`)[0]!.c);
      expect(ownedByBob, 'even an explicit person_id filter for Bob returns nothing under org A\'s principal').toBe(0);
    });

    it('person_grants — derived via person, org A cannot see Bob\'s grants', async () => {
      const rows = await asOrg(orgA, async (tx) => tx<{ grant_name: string }[]>`select grant_name from person_grants`);
      expect(rows.map((r) => r.grant_name)).toEqual(['manage_users']);
    });

    it('org B, symmetrically, cannot see org A\'s roles, scope or grants', async () => {
      const roles = await asOrg(orgB, async (tx) => tx<{ role: string }[]>`select role from person_roles`);
      expect(roles.map((r) => r.role)).toEqual(['admin']);
      const scope = await asOrg(orgB, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_store_scope`)[0]!.c);
      expect(scope).toBe(1);
      const grants = await asOrg(orgB, async (tx) => tx<{ grant_name: string }[]>`select grant_name from person_grants`);
      expect(grants.map((g) => g.grant_name)).toEqual(['manage_price_lists']);
    });

    it('no principal set — zero rows from all three tables, same default-deny as every other org-scoped table', async () => {
      const roles = await asOrg(null, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_roles`)[0]!.c);
      const scope = await asOrg(null, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_store_scope`)[0]!.c);
      const grants = await asOrg(null, async (tx) => (await tx<{ c: number }[]>`select count(*)::int c from person_grants`)[0]!.c);
      expect([roles, scope, grants]).toEqual([0, 0, 0]);
    });

    it('the owner (system principal) still sees both orgs\' rows — the migrator and audit must not break', async () => {
      const [roles] = await sql<{ c: number }[]>`select count(*)::int c from person_roles`;
      const [scope] = await sql<{ c: number }[]>`select count(*)::int c from person_store_scope`;
      const [grants] = await sql<{ c: number }[]>`select count(*)::int c from person_grants`;
      expect([roles!.c, scope!.c, grants!.c]).toEqual([2, 2, 2]);
    });
  });
});

/**
 * DEF-077 — every org-scoped policy must read the org through `app_current_org()`, never a raw
 * `current_setting('app.org_id', true)::uuid`.
 *
 * ⭐ **Why this is a whole describe block and not one more line in the invariant-11 test above.**
 * That test already exercises the exact failing scenario — two sequential transactions on a
 * pooled connection, then a third with no principal — and it passed the entire time six tables
 * were broken, because it asserts against `stores` alone. The invariant was proven for ONE
 * hand-picked table instead of every table that has a policy. Both tests below are enumerated
 * from the live catalogue, so a table added later is covered without anyone remembering to add
 * it — the same "derived, never hand-compared" discipline `capability-matrix.test.ts` applies to
 * the matrix.
 *
 * ⚠️ The mechanism, because it is not obvious: `set_config('app.org_id', $1, true)` is `SET
 * LOCAL` on a CUSTOM GUC. When that transaction ends, PostgreSQL resets the GUC to the empty
 * string — **not** to unset/NULL. `app_current_org()` exists to guard exactly that
 * (`NULLIF(current_setting('app.org_id', true), '')::uuid`). A raw cast instead sees `''` and
 * raises `22P02`, so the policy ERRORS where it should quietly deny. It fails closed, so it was
 * never a data leak — but it is a live 500 on any request that sets no org of its own
 * (`principal.ts`'s customer branch) landing on a connection a staff request used first.
 */
describe('DEF-077 — org policies read the org through app_current_org(), never a raw cast', () => {
  it('⭐ no policy anywhere uses the raw current_setting cast — enumerated, so it cannot come back', async () => {
    const policies = await sql<{ tablename: string; policyname: string; expr: string }[]>`
      select tablename, policyname, coalesce(qual::text, '') || ' ' || coalesce(with_check::text, '') as expr
      from pg_policies where schemaname = 'public'
    `;
    expect(policies.length, 'no policies found — wrong database?').toBeGreaterThan(0);

    const raw = policies
      .filter((p) => /current_setting\('app\.org_id'/.test(p.expr))
      .map((p) => `${p.tablename}.${p.policyname}`)
      .sort();

    expect(raw, 'these policies throw 22P02 instead of denying — use app_current_org()').toEqual([]);
  });

  it('⭐ a no-principal write is REFUSED (42501), never a cast error (22P02), on a reused connection', async () => {
    // A dedicated max:1 pool is the point: the bug is invisible on a fresh connection, because
    // an untouched custom GUC reads as NULL and the raw cast is happy. It only appears once a
    // real principal has been set and reset on that same connection. A fresh-connection probe,
    // or a superuser one (`postgres` has rolbypassrls), both falsely show this as absent.
    const pooled = postgres(url!, { max: 1 });
    try {
      const org = '00000000-0000-0000-0000-000000000009';
      await pooled.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${org}, true)`;
      });

      let code = 'NO ERROR — the write was allowed with no principal, which is worse';
      try {
        await pooled.begin(async (tx) => {
          await tx.unsafe(`set local role ${APP_ROLE}`);
          await tx`insert into price_lists (org_id, name) values (${org}, 'DEF-077 probe')`;
        });
      } catch (e) {
        code = (e as { code?: string }).code ?? String(e);
      }

      expect(code, 'a policy that throws is a 500 where a denial belongs').not.toBe('22P02');
      expect(code).toBe('42501');
    } finally {
      await pooled.end({ timeout: 5 });
    }
  });
});
