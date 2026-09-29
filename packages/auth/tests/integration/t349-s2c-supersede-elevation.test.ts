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

/** S2e (E1/E2) — a real barrier, not a sleep: poll until some backend is blocked SPECIFICALLY BY
 * the lock-holding connection (`holderPid = ANY(pg_blocking_pids(pid))`), never a looser
 * `wait_event_type = 'Lock'` + query-text match — that would also match an unrelated backend
 * blocked on a different lock that merely still has `person_grants` in its last query text. Being
 * blocked BY THIS HOLDER is DB-side proof the SUT's SELECT already ran and reached its own UPDATE
 * — the ONLY statement in `grantCapability`'s person-level "existing" branch that touches an
 * existing row; the same-rank no-op branch returns before ever executing one (§4c item 1). A
 * 300ms sleep only made that likely; this makes it certain, regardless of machine load. Asserts
 * exactly one such backend — more than one means something else is also contending.
 *
 * S2e audit F4 — `sutPromise` races the poll: if the SUT rejects (or resolves) before it is ever
 * observed blocked, that surfaces as ITSELF immediately, not as a `timeoutMs`-later "timed out"
 * error that would hide the real failure behind an unrelated one. `Promise.race` still attaches a
 * handler to the losing side internally, so this never produces an unhandled rejection when the
 * poll wins normally.
 *
 * S2e audit F7 — `timeoutMs` derived from this file's own `testTimeout`/`hookTimeout` budget
 * (`vitest.config.mts:107,122`, both 30s): 20s leaves headroom for the rest of the leg (the
 * revoke/insert/commit and assertions after the barrier fires) inside that ceiling, where the old
 * 5s default was an arbitrary number unrelated to it.
 */
async function waitUntilBlockedByHolder(
  holderPid: number,
  sutPromise: Promise<unknown>,
  timeoutMs = 20_000,
): Promise<{ pid: number; query: string }> {
  const sutRace: Promise<never> = sutPromise.then(
    () => {
      throw new Error('the SUT settled (resolved) before its blocked state was ever observed — the barrier never fired');
    },
    (err) => {
      throw err;
    },
  );
  const poll = (async (): Promise<{ pid: number; query: string }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query
        from pg_stat_activity
        where datname = current_database()
          and ${holderPid} = any(pg_blocking_pids(pid))`;
      if (rows.length > 1) {
        throw new Error(`expected exactly one backend blocked by pid ${holderPid}, found ${rows.length}: ${JSON.stringify(rows)}`);
      }
      const [row] = rows;
      if (row) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for a backend blocked by holder pid ${holderPid}`);
  })();
  return Promise.race([poll, sutRace]);
}

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
        const [pidRow] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!pidRow) throw new Error('pg_backend_pid() returned no row');
        const connPid = pidRow.pid;
        await conn`select id from person_grants where id = ${seededId} for update`;

        // `accessRepo.grantCapability` directly (like E8) — its return carries `id`, which
        // `grantCapabilityAsActor` does not; D2 needs the loser's OWN returned id to prove the
        // re-select ran, not just the final DB state.
        const sutPromise = asOrg(f.orgId, (tx) =>
          accessRepo.grantCapability(tx, { personId: f.targetId, grantName: CAP, grantedBy: f.adminId, grantSource: 'grant' }),
        );
        // S2e (E2) — the barrier IS the distinguishing assertion. `grantCapability`'s same-rank
        // no-op branch returns before ever executing an UPDATE, so a blocked UPDATE on
        // `person_grants` can only be THIS call's "upgraded" arm reaching its own revoke — proof
        // it already committed to that branch before the winner row (inserted below) exists.
        // `result.id === winner.id` alone cannot tell that arm from the same-rank no-op: if the
        // SUT's SELECT ran late enough to see the winner itself as "existing" (same rank as the
        // input), it takes the no-op path and still returns the winner's id.
        const blocked = await waitUntilBlockedByHolder(connPid, sutPromise);
        expect(blocked.query, `unexpected blocked backend: ${blocked.query}`).toMatch(/update[\s\S]*person_grants/i);

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
        // S2e audit F1 — a failed leg above (e.g. the barrier throwing) left `finally` releasing an
        // OPEN transaction back to the max:5 pool. That leaked FOR-UPDATE lock then blocked every
        // later leg's own row lock until the pool starved. Roll back first, always.
        await conn`rollback`.catch(() => {});
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
        const [pidRow] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!pidRow) throw new Error('pg_backend_pid() returned no row');
        const connPid = pidRow.pid;
        await conn`select id from person_grants where id = ${seededId} for update`;

        const sutPromise = asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP }));
        // S2e (E1) — a real barrier: poll until the SUT's own backend is actually WAITING on the
        // row lock this connection holds, proving its SELECT already ran and it reached its own
        // UPDATE (the branch this leg pins) before the concurrent revoke below lands. A 300ms
        // sleep only made that likely; this makes it certain.
        const blocked = await waitUntilBlockedByHolder(connPid, sutPromise);
        expect(blocked.query, `unexpected blocked backend: ${blocked.query}`).toMatch(/update[\s\S]*person_grants/i);

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
        // S2e audit F1 — same leak as E7's: roll back the open transaction before releasing the
        // connection back to the max:5 pool.
        await conn`rollback`.catch(() => {});
        conn.release();
      }
    },
    30000,
  );
});

describe('E10 (S2e, spec §4e item E3) — restored: two real concurrent callers, no manual barrier (⛔ smoke, not a mutation-catcher — see the it() title)', () => {
  it(
    '⛔ SMOKE, not a mutation-catcher (S2e audit F3) — both fulfil, exactly one active row, exactly one revoked row, exactly one wrote:true. Measured: removing access.ts\'s onConflictDoNothing (:783-786) left this GREEN 8/8 runs even with `expect(rejected).toEqual([])` — natural concurrency here reliably serialises before either caller reaches the INSERT, so the ON CONFLICT arm this leg was meant to force is never actually exercised. It still exercises genuine unmanufactured concurrency through the connection pool, which the deterministic E7/E9 barriers above deliberately do not — that is the leg\'s real, remaining value.',
    async () => {
      const f = await fixture('e10');
      await seedRow(f.targetId, CAP, 'elevation', f.thirdId, PAST);

      const results = await Promise.allSettled([
        asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP })),
        asOrg(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.targetId, capability: CAP })),
      ]);

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      // S2e audit F3 — `.not.toContain('23505')` alone pins nothing: it is satisfied by an EMPTY
      // rejected array just as much as by one with a different code in it, so it never actually
      // asserts "no rejection at all". A real ON CONFLICT DO NOTHING never throws either way.
      expect(rejected, 'no rejection at all — a real ON CONFLICT DO NOTHING never throws').toEqual([]);

      const active = await activeRows(f.targetId, CAP);
      expect(active.length, 'exactly one active row').toBe(1);
      expect(active[0]!.grant_source).toBe('grant');

      const allRows = await sql<RowShape[]>`
        select id, grant_source, store_id, granted_by, granted_at, revoked_at, revoke_reason
        from person_grants where person_id = ${f.targetId} and grant_name = ${CAP}`;
      const revoked = allRows.filter((r) => r.revoked_at !== null);
      expect(revoked.length, 'wanted: exactly one revoked row (the seeded one)').toBe(1);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof grantCapabilityAsActor>>> => r.status === 'fulfilled',
      );
      const wroteTrueCount = fulfilled.filter((r) => r.value.wrote).length;
      expect(wroteTrueCount, 'wanted: exactly one call reports wrote:true').toBe(1);
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
