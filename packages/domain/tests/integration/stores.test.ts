/**
 * T-222 — store creation and management, against real Postgres.
 *
 * ⭐ **Invariants 3 and 9 are the two that matter**: they are CAPABILITY-MATRIX §C.2's two halves,
 * and DEF-180 is what happens when an ADR is trusted to enforce itself. §C.2's first half was
 * decided 2026-08-25, never written into `assignRole`, and went unnoticed for two weeks.
 *
 * ⭐ **Invariant 6 needs a deliberate injected failure**, not a happy path. Atomicity is this
 * design's whole advantage over v1 — which could not roll back and therefore had to report per-step
 * — and an untested rollback is a claim of coverage with nothing executable behind it, the exact
 * shape of DEF-175/176/180/182/187.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, transaction, accessRepo, storesRepo, stockLocationsRepo } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createStore,
  deactivateStore,
  reactivateStore,
  storeReadiness,
  updateStoreDetails,
} from '../../src/stores/service';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
const sql = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

let orgA: string, orgB: string;
let adminA: Actor, admin2A: Actor, managerA: Actor, staffA: Actor;
let admin2Id: string;

async function person(orgId: string, name: string, role: string): Promise<{ id: string; actor: Actor }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  return { id: p!.id, actor: { personId: p!.id, orgId } };
}

beforeEach(async () => {
  await sql`
    truncate table person_store_scope, person_grants, person_roles, person_credentials,
      stock_locations, location_types, sales_channels, stores, persons, organizations
      restart identity cascade`;
  const [a] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
  orgA = a!.id; orgB = b!.id;

  adminA = (await person(orgA, 'Admin One', 'admin')).actor;
  const second = await person(orgA, 'Admin Two', 'admin');
  admin2A = second.actor; admin2Id = second.id;
  managerA = (await person(orgA, 'Manager', 'manager')).actor;
  staffA = (await person(orgA, 'Staff', 'staff')).actor;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const make = (actor: Actor, over: Record<string, unknown> = {}) =>
  transaction((tx) => createStore(tx, actor, { code: uid('ST'), name: 'Branch', ...over } as never));

describe('T-222 invariant 1 — only super_admin and admin may open a branch', () => {
  it('⛔ a MANAGER is refused', async () => {
    // ⚠️ CAPABILITY-MATRIX's own rule: every ✅ needs a test proving the ✗ fires. Manager is denied
    // deliberately — opening a branch fans access rows and sets a cash-custody policy, the same bar
    // as manage_users.
    await expect(make(managerA)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('⛔ a STAFF member is refused', async () => {
    await expect(make(staffA)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('✅ an admin succeeds', async () => {
    const res = await make(adminA);
    expect(res.storeId).toBeTruthy();
  });
});

describe('T-222 invariant 2 — a created store has exactly one active room', () => {
  it('creates its default room in the same transaction', async () => {
    const { storeId, locationId } = await make(adminA);
    expect(locationId).toBeTruthy();
    const rooms = await transaction((tx) => stockLocationsRepo.listActiveLocations(tx, storeId));
    expect(rooms).toHaveLength(1);
  });

  it('⚠️ works in an org with NO location_types — otherwise creation is impossible in a fresh org', async () => {
    await sql`delete from location_types where org_id = ${orgA}`;
    const { storeId } = await make(adminA);
    const rooms = await transaction((tx) => stockLocationsRepo.listActiveLocations(tx, storeId));
    expect(rooms).toHaveLength(1);
  });
});

describe('T-222 invariant 3 — ⭐ §C.2 second half: every active admin is scoped', () => {
  it('fans person_store_scope to EVERY active admin, not just the creator', async () => {
    // ⛔ THE test DEF-180 exists to force. Without this a new branch is invisible to the person who
    // just opened it, and the failure looks like a permissions bug rather than a missing row.
    const { storeId, scopedAdminIds } = await make(adminA);

    expect(scopedAdminIds).toHaveLength(2);
    const creatorScoped = await transaction((tx) =>
      accessRepo.personHasStoreScope(tx, adminA.personId, storeId));
    const otherScoped = await transaction((tx) =>
      accessRepo.personHasStoreScope(tx, admin2Id, storeId));
    expect(creatorScoped).toBe(true);
    expect(otherScoped).toBe(true);
  });

  it('⛔ does NOT scope a manager or staff member — the fan-out is admins only', async () => {
    const { storeId } = await make(adminA);
    const mgr = await transaction((tx) =>
      accessRepo.personHasStoreScope(tx, managerA.personId, storeId));
    expect(mgr).toBe(false);
  });
});

describe('T-222 invariants 4 and 5 — the database refuses, not a TypeScript copy', () => {
  it('⛔ refuses a non-daily cadence with no ceiling', async () => {
    // The rule lives in stores_pooling_requires_ceiling_check. There is deliberately no second copy
    // in TypeScript (bible §6.3) — a second copy is a second source of truth, and the two drift.
    await expect(
      make(adminA, { remittanceCadence: 'weekly', unremittedCeiling: null }),
    ).rejects.toThrow();
  });

  it('✅ allows a non-daily cadence WITH a ceiling', async () => {
    const res = await make(adminA, { remittanceCadence: 'weekly', unremittedCeiling: '5000.00' });
    expect(res.storeId).toBeTruthy();
  });

  it('⛔ refuses a duplicate code in the same org', async () => {
    const code = uid('DUP');
    await make(adminA, { code });
    await expect(make(adminA, { code })).rejects.toThrow();
  });
});

describe('T-222 invariant 6 — ⭐ all-or-nothing, proved by an INJECTED failure', () => {
  it('a failure after the store row leaves NO store behind', async () => {
    // ⛔ The atomicity claim is this design's whole advantage over v1, which could not roll back and
    // therefore had to report per-step. An untested rollback is a claim with nothing behind it.
    const code = uid('ROLL');
    const before = await sql<{ n: string }[]>`select count(*)::text n from stores where org_id = ${orgA}`;

    await expect(
      transaction(async (tx) => {
        await createStore(tx, adminA, { code, name: 'Doomed' });
        throw new Error('injected failure after createStore, inside the same transaction');
      }),
    ).rejects.toThrow(/injected failure/);

    const after = await sql<{ n: string }[]>`select count(*)::text n from stores where org_id = ${orgA}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const orphan = await sql<{ n: string }[]>`select count(*)::text n from stores where code = ${code}`;
    expect(orphan[0]!.n).toBe('0');
  });
});

describe('T-222 invariant 7 — readiness is DERIVED, never stored', () => {
  it('goes red again when the condition stops holding', async () => {
    // ⭐ bible row 123's lesson: v1 stored `state` per finding, so resolving one suppressed
    // tomorrow's recompute while the condition still held. A stored "ready" flag is the same defect.
    const { storeId } = await make(adminA);
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_active, is_remitted_daily)
      values (${orgA}, ${storeId}, 'Walk-in', true, true) returning id`;

    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const green = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(green.find((c) => c.key === 'salesChannel')!.ok).toBe(true);

    await sql`delete from sales_channels where id = ${ch!.id}`;
    const red = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(red.find((c) => c.key === 'salesChannel')!.ok).toBe(false);
  });

  it('⚠️ reports "nobody can sign in here" on a brand-new store — the sharpest check', async () => {
    // §5: a credential belongs to a (person, store) PAIR, so a new store has ZERO of them while the
    // sign-in page happily lists it. "My PIN stopped working" is the least informative possible
    // symptom of a correct system.
    const { storeId } = await make(adminA);
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const checks = await transaction((tx) => storeReadiness(tx, adminA, store!));
    const signIn = checks.find((c) => c.key === 'signIn')!;
    expect(signIn.ok).toBe(false);
    expect(signIn.blocking).toBe(true);
    expect(signIn.detail).toMatch(/No one can sign in/);
  });
});

describe('T-243 — readiness checks carry their own remedy link (DEF-216)', () => {
  it('room → /inventory/locations, this store preselected', async () => {
    const { storeId } = await make(adminA);
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const checks = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(checks.find((c) => c.key === 'room')!.remedy).toEqual({
      href: `/inventory/locations?store=${storeId}`,
      label: 'Add a stock room →',
    });
  });

  it('salesChannel → /settings/sales-channels, this store preselected', async () => {
    const { storeId } = await make(adminA);
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const checks = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(checks.find((c) => c.key === 'salesChannel')!.remedy).toEqual({
      href: `/settings/sales-channels?store=${storeId}`,
      label: 'Add a sales channel →',
    });
  });

  it('signIn → /staff, no store param (⚠️ /staff takes none today — out of scope to add one)', async () => {
    const { storeId } = await make(adminA);
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const checks = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(checks.find((c) => c.key === 'signIn')!.remedy).toEqual({
      href: '/staff',
      label: 'Issue a PIN from Staff →',
    });
  });

  it('⭐ adminScope carries NO remedy — cleared by Reactivate on this page, not a link to itself', async () => {
    // Negative case, deliberately: without it, three positives could pass with a remedy on all four.
    const { storeId } = await make(adminA);
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    const checks = await transaction((tx) => storeReadiness(tx, adminA, store!));
    expect(checks.find((c) => c.key === 'adminScope')!.remedy).toBeUndefined();
  });

  it('⛔ stays DERIVED — no readiness/href/remedy column ever lands on `stores`', async () => {
    const { storeId } = await make(adminA);
    await sql`
      insert into sales_channels (org_id, store_id, name, is_active, is_remitted_daily)
      values (${orgA}, ${storeId}, 'Walk-in', true, true)`;

    // Non-zero control FIRST — a query returning 0 for everything is indistinguishable from a
    // broken query (reference_sweep_needs_nonzero_control, bible §13 row 181).
    const control = await sql<{ n: string }[]>`
      select count(*)::text n from information_schema.columns
      where table_name = 'stores' and column_name = 'code'`;
    expect(control[0]!.n).toBe('1');

    const drift = await sql<{ n: string }[]>`
      select count(*)::text n from information_schema.columns
      where table_name = 'stores'
        and (column_name ilike '%readiness%' or column_name ilike '%href%' or column_name ilike '%remedy%')`;
    expect(drift[0]!.n).toBe('0');
  });
});

describe('T-222 invariants 8 and 9 — deactivate never deletes; reactivate re-fans', () => {
  it('deactivate keeps the row and its history', async () => {
    const { storeId } = await make(adminA);
    await transaction((tx) => deactivateStore(tx, adminA, storeId));
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    expect(store).toBeDefined();
    expect(store!.isActive).toBe(false);
  });

  it('⭐ reactivate re-fans scope to an admin appointed WHILE the store was inactive', async () => {
    // ⚠️ §C.2's failure in a THIRD costume. T-219's own smoketest saw "granted scope for 3 store(s)
    // — 3, not 4, because one store is inactive". So an admin appointed during the gap has no row;
    // bring the store back and it is invisible to them.
    const { storeId } = await make(adminA);
    await transaction((tx) => deactivateStore(tx, adminA, storeId));

    const late = await person(orgA, 'Late Admin', 'admin');
    const beforeReactivate = await transaction((tx) =>
      accessRepo.personHasStoreScope(tx, late.id, storeId));
    expect(beforeReactivate).toBe(false);

    const res = await transaction((tx) => reactivateStore(tx, adminA, storeId));
    expect(res.scopedAdminIds).toContain(late.id);
    const after = await transaction((tx) => accessRepo.personHasStoreScope(tx, late.id, storeId));
    expect(after).toBe(true);
  });
});

describe('T-222 — code is the stable handle', () => {
  it('⛔ updateStoreDetails renames but cannot change the code', async () => {
    // Ian, open question 1: rename freely, but the code is user-facing, appears on documents, and
    // other records refer to it. It is deliberately not in UpdateStorePatch at all.
    const { storeId } = await make(adminA, { code: 'KEEPME' });
    await transaction((tx) => updateStoreDetails(tx, adminA, storeId, { name: 'Renamed' }));
    const store = await transaction((tx) => storesRepo.getById(tx, orgA, storeId));
    expect(store!.name).toBe('Renamed');
    expect(store!.code).toBe('KEEPME');
  });
});

describe('T-222 invariant 10 — a store created in org A is invisible to org B', () => {
  it('getById scoped by org returns nothing for a foreign id', async () => {
    const { storeId } = await make(adminA);
    const foreign = await transaction((tx) => storesRepo.getById(tx, orgB, storeId));
    expect(foreign).toBeUndefined();
  });
});
