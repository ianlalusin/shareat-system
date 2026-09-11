/**
 * T-228 — standing up an organization, against real Postgres.
 *
 * ⭐ **Case 5 is the one that matters and it was written first.** Everything else here checks a
 * part; case 5 checks that the chicken-and-egg is actually broken — org → first admin →
 * `createStore` as that admin → `setPin` → `signInWithPin` returns a session for that person.
 * Until T-228 there was no first link in that chain: nothing in this codebase had ever created an
 * organization, production held zero, and `shareat-finding-observation` exited 1 nightly because
 * of it (DEF-195).
 *
 * ⭐ **Case 6 needs a deliberate injected failure**, not a happy path — same reasoning as T-222's
 * invariant 6. A bootstrap that half-succeeds leaves an organization nobody can sign into AND no
 * way to re-run, because `createFirstAdmin`'s refusal would then block the retry. An untested
 * rollback is a claim of coverage with nothing executable behind it.
 *
 * ⚠️ **Case 1 also stands in for DEF-204.** The chart and category seeds run INSIDE the Drizzle
 * transaction that created the org, and `sql.json()` throws there — `drizzle-orm/postgres-js`
 * strips the client's jsonb serializer on construction (driver.js:17-22). If the binding in
 * `packages/db/seed/*.ts` is ever "simplified" back to a single cast, case 1 is what fails.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, transaction, systemTransaction, stockLocationsRepo } from '@shareat/db';
import { setPin, signInWithPin, type Actor } from '@shareat/auth';
import { CHART_OF_ACCOUNTS } from '../../../db/seed/chart-of-accounts';
import { EXPENSE_CATEGORY_SEED } from '../../../db/seed/expense-categories';
import { createStore } from '../../src/stores/service';
import { createFirstAdmin, createOrganization } from '../../src/organizations';

/**
 * ⭐ Why `systemTransaction`, not `withOrgPrincipal`, throughout this file: createOrganization and
 * createFirstAdmin are only ever invoked in production from inside `bootstrapOrganization`
 * (packages/domain/src/organizations/index.ts:377,380), whose own callers
 * (apps/erp/src/app/setup/actions.ts, scripts/bootstrap-org.ts) open their transaction with
 * systemTransaction() — named callers in tests/unit/system-transaction-callers.test.ts's closed
 * list. There is no org yet to scope a principal to at creation time, so withOrgPrincipal is not
 * merely wrong here, it is unexpressible. This file (excluded from that guard: it lives under
 * `tests/` and ends `.test.ts`) mirrors that same production depth.
 */

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
const sql = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** ⚠️ These tests CREATE organizations rather than assuming one, so the fixture starts from
 *  genuinely nothing — which is the situation the whole task exists for. */
beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_store_scope, person_grants, person_roles,
      stock_locations, location_types, sales_channels, stores, persons,
      expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const countFor = async (table: 'accounts' | 'expense_categories', orgId: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int n from ${sql(table)} where org_id = ${orgId}::uuid`;
  return row!.n;
};

// -------------------------------------------------------------------------------------
// Case 5 — written FIRST. The whole chain, end to end.
// -------------------------------------------------------------------------------------

describe('T-228 case 5 — ⭐ the chicken-and-egg, actually broken', () => {
  it('org -> first admin -> createStore -> setPin -> signInWithPin returns that person a session', async () => {
    // ⛔ Every link here was impossible before this task. `setPin` hashes per store, so no PIN
    // exists before a store; `createStore` authorizes `manage_stores`, so no store exists before an
    // admin; and no admin exists before an org. This test is the proof the order is right.
    const pin = '654321';
    const made = await systemTransaction(async (tx) => {
      const org = await createOrganization(tx, { code: uid('BOOT'), name: 'Bootstrap Co' });
      const { personId } = await createFirstAdmin(tx, { orgId: org.orgId, displayName: 'First Admin' });
      const actor: Actor = { personId, orgId: org.orgId };
      const store = await createStore(tx, actor, { code: 'LIPA', name: 'SharEat Lipa' });
      await setPin(tx, { personId, storeId: store.storeId, pin });
      return { orgId: org.orgId, personId, storeId: store.storeId };
    });

    // ⚠️ Deliberately the plain, no-principal `transaction()` here, not systemTransaction — this
    // mirrors apps/erp/src/app/sign-in/actions.ts exactly, which cannot know an org before the PIN
    // resolves who is signing in. If this ever fails under the restricted role, that is a real
    // finding about signInWithPin, not a fixture gap to paper over.
    const session = await transaction((tx) =>
      signInWithPin(tx, { storeId: made.storeId, pin }));

    expect(session.personId).toBe(made.personId);
    expect(session.token).toBeTruthy();
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('⭐ the store carries its default room and the admin\'s scope row — createStore made it, not the bootstrap', async () => {
    // Invariant 7. The bootstrap never writes `person_store_scope` by hand; T-222's §C.2 fan-out
    // does it, and this is what says so out loud rather than trusting the comment.
    const made = await systemTransaction(async (tx) => {
      const org = await createOrganization(tx, { code: uid('BOOT'), name: 'Bootstrap Co' });
      const { personId } = await createFirstAdmin(tx, { orgId: org.orgId, displayName: 'First Admin' });
      const store = await createStore(tx, { personId, orgId: org.orgId }, { code: 'LIPA', name: 'SharEat Lipa' });
      return { personId, storeId: store.storeId };
    });

    const [scope] = await sql<{ n: number }[]>`
      select count(*)::int n from person_store_scope
      where person_id = ${made.personId}::uuid and store_id = ${made.storeId}::uuid`;
    expect(scope!.n).toBe(1);

    // Read through the repo rather than hand-rolling the "active" predicate — `stock_locations`
    // carries a `status` enum, not an `is_active` flag, and T-160's repo owns what active means.
    const rooms = await systemTransaction((tx) => stockLocationsRepo.listActiveLocations(tx, made.storeId));
    expect(rooms).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------
// Case 1 — the organization and its reference data, in one transaction.
// -------------------------------------------------------------------------------------

describe('T-228 case 1 — an org arrives with its chart and its categories', () => {
  it('inserts the org and seeds every account and category against the NEW org_id', async () => {
    // ⚠️ Asserted against the seed arrays, never a literal. The spec said "93 accounts and 39
    // categories"; the real figures are 102 and 38, and 93 was already stale before this task —
    // T-123 added 2160 and 4500. A literal here would go stale the next time the chart grows.
    const code = uid('ORG');
    const result = await systemTransaction((tx) => createOrganization(tx, { code, name: 'Shareat OPC' }));

    expect(result.accountsSeeded).toBe(CHART_OF_ACCOUNTS.length);
    expect(result.categoriesSeeded).toBe(EXPENSE_CATEGORY_SEED.length);
    expect(await countFor('accounts', result.orgId)).toBe(CHART_OF_ACCOUNTS.length);
    expect(await countFor('expense_categories', result.orgId)).toBe(EXPENSE_CATEGORY_SEED.length);

    const [org] = await sql<{ name: string; code: string; is_active: boolean }[]>`
      select name, code, is_active from organizations where id = ${result.orgId}::uuid`;
    expect(org).toMatchObject({ name: 'Shareat OPC', code, is_active: true });
  });

  it('⚠️ DEF-204 — the seeds really do run inside the Drizzle transaction, with intact values', async () => {
    // `sql.json()` throws on a Drizzle-constructed client and a lone `::jsonb` cast arrives
    // double-encoded on a plain one. If either creeps back into packages/db/seed/*.ts, this fails.
    const { orgId } = await systemTransaction((tx) => createOrganization(tx, { code: uid('ORG'), name: 'Payload Check' }));

    const [bad] = await sql<{ n: number }[]>`
      select count(*)::int n from accounts
      where org_id = ${orgId}::uuid and (name is null or type is null or normal_balance is null)`;
    expect(bad!.n).toBe(0);

    // A row whose columns survived the round trip, checked by value rather than by count.
    const [cash] = await sql<{ name: string; type: string; normal_balance: string; is_postable: boolean }[]>`
      select name, type, normal_balance, is_postable from accounts
      where org_id = ${orgId}::uuid and code = '1000'`;
    const seeded = CHART_OF_ACCOUNTS.find((a) => a.code === '1000')!;
    expect(cash).toMatchObject({ name: seeded.name, type: seeded.type, normal_balance: seeded.normalBalance });
  });
});

// -------------------------------------------------------------------------------------
// Case 2 — a duplicate code.
// -------------------------------------------------------------------------------------

describe('T-228 case 2 — a duplicate code is refused, in a sentence a human can act on', () => {
  it('refuses the second org with the same code and names the code', async () => {
    const code = uid('DUP');
    await systemTransaction((tx) => createOrganization(tx, { code, name: 'First' }));

    await expect(
      systemTransaction((tx) => createOrganization(tx, { code, name: 'Second' })),
    ).rejects.toThrow(new RegExp(code));
  });

  it('⛔ leaves nothing behind — the refused org has no accounts either', async () => {
    const code = uid('DUP');
    const first = await systemTransaction((tx) => createOrganization(tx, { code, name: 'First' }));
    await expect(systemTransaction((tx) => createOrganization(tx, { code, name: 'Second' }))).rejects.toThrow();

    const [orgs] = await sql<{ n: number }[]>`select count(*)::int n from organizations where code = ${code}`;
    expect(orgs!.n).toBe(1);
    // The survivor's chart is untouched — the failed attempt did not half-seed over it.
    expect(await countFor('accounts', first.orgId)).toBe(CHART_OF_ACCOUNTS.length);
  });
});

// -------------------------------------------------------------------------------------
// Cases 3 and 4 — the first admin, and why it is only ever the FIRST.
// -------------------------------------------------------------------------------------

describe('T-228 case 3 — the first admin is the base case of the authority chain', () => {
  it('creates the person and an admin role with granted_by NULL', async () => {
    // ⭐ NULL is correct here, not a shortcut: bible row 116's authority chain has a base case,
    // and there is no grantor before the first admin. `dev-seed.ts:104` states the same rule.
    const { orgId } = await systemTransaction((tx) => createOrganization(tx, { code: uid('ORG'), name: 'Org' }));
    const { personId } = await systemTransaction((tx) => createFirstAdmin(tx, { orgId, displayName: 'Ian' }));

    const [person] = await sql<{ display_name: string; org_id: string }[]>`
      select display_name, org_id from persons where id = ${personId}::uuid`;
    expect(person).toMatchObject({ display_name: 'Ian', org_id: orgId });

    const [role] = await sql<{ role: string; granted_by: string | null; revoked_at: Date | null }[]>`
      select role, granted_by, revoked_at from person_roles where person_id = ${personId}::uuid`;
    expect(role!.role).toBe('admin');
    expect(role!.granted_by).toBeNull();
    expect(role!.revoked_at).toBeNull();
  });
});

describe('T-228 case 4 — ⛔ it is the FIRST admin, not a back door that mints admins forever', () => {
  it('refuses once the org holds any role, and names the supported path', async () => {
    const { orgId } = await systemTransaction((tx) => createOrganization(tx, { code: uid('ORG'), name: 'Org' }));
    await systemTransaction((tx) => createFirstAdmin(tx, { orgId, displayName: 'First' }));

    await expect(
      systemTransaction((tx) => createFirstAdmin(tx, { orgId, displayName: 'Second' })),
    ).rejects.toThrow(/\/admin\/users/);
  });

  it('⛔ refuses even when the only existing role is REVOKED, or is not an admin', async () => {
    // ⚠️ `accessRepo.hasActiveAdmin` would say "no admin here" in both of these, and that is the
    // weaker test: after a demotion this function would mint a second first-admin with a NULL
    // grantor, which is exactly the back door the refusal exists to close.
    const revoked = await systemTransaction((tx) => createOrganization(tx, { code: uid('ORG'), name: 'Revoked' }));
    const { personId } = await systemTransaction((tx) => createFirstAdmin(tx, { orgId: revoked.orgId, displayName: 'Gone' }));
    await sql`update person_roles set revoked_at = now() where person_id = ${personId}::uuid`;
    await expect(
      systemTransaction((tx) => createFirstAdmin(tx, { orgId: revoked.orgId, displayName: 'Second' })),
    ).rejects.toThrow(/\/admin\/users/);

    const staffOnly = await systemTransaction((tx) => createOrganization(tx, { code: uid('ORG'), name: 'Staff only' }));
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${staffOnly.orgId}, 'A Cashier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${staffOnly.orgId}, 'staff')`;
    await expect(
      systemTransaction((tx) => createFirstAdmin(tx, { orgId: staffOnly.orgId, displayName: 'Second' })),
    ).rejects.toThrow(/\/admin\/users/);
  });
});

// -------------------------------------------------------------------------------------
// Case 6 — the failure that matters.
// -------------------------------------------------------------------------------------

describe('T-228 case 6 — ⭐ all-or-nothing, proved by an INJECTED failure', () => {
  it('a failure at the store step leaves NO organization, no chart and no admin behind', async () => {
    // ⛔ A bootstrap that half-succeeds leaves an org nobody can sign into and no way to re-run,
    // because case 4's refusal would then block the retry. This is the test that says the
    // atomicity claim is executable rather than asserted.
    const code = uid('ROLL');

    await expect(
      systemTransaction(async (tx) => {
        const org = await createOrganization(tx, { code, name: 'Doomed' });
        await createFirstAdmin(tx, { orgId: org.orgId, displayName: 'Doomed Admin' });
        throw new Error('injected failure at the store step, inside the same transaction');
      }),
    ).rejects.toThrow(/injected failure/);

    const [orgs] = await sql<{ n: number }[]>`select count(*)::int n from organizations where code = ${code}`;
    expect(orgs!.n).toBe(0);
    // ⚠️ The accounts go with it — which is only true because the seeds ran inside the same
    // transaction. If they ever run on their own connection, this is what notices.
    const [orphans] = await sql<{ n: number }[]>`select count(*)::int n from accounts`;
    expect(orphans!.n).toBe(0);
    const [people] = await sql<{ n: number }[]>`select count(*)::int n from persons`;
    expect(people!.n).toBe(0);
  });

  it('and the retry then succeeds — the refusal in case 4 does not block a rolled-back attempt', async () => {
    const code = uid('ROLL');
    await expect(
      systemTransaction(async (tx) => {
        const org = await createOrganization(tx, { code, name: 'Doomed' });
        await createFirstAdmin(tx, { orgId: org.orgId, displayName: 'Doomed Admin' });
        throw new Error('injected failure');
      }),
    ).rejects.toThrow();

    const retried = await systemTransaction(async (tx) => {
      const org = await createOrganization(tx, { code, name: 'Second Attempt' });
      const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: 'Real Admin' });
      return { orgId: org.orgId, personId: admin.personId };
    });
    expect(retried.personId).toBeTruthy();
    expect(await countFor('accounts', retried.orgId)).toBe(CHART_OF_ACCOUNTS.length);
  });
});

// -------------------------------------------------------------------------------------
// Case 7 — one org's chart is its own.
// -------------------------------------------------------------------------------------

describe('T-228 case 7 — the chart is per-org, and the second org does not touch the first', () => {
  it('seeds a full, independent chart for each org', async () => {
    // ⛔ Every seeded row carries org_id. The symptom of assuming otherwise is `postEntry`
    // refusing with "unknown account code", which is the engine working correctly and is
    // baffling if you think the chart is global.
    const a = await systemTransaction((tx) => createOrganization(tx, { code: uid('A'), name: 'Org A' }));
    const b = await systemTransaction((tx) => createOrganization(tx, { code: uid('B'), name: 'Org B' }));

    expect(a.orgId).not.toBe(b.orgId);
    expect(await countFor('accounts', a.orgId)).toBe(CHART_OF_ACCOUNTS.length);
    expect(await countFor('accounts', b.orgId)).toBe(CHART_OF_ACCOUNTS.length);
    expect(await countFor('expense_categories', a.orgId)).toBe(EXPENSE_CATEGORY_SEED.length);
    expect(await countFor('expense_categories', b.orgId)).toBe(EXPENSE_CATEGORY_SEED.length);

    // The same code exists twice, once per org, on different rows.
    const rows = await sql<{ org_id: string }[]>`select org_id from accounts where code = '1000'`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([a.orgId, b.orgId]));
  });
});
