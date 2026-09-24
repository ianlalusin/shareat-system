/**
 * T-336 auto-role delta (Ian, 2026-09-24, approved) — a hire with no existing role gets `staff`
 * automatically. Cases a-d.
 *
 * ⛔ Originally written as a data-level MUTANT/FIXED simulation because the builder was wiring
 * `createEmployment` in parallel and a normal red-before-green sequence would race. Mid-session the
 * real guard landed in `packages/domain/src/people/index.ts:121-128` (check-first via
 * `accessRepo.activeRoleForPerson`, then `accessRepo.insertRole`) — so every case below now asserts
 * the REAL behavior directly. The manual "FIXED (simulated)" `insertRole` calls were deleted: they
 * now double-insert against the real auto-assignment and 23505. Where a naive-unconditional
 * contrast is still useful (cases b, d) it is kept as an explicit, clearly-labeled "what the guard
 * prevents" call to `accessRepo.insertRole` made AFTER the real hire, never inside it.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, accessRepo } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { bootstrapOrganization } from '../../src/organizations';
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

const INPUT = { code: 'T336R', name: 'T336 Role Co', adminDisplayName: 'Admin', storeCode: 'MAIN', storeName: 'Main', pin: '135790' };

const activeRole = async (personId: string, orgId: string) => {
  const rows = await sql<{ role: string }[]>`select role from person_roles where person_id = ${personId} and org_id = ${orgId} and revoked_at is null`;
  return rows;
};

describe('(a) a hire with no role gets exactly one active staff role, grantedBy the hiring actor', () => {
  it('createEmployment auto-assigns staff, granted by the hiring actor', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('A1') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'W') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    const rows = await sql<{ role: string; granted_by: string }[]>`select role, granted_by from person_roles where person_id = ${worker!.id} and org_id = ${boot.orgId} and revoked_at is null`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ role: 'staff', granted_by: adminActor.personId });
  });
});

describe('(b) NEGATIVE: a person already holding admin/manager keeps exactly that role, no staff added', () => {
  it('hiring the org admin as a store employee leaves their role untouched at admin', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('B1') }));
    // The bootstrap admin themself, also hired as a store employee — a real "owner also works
    // shifts" shape. Their role is already 'admin' before this hire.
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: boot.personId, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    const rows = await activeRole(boot.personId, boot.orgId);
    expect(rows).toEqual([{ role: 'admin' }]);
  });

  it('contrast: the naive-unconditional insertRole this guard replaces 23505s against an already-active role', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('B2') }));
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: boot.personId, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    // The real hire above already ran the GUARDED insert (and correctly skipped it, since admin
    // was already active). This is the naive, unconditional version the guard must not be.
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => accessRepo.insertRole(tx, { personId: boot.personId, orgId: boot.orgId, role: 'staff', grantedBy: adminActor.personId })),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

/** Grants a capability directly on whatever position the hire already resolved to (Server, for a
 *  blank hire) — NOT `grantEverydayPositionAccess`, which mints a NEW ad-hoc position and tries to
 *  make it primary, colliding with `employment_positions_one_primary_unique` against the position
 *  `createEmployment` already assigned (own bug, found by running: first draft used the fixture
 *  and hit exactly that collision, then cascaded into two timeouts in case (d) via a stuck lock). */
async function grantOnExistingPrimaryPosition(args: { orgId: string; storeId: string; personId: string; setBy: string; capability: string }) {
  const [primary] = await sql<{ position_id: string }[]>`
    select ep.position_id from employment_positions ep
    join employments e on e.id = ep.employment_id
    where e.person_id = ${args.personId} and ep.is_primary = true`;
  const [def] = await sql<{ id: string }[]>`
    insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
    values (${args.orgId}, ${primary!.position_id}, ${args.storeId}, ${args.capability}, ${args.setBy}) returning id`;
  await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, source_ref) values (${args.personId}, ${args.capability}, ${args.setBy}, 'position', ${def!.id})`;
}

describe('(c) a hired Cashier passes authorize for a ruled capability once staffed; a Server is refused one it lacks', () => {
  // Amendment, orchestrator 2026-09-24: the hire ALSO grants person_store_scope for the hired
  // store only (builder wiring in parallel — same race as the role guard). No manual scope
  // insert below; these assert the ruled behavior directly.
  it('hire alone grants store scope at the hired store — no manual scope insert, capability passes', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('C1') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Cashier-ish') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await grantOnExistingPrimaryPosition({ orgId: boot.orgId, storeId: boot.storeId, personId: worker!.id, setBy: boot.personId, capability: 'record_sale' });
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId }))).resolves.toBeUndefined();
  });

  it('refused at a second store the hire never scoped', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('C2') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Cashier-ish') returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${boot.orgId}, ${uid('stb')}, 'Store B') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await grantOnExistingPrimaryPosition({ orgId: boot.orgId, storeId: boot.storeId, personId: worker!.id, setBy: boot.personId, capability: 'record_sale' });
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: storeB!.id })),
      'the hire scoped only boot.storeId; storeB was never granted',
    ).rejects.toThrow(/no store scope/);
  });

  it('refused for a capability the position never granted, even with hire-granted store scope', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('C3') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Cashier-ish') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await grantOnExistingPrimaryPosition({ orgId: boot.orgId, storeId: boot.storeId, personId: worker!.id, setBy: boot.personId, capability: 'record_sale' });
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'void_sales_day', { storeId: boot.storeId })),
      'refused for a capability never granted to this position',
    ).rejects.toThrow(AuthorizationError);
  });

  it('mutation check: revoking exactly the hire-granted scope row reproduces the refusal the scope line prevents', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('C4') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Cashier-ish') returning id`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await grantOnExistingPrimaryPosition({ orgId: boot.orgId, storeId: boot.storeId, personId: worker!.id, setBy: boot.personId, capability: 'record_sale' });
    const workerActor: Actor = { personId: worker!.id, orgId: boot.orgId };
    await expect(withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId }))).resolves.toBeUndefined();
    // Simulate the scope line's absence by removing exactly what it wrote — never touching
    // people/index.ts itself.
    await withOrgPrincipal(boot.orgId, (tx) => accessRepo.revokeStoreScope(tx, worker!.id, boot.storeId));
    await expect(
      withOrgPrincipal(boot.orgId, (tx) => authorize(tx, workerActor, 'record_sale', { storeId: boot.storeId })),
      'MUTANT quoted: without the hire-time scope grant, the same ruled capability is refused for no store scope',
    ).rejects.toThrow(/no store scope/);
  });
});

describe('(d) a second hire of the same person does not duplicate the role', () => {
  it('real behavior at the second store does not double-insert; the naive-unconditional call this guard replaces 23505s', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('D1') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Twice Hired') returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${boot.orgId}, ${uid('stb')}, 'Store B') returning id`;
    // storeB was raw-inserted, bypassing createStore's admin-scope fan-out — the admin needs scope
    // here to be authorized to hire at all (own fixture gap, not a builder bug).
    await sql`insert into person_store_scope (person_id, store_id, source) values (${boot.personId}, ${storeB!.id}, 'manual')`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await expect(
      withOrgPrincipal(boot.orgId, async (tx) => {
        // Real code: guarded, sees worker's existing active role, does not insert again — succeeds.
        await createEmployment(tx, adminActor, { storeId: storeB!.id, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' });
        // The naive, unconditional version the guard must not be.
        await accessRepo.insertRole(tx, { personId: worker!.id, orgId: boot.orgId, role: 'staff', grantedBy: adminActor.personId });
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('real behavior: a second hire at a different store leaves exactly one active staff role', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('D2') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Twice Hired') returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${boot.orgId}, ${uid('stb')}, 'Store B') returning id`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${boot.personId}, ${storeB!.id}, 'manual')`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: boot.storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    await withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId: storeB!.id, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    expect(await activeRole(worker!.id, boot.orgId)).toEqual([{ role: 'staff' }]);
  });

  it('audit item 4: two genuinely concurrent hires of the same person, two stores, never surface a raw 23505', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('D3') }));
    const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${boot.orgId}, 'Concurrent Hire') returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${boot.orgId}, ${uid('stb')}, 'Store B') returning id`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${boot.personId}, ${storeB!.id}, 'manual')`;
    const adminActor: Actor = { personId: boot.personId, orgId: boot.orgId };

    const hireAt = (storeId: string) =>
      withOrgPrincipal(boot.orgId, (tx) => createEmployment(tx, adminActor, { storeId, personId: worker!.id, employmentStatus: 'probationary', startedOn: '2026-09-24' }));
    const results = await Promise.allSettled([hireAt(boot.storeId), hireAt(storeB!.id)]);

    const raw23505 = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String((r.reason as { message?: string })?.message ?? r.reason))
      .filter((msg) => /23505|duplicate key/i.test(msg));
    expect(raw23505, `createEmployment's check-then-insert auto-role guard is not race-safe: ${JSON.stringify(raw23505)}`).toEqual([]);

    const rows = await activeRole(worker!.id, boot.orgId);
    expect(rows, 'exactly one active role survives regardless of which hire "won"').toHaveLength(1);
  });
});
