import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-349 S2c (DEF-456), finding 1 — `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §4c,
 * legs E1-E8. Ian's Q2 ruling (2026-09-28): "close and replace" — a hand-grant that outranks an
 * existing person-level row REVOKES the old row (with a fixed reason) and INSERTS a fresh one,
 * same transaction, rather than T-248's re-tag-in-place.
 *
 * ⛔ TESTER, not BUILDER. `grantCapability`'s person-level "existing" arm
 * (`packages/db/src/repo/access.ts` ~:726-744) still does `UPDATE person_grants SET grant_source =
 * ... WHERE id = existing.id` — `granted_by`/`granted_at` never move, and no row is ever revoked.
 * Every red below is that gap; the same-rank/guard legs are already correct today because they
 * never reach the UPDATE at all.
 *
 * Fixture (spec's own, "the TESTER names it"): an org with an active admin (the actor); a target
 * person with a RAW-INSERTED `manager` role (never `assignRole` — the elevation row itself is
 * seeded directly per case, so each leg controls its shape exactly); a third person (the seeded
 * grantor); `manage_fixed_assets` — org-scoped, `CAPABILITY_MATRIX.manager` is `false`
 * (`packages/auth/src/capabilities.ts:937`), so `authorize` for the target depends on the grant
 * row alone. The seeded row is a raw INSERT with an explicit past `granted_at`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { accessRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { assignRole, authorize, grantCapabilityAsActor, type Actor } from '@shareat/auth';
import { createEmployment, seedCanonicalPositions, setPositionDefault } from '@shareat/domain';

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

const CAP = 'manage_fixed_assets' as const;
const REASON = 'Replaced by a hand grant of the same capability.';

async function fixture(hint: string) {
  const code = uid(`t349s2c-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store A') returning id`;
  const storeId = store!.id;

  const [adminPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = adminPerson!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeId}, 'manual')`;
  const admin = actor(orgId, adminId);

  const [targetPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('target')}) returning id`;
  const targetId = targetPerson!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${targetId}, ${orgId}, 'manager')`;

  const [thirdPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Third Person') returning id`;
  const thirdId = thirdPerson!.id;

  return { orgId, storeId, admin, adminId, targetId, thirdId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedRow(
  personId: string,
  grantName: string,
  grantSource: string | null,
  grantedBy: string | null,
  grantedAt: Date,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by, granted_at)
    values (${personId}, ${grantName}, ${grantSource}, null, ${grantedBy}, ${grantedAt})
    returning id`;
  return row!.id;
}

interface RowShape {
  id: string;
  grant_source: string | null;
  store_id: string | null;
  granted_by: string | null;
  granted_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

async function activeRows(personId: string, grantName: string): Promise<RowShape[]> {
  return sql<RowShape[]>`
    select id, grant_source, store_id, granted_by, granted_at, revoked_at, revoke_reason
    from person_grants where person_id = ${personId} and grant_name = ${grantName} and revoked_at is null`;
}

async function rowById(id: string): Promise<RowShape> {
  const [row] = await sql<RowShape[]>`
    select id, grant_source, store_id, granted_by, granted_at, revoked_at, revoke_reason
    from person_grants where id = ${id}`;
  return row!;
}

const PAST = new Date('2020-01-01T00:00:00Z');

describe('E1 — a hand-grant over a seeded elevation row (granted_by = a third person)', () => {
  it(
    'supersedes: one active "grant" row (granted_by = actor), the seeded row revoked with the named reason, no gap — was red today: active row keeps granted_by = third person, no revoked row',
    async () => {
      const f = await fixture('e1');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);

      const result = await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

      const active = await activeRows(f.targetId, CAP);
      expect(active.length, 'exactly one active NULL-store row').toBe(1);
      const row = active[0]!;
      expect(row.grant_source).toBe('grant');
      expect(row.granted_by, 'wanted: the acting admin — was red: still the third person').toBe(f.adminId);
      expect(row.store_id).toBeNull();
      expect(row.granted_at.getTime(), 'wanted: after the seeded past date').toBeGreaterThan(PAST.getTime());

      const seeded = await rowById(seededId);
      expect(seeded.revoked_at, 'wanted: the seeded row is revoked — was red: never revoked').not.toBeNull();
      expect(seeded.revoke_reason).toBe(REASON);
      expect(seeded.granted_by, "the seeded row's own history stays untouched").toBe(f.thirdId);
      expect(seeded.granted_at.getTime()).toBe(PAST.getTime());
      expect(seeded.grant_source, "the seeded row's own grant_source stays 'elevation' — the NEW row carries 'grant'").toBe('elevation');
      expect(seeded.revoked_at!.getTime(), 'no gap on record: revoked_at equals the new row\'s granted_at').toBe(row.granted_at.getTime());

      expect(result.wrote).toBe(true);
      expect(result.heldEverywhere).toBe(true);
    },
  );
});

describe('E2 — the seeded row has granted_by NULL', () => {
  it(
    'same target as E1 — was red today: active row keeps granted_by NULL',
    async () => {
      const f = await fixture('e2');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', null, PAST);

      const result = await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

      const active = await activeRows(f.targetId, CAP);
      expect(active.length).toBe(1);
      const row = active[0]!;
      expect(row.grant_source).toBe('grant');
      expect(row.granted_by, 'wanted: the acting admin — was red: still NULL').toBe(f.adminId);

      const seeded = await rowById(seededId);
      expect(seeded.revoked_at).not.toBeNull();
      expect(seeded.revoke_reason).toBe(REASON);
      expect(seeded.granted_by).toBeNull();
      expect(result.wrote).toBe(true);
    },
  );
});

describe('E3 — the same supersede via the org-scoped hold path (positionGrantId given)', () => {
  async function orgCapFixture(hint: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) => seedCanonicalPositions(tx, f.orgId));
    const [cashier] = await sql<{ id: string }[]>`select id from positions where org_id = ${f.orgId} and store_id is null and name = 'Cashier'`;
    const cashierId = cashier!.id;
    await asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: cashierId, storeId: f.storeId, capability: CAP, on: true }));
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: f.targetId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
        positionIds: [cashierId],
        primaryPositionId: cashierId,
      }),
    );
    const [positionRow] = await sql<{ id: string }[]>`
      select id from person_grants
      where person_id = ${f.targetId} and grant_name = ${CAP} and grant_source = 'position' and revoked_at is null`;
    return { ...f, positionGrantId: positionRow!.id };
  }

  it(
    'as E1, plus storeName null (manage_fixed_assets is org-scoped — no store to name) — was red today: same as E1',
    async () => {
      const f = await orgCapFixture('e3');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);

      const result = await asOrg(f.orgId, (tx) =>
        grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP, positionGrantId: f.positionGrantId }),
      );

      const active = await activeRows(f.targetId, CAP);
      const supersedeRow = active.find((r) => r.store_id === null);
      expect(supersedeRow, 'the supersede lands on the NULL-store row, distinct from the position row').toBeDefined();
      expect(supersedeRow!.grant_source).toBe('grant');
      expect(supersedeRow!.granted_by, 'wanted: the acting admin — was red: still the third person').toBe(f.adminId);

      const seeded = await rowById(seededId);
      expect(seeded.revoked_at, 'was red: never revoked').not.toBeNull();
      expect(seeded.revoke_reason).toBe(REASON);

      expect(result.wrote).toBe(true);
      expect(result.heldEverywhere).toBe(true);
      expect(result.storeName, 'org-scoped: no store to name').toBeNull();
    },
  );
});

describe('E4 — the seeded row has grant_source NULL (a pre-0140 row)', () => {
  it(
    'as E1, same reason literal — was red today: no revoked row',
    async () => {
      const f = await fixture('e4');
      const seededId = await seedRow(f.targetId, CAP, null, f.thirdId, PAST);

      await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

      const active = await activeRows(f.targetId, CAP);
      expect(active.length).toBe(1);
      expect(active[0]!.grant_source).toBe('grant');

      const seeded = await rowById(seededId);
      expect(seeded.revoked_at, 'was red: a NULL-source row was never revoked either').not.toBeNull();
      expect(seeded.revoke_reason, 'the reason literal is the same regardless of the old source').toBe(REASON);
    },
  );
});

describe('E5 (⛔ guard, green today and after) — authorize is unaffected, and the new row survives the admin-arrival sweep', () => {
  it('authorize resolves identically before and after the grant, and the sweep revokes nothing of the target\'s', async () => {
    const f = await fixture('e5');
    await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);
    const target = actor(f.orgId, f.targetId);

    await expect(asOrg(f.orgId, (tx) => authorize(tx, target, CAP, {}))).resolves.toBeUndefined();

    await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

    await expect(asOrg(f.orgId, (tx) => authorize(tx, target, CAP, {}))).resolves.toBeUndefined();

    const newAdminPerson = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Second Admin') returning id`;
    const newAdminId = newAdminPerson[0]!.id;
    const sweep = await asOrg(f.orgId, (tx) => assignRole(tx, { personId: newAdminId, orgId: f.orgId, role: 'admin', grantedBy: f.adminId }));
    expect(
      sweep.revokedElevatedGrants.some((g) => g.personId === f.targetId && g.grantName === CAP),
      'the target\'s row is no longer sweepable — the sweep must not touch it',
    ).toBe(false);

    await expect(asOrg(f.orgId, (tx) => authorize(tx, target, CAP, {}))).resolves.toBeUndefined();
    const active = await activeRows(f.targetId, CAP);
    expect(active.length, 'still exactly one active row after the sweep').toBe(1);
  });
});

describe('E6 (⛔ guard, green today and after) — same-rank calls never write', () => {
  it('over an active "grant" row: wrote:false, no new row, no revoke', async () => {
    const f = await fixture('e6grant');
    const seededId = await seedRow(f.targetId, CAP, 'grant', f.adminId, PAST);

    const result = await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

    const active = await activeRows(f.targetId, CAP);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(seededId);
    expect(result.wrote).toBe(false);
    expect(result.heldEverywhere).toBe(true);
  });

  it('over an active "owner" row: wrote:false, no new row, no revoke', async () => {
    const f = await fixture('e6owner');
    const seededId = await seedRow(f.targetId, CAP, 'owner', f.adminId, PAST);

    const result = await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

    const active = await activeRows(f.targetId, CAP);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(seededId);
    expect(result.wrote).toBe(false);
  });

  it('a sequential double-click right after E1\'s supersede: the second call is a no-op over the new "grant" row', async () => {
    const f = await fixture('e6double');
    await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);
    await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));
    const afterFirst = await activeRows(f.targetId, CAP);
    expect(afterFirst.length).toBe(1);

    const second = await asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));

    const afterSecond = await activeRows(f.targetId, CAP);
    expect(afterSecond.length, 'no new row from the double-click').toBe(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
    expect(second.wrote).toBe(false);
  });
});

describe('E7 (S2d, D2 — made deterministic) — the ON CONFLICT arm is actually reached, not just serialisation luck', () => {
  it(
    "a real concurrent winner is inserted while the SUT's own UPDATE is blocked on a row lock; the SUT then loses on the unique index for real and returns the WINNER's id — was red before S2c: a raw 23505 either way",
    async () => {
      const f = await fixture('e7');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);

      // ⚠️ A plain `Promise.allSettled` of two SUT calls cannot tell a real interleaving from pure
      // serialisation (S2d, D2): if the first call fully commits before the second's own SELECT
      // even runs, the second sees the ALREADY-superseded 'grant' row and takes the same-rank
      // no-op branch at the top — never reaching the INSERT/ON CONFLICT code at all. Holding a
      // real row lock on a second, manually-driven connection forces the SUT to reach its own
      // UPDATE while the row is still 'elevation', then — while it is blocked — a real competing
      // writer inserts the winning row, so the SUT's later INSERT is GUARANTEED to hit the unique
      // index for real, not by chance.
      const conn = await sql.reserve();
      try {
        await conn`begin`;
        await conn`select id from person_grants where id = ${seededId} for update`;

        // `accessRepo.grantCapability` directly (like E8) — its return carries `id`, which
        // `grantCapabilityAsActor` does not; D2 needs the loser's OWN returned id to prove the
        // re-select ran, not just the final DB state.
        const sutPromise = asOrg(f.orgId, (tx) =>
          accessRepo.grantCapability(tx, { personId: f.targetId, grantName: CAP, grantedBy: f.adminId, grantSource: 'grant' }),
        );
        await new Promise((r) => setTimeout(r, 300));

        await conn`update person_grants set revoked_at = now(), revoke_reason = ${accessRepo.SUPERSEDED_BY_HAND_GRANT_REASON} where id = ${seededId} and revoked_at is null`;
        const [winner] = await conn<{ id: string }[]>`
          insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
          values (${f.targetId}, ${CAP}, 'grant', null, ${f.adminId}) returning id`;
        await conn`commit`;

        const result = await sutPromise;
        expect(result.wrote, "the SUT lost the race for real — it must not claim it wrote").toBe(false);
        expect(result.heldEverywhere).toBe(true);
        expect(result.id, "wanted: the WINNER's id — proves the ON CONFLICT re-select ran, not a guess").toBe(winner!.id);

        const active = await activeRows(f.targetId, CAP);
        expect(active.length, "exactly one active row (the winner's)").toBe(1);
        expect(active[0]!.id).toBe(winner!.id);
      } finally {
        conn.release();
      }
    },
    30000,
  );
});

describe('E9 (S2d, D1) — a concurrent revoke lands between the SELECT and the UPDATE: the call still inserts', () => {
  it(
    'exactly one active "grant" row, wrote:true — pins §4c item 1.2\'s "0 rows must NOT return early" rule, which no prior leg forced (a mutant adding `if (revoked.length === 0) return {..., wrote:false}` kept all 472 tests green)',
    async () => {
      const f = await fixture('e9');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);

      const conn = await sql.reserve();
      try {
        await conn`begin`;
        await conn`select id from person_grants where id = ${seededId} for update`;

        const sutPromise = asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));
        // Give the SUT's own (non-locking) SELECT time to complete and its own UPDATE time to
        // reach and block on the row lock this connection holds.
        await new Promise((r) => setTimeout(r, 300));

        // The barrier: a REAL concurrent revoke, landing exactly between the SUT's SELECT and its
        // own UPDATE — by the time this connection releases the lock, the SUT's UPDATE (`WHERE
        // revoked_at IS NULL`) will affect 0 rows.
        await conn`update person_grants set revoked_at = now(), revoke_reason = 'concurrent revoke (E9 barrier)' where id = ${seededId} and revoked_at is null`;
        await conn`commit`;

        const result = await sutPromise;
        expect(result.wrote, 'wanted: true — the SUT must not bail out just because its own UPDATE affected 0 rows').toBe(true);
        expect(result.heldEverywhere).toBe(true);

        const active = await activeRows(f.targetId, CAP);
        expect(active.length, 'exactly one active row').toBe(1);
        expect(active[0]!.grant_source).toBe('grant');

        const seeded = await rowById(seededId);
        expect(seeded.revoked_at, 'revoked by the barrier — the SUT\'s own UPDATE hit 0 rows').not.toBeNull();
        expect(seeded.revoke_reason).toBe('concurrent revoke (E9 barrier)');
      } finally {
        conn.release();
      }
    },
    30000,
  );
});

describe('E8 — atomicity: a failing INSERT rolls back its own revoke', () => {
  it(
    'grantedBy an FK-invalid uuid: the call rejects, and the seeded elevation row is still active — was red today: the call resolves (the UPDATE never touches granted_by)',
    async () => {
      const f = await fixture('e8');
      const seededId = await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);
      const bogusPersonId = randomUUID();

      await expect(
        asOrg(f.orgId, (tx) =>
          accessRepo.grantCapability(tx, { personId: f.targetId, grantName: CAP, grantedBy: bogusPersonId, grantSource: 'grant' }),
        ),
        'wanted: the call rejects (FK violation on the INSERT) — was red: it resolves',
      ).rejects.toThrow();

      const seeded = await rowById(seededId);
      expect(seeded.revoked_at, 'the failed insert must roll back the revoke too — same tx').toBeNull();
      expect(seeded.grant_source).toBe('elevation');
    },
  );
});
