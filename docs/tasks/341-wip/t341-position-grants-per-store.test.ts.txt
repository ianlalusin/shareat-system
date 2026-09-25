import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-341 / DEF-414 — `docs/tasks/341-def-414-person-grants-store.md` §5.
 * A position-sourced, store-scoped capability is honoured only at the store whose default produced
 * it. Fixture (`asOrg`/`fixture`/`hireStaff`/`setDefault`) copied from
 * `position-defaults.test.ts:54-163` — every decision goes through real `authorize()`/domain
 * functions; no test here hand-inserts a `person_grants` row.
 *
 * ⛔ RED (P1-P4) until the builder ships the store dimension on `person_grants` — today
 * `authorize()` accepts any active grant regardless of which store's default produced it, so the
 * NEGATIVE half of each case (the cross-store leak) resolves instead of rejecting.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, accessRepo, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor, type Capability } from '@shareat/auth';
import { grantCapabilityAsActor } from '@shareat/auth';
import { createEmployment, seedCanonicalPositions, setPositionDefault, upsertStorePosition } from '@shareat/domain';

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
  const code = uid(`t341-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`T341 Org ${code}`}, ${code}) returning id`;
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
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminPerson!.id}, ${storeAId}, 'manual')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminPerson!.id}, ${storeBId}, 'manual')`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [cashier] = await sql<{ id: string }[]>`
    select id from positions where org_id = ${orgId} and store_id is null and name = 'Cashier'`;
  const [cook] = await sql<{ id: string }[]>`
    select id from positions where org_id = ${orgId} and store_id is null and name = 'Cook'`;

  return {
    orgId,
    storeAId,
    storeBId,
    admin: actor(orgId, adminPerson!.id),
    adminId: adminPerson!.id,
    cashierId: cashier!.id,
    cookId: cook!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function hireStaff(
  f: Fixture,
  opts: { storeId: string; positionIds: string[]; primaryPositionId?: string; actor?: Actor; personId?: string; name?: string },
) {
  const personId =
    opts.personId ??
    (
      await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${f.orgId}, ${opts.name ?? uid('staff')}) returning id`
    )[0]!.id;
  const employment = await asOrg(f.orgId, (tx) =>
    createEmployment(tx, opts.actor ?? f.admin, {
      storeId: opts.storeId,
      personId,
      employmentStatus: 'probationary',
      startedOn: '2026-01-05',
      positionIds: opts.positionIds,
      primaryPositionId: opts.primaryPositionId ?? opts.positionIds[0],
    }),
  );
  return { personId, employmentId: employment.id };
}

interface GrantSnapshot {
  id: string;
  grant_name: string;
  grant_source: string | null;
  source_ref: string | null;
}
// ⚠️ Deliberately NOT `store_id` — that column does not exist until the builder's migration lands;
// selecting it here would fail every case with a bare "column does not exist" rather than the real
// red. P3 reads the store dimension separately, via the join to `position_capability_defaults` that
// already exists today (the column this whole task adds is the point being tested).
const activeGrants = (personId: string) =>
  sql<GrantSnapshot[]>`
    select id, grant_name, grant_source, source_ref from person_grants
    where person_id = ${personId} and revoked_at is null`;

const setDefault = (
  orgId: string,
  actingAs: Actor,
  positionId: string,
  storeId: string,
  capability: Capability,
  on: boolean,
) => asOrg(orgId, (tx) => setPositionDefault(tx, actingAs, { positionId, storeId, capability, on }));

const check = (f: Fixture, personId: string, capability: Capability, storeId: string) =>
  asOrg(f.orgId, (tx) => authorize(tx, actor(f.orgId, personId), capability, { storeId }));

describe('P1 (DEF-414) — a Cashier at B and a Cook at A: record_sale never leaks to A', () => {
  it('record_sale@B resolves; record_sale@A rejects "may not", not "no store scope"; record_wastage@A (Cook default) resolves', async () => {
    const f = await fixture('p1');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'record_sale', true);
    await setDefault(f.orgId, f.admin, f.cookId, f.storeAId, 'record_wastage', true);

    const { personId } = await hireStaff(f, { storeId: f.storeBId, positionIds: [f.cashierId] });
    // Second employment, same person, at A as Cook — DEF-414's exact scenario shape.
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeAId,
        personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cookId],
        primaryPositionId: f.cookId,
      }),
    );

    await expect(check(f, personId, 'record_sale', f.storeBId)).resolves.toBeUndefined();
    await expect(check(f, personId, 'record_sale', f.storeAId)).rejects.toThrow(/may not 'record_sale'/);
    // Control: the Cook default at A is unaffected.
    await expect(check(f, personId, 'record_wastage', f.storeAId)).resolves.toBeUndefined();
  });
});

describe('P2 (§2.2 sibling) — a wrongful revocation must not follow a surviving manual scope', () => {
  it('after ending the A employment (manual scope at A survives), record_sale@B still resolves and @A rejects on the grant, not the scope', async () => {
    const f = await fixture('p2');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', true);
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'record_sale', true);

    const { personId, employmentId: employmentA } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );
    // Manual scope at A, layered on top of the employment-derived scope — survives endEmployment.
    await asOrg(f.orgId, (tx) => accessRepo.grantStoreScope(tx, { personId, storeId: f.storeAId, grantedBy: f.adminId, source: 'manual' }));

    const { endEmployment } = await import('@shareat/domain');
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: employmentA, endedOn: '2026-03-31', employmentStatus: 'resigned' }),
    );

    await expect(check(f, personId, 'record_sale', f.storeBId)).resolves.toBeUndefined();
    await expect(check(f, personId, 'record_sale', f.storeAId)).rejects.toThrow(/may not 'record_sale'/);
  });
});

describe('P3 — one active position row per store, each tied to its own store\'s default', () => {
  it('two active rows, sorted by store, each source_ref pointing at that store\'s default; no null-store row', async () => {
    const f = await fixture('p3');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', true);
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'record_sale', true);

    const { personId } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );

    // Pre-T-341: `person_grants.store_id` does not exist, so this always reads as an array of one —
    // asserted via the join to the source_ref default's own store until the column exists.
    const withStore = await sql<{ id: string; store_id: string }[]>`
      select g.id, d.store_id from person_grants g
      join position_capability_defaults d on d.id = g.source_ref
      where g.person_id = ${personId} and g.grant_name = 'record_sale' and g.revoked_at is null
      order by d.store_id
    `;
    expect(withStore.map((r) => r.store_id).sort()).toEqual([f.storeAId, f.storeBId].sort());
    // NEGATIVE — no row for this store-scoped capability with a NULL source_ref (which pre-T-341
    // would be the only way a "null-store" row could exist at all, since the column itself is new).
    const grants = (await activeGrants(personId)).filter((g) => g.grant_name === 'record_sale');
    expect(grants.some((g) => g.source_ref === null), 'no null-source row for this store-scoped capability').toBe(false);
  });
});

describe('P4 — switching one store\'s default off only revokes that store\'s row', () => {
  it('B still resolves; A rejects and P keeps scope at A', async () => {
    const f = await fixture('p4');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', true);
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'record_sale', true);

    const { personId } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );

    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', false);

    await expect(check(f, personId, 'record_sale', f.storeBId)).resolves.toBeUndefined();
    await expect(check(f, personId, 'record_sale', f.storeAId)).rejects.toThrow(/may not/);
    const [scope] = await sql<{ id: string }[]>`
      select id from person_store_scope where person_id = ${personId} and store_id = ${f.storeAId}`;
    expect(scope, 'store scope at A is untouched — only the grant is store-specific').toBeDefined();
  });
});

describe('P5 (guard) — a person-level hand-grant authorises everywhere the person has scope', () => {
  it('resolves at A and B; after revokeGrantById, A rejects too (both stores lose it together)', async () => {
    const f = await fixture('p5');
    const { personId } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cookId] });
    await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${f.storeBId}, 'manual')`;

    await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId, capability: 'record_sale' }));

    await expect(check(f, personId, 'record_sale', f.storeAId)).resolves.toBeUndefined();
    await expect(check(f, personId, 'record_sale', f.storeBId)).resolves.toBeUndefined();

    const [grant] = await activeGrants(personId);
    await asOrg(f.orgId, (tx) => accessRepo.revokeGrantById(tx, grant!.id, 'P5 guard'));

    await expect(check(f, personId, 'record_sale', f.storeAId)).rejects.toThrow(/may not/);
  });
});

describe('P6 (guard) — an org-scoped capability is unaffected by the store dimension', () => {
  it('a Cashier at B with manage_items default resolves with empty context; a Cook-only person at A without it rejects', async () => {
    const f = await fixture('p6');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'manage_items', true);
    const { personId: cashierAtB } = await hireStaff(f, { storeId: f.storeBId, positionIds: [f.cashierId] });
    const { personId: cookAtA } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cookId] });

    await expect(asOrg(f.orgId, (tx) => authorize(tx, actor(f.orgId, cashierAtB), 'manage_items', {}))).resolves.toBeUndefined();
    await expect(asOrg(f.orgId, (tx) => authorize(tx, actor(f.orgId, cookAtA), 'manage_items', {}))).rejects.toThrow(
      /may not 'manage_items'/,
    );
  });
});

describe('P7 (guard, matrix invariant 6) — removing store scope refuses on scope, not on the grant', () => {
  it('revokeStoreScope at B makes record_sale@B reject "no store scope"', async () => {
    const f = await fixture('p7');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeBId, 'record_sale', true);
    const { personId } = await hireStaff(f, { storeId: f.storeBId, positionIds: [f.cashierId] });

    await asOrg(f.orgId, (tx) => accessRepo.revokeStoreScope(tx, personId, f.storeBId));

    await expect(check(f, personId, 'record_sale', f.storeBId)).rejects.toThrow(/no store scope/);
  });
});

describe('P8 (self-skip, bible §7 rule 5) — an admin hiring themselves gains no position row; another hire does', () => {
  it('admin stays without the row; a second, ordinary hire in the same store gets it', async () => {
    const f = await fixture('p8');
    await setDefault(f.orgId, f.admin, f.cashierId, f.storeAId, 'record_sale', true);

    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeAId,
        personId: f.adminId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [f.cashierId],
        primaryPositionId: f.cashierId,
      }),
    );
    const adminGrants = await activeGrants(f.adminId);
    expect(adminGrants.map((g) => g.grant_name)).not.toContain('record_sale');

    const { personId: otherPersonId } = await hireStaff(f, { storeId: f.storeAId, positionIds: [f.cashierId] });
    const otherGrants = await activeGrants(otherPersonId);
    expect(otherGrants.map((g) => g.grant_name)).toContain('record_sale');
  });
});
