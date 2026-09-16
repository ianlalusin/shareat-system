import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * T-289 — the spine's thirteen integration cases. `docs/tasks/289-position-access-defaults-spine.md`.
 *
 * Fixture is `packages/domain/tests/integration/employment.test.ts:37-77`'s specimen, extended:
 * `asOrg` copied verbatim (`set local role`, `app.principal_kind`, `app.org_id`) so RLS is live
 * exactly as in production; raw `postgres` inserts for fixture rows, domain functions for
 * everything under test.
 *
 * ⛔ Run ONLY via `it.mjs` against the lane database — never `npm run test:integration`
 * (RULES §2: two agents against one `shareat_test` truncate each other's fixtures):
 *
 *   node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_lanec \
 *     packages/domain/tests/integration/position-defaults.test.ts --repo C:\Users\ianla\webapps\shareat-system
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor, type Capability } from '@shareat/auth';
import { assignRole, grantCapabilityAsActor } from '@shareat/auth';
import {
  createEmployment,
  endEmployment,
  retireStorePosition,
  seedCanonicalPositions,
  setEmploymentPositions,
  setPositionDefault,
  upsertStorePosition,
} from '@shareat/domain';
// ⛔ NOT exported from `@shareat/domain` — T-289 §C11's closed importer list is the guard that
// keeps `reconcilePositionGrants` unreachable from a screen. This file is one of its four named
// importers, used directly below to prove the self-skip primitive in isolation (case 10).
import { PositionDefaultError, reconcilePositionGrants } from '../../src/people/position-defaults';

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

/**
 * Plan §7's fixture: one org, two stores, canonical positions seeded, one store-invented
 * position at store A, an admin (both stores), a manager holding `enrol_staff` at A only
 * and NOT `grant_capability` (the plain 'manager' role matrix cell already gives exactly
 * this pair — `enrol_staff: manager true`, `grant_capability: manager false`).
 */
async function fixture(hint: string) {
  const code = uid(`pd-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`PD Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [storeA] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}a`)}, ${`Store ${hint} A`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}b`)}, ${`Store ${hint} B`}) returning id`;
  const storeAId = storeA!.id;
  const storeBId = storeB!.id;

  const [adminPerson] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminPerson!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminPerson!.id}, ${storeAId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminPerson!.id}, ${storeBId})`;

  const [managerPerson] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager A') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerPerson!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerPerson!.id}, ${storeAId})`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [cashier] = await sql<{ id: string }[]>`
    select id from positions where org_id = ${orgId} and store_id is null and name = 'Cashier'`;
  const [cook] = await sql<{ id: string }[]>`
    select id from positions where org_id = ${orgId} and store_id is null and name = 'Cook'`;

  const admin = actor(orgId, adminPerson!.id);
  const invented = await asOrg(orgId, (tx) =>
    upsertStorePosition(tx, admin, { storeId: storeAId, name: `Prep Lead ${code}` }),
  );

  return {
    orgId,
    storeAId,
    storeBId,
    admin,
    adminId: adminPerson!.id,
    manager: actor(orgId, managerPerson!.id),
    managerId: managerPerson!.id,
    cashierId: cashier!.id,
    cookId: cook!.id,
    inventedPositionId: invented.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function hireStaff(
  f: Fixture,
  opts: { storeId: string; positionIds: string[]; primaryPositionId?: string; actor?: Actor; name?: string },
) {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${f.orgId}, ${opts.name ?? uid('staff')}) returning id`;
  const employment = await asOrg(f.orgId, (tx) =>
    createEmployment(tx, opts.actor ?? f.admin, {
      storeId: opts.storeId,
      personId: person!.id,
      employmentStatus: 'probationary',
      startedOn: '2026-01-05',
      positionIds: opts.positionIds,
      primaryPositionId: opts.primaryPositionId ?? opts.positionIds[0],
    }),
  );
  return { personId: person!.id, employmentId: employment.id };
}

interface GrantSnapshot {
  id: string;
  grant_name: string;
  grant_source: string | null;
  source_ref: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

const activeGrants = (personId: string) =>
  sql<GrantSnapshot[]>`
    select id, grant_name, grant_source, source_ref, revoked_at, revoke_reason from person_grants
    where person_id = ${personId} and revoked_at is null`;

const setDefault = (
  orgId: string,
  actingAs: Actor,
  positionId: string,
  storeId: string,
  capability: Capability,
  on: boolean,
  reason?: string,
) => asOrg(orgId, (tx) => setPositionDefault(tx, actingAs, { positionId, storeId, capability, on, reason }));

// ---------------------------------------------------------------------------------------------

describe('T-289 case 1 — toggle on reaches every open-employment holder at that store and nobody at the other', () => {
  it('grants the holder at store A, not the same-position holder at store B', async () => {
    const f = await fixture('c1');
    const holderA = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    const holderB = await hireStaff(f, { storeId: f.storeBId, positionIds: [f.cashierId] });

    const result = await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    expect(result.affected).toBe(1);
    expect(result.skippedSelf).toBe(false);

    const grantsA = await activeGrants(holderA.personId);
    expect(grantsA.map((g) => g.grant_name)).toContain('adjust_inventory');
    expect(grantsA.find((g) => g.grant_name === 'adjust_inventory')!.grant_source).toBe('position');

    const grantsB = await activeGrants(holderB.personId);
    expect(grantsB.map((g) => g.grant_name)).not.toContain('adjust_inventory');
  });
});

describe('T-289 case 2 — toggle off revokes only position rows carrying that ref', () => {
  it("a hand-grant for the SAME capability, held by someone else, survives the sweep", async () => {
    const f = await fixture('c2');
    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    const bystander = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cookId] });

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    await asOrg(f.orgId, (tx) =>
      grantCapabilityAsActor(tx, f.admin, { personId: bystander.personId, capability: 'adjust_inventory' }),
    );

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', false);

    const holderGrants = await activeGrants(holder.personId);
    expect(holderGrants.map((g) => g.grant_name)).not.toContain('adjust_inventory');

    const bystanderGrants = await activeGrants(bystander.personId);
    expect(bystanderGrants.map((g) => g.grant_name)).toContain('adjust_inventory');
  });
});

describe('T-289 case 3 — a hand-grant over a position row upgrades provenance to grant', () => {
  it('keeps the ref, and the row survives the toggle off', async () => {
    const f = await fixture('c3');
    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    const before = (await activeGrants(holder.personId)).find((g) => g.grant_name === 'adjust_inventory')!;
    expect(before.grant_source).toBe('position');
    expect(before.source_ref).not.toBeNull();
    const refBefore = before.source_ref;

    await asOrg(f.orgId, (tx) =>
      grantCapabilityAsActor(tx, f.admin, { personId: holder.personId, capability: 'adjust_inventory' }),
    );

    const afterGrant = (await activeGrants(holder.personId)).find((g) => g.grant_name === 'adjust_inventory')!;
    expect(afterGrant.grant_source).toBe('grant');
    // ⛔ §C3/§C5 transition 1 — the ref is HISTORY and must be kept, never nulled or rewritten.
    expect(afterGrant.source_ref).toBe(refBefore);
    expect(afterGrant.id).toBe(before.id); // same row, upgraded in place — not a new row

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', false);

    const afterToggleOff = (await activeGrants(holder.personId)).find((g) => g.grant_name === 'adjust_inventory');
    expect(afterToggleOff, 'the upgraded row must survive — the sweep matches on grant_source, never source_ref').toBeDefined();
    expect(afterToggleOff!.grant_source).toBe('grant');
  });
});

describe('T-289 case 4 — hiring into a position with defaults grants them', () => {
  it('applies even when the hire is made by the enrol_staff manager, who cannot grant capabilities', async () => {
    const f = await fixture('c4');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);

    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId], actor: f.manager });

    const grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).toContain('adjust_inventory');
    expect(grants.find((g) => g.grant_name === 'adjust_inventory')!.grant_source).toBe('position');
  });
});

describe('T-289 case 5 — Cashier→Cook swaps the sets; Cashier+Cook keeps the union', () => {
  it('reconciles on every setEmploymentPositions call', async () => {
    const f = await fixture('c5');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    await setDefault(f.orgId, f.admin, f.cookId, f.storeAId, 'manage_locations', true);

    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    let grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name).sort()).toEqual(['adjust_inventory']);

    const [emp] = await sql<{ id: string }[]>`select id from employments where person_id = ${holder.personId}`;

    await asOrg(f.orgId, (tx) =>
      setEmploymentPositions(tx, f.admin, { employmentId: emp!.id, positionIds: [f.cookId], primaryPositionId: f.cookId }),
    );
    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name).sort()).toEqual(['manage_locations']);

    await asOrg(f.orgId, (tx) =>
      setEmploymentPositions(tx, f.admin, {
        employmentId: emp!.id,
        positionIds: [f.cashierId, f.cookId],
        primaryPositionId: f.cashierId,
      }),
    );
    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name).sort()).toEqual(['adjust_inventory', 'manage_locations']);
  });
});

describe('T-289 case 6 — two positions defaulting one capability', () => {
  it('switching one off leaves it held via the other, as a NEW row', async () => {
    const f = await fixture('c6');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    await setDefault(f.orgId, f.admin, f.cookId, f.storeAId, 'adjust_inventory', true);

    const holder = await hireStaff(f, {
      storeId: f.storeAId,
      positionIds: [f.cashierId, f.cookId],
      primaryPositionId: f.cashierId,
    });

    const before = (await activeGrants(holder.personId)).find((g) => g.grant_name === 'adjust_inventory')!;

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', false);

    const after = (await activeGrants(holder.personId)).find((g) => g.grant_name === 'adjust_inventory');
    expect(after, 'still held — the Cook default independently justifies it').toBeDefined();
    expect(after!.grant_source).toBe('position');
    expect(after!.id, 'a NEW row — plan §4.1: no reference counting, a new ref after a revoke-then-regrant').not.toBe(before.id);
  });
});

describe('T-289 case 7 — ending the employment at A revokes A rows and leaves B untouched', () => {
  it('reconciles on endEmployment, scoped to the ended store only', async () => {
    const f = await fixture('c7');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'manage_locations', true);

    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId: holder.personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );

    let grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name).sort()).toEqual(['adjust_inventory', 'manage_locations']);

    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: holder.employmentId, endedOn: '2026-03-31', employmentStatus: 'resigned' }),
    );

    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).toEqual(['manage_locations']);
  });
});

describe('T-289 case 8 — the same person in the same position at two stores has independent rows', () => {
  it('toggling one store never touches the other', async () => {
    const f = await fixture('c8');
    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId: holder.personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    let grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).toEqual(['adjust_inventory']);

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'manage_locations', true);
    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name).sort()).toEqual(['adjust_inventory', 'manage_locations']);

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', false);
    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).toEqual(['manage_locations']);
  });
});

describe('T-289 case 9 — retiring the store-invented position revokes its rows', () => {
  it('a canonical position cannot be retired', async () => {
    const f = await fixture('c9');
    await setDefault(f.orgId, f.admin, f.inventedPositionId, f.storeAId, 'adjust_inventory', true);
    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.inventedPositionId] });

    let grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).toContain('adjust_inventory');

    const result = await asOrg(f.orgId, (tx) => retireStorePosition(tx, f.admin, { positionId: f.inventedPositionId }));
    expect(result.affected).toBe(1);

    grants = await activeGrants(holder.personId);
    expect(grants.map((g) => g.grant_name)).not.toContain('adjust_inventory');

    const [pos] = await sql<{ is_active: boolean }[]>`select is_active from positions where id = ${f.inventedPositionId}`;
    expect(pos!.is_active).toBe(false);

    await expect(
      asOrg(f.orgId, (tx) => retireStorePosition(tx, f.admin, { positionId: f.cashierId })),
    ).rejects.toThrow(PositionDefaultError);
  });
});

describe('T-289 case 10 — an actor holding the position is skipped and reported', () => {
  it('everyone else is still written; the primitive itself reports the skip with no write', async () => {
    const f = await fixture('c10');
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeAId,
        personId: f.adminId,
        employmentStatus: 'regular',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );
    const other = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });

    const direct = await asOrg(f.orgId, (tx) => reconcilePositionGrants(tx, f.admin, { personId: f.adminId, storeId: f.storeAId }));
    expect(direct).toEqual({ granted: [], revoked: [], skippedSelf: true });

    const result = await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'adjust_inventory', true);
    expect(result.skippedSelf).toBe(true);
    expect(result.affected).toBe(1);

    const adminGrants = await activeGrants(f.adminId);
    expect(adminGrants.map((g) => g.grant_name)).not.toContain('adjust_inventory');

    const otherGrants = await activeGrants(other.personId);
    expect(otherGrants.map((g) => g.grant_name)).toContain('adjust_inventory');
  });
});

describe('T-289 case 11 — denials, each refused at the domain', () => {
  it('no grant_capability — the enrol_staff manager may not toggle a default', async () => {
    const f = await fixture('c11a');
    await expect(setDefault(f.orgId, f.manager, f.cashierId, f.storeAId, 'adjust_inventory', true)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('a store outside the org is refused', async () => {
    const f = await fixture('c11b');
    const [otherOrg] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('Other Org', ${uid('other-org')}) returning id`;
    const [otherStore] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${otherOrg!.id}, ${uid('other-store')}, 'Other Store') returning id`;

    await expect(
      setDefault(f.orgId, f.admin, f.cashierId, otherStore!.id, 'adjust_inventory', true),
    ).rejects.toThrow(PositionDefaultError);
  });

  it('a store-A-invented position targeted at store B is refused', async () => {
    const f = await fixture('c11c');
    await expect(
      setDefault(f.orgId, f.admin, f.inventedPositionId, f.storeBId, 'adjust_inventory', true),
    ).rejects.toThrow(PositionDefaultError);
  });

  it('a SUPER_ADMIN_ONLY capability is refused', async () => {
    const f = await fixture('c11d');
    await expect(setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'approve_item', true)).rejects.toThrow(
      PositionDefaultError,
    );
  });

  it('a platform-scoped capability is refused', async () => {
    const f = await fixture('c11e');
    await expect(setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'cross_org_access', true)).rejects.toThrow(
      PositionDefaultError,
    );
  });

  it('close_period is refused', async () => {
    const f = await fixture('c11f');
    await expect(setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'close_period', true)).rejects.toThrow(
      PositionDefaultError,
    );
  });

  it('T-318 Contract 2 — a former staff-matrix capability is now ACCEPTED, not refused', async () => {
    // Until T-318, record_sale was one of 21 cells automatic for every 'staff' role, so a
    // position default for it "would be a row that changes nothing" and this test asserted
    // the refusal. T-318 shrank the staff baseline (docs/tasks/318-position-decides-access.md)
    // — the 21 moved OFF the matrix onto position grants, so the refusal's own premise is now
    // false, and Contract 2 requires the opposite: setPositionDefault accepts all 21.
    const f = await fixture('c11g');
    const holder = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });

    const result = await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', true);
    expect(result.wroteDefault).toBe(true);
    expect(result.affected).toBe(1);

    const holderGrants = await activeGrants(holder.personId);
    expect(holderGrants.map((g) => g.grant_name)).toContain('record_sale');
    expect(holderGrants.find((g) => g.grant_name === 'record_sale')!.grant_source).toBe('position');
  });
});

describe('T-289 case 12 — an elevated manager in an adminless org keeps the capability as a position row', () => {
  it('admin arrival does not sweep it; switching the default off does revoke it (Invariant 8)', async () => {
    const code = uid('c12');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('C12 Org', ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('c12s')}, 'C12 Store') returning id`;
    const storeId = store!.id;

    const [m1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager One') returning id`;
    const [m2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager Two') returning id`;

    // Both appointed while the org is adminless — the grant-time fallback fires for each
    // (bible row 115). `assignRole` is the ungated primitive; no admin exists yet to gate through.
    await asOrg(orgId, (tx) => assignRole(tx, { personId: m1!.id, orgId, role: 'manager', grantedBy: null }));
    await asOrg(orgId, (tx) => assignRole(tx, { personId: m2!.id, orgId, role: 'manager', grantedBy: null }));
    await sql`insert into person_store_scope (person_id, store_id) values (${m1!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${m2!.id}, ${storeId})`;

    await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
    const [cashier] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${orgId} and store_id is null and name = 'Cashier'`;

    const m2Actor = actor(orgId, m2!.id);
    // m2 hires m1 (m2 already holds enrol_staff natively as a manager).
    await asOrg(orgId, (tx) =>
      createEmployment(tx, m2Actor, {
        storeId,
        personId: m1!.id,
        employmentStatus: 'regular',
        startedOn: '2026-01-05',
        positionIds: [cashier!.id],
        primaryPositionId: cashier!.id,
      }),
    );

    let grants = await activeGrants(m1!.id);
    expect(grants.find((g) => g.grant_name === 'manage_users')!.grant_source).toBe('elevation');

    // m2 also holds `grant_capability` via elevation (it is in ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER
    // too) and can therefore toggle a default that reconciles m1 (not self).
    await asOrg(orgId, (tx) =>
      setPositionDefault(tx, m2Actor, { positionId: cashier!.id, storeId, capability: 'manage_users', on: true }),
    );

    grants = await activeGrants(m1!.id);
    expect(grants.find((g) => g.grant_name === 'manage_users')!.grant_source).toBe('position');

    // Admin arrives — the elevation sweep runs and must NOT touch this now-position-sourced row.
    const [adminPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'New Admin') returning id`;
    await asOrg(orgId, (tx) => assignRole(tx, { personId: adminPerson!.id, orgId, role: 'admin', grantedBy: m2!.id }));

    grants = await activeGrants(m1!.id);
    expect(grants.map((g) => g.grant_name)).toContain('manage_users');

    // Switching the default off DOES revoke it — the accepted consequence, Invariant 8.
    const adminActor = actor(orgId, adminPerson!.id);
    await asOrg(orgId, (tx) =>
      setPositionDefault(tx, adminActor, { positionId: cashier!.id, storeId, capability: 'manage_users', on: false }),
    );

    grants = await activeGrants(m1!.id);
    expect(grants.map((g) => g.grant_name)).not.toContain('manage_users');
  });
});

describe('T-289 case 13 — migration 0146 applies to an empty database, and admits pre-0146-shaped rows', () => {
  // DEF-325 (docs/tasks/299-def-325-from-zero-migration-timeout.md, Slice 2): 120_000ms here is
  // ABSORBING LOCAL CONTENTION, NOT A PERFORMANCE BUDGET. CI runs this test in ~5.5s against the
  // project's 30s default and has never once failed it (run 34705670725). Locally this test was
  // observed bimodal — fine in ~2-3s, or stuck at whatever ceiling was configured, nothing between
  // across 5 attempts — which is the signature of a lock wait, not of load (contrast DEF-313's
  // smooth drift). `scratchName` below WAS a hardcoded literal, shared by every lane/session on
  // this one Postgres server, so two concurrent runs of this file raced CREATE/DROP DATABASE on
  // the identical name — filed as DEF-334. That race WAS confirmed deterministically (4/4
  // concurrent trials; the comment on the test below carries the evidence), and the pid-derived
  // `scratchName` below IS the fix.
  // ⛔ RULING: this 120s override must NOT be removed on the strength of that fix. DEF-334's
  // failure shape is wrong for DEF-325's stall — a fast explicit duplicate-key error at
  // ~100-200ms, not a stall to the ceiling — so DEF-325's stall remains UNEXPLAINED; re-measure
  // under lane isolation before touching this number.
  // ⭐ A comment phrased "whoever fixes X should then do Y" is a booby trap with a timer, because
  // X eventually happens and nothing links the two — record the ruling, not a conditional
  // instruction.
  it('proven on a scratch database, created and dropped here — never a shared one', async () => {
    // DEF-334: was a hardcoded literal, identical across every lane/session on this one Postgres
    // server — confirmed as a real, reproducible collision (4/4 concurrent trials, immediate
    // `duplicate key value violates unique constraint "pg_database_datname_index"` on `CREATE
    // DATABASE`). `process.pid` is unique among every process alive on this OS at once, so two
    // RUNS THAT ARE BOTH STILL RUNNING can never compute the same name — that's the property
    // (not "unlikely to collide"). The lane tag is cosmetic (so `pg_database` reads legibly); the
    // pid is what makes it structural.
    const laneTag = new URL(url!).pathname.replace(/^\//, '').replace(/[^a-zA-Z0-9_]/g, '_');
    const scratchName = `${laneTag}_scratch_t289_${process.pid}`;
    const scratchUrl = (() => {
      const u = new URL(url!);
      u.pathname = `/${scratchName}`;
      return u.toString();
    })();

    const admin = postgres(url!, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists "${scratchName}"`);
      await admin.unsafe(`create database "${scratchName}"`);
    } finally {
      await admin.end();
    }

    const scratchSql = postgres(scratchUrl, { max: 1 });
    try {
      const migrationsFolder = path.resolve(
        fileURLToPath(new URL('.', import.meta.url)),
        '../../../../packages/db/migrations',
      );
      await migrate(drizzle(scratchSql), { migrationsFolder });

      // ⚠️ NOT `idx + 1` — the journal reserves gaps (ADR-012 §2.1, DEF-091), so the row count in
      // `drizzle.__drizzle_migrations` is the journal's ENTRY count, not its highest idx. Read the
      // real journal rather than hardcode either number.
      const journal = JSON.parse(
        readFileSync(
          path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../packages/db/migrations/meta/_journal.json'),
          'utf8',
        ),
      ) as { entries: unknown[] };
      const applied = await scratchSql<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(applied[0]!.count).toBe(journal.entries.length);

      const [org] = await scratchSql<{ id: string }[]>`
        insert into organizations (name, code) values ('Scratch Org', 'scratch-t289') returning id`;
      const [person] = await scratchSql<{ id: string }[]>`
        insert into persons (org_id, display_name) values (${org!.id}, 'Scratch Person') returning id`;

      // Every non-'position' source, with source_ref NULL — the shape every pre-0146 row has
      // (the column did not exist before this migration). All four must be ADMITTED.
      for (const source of [null, 'elevation', 'owner', 'grant'] as const) {
        await scratchSql`
          insert into person_grants (person_id, grant_name, grant_source, source_ref)
          values (${person!.id}, ${`scratch_cap_${source ?? 'null'}`}, ${source}, null)`;
      }
      const rows = await scratchSql<{ grant_source: string | null }[]>`
        select grant_source from person_grants where person_id = ${person!.id}`;
      expect(rows.length).toBe(4);

      // A 'position' row with a NULL ref must be REFUSED — the CHECK's positive direction.
      await expect(
        scratchSql`
          insert into person_grants (person_id, grant_name, grant_source, source_ref)
          values (${person!.id}, 'scratch_cap_bad', 'position', null)`,
      ).rejects.toThrow();

      const constraint = await scratchSql<{ conname: string }[]>`
        select conname from pg_constraint where conname = 'person_grants_position_source_ref_check'`;
      expect(constraint.length).toBe(1);
    } finally {
      await scratchSql.end();
      const admin2 = postgres(url!, { max: 1 });
      try {
        await admin2.unsafe(`drop database if exists "${scratchName}"`);
      } finally {
        await admin2.end();
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// T-318 — THE TEST THAT IS THE WHOLE TASK. Ian's own report: "still cant turn off record_sale
// submit_sales_day on dishwasher role and server and panda role they do not have this." Two
// people, one store, two DIFFERENT positions, one capability — one holds it, one is refused.
// This is what would have answered his question without anybody opening a screen.
// ---------------------------------------------------------------------------------------------

describe('T-318 — a position decides what a person may do', () => {
  it('Dishwasher is refused submit_sales_day; Server, same store, holds it', async () => {
    const f = await fixture('t318');

    // 'Dishwasher' and 'Server' are two of the six CANONICAL positions (org-level,
    // store_id null — `CANONICAL_POSITIONS` in packages/db/schema/employment.ts), already
    // seeded by fixture()'s call to seedCanonicalPositions, exactly like f.cashierId/f.cookId
    // above. A canonical position still gets a PER-STORE default via setPositionDefault's
    // storeId argument (case 1 does this for Cashier) — upsertStorePosition is for a
    // STORE-INVENTED position only and refuses a name that already exists canonically.
    const [dishwasher] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${f.orgId} and store_id is null and name = 'Dishwasher'`;
    const [server] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${f.orgId} and store_id is null and name = 'Server'`;

    // ⛔ THE TRAP (T-302's gate-leg tests failed this way): two people who share a POSITION
    // prove nothing. Pin the precondition explicitly so a future edit cannot silently collapse
    // it — different positions, same store.
    expect(dishwasher!.id).not.toBe(server!.id);

    // Server gets the default; Dishwasher does not — reproducing Ian's exact report, where
    // Dishwasher and Server both lacked a way to turn this off (or on) at all.
    await setDefault(f.orgId, f.admin, server!.id, f.storeAId, 'submit_sales_day', true);

    const dishwasherPerson = await hireStaff(f, {
      storeId: f.storeAId,
      positionIds: [dishwasher!.id],
      name: 'Dishwasher Person',
    });
    const serverPerson = await hireStaff(f, {
      storeId: f.storeAId,
      positionIds: [server!.id],
      name: 'Server Person',
    });
    // hireStaff only creates the employment/position link — a real actor also needs an active
    // role and store scope, exactly as any real staff member would (fixture()'s admin/manager
    // personas above get the same two rows for the same reason).
    for (const personId of [dishwasherPerson.personId, serverPerson.personId]) {
      await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${f.orgId}, 'staff')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${f.storeAId})`;
    }

    // Both people, same store — the halves of the trap the "different position" check above
    // does not cover on its own.
    const dishwasherActor: Actor = { personId: dishwasherPerson.personId, orgId: f.orgId };
    const serverActor: Actor = { personId: serverPerson.personId, orgId: f.orgId };

    await expect(
      asOrg(f.orgId, (tx) => authorize(tx, dishwasherActor, 'submit_sales_day', { storeId: f.storeAId })),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      asOrg(f.orgId, (tx) => authorize(tx, serverActor, 'submit_sales_day', { storeId: f.storeAId })),
    ).resolves.toBeUndefined();
  });
});
