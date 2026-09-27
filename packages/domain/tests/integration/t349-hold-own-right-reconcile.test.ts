import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-349 / DEF-456 S2 — `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §4 (C1-C4).
 * Real Postgres (bible §9 rule 3). Proves the hand grant (`'grant'`, store-scoped) and the job
 * grant (`'position'`) are independent: reconcile only ever sees `'position'` rows
 * (`heldPositionGrantsForPersonAtStore` filters `grant_source = 'position'`), and because the
 * per-store slot is split by source (T-349 S1), a re-inserted `'position'` row coexists with the
 * `'grant'` row at the same store.
 *
 * ⛔ TESTER, not BUILDER. S2 is now built and every leg below is green; a "was red before T-349 S2"
 * note records the pre-S2 failure this leg originally pinned.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { accessRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, grantCapabilityAsActor, type Actor } from '@shareat/auth';
import type { GrantCapabilityAsActorInput } from '../../../auth/src/roles';
import { createEmployment, endEmployment, seedCanonicalPositions, setPositionDefault } from '@shareat/domain';
// ⛔ `reconcilePositionGrants` itself is NEVER imported here — `tests/unit/position-defaults-
// callers.test.ts` (T-289 §C11) is a closed-importer list of exactly 5 files and this is not one
// of them. C3/C4 drive it exclusively through the public `setPositionDefault` entry point, which
// fans out to it internally (`position-defaults.ts` step 6 / `reconcileHolders`).

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
const CAP = 'confirm_receipt' as const;

async function fixture(hint: string) {
  const code = uid(`t349c-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`T349C Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}a`)}, 'Store A') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}b`)}, 'Store B') returning id`;
  const storeAId = a!.id;
  const storeBId = b!.id;

  const [adminPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = adminPerson!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeAId}, 'manual')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeBId}, 'manual')`;
  const admin = actor(orgId, adminId);

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [cashier] = await sql<{ id: string }[]>`select id from positions where org_id = ${orgId} and store_id is null and name = 'Cashier'`;
  const cashierId = cashier!.id;

  await asOrg(orgId, (tx) => setPositionDefault(tx, admin, { positionId: cashierId, storeId: storeAId, capability: CAP, on: true }));

  const [staffPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('staff')}) returning id`;
  const staffId = staffPerson!.id;
  // Independent of the employment, on purpose — T-336/migration 0156 deletes an 'employment'-
  // sourced person_store_scope row once no open employment justifies it (endEmployment in C1
  // below). A 'manual' row survives that (setStoreScopeAction's own comment: "a human explicitly
  // ticking this box must survive that hire ending"). Without this, C1's authorize() check would
  // fail on the SCOPE axis, not the grant axis — testing the wrong rule.
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staffId}, ${storeAId}, 'manual')`;
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, {
      storeId: storeAId,
      personId: staffId,
      employmentStatus: 'probationary',
      startedOn: '2026-01-05',
      positionIds: [cashierId],
      primaryPositionId: cashierId,
    }),
  );

  const [positionRow] = await sql<{ id: string }[]>`
    select id from person_grants
    where person_id = ${staffId} and grant_name = ${CAP} and grant_source = 'position' and revoked_at is null`;

  return { orgId, storeAId, storeBId, admin, adminId, staff: actor(orgId, staffId), staffId, cashierId, employmentId: employment.id, positionGrantId: positionRow!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function holdOwnRight(tx: Tx, byActor: Actor, input: GrantCapabilityAsActorInput): Promise<void> {
  await grantCapabilityAsActor(tx, byActor, input);
}

async function activeGrantRows(personId: string, grantName: string) {
  return sql<{ id: string; grant_source: string | null; store_id: string | null; revoked_at: string | null }[]>`
    select id, grant_source, store_id, revoked_at from person_grants
    where person_id = ${personId} and grant_name = ${grantName} and revoked_at is null`;
}

describe('C1 — reconcile: hold at A, then end the Cashier employment at A', () => {
  it(
    "the position row is revoked; the hand grant survives, store-scoped at A (was red before T-349 S2: it was NULL-store, not store-scoped, so it still counted as a survivor either way, just not the right one)",
    async () => {
      const f = await fixture('c1');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      await asOrg(f.orgId, (tx) => endEmployment(tx, f.admin, { employmentId: f.employmentId, endedOn: '2026-02-01', employmentStatus: 'resigned' }));

      const rows = await sql<{ grant_source: string | null; store_id: string | null; revoked_at: string | null }[]>`
        select grant_source, store_id, revoked_at from person_grants where person_id = ${f.staffId} and grant_name = ${CAP}`;
      const position = rows.find((r) => r.grant_source === 'position');
      expect(position?.revoked_at, 'the position row must be revoked once the employment ends').not.toBeNull();

      const activeGrant = rows.find((r) => r.grant_source === 'grant' && r.revoked_at === null);
      expect(activeGrant, 'the hand grant must still be active after the employment ends').toBeDefined();
      expect(activeGrant?.store_id, "was red before T-349 S2: the hold wrote a NULL-store row, not store A").toBe(f.storeAId);

      await expect(asOrg(f.orgId, (tx) => authorize(tx, f.staff, CAP, { storeId: f.storeAId }))).resolves.toBeUndefined();
    },
    30000,
  );
});

describe('C2 — hold at A, default off, default on again: the position row and the grant row coexist', () => {
  it(
    'one new active position row at A beside the grant row; no 23505; no second grant row',
    async () => {
      const f = await fixture('c2');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      await asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: CAP, on: false }));

      await expect(
        asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: CAP, on: true })),
        'turning the default back on must not surface a raw 23505',
      ).resolves.toBeDefined();

      const rows = await activeGrantRows(f.staffId, CAP);
      const positionRows = rows.filter((r) => r.grant_source === 'position');
      const grantRows = rows.filter((r) => r.grant_source === 'grant');
      expect(positionRows, 'exactly one active position row at A').toHaveLength(1);
      expect(positionRows[0]!.store_id).toBe(f.storeAId);
      expect(grantRows, 'exactly one active grant row — no second one from the reconcile').toHaveLength(1);
    },
    30000,
  );
});

describe('C3 (⛔ green now — a guard, not a defect proof) — reconciling store B never touches store A or the hand grant', () => {
  it(
    "toggling the Cashier default at B (the person's second, real employment there) writes nothing at A and leaves the hand grant untouched",
    async () => {
      const f = await fixture('c3');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const beforeA = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.store_id === f.storeAId || r.store_id === null);

      // A genuinely second employment at B — reconciling a store the person has no position at
      // would prove nothing (`openEmploymentPersonIdsForPosition` would simply skip them).
      await asOrg(f.orgId, (tx) =>
        createEmployment(tx, f.admin, {
          storeId: f.storeBId,
          personId: f.staffId,
          employmentStatus: 'probationary',
          startedOn: '2026-01-05',
          positionIds: [f.cashierId],
          primaryPositionId: f.cashierId,
        }),
      );
      // The only public entry point that fans out to `reconcilePositionGrants` — see the header
      // note on why this file never imports that primitive directly.
      await asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeBId, capability: CAP, on: true }));

      const afterA = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.store_id === f.storeAId || r.store_id === null);
      expect(afterA, 'store A / the NULL-store hand grant must be byte-identical after a B-only reconcile').toEqual(beforeA);
      expect(afterA.some((r) => r.grant_source === 'grant'), 'the hand grant must still be active').toBe(true);

      const bRows = await activeGrantRows(f.staffId, CAP);
      expect(bRows.some((r) => r.grant_source === 'position' && r.store_id === f.storeBId), 'the fan-out must have actually run at B').toBe(true);
    },
    30000,
  );
});

describe('C4 — re-enabling the default at A actually (re-)grants the capability, not suppressed by the hand grant', () => {
  it(
    "setPositionDefault's own fan-out count and the resulting row both show a real grant, not a no-op",
    async () => {
      const f = await fixture('c4');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      await asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: CAP, on: false }));

      const beforePosition = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.grant_source === 'position');
      expect(beforePosition, 'default is off: no active position row at A').toHaveLength(0);

      const fanout = await asOrg(f.orgId, (tx) =>
        setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: CAP, on: true }),
      );
      expect(fanout.affected, 'the holder is reported as affected — a capability was actually (re-)granted').toBeGreaterThan(0);

      const afterPosition = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.grant_source === 'position');
      expect(afterPosition, 'exactly one new active position row at A').toHaveLength(1);
      expect(afterPosition[0]!.store_id).toBe(f.storeAId);

      const grantRow = (await activeGrantRows(f.staffId, CAP)).find((r) => r.grant_source === 'grant');
      expect(grantRow, "the hand grant is untouched — it isn't what suppressed the position grant").toBeDefined();
    },
    30000,
  );
});
