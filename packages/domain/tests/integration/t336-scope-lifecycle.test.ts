/**
 * T-336 — SCOPE LIFECYCLE (auditor finding 1, RULED 2026-09-24, Opus judgement, orchestrator).
 * `docs/tasks/336-per-position-access-defaults.md`'s own "SCOPE LIFECYCLE" section: Fix A,
 * migration `0156`. `person_store_scope.source` ∈ {employment, manual, fan_out}, NOT NULL.
 * `endEmployment` deletes the row only when `source='employment'` AND no other open employment
 * exists at that store. `manual` always wins a conflict, including over an `employment` row.
 *
 * ⛔ Written against the ruled spec while this is landing in parallel (same posture as the
 * auto-role/store-scope deltas earlier in T-336): as of this write, the schema column and the
 * `accessRepo.grantStoreScope`/`findStoreScope`/`deleteStoreScopeById` primitives exist, but
 * migration `0156` itself is not yet generated/applied to this lane DB, and `endEmployment`
 * (`packages/domain/src/people/index.ts`) does not yet call the deletion decision. Expect RED on
 * "column source does not exist" until the migration lands + this lane DB is remigrated, then RED
 * on the deletion assertions until `endEmployment` is wired — report both, don't fix either.
 *
 * Case 3's second clause ("keeps A too if another open employment remains at A") is read here as
 * the two-store scenario's own store-A branch, restated — `employments_open_person_store_unique`
 * (0080) makes a SECOND open employment at the SAME store impossible, so there is no separate
 * same-store scenario to construct. Flagged to the orchestrator; will revise if that's wrong.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, accessRepo } from '@shareat/db';
import { authorize, assignRoleAsActor, AuthorizationError, type Actor } from '@shareat/auth';
import { bootstrapOrganization } from '../../src/organizations';
import { createStore } from '../../src/stores/service';
import { createEmployment, endEmployment } from '../../src/people';

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

const INPUT = { code: 'T336L', name: 'T336 Lifecycle Co', adminDisplayName: 'Admin', storeCode: 'MAIN', storeName: 'Main', pin: '135790' };

const scopeSource = async (personId: string, storeId: string) => {
  const [row] = await sql<{ source: string }[]>`select source from person_store_scope where person_id = ${personId} and store_id = ${storeId}`;
  return row?.source;
};
const hasScope = async (personId: string, storeId: string) => (await scopeSource(personId, storeId)) !== undefined;

async function hire(orgId: string, actor: Actor, storeId: string, personId: string, positionIds?: string[]) {
  return withOrgPrincipal(orgId, (tx) =>
    createEmployment(tx, actor, { storeId, personId, employmentStatus: 'probationary', startedOn: '2026-09-24', positionIds, primaryPositionId: positionIds?.[0] }),
  );
}
async function terminate(orgId: string, actor: Actor, employmentId: string) {
  return withOrgPrincipal(orgId, (tx) => endEmployment(tx, actor, { employmentId, endedOn: '2026-09-25', employmentStatus: 'terminated' }));
}

describe('1 — termination refuses sign-in and store-scoped authorize at the terminated store', () => {
  it('scope at A is gone; authorize throws "no store scope"', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L1') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W1') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const employment = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await hasScope(worker!.id, boot.storeId)).toBe(true);
    // Isolate scope from capability: a MANUAL grant (grantSource='grant'), not a position default
    // — endEmployment's pre-existing T-289 revocation only touches grantSource='position' rows
    // (`positionDefaultsRepo.heldPositionGrantsForPersonAtStore`), so this survives termination
    // and the only thing that can refuse it afterward is the missing store-scope row.
    await withOrgPrincipal(boot.orgId, (tx) =>
      accessRepo.grantCapability(tx, { personId: worker!.id, grantName: 'record_wastage', grantedBy: boot.personId, grantSource: 'grant' }),
    );

    await terminate(boot.orgId, adminActor, employment.id);

    expect(await hasScope(worker!.id, boot.storeId), 'terminated: the employment-sourced scope row must be gone').toBe(false);
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_wastage', { storeId: boot.storeId })),
      'the manual grant is still held (never revoked) — only the missing store scope can refuse this',
    ).rejects.toThrow(/no store scope/);
  });
});

describe('2 — hire at A, terminate, hire at B as Cashier: authorised at B, refused at A', () => {
  it('the new store carries the live scope; the old one carries none', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L2') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W2') returning id`;
    const [cashierA] = await sql<{ id: string }[]>`select id from positions where org_id = ${boot.orgId} and name = 'Cashier'`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const storeB = await withOrgPrincipal(boot.orgId, (tx) => createStore(tx, adminActor, { code: uid('L2b').slice(0, 10), name: 'Store B' }));

    const empA = await hire(boot.orgId, adminActor, boot.storeId, worker!.id, [cashierA!.id]);
    await terminate(boot.orgId, adminActor, empA.id);
    const [cashierB] = await sql<{ id: string }[]>`select id from positions where org_id = ${boot.orgId} and name = 'Cashier'`;
    await hire(boot.orgId, adminActor, storeB.storeId, worker!.id, [cashierB!.id]);

    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: storeB.storeId })),
      'authorised at B — the live hire',
    ).resolves.toBeUndefined();
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId })),
      'refused at A — the terminated one',
    ).rejects.toThrow(/no store scope/);
  });
});

describe('3 — two open employments at two stores: terminating A removes A only, B survives', () => {
  it('scope at A is gone; scope at B, still open, is untouched', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L3') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W3') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const storeB = await withOrgPrincipal(boot.orgId, (tx) => createStore(tx, adminActor, { code: uid('L3b').slice(0, 10), name: 'Store B' }));

    const empA = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    await hire(boot.orgId, adminActor, storeB.storeId, worker!.id);
    expect(await hasScope(worker!.id, boot.storeId)).toBe(true);
    expect(await hasScope(worker!.id, storeB.storeId)).toBe(true);

    await terminate(boot.orgId, adminActor, empA.id);

    expect(await hasScope(worker!.id, boot.storeId), 'A: no other open employment there — removed').toBe(false);
    expect(await hasScope(worker!.id, storeB.storeId), 'B: still open — untouched').toBe(true);
  });
});

describe('4 — an admin/manager with a manual or fan_out row and no employment is untouched by any endEmployment', () => {
  it("the bootstrap admin's fan_out-sourced scope survives a different person's termination at the same store", async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L4') }));
    const adminSourceBefore = await scopeSource(boot.personId, boot.storeId);
    expect(adminSourceBefore, 'the founding admin has no employment — their scope is the createStore fan-out').toBe('fan_out');

    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W4') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const empWorker = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    await terminate(boot.orgId, adminActor, empWorker.id);

    expect(await scopeSource(boot.personId, boot.storeId), "the admin's own row must be untouched by someone else's termination").toBe('fan_out');
  });
});

describe('5 — provenance: a manual grant always wins, in either order', () => {
  it('(a) an admin grant AFTER a hire flips the row to manual, and it survives termination', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L5A') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W5a') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const employment = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await scopeSource(worker!.id, boot.storeId)).toBe('employment');

    await withOrgPrincipal(boot.orgId, (tx) => accessRepo.grantStoreScope(tx, { personId: worker!.id, storeId: boot.storeId, grantedBy: boot.personId, source: 'manual' }));
    expect(await scopeSource(worker!.id, boot.storeId), 'a manual grant flips provenance, even over an existing employment row').toBe('manual');

    await terminate(boot.orgId, adminActor, employment.id);
    expect(await hasScope(worker!.id, boot.storeId), 'source is manual, not employment — endEmployment must not delete it').toBe(true);
  });

  it('(b) a hire AFTER an admin grant leaves the row manual, untouched', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L5B') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W5b') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };

    await withOrgPrincipal(boot.orgId, (tx) => accessRepo.grantStoreScope(tx, { personId: worker!.id, storeId: boot.storeId, grantedBy: boot.personId, source: 'manual' }));
    expect(await scopeSource(worker!.id, boot.storeId)).toBe('manual');

    await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await scopeSource(worker!.id, boot.storeId), "employment/fan_out never overwrite an existing row of any source — it stays manual").toBe('manual');
  });
});

describe('6 — a rehire at A writes the row again', () => {
  it('after termination removes the row, a fresh hire at A creates a new employment-sourced row', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L6') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W6') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const first = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    await terminate(boot.orgId, adminActor, first.id);
    expect(await hasScope(worker!.id, boot.storeId), 'removed by termination').toBe(false);

    await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await scopeSource(worker!.id, boot.storeId), 'rehire writes a fresh employment-sourced row').toBe('employment');
  });
});

describe('7 — the column is NOT NULL, CHECK-constrained, and defaults to manual', () => {
  it('information_schema confirms NOT NULL and the DEFAULT; a raw insert without source lands as manual', async () => {
    // Round 1's version truncated the table in beforeEach and asserted "no null source" — vacuously
    // true on an empty table (own bug, caught by the auditor). Asserts the CONSTRAINTS instead.
    const [col] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'person_store_scope' and column_name = 'source'`;
    expect(col?.is_nullable, 'source must be NOT NULL').toBe('NO');
    expect(String(col?.column_default ?? ''), "source must DEFAULT 'manual'").toContain('manual');

    const [check] = await sql<{ n: number }[]>`
      select count(*)::int n from information_schema.check_constraints
      where constraint_name = 'person_store_scope_source_check'`;
    expect(check!.n, 'the CHECK constraint must exist').toBe(1);

    const [org] = await sql<{ id: string }[]>`insert into organizations (code, name) values (${uid('L7')}, 'L7 Co') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'L7 Person') returning id`;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid('l7s')}, 'L7 Store') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${person!.id}, ${store!.id})`;
    const [row] = await sql<{ source: string }[]>`select source from person_store_scope where person_id = ${person!.id} and store_id = ${store!.id}`;
    expect(row?.source, 'a raw insert with no source column lands as the DEFAULT').toBe('manual');
  });
});

describe('8 — promotion to admin, then termination: scope at the hired store remains', () => {
  it('hire at A, promote to admin (fan-out), end the employment: scope at A survives', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L8') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W8') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    const employment = await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await scopeSource(worker!.id, boot.storeId)).toBe('employment');

    await withOrgPrincipal(boot.orgId, (tx) => assignRoleAsActor(tx, adminActor, { personId: worker!.id, role: 'admin' }));

    await terminate(boot.orgId, adminActor, employment.id);

    expect(
      await hasScope(worker!.id, boot.storeId),
      'a promoted admin\'s access should not evaporate when their original hire ends — quoted, not assumed',
    ).toBe(true);
  });
});

describe('9 — an admin\'s explicit toggle overrides provenance', () => {
  it('unticking an employed person\'s store removes it even with an open employment; re-ticking restores it as manual', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('L9') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W9') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await hire(boot.orgId, adminActor, boot.storeId, worker!.id);
    expect(await hasScope(worker!.id, boot.storeId)).toBe(true);

    // No domain wrapper exists yet for this admin action (`access.ts`'s own note: the app layer
    // calls the accessRepo primitives directly) — this IS the primitive the un-tick action calls.
    await withOrgPrincipal(boot.orgId, (tx) => accessRepo.revokeStoreScope(tx, worker!.id, boot.storeId));
    expect(await hasScope(worker!.id, boot.storeId), "the admin's explicit act removes it, employment still open or not").toBe(false);

    await withOrgPrincipal(boot.orgId, (tx) => accessRepo.grantStoreScope(tx, { personId: worker!.id, storeId: boot.storeId, grantedBy: boot.personId, source: 'manual' }));
    expect(await scopeSource(worker!.id, boot.storeId), 're-ticking is a fresh explicit grant — manual, not employment').toBe('manual');
  });
});
