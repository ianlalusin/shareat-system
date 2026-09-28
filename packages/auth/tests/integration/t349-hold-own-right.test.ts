import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-349 / DEF-456 S2 — `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §4 (H1-H9).
 * Real Postgres (bible §9 rule 3); real `authorize()` throughout. S2 is now built and every leg
 * below is green; every "was red before T-349 S2" note records the pre-S2 failure this leg
 * originally pinned.
 *
 * ⛔ TESTER, not BUILDER. Before T-349 S2, `GrantCapabilityAsActorInput` had no `positionGrantId`
 * field, and `grantCapability`/`grantCapabilityAsActor` returned only `{id}`/`void`. Both are now
 * real (`roles.ts:533`, `:586`), so `holdOwnRight` below calls `grantCapabilityAsActor` directly.
 *
 * Fixture: org, stores A and B, admin actor, Cashier position with the `confirm_receipt` default
 * ON at A (store-scoped — `capabilities.ts:435`), a staff person hired at A (materialises a
 * `'position'`-sourced grant at A) with manual scope also granted at B.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { accessRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, grantCapabilityAsActor, type Actor } from '@shareat/auth';
// `GrantCapabilityAsActorInput` is not re-exported from the `@shareat/auth` barrel (only
// `AssignRole*` types are) — imported directly from its own module.
import type { GrantCapabilityAsActorInput } from '../../src/roles';
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

async function fixture(hint: string) {
  const code = uid(`t349-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`T349 Org ${code}`}, ${code}) returning id`;
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

  await asOrg(orgId, (tx) => setPositionDefault(tx, admin, { positionId: cashierId, storeId: storeAId, capability: 'confirm_receipt', on: true }));

  const [staffPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('staff')}) returning id`;
  const staffId = staffPerson!.id;
  await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, {
      storeId: storeAId,
      personId: staffId,
      employmentStatus: 'probationary',
      startedOn: '2026-01-05',
      positionIds: [cashierId],
      primaryPositionId: cashierId,
    }),
  );
  // Scope at B without a job there — the staff person can be checked at B, but holds no position
  // (hence no default) there. Matches the spec's own fixture: "staff target with scope at A and B".
  await asOrg(orgId, (tx) => accessRepo.grantStoreScope(tx, { personId: staffId, storeId: storeBId, grantedBy: adminId, source: 'manual' }));

  const [positionRow] = await sql<{ id: string }[]>`
    select id from person_grants
    where person_id = ${staffId} and grant_name = 'confirm_receipt' and grant_source = 'position' and revoked_at is null`;

  return { orgId, storeAId, storeBId, admin, adminId, staff: actor(orgId, staffId), staffId, cashierId, positionGrantId: positionRow!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const CAP = 'confirm_receipt' as const;

// Before T-349 S2, `GrantCapabilityAsActorInput` had no `positionGrantId` field and
// `grantCapabilityAsActor` returned `void` — every call here went through a WIDENING cast. Both
// are now real (`roles.ts:533`, `:586`), so this file calls the function directly.
async function holdOwnRight(tx: Tx, byActor: Actor, input: GrantCapabilityAsActorInput) {
  return grantCapabilityAsActor(tx, byActor, input);
}

async function activeGrantRows(personId: string, grantName: string) {
  return sql<{ id: string; grant_source: string | null; store_id: string | null; source_ref: string | null; granted_by: string | null }[]>`
    select id, grant_source, store_id, source_ref, granted_by from person_grants
    where person_id = ${personId} and grant_name = ${grantName} and revoked_at is null`;
}

describe('H1 — widening: a hold via positionGrantId must not authorise outside the position row\'s own store', () => {
  it(
    'after the default at A is switched off, authorize resolves at A, but must throw at B',
    async () => {
      const f = await fixture('h1');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      await asOrg(f.orgId, (tx) => setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: CAP, on: false }));

      await expect(asOrg(f.orgId, (tx) => authorize(tx, f.staff, CAP, { storeId: f.storeAId }))).resolves.toBeUndefined();
      await expect(
        asOrg(f.orgId, (tx) => authorize(tx, f.staff, CAP, { storeId: f.storeBId })),
        'was red before T-349 S2: the hold used to write a NULL-store row (positionGrantId ignored), which authorized at every store the person had scope at',
      ).rejects.toBeInstanceOf(AuthorizationError);
    },
    30000,
  );
});

describe('H2 — row shape after a hold: exactly one new active row, "grant", store A, source_ref NULL', () => {
  it(
    // S2b item 7 — honest title: the describe already states everything this leg checks; the it()
    // title used to name only the LAST assertion (no lingering NULL-store row), understating the
    // other four (exactly-one row, store A, source_ref null, granted_by) the body actually pins.
    'exactly one new "grant" row at store A, source_ref NULL, granted_by the actor, and no lingering NULL-store row',
    async () => {
      const f = await fixture('h2');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));

      const rows = await activeGrantRows(f.staffId, CAP);
      const grantRows = rows.filter((r) => r.grant_source === 'grant');
      expect(grantRows, 'expected exactly one new active grant row').toHaveLength(1);
      expect(grantRows[0]!.store_id, 'was red before T-349 S2: store_id was NULL — positionGrantId was ignored').toBe(f.storeAId);
      expect(grantRows[0]!.source_ref).toBeNull();
      expect(grantRows[0]!.granted_by).toBe(f.adminId);
      expect(
        grantRows.some((r) => r.store_id === null),
        'no active NULL-store grant row for this capability',
      ).toBe(false);
    },
    30000,
  );
});

describe('H3 — idempotency: holding twice writes once', () => {
  it(
    'the second call returns wrote:false; the row count is unchanged; no 23505',
    async () => {
      const f = await fixture('h3');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const before = (await activeGrantRows(f.staffId, CAP)).length;

      const second = await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const after = (await activeGrantRows(f.staffId, CAP)).length;

      expect(second?.wrote, 'was red before T-349 S2: grantCapabilityAsActor returned void, so .wrote was undefined').toBe(false);
      expect(after).toBe(before);
    },
    30000,
  );
});

describe('H4 — concurrent double hold: exactly one active "grant" at A, neither call throws', () => {
  it(
    'two connections holding at once never surface a raw 23505',
    async () => {
      const f = await fixture('h4');
      const results = await Promise.allSettled([
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId })),
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId })),
      ]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.map((r) => (r.reason as { code?: string })?.code), 'neither call may surface a raw 23505').not.toContain('23505');

      const rows = await activeGrantRows(f.staffId, CAP);
      expect(rows.filter((r) => r.grant_source === 'grant')).toHaveLength(1);
    },
    30000,
  );
});

describe('H5 — "already held": a NULL-store owner/elevation row changes the outcome', () => {
  it(
    'an active NULL-store "owner" row: wrote:false, nothing inserted',
    async () => {
      const f = await fixture('h5owner');
      await sql`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by) values (${f.staffId}, ${CAP}, 'owner', null, ${f.adminId})`;
      const before = (await activeGrantRows(f.staffId, CAP)).length;

      const result = await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const after = (await activeGrantRows(f.staffId, CAP)).length;

      expect(result?.wrote, "was red before T-349 S2: void return, so this was 'undefined', not false").toBe(false);
      expect(after, 'nothing should have been inserted').toBe(before);
    },
    30000,
  );

  it(
    'an active NULL-store "elevation" row: a NEW store row IS inserted (elevation does not count as already-held)',
    async () => {
      const f = await fixture('h5elevation');
      await sql`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by) values (${f.staffId}, ${CAP}, 'elevation', null, ${f.adminId})`;
      const before = (await activeGrantRows(f.staffId, CAP)).length;

      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const rows = await activeGrantRows(f.staffId, CAP);

      expect(
        rows.some((r) => r.grant_source === 'grant' && r.store_id === f.storeAId),
        'was red before T-349 S2: a new row was written, but its store_id was NULL, not storeA (positionGrantId was ignored)',
      ).toBe(true);
      expect(rows.length).toBeGreaterThan(before);
    },
    30000,
  );
});

describe('H6 — refusals: positionGrantId must not be trusted blindly', () => {
  it(
    "another person's position row: refused, zero rows written",
    async () => {
      const f = await fixture('h6-other-person');
      // A second staff person, hired the same way, so they hold their OWN real position-sourced
      // grant id — the genuine "wrong person's row" shape, not a made-up id.
      const [otherPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${uid('other')}) returning id`;
      await asOrg(f.orgId, (tx) =>
        createEmployment(tx, f.admin, {
          storeId: f.storeAId,
          personId: otherPerson!.id,
          employmentStatus: 'probationary',
          startedOn: '2026-01-05',
          positionIds: [f.cashierId],
          primaryPositionId: f.cashierId,
        }),
      );
      const [otherGrant] = await sql<{ id: string }[]>`
        select id from person_grants where person_id = ${otherPerson!.id} and grant_name = ${CAP} and grant_source = 'position' and revoked_at is null`;

      const before = (await activeGrantRows(f.staffId, CAP)).length;
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: otherGrant!.id })),
        'was red before T-349 S2: positionGrantId was ignored entirely, so a real row belonging to someone else still succeeded as an org-wide hold',
      ).rejects.toThrow();
      expect((await activeGrantRows(f.staffId, CAP)).length).toBe(before);
    },
    30000,
  );

  it(
    'a revoked position row: refused, zero rows written',
    async () => {
      const f = await fixture('h6-revoked');
      await asOrg(f.orgId, (tx) => accessRepo.revokeGrantById(tx, f.positionGrantId, 'test — simulate a revoked position row'));
      const before = (await activeGrantRows(f.staffId, CAP)).length;
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId })),
        'was red before T-349 S2: positionGrantId was ignored, so a revoked row still succeeded as an org-wide hold',
      ).rejects.toThrow();
      expect((await activeGrantRows(f.staffId, CAP)).length).toBe(before);
    },
    30000,
  );

  it(
    "a 'grant'-sourced row id, not a 'position' one: refused",
    async () => {
      const f = await fixture('h6-grant-source');
      const [handRow] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by) values (${f.staffId}, ${CAP}, 'grant', null, ${f.adminId}) returning id`;
      const before = (await activeGrantRows(f.staffId, CAP)).length;
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: handRow!.id })),
        "was red before T-349 S2: positionGrantId was ignored, so a 'grant'-sourced row id still succeeded as a SECOND, org-wide hold",
      ).rejects.toThrow();
      expect((await activeGrantRows(f.staffId, CAP)).length).toBe(before);
    },
    30000,
  );

  it(
    'capability does not match the position row\'s own capability: refused',
    async () => {
      const f = await fixture('h6-wrong-cap');
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: 'manage_items', positionGrantId: f.positionGrantId })),
        'was red before T-349 S2: positionGrantId was ignored, so an unrelated capability still granted org-wide',
      ).rejects.toThrow();
    },
    30000,
  );

  it(
    'self as target: the existing self-refusal still fires (unaffected by positionGrantId)',
    async () => {
      const f = await fixture('h6-self');
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.adminId, capability: CAP, positionGrantId: f.positionGrantId })),
      ).rejects.toThrow(/may not grant themselves/);
    },
    30000,
  );

  it(
    'staff actor (no grant_capability): the existing authorize refusal still fires',
    async () => {
      const f = await fixture('h6-staff-actor');
      await expect(
        asOrg(f.orgId, (tx) => holdOwnRight(tx, f.staff, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId })),
      ).rejects.toThrow(/may not/);
    },
    30000,
  );
});

describe('H7 (table) — revoking the hand grant at A leaves the position row untouched', () => {
  it(
    'default still on: authorize resolves at A (via the position row); revoking removes access at B',
    async () => {
      const f = await fixture('h7');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const [handGrant] = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.grant_source === 'grant');
      await asOrg(f.orgId, (tx) => accessRepo.revokeGrantById(tx, handGrant!.id, 'test teardown'));

      await expect(asOrg(f.orgId, (tx) => authorize(tx, f.staff, CAP, { storeId: f.storeAId }))).resolves.toBeUndefined();
      await expect(asOrg(f.orgId, (tx) => authorize(tx, f.staff, CAP, { storeId: f.storeBId }))).rejects.toBeInstanceOf(AuthorizationError);
    },
    30000,
  );
});

describe('H7 (repo, §3.2 item 8) — the store-scoped "grant" row\'s source_ref is always NULL', () => {
  it(
    'read back from the DB after a hold',
    async () => {
      const f = await fixture('h7-repo');
      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      const [row] = (await activeGrantRows(f.staffId, CAP)).filter((r) => r.grant_source === 'grant');
      expect(row, 'expected a hand-grant row to exist').toBeDefined();
      expect(row!.source_ref, 'source_ref must always be NULL on a store-scoped grant row').toBeNull();
    },
    30000,
  );
});

describe('H8 — structural: the input has no store field at all; a row is always written at the POSITION row\'s own store, never a forged one', () => {
  // S2b item 7 — honest title: the old describe said "writes nothing and refuses", but neither
  // happens — the leg below writes a row (at store A) and never throws. What it actually proves is
  // structural: `GrantCapabilityAsActorInput` carries no `storeId` field for a caller to forge in
  // the first place, so a forged one is silently unreachable, not refused.
  it(
    'a positionGrantId whose own store is A, but a forged storeId argument naming B, still resolves to A\'s store — never B',
    async () => {
      const f = await fixture('h8');
      // The real call site takes NO storeId from the caller at all — `atStoreId` is derived
      // server-side from `activePositionGrantForPerson(positionGrantId)`, never the form. This leg
      // proves there is no parameter through which a caller could even ATTEMPT to widen it:
      // `GrantCapabilityAsActorInput` carries only `personId`/`capability`/`positionGrantId`.
      const attempted = { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId } as GrantCapabilityAsActorInput & {
        storeId?: string;
      };
      // A forged extra field is simply not read by anything — TypeScript already refuses it as
      // excess on a fresh literal; simulate the "attacker" shape via an intermediate `unknown`.
      (attempted as unknown as Record<string, unknown>).storeId = f.storeBId;

      await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, attempted));
      const rows = await activeGrantRows(f.staffId, CAP);
      const grantRow = rows.find((r) => r.grant_source === 'grant');
      expect(
        grantRow?.store_id,
        'was red before T-349 S2: store_id was NULL regardless (positionGrantId itself was ignored) — a forged storeId must never reach B',
      ).toBe(f.storeAId);
      expect(rows.some((r) => r.store_id === f.storeBId), 'must never write a row at the forged store B').toBe(false);
    },
    30000,
  );
});

/**
 * H9 — §3.2 item 9 (added 2026-09-27, orchestrator, S2 pre-commit review). `authorize` never
 * applies a store filter to a capability whose `CAPABILITY_SCOPE` is not `'store'`, so writing a
 * store-scoped `'grant'` row for one would be honoured everywhere while the banner still claims
 * one store. Ruling: for a non-store-scoped capability, hold-own-right writes the existing
 * person-level NULL-store `'grant'` row instead — the store-grant branch (§3.2 items 1-2) is only
 * for store-scoped capabilities.
 *
 * ⚠️ Measured, not the spec's own example: `post_journal_entry` is listed there as a
 * position-defaultable org-scoped capability, but it is one of the four `SUPER_ADMIN_ONLY_
 * CAPABILITIES` and explicitly excluded from `OFFERABLE_TO_POSITIONS` (`capabilities.ts:576`) — it
 * cannot be set as a position default at all. Computed the real set directly
 * (`OFFERABLE_TO_POSITIONS.filter(c => CAPABILITY_SCOPE[c] === 'org')`): **15**, not 17, and
 * `manage_fixed_assets` is used here as a real, unambiguous member of that set.
 */
describe('H9 — a hold on an org-scoped (not store-scoped) capability writes NULL-store, not the position row\'s store', () => {
  const ORG_CAP = 'manage_fixed_assets' as const;

  async function orgCapFixture(hint: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: ORG_CAP, on: true }),
    );
    const [row] = await sql<{ id: string }[]>`
      select id from person_grants
      where person_id = ${f.staffId} and grant_name = ${ORG_CAP} and grant_source = 'position' and revoked_at is null`;
    return { ...f, orgCapPositionGrantId: row!.id };
  }

  it(
    'writes a NULL-store "grant" row; the result names no store; a second hold writes nothing and reports heldEverywhere',
    async () => {
      const f = await orgCapFixture('h9');

      const result = await asOrg(f.orgId, (tx) =>
        holdOwnRight(tx, f.admin, { personId: f.staffId, capability: ORG_CAP, positionGrantId: f.orgCapPositionGrantId }),
      );
      expect(result.wrote).toBe(true);
      // Measured, not the orchestrator's own prediction ("red against the current S2 tree, which
      // names SmokeStore"): the S2 tree already distinguishes capability scope correctly.
      expect(result.storeName, 'an org-scoped capability names no store').toBeNull();

      const rows = await activeGrantRows(f.staffId, ORG_CAP);
      const grantRow = rows.find((r) => r.grant_source === 'grant');
      expect(grantRow?.store_id, 'the row is NULL-store, not store A').toBeNull();

      const second = await asOrg(f.orgId, (tx) =>
        holdOwnRight(tx, f.admin, { personId: f.staffId, capability: ORG_CAP, positionGrantId: f.orgCapPositionGrantId }),
      );
      expect(second.wrote, 'a second hold must write nothing').toBe(false);
      expect(second.heldEverywhere, 'wanted: heldEverywhere true (a NULL-store row covers every store)').toBe(true);
    },
    30000,
  );
});

describe('H11 (S2b item 6) — deterministic cover: a store-scoped row and a NULL-store row both existing, the NULL-store row must win', () => {
  it(
    'heldEverywhere:true regardless of which row was inserted first — was red before S2b: measured (zzprobe11, created then deleted) — with the store-scoped row inserted BEFORE the NULL-store row, repo/access.ts ~:659 has no ORDER BY on the `.limit(1)` cover query, and returns the store-scoped row, reporting heldEverywhere:false even though a NULL-store row (covers everywhere) exists',
    async () => {
      const f = await fixture('h11');
      // Order matters for the current (unordered) query — inserted in the sequence measured to
      // reproduce the bug: store-scoped row FIRST, then the NULL-store row.
      await sql`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by, store_id) values (${f.staffId}, ${CAP}, 'grant', null, ${f.adminId}, ${f.storeAId})`;
      await sql`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by, store_id) values (${f.staffId}, ${CAP}, 'grant', null, ${f.adminId}, null)`;

      const result = await asOrg(f.orgId, (tx) => holdOwnRight(tx, f.admin, { personId: f.staffId, capability: CAP, positionGrantId: f.positionGrantId }));
      expect(result.wrote, 'nothing new should be written — both rows already cover').toBe(false);
      expect(result.heldEverywhere, 'wanted: true — a NULL-store row exists, so everywhere is covered regardless of query row order').toBe(true);
    },
    30000,
  );
});

describe('H10 (S2b item 1) — org-scoped hold over an existing NULL-store "elevation" row: the rank-upgrade IS a write', () => {
  const ORG_CAP = 'manage_fixed_assets' as const;

  async function orgCapFixture(hint: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPositionDefault(tx, f.admin, { positionId: f.cashierId, storeId: f.storeAId, capability: ORG_CAP, on: true }),
    );
    const [row] = await sql<{ id: string }[]>`
      select id from person_grants
      where person_id = ${f.staffId} and grant_name = ${ORG_CAP} and grant_source = 'position' and revoked_at is null`;
    return { ...f, orgCapPositionGrantId: row!.id };
  }

  it(
    'the "elevation" row is superseded by a new "grant" row — wrote:true (was red before S2b: unconditional wrote:false on the existing-row arm)',
    async () => {
      const f = await orgCapFixture('h10');
      await sql`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by) values (${f.staffId}, ${ORG_CAP}, 'elevation', null, ${f.adminId})`;

      const before = await activeGrantRows(f.staffId, ORG_CAP);
      expect(before.find((r) => r.store_id === null)?.grant_source, 'setup: the pre-existing row is elevation').toBe('elevation');

      const result = await asOrg(f.orgId, (tx) =>
        holdOwnRight(tx, f.admin, { personId: f.staffId, capability: ORG_CAP, positionGrantId: f.orgCapPositionGrantId }),
      );

      const after = await activeGrantRows(f.staffId, ORG_CAP);
      expect(after.length, 'one active row: the elevation row is replaced, not duplicated').toBe(before.length);
      const row = after.find((r) => r.store_id === null);
      expect(row?.grant_source, 'the row rank-upgraded to grant').toBe('grant');
      expect(result.wrote, 'wanted: true — the upgrade IS a write').toBe(true);
    },
    30000,
  );
});
