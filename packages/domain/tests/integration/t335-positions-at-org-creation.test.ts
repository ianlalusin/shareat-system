/**
 * T-335 — every organisation can hire from day one (DEF-150).
 * `docs/tasks/335-positions-seeded-at-org-creation.md` §7, T1-T7 + T5b + T6b.
 *
 * House style matches `first-run-setup.test.ts` / `organizations.test.ts`: `systemTransaction` for
 * anything that creates an org (no principal exists yet), `withOrgPrincipal` for anything after.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, employmentRepo } from '@shareat/db';
import { CANONICAL_POSITIONS } from '@shareat/db/schema';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { bootstrapOrganization, createOrganization } from '../../src/organizations';
import { createStore } from '../../src/stores/service';
import { createEmployment, setPositionDefault } from '../../src/people';

/** Dynamic on purpose: this module does not exist until the builder creates it (§4). A static
 *  top-level import would fail the WHOLE FILE, hiding T1-T6/T6b's own specific red reasons behind
 *  one blanket module-not-found — the exact vacuous-red shape this project's own rules warn
 *  against. Only T5b/T7, which genuinely need it, fail on it; every other case stays independent. */
async function loadBackfill(): Promise<{
  backfillOrgPositions: (tx: unknown, org: { id: string; name: string }) => Promise<{
    inserted: number;
    collisions: readonly { storeCode: string; positionId: string; name: string }[];
  }>;
}> {
  return import('../../../../scripts/backfill-canonical-positions' as string);
}

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_grants, person_roles,
      position_capability_defaults, employment_positions, employments, positions,
      person_store_scope, stock_locations, location_types, sales_channels, stores, persons,
      fiscal_periods, expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const INPUT = {
  code: 'T335',
  name: 'T335 Co',
  adminDisplayName: 'T335 Admin',
  storeCode: 'MAIN',
  storeName: 'Main Store',
  pin: '135790',
};

const countPositions = async (orgId: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int n from positions where org_id = ${orgId}`;
  return row!.n;
};

// -------------------------------------------------------------------------------------
// T1
// -------------------------------------------------------------------------------------

describe('T1 — a freshly bootstrapped org has exactly the six, set-equal, and positionsSeeded matches what was inserted', () => {
  it('bootstrapOrganization seeds exactly CANONICAL_POSITIONS, all org-wide canonical', async () => {
    const result = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T1') }));
    expect(result.positionsSeeded).toBe(6);

    const rows = await sql<{ name: string; store_id: string | null; is_canonical: boolean }[]>`
      select name, store_id, is_canonical from positions where org_id = ${result.orgId} order by name`;
    expect(rows.every((r) => r.store_id === null), 'every seeded row should be org-wide (store_id null)').toBe(true);
    expect(rows.every((r) => r.is_canonical === true), 'every seeded row should be is_canonical').toBe(true);
    // Set equality, not a count — a wrong or misspelled six passes a bare length check.
    expect([...rows.map((r) => r.name)].sort()).toEqual([...CANONICAL_POSITIONS].sort());
    expect(result.positionsSeeded).toBe(rows.length);
  });
});

// -------------------------------------------------------------------------------------
// T2
// -------------------------------------------------------------------------------------

describe('T2 — a blank hire into a fresh org gets Server as its single primary', () => {
  it('createEmployment with no positionIds resolves to a single primary named Server', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T2') }));
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${boot.orgId}, 'Worker Two') returning id`;
    const actor: Actor = { personId: boot.personId, orgId: boot.orgId };

    const employment = await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, actor, {
        storeId: boot.storeId,
        personId: worker!.id,
        employmentStatus: 'probationary',
        startedOn: '2026-09-24',
      }),
    );

    const assigned = await sql<{ name: string; is_primary: boolean }[]>`
      select p.name, ep.is_primary from employment_positions ep
      join positions p on p.id = ep.position_id
      where ep.employment_id = ${employment.id}`;
    expect(assigned).toHaveLength(1);
    // The name, not merely "one primary exists" — a fallback resolving to the first alphabetical
    // canonical (Cashier) would pass a weaker assertion.
    expect(assigned[0]!.name).toBe('Server');
    expect(assigned[0]!.is_primary).toBe(true);
  });
});

// -------------------------------------------------------------------------------------
// T3 — atomic with the org.
//
// ⚠️ T1 is this test's POSITIVE half. T3 only proves the seed does not survive a rollback — it
// currently passes even with no seed implemented at all, because nothing writes positions either
// way. It is T1 that proves the seed writes 6 rows on the SUCCESS path. Weakening or deleting T1
// would leave T3 "green" while asserting nothing about atomicity actually holding.
// -------------------------------------------------------------------------------------

describe('T3 — the seed is atomic with the org', () => {
  it('a failure after createOrganization leaves zero positions for that org', async () => {
    let capturedOrgId: string | undefined;
    await expect(
      systemTransaction(async (tx) => {
        const org = await createOrganization(tx, { code: uid('T3'), name: 'T3 Co' });
        capturedOrgId = org.orgId;
        throw new Error('injected failure, inside the same transaction');
      }),
    ).rejects.toThrow(/injected failure/);

    expect(capturedOrgId, 'fixture problem: createOrganization did not return before the throw').toBeTruthy();
    // The org itself is gone too (rolled back) — a seed on its own connection/transaction would be
    // the only way positions survive an organization that does not.
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${capturedOrgId!}`;
    expect(org, 'the org should not exist after rollback').toBeUndefined();
    expect(await countPositions(capturedOrgId!)).toBe(0);
  });
});

// -------------------------------------------------------------------------------------
// T4
// -------------------------------------------------------------------------------------

describe('T4 — seeding twice creates no duplicates; a pre-existing canonical differing only in case/space is honoured', () => {
  it('(a) seedCanonical twice: inserted 6 then 0, count stays 6', async () => {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (code, name) values (${uid('T4A')}, 'T4a Co') returning id`;
    const orgId = org!.id;

    const first = await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    expect(first.inserted).toBe(6);
    const second = await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    expect(second.inserted).toBe(0);
    expect(await countPositions(orgId)).toBe(6);
  });

  it('(b) a pre-existing canonical differing only in case/space is honoured: inserted 5, count 6', async () => {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (code, name) values (${uid('T4B')}, 'T4b Co') returning id`;
    const orgId = org!.id;
    // Bypasses seedCanonical on purpose — a row that already exists under a different spelling,
    // not one seedCanonical itself wrote.
    await sql`insert into positions (org_id, store_id, name, is_canonical) values (${orgId}, null, ' server ', true)`;

    const result = await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    expect(result.inserted).toBe(5);
    expect(await countPositions(orgId)).toBe(6);
  });
});

// -------------------------------------------------------------------------------------
// T5 / T5b — seeding grants nothing.
// -------------------------------------------------------------------------------------

describe('T5 — seeding grants nothing', () => {
  it('after bootstrap and a blank hire: zero defaults, zero position-sourced grants, record_sale rejected; the control then passes it', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T5') }));
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${boot.orgId}, 'Worker Five') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };

    const employment = await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, adminActor, {
        storeId: boot.storeId,
        personId: worker!.id,
        employmentStatus: 'probationary',
        startedOn: '2026-09-24',
      }),
    );

    // T-336 amendment: bootstrap now seeds the ruled 38 position_capability_defaults rows, and a
    // blank hire (Server) is reconciled against them at hire time — this test's own POINT (a
    // blank Server hire is never granted record_sale) still holds; only the raw counts changed.
    const [defaultsRow] = await sql<{ n: number }[]>`
      select count(*)::int n from position_capability_defaults where org_id = ${boot.orgId}`;
    expect(defaultsRow!.n).toBe(38);

    const positionGrants = await sql<{ grant_name: string }[]>`
      select grant_name from person_grants where person_id = ${worker!.id} and grant_source = 'position' order by grant_name`;
    expect(positionGrants.map((r) => r.grant_name)).toEqual(['record_stock_movement', 'record_wastage']);

    // T-336 auto-role/scope delta: createEmployment now auto-assigns 'staff' and grants store
    // scope for the hired store, so the manual inserts this test used to need here would 23505.
    // Assert they happened instead — the point (authorize refuses without a position default) is
    // otherwise unchanged from position-defaults.test.ts:691-693's precedent.
    const [role] = await sql<{ role: string }[]>`
      select role from person_roles where person_id = ${worker!.id} and org_id = ${boot.orgId} and revoked_at is null`;
    expect(role?.role, 'createEmployment should auto-assign an active role').toBe('staff');
    const scoped = await sql<{ id: string }[]>`
      select id from person_store_scope where person_id = ${worker!.id} and store_id = ${boot.storeId}`;
    expect(scoped, 'createEmployment should grant store scope for the hired store').toHaveLength(1);

    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId })),
    ).rejects.toThrow(AuthorizationError);

    // Control: the admin sets the default, and now the SAME authorize call passes — proves the
    // rejection above came from the missing default, not a broken actor fixture.
    const [server] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${boot.orgId} and name = 'Server'`;
    await withOrgPrincipal(boot.orgId, (tx) =>
      setPositionDefault(tx, adminActor, {
        positionId: server!.id,
        storeId: boot.storeId,
        capability: 'record_sale',
        on: true,
      }),
    );
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId })),
    ).resolves.toBeUndefined();
  });
});

describe('T5b — an org already in 0152\'s state keeps its defaults exactly; the new canonical rows grant nothing', () => {
  it('position_capability_defaults and person_grants are byte-identical before and after the per-org backfill', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T5B') }));
    // Zero canonical rows for this org — the pre-T-335 state — plus a store-scoped position with
    // real defaults and the matching grant, exactly 0152's shape. T-336: bootstrap's own 38 ruled
    // defaults now reference these positions (RESTRICT FK) — clear them first; no employment
    // exists yet at this point in the fixture, so there is nothing fanned out to clean up too.
    await sql`delete from position_capability_defaults where org_id = ${boot.orgId}`;
    await sql`delete from positions where org_id = ${boot.orgId}`;
    const [storePos] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical) values (${boot.orgId}, ${boot.storeId}, 'Legacy Cashier', false) returning id`;
    await sql`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
      values (${boot.orgId}, ${storePos!.id}, ${boot.storeId}, 'record_sale', ${boot.personId})`;
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${boot.orgId}, 'Worker 5b') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, adminActor, {
        storeId: boot.storeId,
        personId: worker!.id,
        employmentStatus: 'probationary',
        startedOn: '2026-09-24',
        positionIds: [storePos!.id],
        primaryPositionId: storePos!.id,
      }),
    );

    const snapshotDefaults = () => sql<{ id: string; position_id: string; store_id: string; capability: string; revoked_at: string | null }[]>`
      select id, position_id, store_id, capability, revoked_at from position_capability_defaults
      where org_id = ${boot.orgId} order by id`;
    const snapshotGrants = () => sql<{ id: string; person_id: string; grant_name: string; source_ref: string | null; revoked_at: string | null }[]>`
      select id, person_id, grant_name, source_ref, revoked_at from person_grants
      where person_id = ${worker!.id} order by id`;

    const beforeDefaults = await snapshotDefaults();
    const beforeGrants = await snapshotGrants();
    expect(beforeDefaults.length).toBeGreaterThan(0);
    expect(beforeGrants.length).toBeGreaterThan(0);

    const { backfillOrgPositions } = await loadBackfill();
    await systemTransaction((tx) => backfillOrgPositions(tx, { id: boot.orgId, name: INPUT.name }));

    expect(await snapshotDefaults()).toEqual(beforeDefaults);
    expect(await snapshotGrants()).toEqual(beforeGrants);
  });
});

// -------------------------------------------------------------------------------------
// T6 / T6b
// -------------------------------------------------------------------------------------

describe('T6 — tenancy: seeding org A writes nothing into org B', () => {
  it('two orgs, each exactly 6, every row org-scoped to its own org', async () => {
    // createOrganization, not bootstrapOrganization — bootstrap refuses a second call the moment
    // ANY organization exists (first-run-setup.test.ts case 3), so it cannot make two orgs in one
    // test. createOrganization carries no such restriction; that is the whole point of tenancy.
    const a = await systemTransaction((tx) => createOrganization(tx, { code: uid('T6A'), name: 'T6 Org A' }));
    const b = await systemTransaction((tx) => createOrganization(tx, { code: uid('T6B'), name: 'T6 Org B' }));

    expect(await countPositions(a.orgId)).toBe(6);
    expect(await countPositions(b.orgId)).toBe(6);

    const rows = await sql<{ org_id: string }[]>`
      select org_id from positions where org_id in (${a.orgId}, ${b.orgId})`;
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.org_id === a.orgId || r.org_id === b.orgId)).toBe(true);
  });
});

describe('T6b — the picker source shows the six for a NEW store created after the org', () => {
  it('employmentRepo.listPositions for a second store returns the six, set-equal', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T6b') }));
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };

    const secondStore = await withOrgPrincipal(boot.orgId, (tx) =>
      createStore(tx, adminActor, { code: uid('T6bS').slice(0, 10), name: 'Second Store' }),
    );

    const rows = await withOrgPrincipal(boot.orgId, (tx) =>
      employmentRepo.listPositions(tx, boot.orgId, secondStore.storeId),
    );
    expect([...rows.map((r) => r.name)].sort()).toEqual([...CANONICAL_POSITIONS].sort());
  });
});

// -------------------------------------------------------------------------------------
// T7 — the backfill reports a collision and changes nothing about it.
// -------------------------------------------------------------------------------------

describe('T7 — the backfill reports a collision and changes nothing about it', () => {
  it('org with 0 canonical rows plus a store-scoped Server: 6 inserted, collision named by store code and position id, row unchanged', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('T7') }));
    // T-336: bootstrap's own 38 ruled defaults reference these positions (RESTRICT FK) — clear
    // them first, same fix as T5b.
    await sql`delete from position_capability_defaults where org_id = ${boot.orgId}`;
    await sql`delete from positions where org_id = ${boot.orgId}`;
    const [storeRow] = await sql<{ code: string }[]>`select code from stores where id = ${boot.storeId}`;
    const [collider] = await sql<{ id: string; store_id: string; is_active: boolean }[]>`
      insert into positions (org_id, store_id, name, is_canonical) values (${boot.orgId}, ${boot.storeId}, 'Server', false)
      returning id, store_id, is_active`;

    const { backfillOrgPositions } = await loadBackfill();
    const result = await systemTransaction((tx) => backfillOrgPositions(tx, { id: boot.orgId, name: INPUT.name }));

    expect(result.inserted).toBe(6);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatchObject({ storeCode: storeRow!.code, positionId: collider!.id, name: 'Server' });

    const [after] = await sql<{ id: string; store_id: string; is_active: boolean }[]>`
      select id, store_id, is_active from positions where id = ${collider!.id}`;
    expect(after).toEqual({ id: collider!.id, store_id: collider!.store_id, is_active: collider!.is_active });
    expect(await countPositions(boot.orgId)).toBe(7); // 6 canonical + the untouched collider
  });
});
