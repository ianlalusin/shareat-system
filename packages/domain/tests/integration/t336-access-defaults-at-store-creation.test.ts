/**
 * T-336 — I1-I8. `docs/tasks/336-per-position-access-defaults.md` §8, ruled by
 * PROPOSAL-DEF-413 + its Amendment (2026-09-24): 38 rows, Server/Dishwasher = {F1, F3}, every
 * new store (including a later branch), existing defaults byte-identical.
 *
 * House style matches T-335's own integration file: `systemTransaction` for anything that creates
 * an org, `withOrgPrincipal` for anything after, raw `postgres` for direct row assertions.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, positionDefaultsRepo, employmentRepo } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { CANONICAL_POSITION_DEFAULTS, seedStoreAccessDefaults } from '@shareat/domain';
import { bootstrapOrganization, createFirstAdmin, createOrganization } from '../../src/organizations';
import { createStore } from '../../src/stores/service';
import { createEmployment } from '../../src/people';

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
  code: 'T336',
  name: 'T336 Co',
  adminDisplayName: 'T336 Admin',
  storeCode: 'MAIN',
  storeName: 'Main Store',
  pin: '135790',
};

const TOTAL_RULED = 38;

const activeDefaultsByPosition = async (storeId: string) => {
  const rows = await sql<{ name: string; capability: string }[]>`
    select p.name, d.capability from position_capability_defaults d
    join positions p on p.id = d.position_id
    where d.store_id = ${storeId} and d.revoked_at is null`;
  const byName: Record<string, string[]> = {};
  for (const r of rows) (byName[r.name] ??= []).push(r.capability);
  for (const name of Object.keys(byName)) byName[name]!.sort();
  return byName;
};

const oracleSorted = () =>
  Object.fromEntries(Object.entries(CANONICAL_POSITION_DEFAULTS).map(([k, v]) => [k, [...v].sort()]));

// -------------------------------------------------------------------------------------
// I1
// -------------------------------------------------------------------------------------

describe('I1 — a fresh org\'s store holds exactly the ruled table', () => {
  it('per-position active capability set matches the oracle; accessDefaultsSeeded === 38 === count(*)', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I1') }));
    expect((boot as unknown as { accessDefaultsSeeded: number }).accessDefaultsSeeded).toBe(TOTAL_RULED);

    const byName = await activeDefaultsByPosition(boot.storeId);
    expect(byName).toEqual(oracleSorted());

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int n from position_capability_defaults where store_id = ${boot.storeId} and revoked_at is null`;
    expect(row!.n).toBe(TOTAL_RULED);

    const setByIds = await sql<{ set_by: string }[]>`
      select distinct set_by from position_capability_defaults where store_id = ${boot.storeId}`;
    expect(setByIds).toHaveLength(1);
    expect(setByIds[0]!.set_by).toBe(boot.personId);
  });
});

// -------------------------------------------------------------------------------------
// I2
// -------------------------------------------------------------------------------------

describe('I2 — a Cashier can do its 18 and not the rest', () => {
  it('authorize passes for all 18; refused for R5/R6/F4 AND for the 4 beyond the 21', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I2') }));
    const [cashier] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${boot.orgId} and name = 'Cashier'`;
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${boot.orgId}, 'Cashier Worker') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, adminActor, {
        storeId: boot.storeId,
        personId: worker!.id,
        employmentStatus: 'probationary',
        startedOn: '2026-09-24',
        positionIds: [cashier!.id],
        primaryPositionId: cashier!.id,
      }),
    );
    // T-336 auto-role delta: createEmployment now auto-assigns 'staff', so a manual insertRole
    // here would 23505 against person_roles_active_person_org_unique. Assert it happened instead.
    const [role] = await sql<{ role: string }[]>`
      select role from person_roles where person_id = ${worker!.id} and org_id = ${boot.orgId} and revoked_at is null`;
    expect(role?.role, 'createEmployment should auto-assign an active role').toBe('staff');
    // T-336 store-scope amendment: createEmployment now also grants person_store_scope for the
    // hired store, so a manual insert here would 23505. Assert it happened instead.
    const scoped = await sql<{ id: string }[]>`
      select id from person_store_scope where person_id = ${worker!.id} and store_id = ${boot.storeId}`;
    expect(scoped, 'createEmployment should grant store scope for the hired store').toHaveLength(1);
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };

    for (const capability of CANONICAL_POSITION_DEFAULTS.Cashier) {
      await expect(
        withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, capability, { storeId: boot.storeId })),
        `Cashier should hold ${capability}`,
      ).resolves.toBeUndefined();
    }

    const refused = [
      'record_customer_return',
      'create_wholesale_order',
      'request_pos_map',
      'void_sales_day',
      'void_statutory_discount',
      'refund_customer',
      'record_ar_collection',
    ] as const;
    for (const capability of refused) {
      await expect(
        withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, capability, { storeId: boot.storeId })),
        `Cashier should NOT hold ${capability}`,
      ).rejects.toThrow(AuthorizationError);
    }
  });
});

// -------------------------------------------------------------------------------------
// I3
// -------------------------------------------------------------------------------------

describe('I3 — a blank hire (Server) gets exactly {record_stock_movement, record_wastage}', () => {
  it('position grants set-equal the oracle; record_sale and submit_sales_day refused', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I3') }));
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${boot.orgId}, 'Blank Hire') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, adminActor, {
        storeId: boot.storeId,
        personId: worker!.id,
        employmentStatus: 'probationary',
        startedOn: '2026-09-24',
      }),
    );

    const grants = await sql<{ grant_name: string }[]>`
      select grant_name from person_grants where person_id = ${worker!.id} and grant_source = 'position'`;
    expect([...grants.map((g) => g.grant_name)].sort()).toEqual([...CANONICAL_POSITION_DEFAULTS.Server].sort());

    // T-336 auto-role delta — see I2's own note.
    const [role] = await sql<{ role: string }[]>`
      select role from person_roles where person_id = ${worker!.id} and org_id = ${boot.orgId} and revoked_at is null`;
    expect(role?.role, 'createEmployment should auto-assign an active role').toBe('staff');
    // T-336 store-scope amendment — see I2's own note.
    const scoped = await sql<{ id: string }[]>`
      select id from person_store_scope where person_id = ${worker!.id} and store_id = ${boot.storeId}`;
    expect(scoped, 'createEmployment should grant store scope for the hired store').toHaveLength(1);
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_stock_movement', { storeId: boot.storeId })),
    ).resolves.toBeUndefined();
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_wastage', { storeId: boot.storeId })),
    ).resolves.toBeUndefined();
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId })),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'submit_sales_day', { storeId: boot.storeId })),
    ).rejects.toThrow(AuthorizationError);
  });
});

// -------------------------------------------------------------------------------------
// I4
// -------------------------------------------------------------------------------------

describe('I4 — virgin-store guard and idempotence', () => {
  it('(a) calling seedStoreAccessDefaults again on the bootstrapped store throws; row count unchanged', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I4A') }));
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };

    await expect(
      withOrgPrincipal(boot.orgId, (tx) => seedStoreAccessDefaults(tx, adminActor, boot.storeId)),
    ).rejects.toThrow();

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int n from position_capability_defaults where store_id = ${boot.storeId} and revoked_at is null`;
    expect(row!.n).toBe(TOTAL_RULED);
  });

  it('(b) the repo insert called twice directly: inserted 38 then 0', async () => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (code, name) values (${uid('I4B')}, 'I4b Co') returning id`;
    const orgId = org!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store') returning id`;
    await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    const [cashier] = await sql<{ id: string }[]>`select id from positions where org_id = ${orgId} and name = 'Cashier'`;

    const pairs = CANONICAL_POSITION_DEFAULTS.Cashier.map((capability) => ({ positionId: cashier!.id, capability }));
    const first = await systemTransaction((tx) =>
      positionDefaultsRepo.insertDefaultsForNewStore(tx, { orgId, storeId: store!.id, setBy: admin!.id, pairs }),
    );
    expect(first.inserted).toBe(pairs.length);
    const second = await systemTransaction((tx) =>
      positionDefaultsRepo.insertDefaultsForNewStore(tx, { orgId, storeId: store!.id, setBy: admin!.id, pairs }),
    );
    expect(second.inserted).toBe(0);
  });
});

// -------------------------------------------------------------------------------------
// I5
// -------------------------------------------------------------------------------------

describe('I5 — existing defaults are byte-identical (ruling item 2)', () => {
  it('an 0152-shaped store (S1) is untouched by a second org\'s bootstrap or a same-org second store; S2 holds exactly the ruled table', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I5') }));
    // 0152's shape: all 21 EVERYDAY capabilities, for every canonical position, at S1 — raw, not
    // through seedStoreAccessDefaults (S1 already got the ruled 38 from bootstrap; this ADDS the
    // legacy all-21 shape on top to model production's pre-existing state at cutover... instead,
    // to model 0152 precisely, clear S1 first and raw-insert the legacy shape).
    await sql`delete from position_capability_defaults where store_id = ${boot.storeId}`;
    const positions = await sql<{ id: string; name: string }[]>`select id, name from positions where org_id = ${boot.orgId}`;
    const EVERYDAY = [
      'record_sale', 'submit_sales_day', 'record_statutory_discount', 'record_till_count', 'create_expense',
      'edit_own_expense', 'record_stock_movement', 'record_wastage', 'transfer_stock', 'record_supplier_return',
      'record_customer_return', 'confirm_receipt', 'set_item_threshold', 'post_order_message', 'place_branch_order',
      'fulfil_branch_order', 'receive_delivery', 'record_supplier_invoice', 'create_wholesale_order',
      'record_order_wastage', 'request_pos_map',
    ];
    for (const p of positions) {
      for (const capability of EVERYDAY) {
        await sql`
          insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
          values (${boot.orgId}, ${p.id}, ${boot.storeId}, ${capability}, ${boot.personId})`;
      }
    }
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'S1 Holder') returning id`;
    const [server] = positions.filter((p) => p.name === 'Server');
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) =>
      createEmployment(tx, adminActor, {
        storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24',
        positionIds: [server!.id], primaryPositionId: server!.id,
      }),
    );

    const snapshotDefaults = () => sql<{ id: string; position_id: string; store_id: string; capability: string; set_by: string; set_at: string; revoked_at: string | null }[]>`
      select id, position_id, store_id, capability, set_by, set_at::text, revoked_at from position_capability_defaults where store_id = ${boot.storeId} order by id`;
    const snapshotGrants = () => sql<{ id: string; person_id: string; grant_name: string; grant_source: string | null; source_ref: string | null; revoked_at: string | null }[]>`
      select id, person_id, grant_name, grant_source, source_ref, revoked_at from person_grants where person_id = ${worker!.id} order by id`;
    const beforeDefaults = await snapshotDefaults();
    const beforeGrants = await snapshotGrants();
    expect(beforeDefaults.length).toBeGreaterThan(0);

    // A second org's bootstrap, and a second store in the SAME org.
    const boot2 = await systemTransaction((tx) => createOrganization(tx, { code: uid('I5B'), name: 'I5 Org B' }));
    expect(boot2.orgId).toBeTruthy();
    const secondStore = await withOrgPrincipal(boot.orgId, (tx) => createStore(tx, adminActor, { code: uid('I5S2').slice(0, 10), name: 'Second' }));
    expect(await activeDefaultsByPosition(secondStore.storeId)).toEqual(oracleSorted());

    // Re-seeding S1 must throw and change nothing.
    await expect(withOrgPrincipal(boot.orgId, (tx) => seedStoreAccessDefaults(tx, adminActor, boot.storeId))).rejects.toThrow();

    expect(await snapshotDefaults()).toEqual(beforeDefaults);
    expect(await snapshotGrants()).toEqual(beforeGrants);
  });
});

// -------------------------------------------------------------------------------------
// I6
// -------------------------------------------------------------------------------------

describe('I6 — tenancy', () => {
  it('two orgs, 38 rows each, every row scoped to its own org and its own position', async () => {
    // bootstrapOrganization refuses a second call once ANY org exists (first-run-setup.test.ts
    // case 3) — same fix as T-335's own T6. Org A via bootstrap; org B built manually through the
    // same three domain calls bootstrap itself makes (createOrganization + createFirstAdmin +
    // createStore), a "bootstrap-equivalent path".
    const a = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I6A') }));

    const bOrg = await systemTransaction((tx) => createOrganization(tx, { code: uid('I6B'), name: 'I6 Org B' }));
    const bAdmin = await systemTransaction((tx) => createFirstAdmin(tx, { orgId: bOrg.orgId, displayName: 'I6B Admin' }));
    const bActor: Actor = { personId: bAdmin.personId, orgId: bOrg.orgId };
    const bStore = await withOrgPrincipal(bOrg.orgId, (tx) =>
      createStore(tx, bActor, { code: uid('I6Bs').slice(0, 10), name: 'I6B Store' }),
    );
    const b = { orgId: bOrg.orgId, storeId: bStore.storeId };

    for (const boot of [{ orgId: a.orgId, storeId: a.storeId }, b]) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int n from position_capability_defaults where store_id = ${boot.storeId} and revoked_at is null`;
      expect(row!.n).toBe(TOTAL_RULED);
    }

    const rows = await sql<{ org_id: string; position_id: string }[]>`
      select d.org_id, d.position_id from position_capability_defaults d where d.org_id in (${a.orgId}, ${b.orgId})`;
    expect(rows).toHaveLength(TOTAL_RULED * 2);
    const aPositionIds = new Set((await sql<{ id: string }[]>`select id from positions where org_id = ${a.orgId}`).map((r) => r.id));
    const bPositionIds = new Set((await sql<{ id: string }[]>`select id from positions where org_id = ${b.orgId}`).map((r) => r.id));
    for (const r of rows) {
      if (r.org_id === a.orgId) expect(aPositionIds.has(r.position_id), 'org A row must point at org A\'s own position').toBe(true);
      if (r.org_id === b.orgId) expect(bPositionIds.has(r.position_id), 'org B row must point at org B\'s own position').toBe(true);
    }
  });
});

// -------------------------------------------------------------------------------------
// I7
// -------------------------------------------------------------------------------------

describe('I7 — atomicity', () => {
  it('a failure after createStore leaves zero defaults for that org', async () => {
    let capturedOrgId: string | undefined;
    await expect(
      systemTransaction(async (tx) => {
        const boot = await bootstrapOrganization(tx, { ...INPUT, code: uid('I7') });
        capturedOrgId = boot.orgId;
        throw new Error('injected failure, inside the same transaction');
      }),
    ).rejects.toThrow(/injected failure/);

    expect(capturedOrgId).toBeTruthy();
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int n from position_capability_defaults where org_id = ${capturedOrgId!}`;
    expect(row!.n).toBe(0);
  });
});

// -------------------------------------------------------------------------------------
// I8
// -------------------------------------------------------------------------------------

describe('I8 — a later store gets them, and a positionless org gets none quietly', () => {
  it('(a) a second store created after bootstrap gets exactly the ruled table', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('I8A') }));
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const secondStore = await withOrgPrincipal(boot.orgId, (tx) =>
      createStore(tx, adminActor, { code: uid('I8AS2').slice(0, 10), name: 'Second Branch' }),
    );
    expect(await activeDefaultsByPosition(secondStore.storeId)).toEqual(oracleSorted());
  });

  it('(b) a raw org with 0 canonical rows: createStore succeeds, seeds 0, missingCanonical lists all six', async () => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (code, name) values (${uid('I8B')}, 'I8b Co') returning id`;
    const orgId = org!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
    const adminActor: Actor = { personId: admin!.id, orgId };

    const store = await withOrgPrincipal(orgId, (tx) => createStore(tx, adminActor, { code: uid('I8Bs').slice(0, 10), name: 'No Positions' }));
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from position_capability_defaults where store_id = ${store.storeId}`;
    expect(row!.n).toBe(0);
    expect([...(store as unknown as { missingCanonical: string[] }).missingCanonical].sort()).toEqual(
      [...['Cashier', 'Kitchen Staff', 'Server', 'Dishwasher', 'Slicer', 'Inventory Staff']].sort(),
    );
  });
});

// -------------------------------------------------------------------------------------
// I9 — audit item 2
// -------------------------------------------------------------------------------------

describe('I9 — a case-drifted canonical row still matches its ruled defaults', () => {
  it('a lowercase "cashier" org-wide row still yields Cashier defaults, not missingCanonical', async () => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (code, name) values (${uid('I9')}, 'I9 Co') returning id`;
    const orgId = org!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
    await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    // The DB's own uniqueness treats name case-insensitively (`lower(trim(name))`, 0080), and
    // `findPositionByName` matches the same way — a case-drifted row (data drift, or a raw
    // fixture) is a real, reachable shape this function must not silently treat as missing.
    await sql`update positions set name = 'cashier' where org_id = ${orgId} and name = 'Cashier'`;
    const adminActor: Actor = { personId: admin!.id, orgId };

    const store = await withOrgPrincipal(orgId, (tx) => createStore(tx, adminActor, { code: uid('I9s').slice(0, 10), name: 'I9 Store' }));
    const result = store as unknown as { missingCanonical: string[] };
    expect(result.missingCanonical, 'a case-drifted Cashier row should still match — not report missing').not.toContain('Cashier');

    const [cashier] = await sql<{ id: string }[]>`select id from positions where org_id = ${orgId} and lower(name) = 'cashier'`;
    const rows = await sql<{ capability: string }[]>`
      select capability from position_capability_defaults where store_id = ${store.storeId} and position_id = ${cashier!.id} and revoked_at is null`;
    expect([...rows.map((r) => r.capability)].sort()).toEqual([...CANONICAL_POSITION_DEFAULTS.Cashier].sort());
  });
});

// -------------------------------------------------------------------------------------
// I10 — audit item 3
// -------------------------------------------------------------------------------------

describe('I10 — an org missing SOME canonical positions reports exactly the missing ones, seeds the rest', () => {
  it('missingCanonical names only the absent position; the other five still get their ruled rows', async () => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (code, name) values (${uid('I10')}, 'I10 Co') returning id`;
    const orgId = org!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
    await systemTransaction((tx) => employmentRepo.seedCanonical(tx, orgId));
    // Simulates an org T-335's backfill hasn't fully reached — one canonical row missing, not all six.
    await sql`delete from positions where org_id = ${orgId} and name = 'Slicer'`;
    const adminActor: Actor = { personId: admin!.id, orgId };

    const store = await withOrgPrincipal(orgId, (tx) => createStore(tx, adminActor, { code: uid('I10s').slice(0, 10), name: 'I10 Store' }));
    const result = store as unknown as { missingCanonical: string[]; accessDefaultsSeeded: number };
    expect(result.missingCanonical).toEqual(['Slicer']);
    expect(result.accessDefaultsSeeded).toBe(TOTAL_RULED - CANONICAL_POSITION_DEFAULTS.Slicer.length);

    const byName = await activeDefaultsByPosition(store.storeId);
    const expectedWithoutSlicer = { ...oracleSorted() } as Record<string, string[]>;
    delete expectedWithoutSlicer.Slicer;
    expect(byName).toEqual(expectedWithoutSlicer);
  });
});
