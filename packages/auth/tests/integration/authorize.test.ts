import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * Proves the 13 invariants of docs/tasks/121-roles-and-access.md Contract (minus
 * invariant 13, "Person A in org A cannot read org B's roles, grants or scope" — an RLS
 * isolation proof that lives in packages/db/tests/integration/rls.test.ts alongside T-120's
 * other org-isolation invariants, the established home for that kind of proof) against a
 * real PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * ## ⭐ Invariant 5 — every one of the 44 capabilities, not a sample
 *
 * CAPABILITY-MATRIX.md and the task spec's prose both say "36" — the table itself had 38
 * rows at T-121 (tests/unit/capability-matrix.test.ts pins this and the task report explains
 * it as a found spec defect); T-130 added `record_supplier_invoice`, `verify_supplier_invoice`
 * and `void_supplier_invoice`, making 47. This file tests against the ACTUAL 47, generated from
 * `CAPABILITY_MATRIX` itself via `it.each` rather than hand-written per capability — the
 * same "parsed/derived, not hand-compared" discipline invariant 3 applies to the matrix's
 * CONTENT applied here to the TEST COVERAGE: a hand-written list of 45 `it()` blocks could
 * silently miss one exactly the way the document's own prose count did.
 *
 * Lives under packages/auth/tests/integration/ (task Scope). vitest.config.mts's
 * "integration" project picks this up via `packages/**\/tests/integration/**\/*.test.ts`
 * and runs tests/integration/setup.ts first, pointing DATABASE_URL at TEST_DATABASE_URL —
 * `authorize()` opens no connection of its own; it takes the `Tx` this file hands it via
 * `@shareat/db`'s `transaction()`, which reads that same DATABASE_URL.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { accessRepo, transaction, systemTransaction, APP_ROLE, type Tx } from '@shareat/db';
import {
  authorize,
  assignRole,
  elevateManager,
  grantCapabilityAsActor,
  AuthorizationError,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLES,
  type Actor,
  type Capability,
  type Role,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Runs `fn` inside one Drizzle transaction with the 'staff' principal applied for
 * `orgId` — the RLS context every real mutation runs under (T-120). Mirrors
 * packages/db/src/rls/principal.ts's `applyPrincipal`, adapted to a Drizzle `Tx` (which
 * exposes `.execute(sql\`...\`)`, not postgres.js's raw `.unsafe`) the same way
 * repo/journal.ts's `beginReversalPostingContext` already does for its own `set_config`. */
async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`auth-${hint}`);
  const [row] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

async function insertStore(orgId: string, hint: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  return row!.id;
}

/** Direct SQL role insert — deliberately NOT going through `assignRole` for the read-only
 * fixture personas below, so they get exactly the row this test writes and nothing else:
 * no grant-time-fallback elevation, no accidental extra capability. `assignRole`'s own
 * behaviour is exercised separately, in the "grant-time fallback" describe block. */
async function insertRoleRaw(personId: string, orgId: string, role: Role): Promise<void> {
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
}

async function insertStoreScopeRaw(personId: string, storeId: string): Promise<void> {
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
}

// ---------------------------------------------------------------------------------------
// Fixtures — one org (A) with a full role ladder and deliberately varied store scope,
// a second org (B) for the cross-org invariant, seeded ONCE in beforeAll. Nothing in the
// "matrix denial / positive / store-scope / close_period" describe blocks below WRITES to
// these rows, so a shared beforeAll is safe; the "grant-time fallback" block creates its
// OWN fresh orgs/persons per test instead of touching these.
// ---------------------------------------------------------------------------------------

let orgA: string;
let orgB: string;
let storeA1: string;
let storeA2: string;
let storeA3: string;
let storeB1: string;

/** One store (A1) only — the "false" boundary for invariant 6 and invariant 8's denial. */
let managerA: string;
/** Every store in org A — the "true" boundary for invariant 8's positive case. */
let managerAFull: string;
let adminA: string;
let staffA: string;
let superA: string;

const personaId: Record<Role, string> = {} as Record<Role, string>;

beforeAll(async () => {
  await sql`truncate table person_grants, person_store_scope, person_roles, journal_lines, journal_entries, audit_log, fiscal_periods, accounts, person_identities, persons, stores, organizations restart identity cascade`;

  orgA = await insertOrg('a');
  orgB = await insertOrg('b');
  storeA1 = await insertStore(orgA, 'a1');
  storeA2 = await insertStore(orgA, 'a2');
  storeA3 = await insertStore(orgA, 'a3');
  storeB1 = await insertStore(orgB, 'b1');

  superA = await insertPerson(orgA, 'Super');
  adminA = await insertPerson(orgA, 'Admin');
  managerA = await insertPerson(orgA, 'Manager (A1 only)');
  managerAFull = await insertPerson(orgA, 'Manager (whole org)');
  staffA = await insertPerson(orgA, 'Staff');

  await insertRoleRaw(superA, orgA, 'super_admin');
  await insertRoleRaw(adminA, orgA, 'admin');
  await insertRoleRaw(managerA, orgA, 'manager');
  await insertRoleRaw(managerAFull, orgA, 'manager');
  await insertRoleRaw(staffA, orgA, 'staff');

  // Every persona holds storeA1, so any store-scoped capability's POSITIVE test works
  // uniformly regardless of role. managerA deliberately does NOT hold A2/A3 (invariant 6,
  // invariant 8's denial); managerAFull holds all three (invariant 8's positive case).
  for (const personId of [superA, adminA, managerA, managerAFull, staffA]) {
    await insertStoreScopeRaw(personId, storeA1);
  }
  await insertStoreScopeRaw(managerAFull, storeA2);
  await insertStoreScopeRaw(managerAFull, storeA3);

  personaId.super_admin = superA;
  personaId.admin = adminA;
  personaId.manager = managerA;
  personaId.staff = staffA;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** The storeId to pass for a store-scoped capability's HAPPY-PATH context — every fixture
 * persona holds storeA1, so this is safe for any of them except the close_period+manager
 * combination, which is org-scoped and never reads ctx.storeId regardless. */
function happyCtx(capability: Capability): { storeId?: string } {
  return CAPABILITY_SCOPE[capability] === 'store' ? { storeId: storeA1 } : {};
}

// ---------------------------------------------------------------------------------------
// Invariant 5 — ⭐ every capability DENIES a role that lacks it. All 38, not a sample.
// ---------------------------------------------------------------------------------------

describe('invariant 5 — every capability denies a role that lacks it (all 56)', () => {
  const denialCases: { capability: Capability; role: Role }[] = CAPABILITIES.flatMap((capability) =>
    ROLES.filter((role) => !CAPABILITY_MATRIX[capability][role]).map((role) => ({ capability, role })),
  );

  // ⛔ T-318 (2026-09-14): THIS SET IS NOW EMPTY, AND THAT IS THE WHOLE POINT OF THE TASK.
  // Twenty-one capabilities used to be held by ALL FOUR roles — `record_sale`, `submit_sales_day`,
  // `create_expense`, `edit_own_expense`, `record_stock_movement`, `record_wastage`,
  // `create_wholesale_order`, `record_supplier_invoice`, `confirm_receipt`, `set_item_threshold`,
  // `post_order_message`, `record_statutory_discount`, `record_till_count`, `transfer_stock`,
  // `record_supplier_return`, `record_customer_return`, `place_branch_order`,
  // `fulfil_branch_order`, `receive_delivery`, `record_order_wastage`, `request_pos_map` — and had
  // no role to deny, so invariant 5 was vacuously satisfied for them rather than violated. Ian's
  // ruling to shrink the staff baseline (docs/tasks/318-position-decides-access.md) moved every
  // one of them off the matrix's `staff` cell and onto position grants: `staff` now denies all 21
  // in `CAPABILITY_MATRIX`, same as everyone else the matrix used to leave alone. The per-capability
  // "why staff-open" reasoning this comment used to carry lives in `docs/decisions/
  // CAPABILITY-MATRIX.md`'s Notes column, which each of the 21 rows still gives — the WHY is
  // unchanged; only the MECHANISM (automatic vs. a position default) moved. Kept as a typed,
  // empty constant rather than deleted outright: if a future capability becomes genuinely
  // universal again, this is where a reviewer would expect to find that decision recorded.
  const UNIVERSALLY_GRANTED: readonly Capability[] = [];

  it('every capability has at least one denial case', () => {
    const covered = new Set(denialCases.map((c) => c.capability));
    const missing = CAPABILITIES.filter((c) => !covered.has(c));
    expect(missing.sort()).toEqual([...UNIVERSALLY_GRANTED].sort());
  });

  it('no capability is universally granted anymore — T-318 retired the last 21', () => {
    expect(UNIVERSALLY_GRANTED).toEqual([]);
  });

  it('every capability has a denial case for EVERY role that lacks it, not just one', () => {
    // Stronger than the letter of invariant 5 ("a role", singular) — proves the sweep
    // below is exhaustive over false cells, not merely non-empty. T-318 emptied
    // UNIVERSALLY_GRANTED, so this now runs unfiltered over all of CAPABILITIES; the `continue`
    // stays as dead-but-harmless defence in case that set is ever non-empty again.
    for (const capability of CAPABILITIES) {
      if (UNIVERSALLY_GRANTED.includes(capability)) continue;
      const expectedFalseRoles = ROLES.filter((r) => !CAPABILITY_MATRIX[capability][r]);
      const actualCases = denialCases.filter((c) => c.capability === capability).map((c) => c.role);
      expect(actualCases.sort()).toEqual([...expectedFalseRoles].sort());
    }
  });

  it.each(denialCases)('$capability denies $role', async ({ capability, role }) => {
    const actor: Actor = { personId: personaId[role], orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, capability, happyCtx(capability)))).rejects.toThrow(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------------------
// Invariant 4 — a role holding the capability, in scope, passes. All 38 (full sweep, not
// required by the letter of invariant 4 but cheap once the harness exists, and it proves
// every "true" matrix cell is actually reachable, not just typed).
// ---------------------------------------------------------------------------------------

describe('invariant 4 — a role holding the capability, in scope, passes (all 53)', () => {
  const positiveCases: { capability: Capability; role: Role }[] = CAPABILITIES.flatMap((capability) =>
    ROLES.filter((role) => CAPABILITY_MATRIX[capability][role]).map((role) => ({ capability, role })),
  );

  it('generates at least one positive case per capability', () => {
    const covered = new Set(positiveCases.map((c) => c.capability));
    const missing = CAPABILITIES.filter((c) => !covered.has(c));
    expect(missing).toEqual([]);
  });

  it.each(positiveCases)('$capability allows $role', async ({ capability, role }) => {
    // close_period + manager is the one combination with an extra, data-dependent
    // condition (invariant 8) — the plain single-store `managerA` fixture does NOT
    // satisfy it by design, so this combination uses `managerAFull` instead. Every other
    // (capability, role) pair uses the shared, single-store persona.
    const personId = capability === 'close_period' && role === 'manager' ? managerAFull : personaId[role];
    const actor: Actor = { personId, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, capability, happyCtx(capability)))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Invariant 6 — holding the capability but not the STORE is denied, checked separately.
// ---------------------------------------------------------------------------------------

describe('invariant 6 — store scope is checked separately, always', () => {
  it('managerA holds void_expense (store-scoped) but not storeA2 — denied', async () => {
    expect(CAPABILITY_MATRIX.void_expense.manager).toBe(true); // sanity: this IS a capability they hold
    const actor: Actor = { personId: managerA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'void_expense', { storeId: storeA2 }))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('a staff person HOLDING create_expense via a grant is still denied at the wrong store', async () => {
    // T-318 emptied CAPABILITY_MATRIX.*.staff (invariant 5's comment above) — a plain 'staff'
    // role holds nothing from the matrix anymore, so proving "store scope is checked
    // separately" for staff specifically now needs a REAL grant, not the automatic cell this
    // test used to rely on. A fresh org/person, never orgA/staffA: the shared fixture's
    // invariant-5 sweep expects staffA to hold NOTHING, and writing a grant onto it would
    // break that sweep for (create_expense, staff).
    // authorize.ts's store-scope check (axis 2) runs identically whether `allowed` came from
    // the matrix or from personHasActiveGrant — so this exercises the same code invariant 6
    // always has, just via the mechanism staff now actually uses.
    const org = await insertOrg('inv6-staff-grant');
    const store1 = await insertStore(org, 'inv6-staff-grant-1');
    const store2 = await insertStore(org, 'inv6-staff-grant-2');
    const person = await insertPerson(org, 'Grant-holding Staff');
    await insertRoleRaw(person, org, 'staff');
    await insertStoreScopeRaw(person, store1);
    expect(CAPABILITY_MATRIX.create_expense.staff).toBe(false); // denied via the matrix alone
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${person}, 'create_expense', null, null)`;
    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'create_expense', { storeId: store1 }))).resolves.toBeUndefined();
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'create_expense', { storeId: store2 }))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('a store-scoped capability called with NO storeId at all is denied, not silently allowed', async () => {
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'void_expense', {}))).rejects.toThrow(AuthorizationError);
  });

  it('a storeId from a different org is denied even if a stray scope row existed', async () => {
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'void_expense', { storeId: storeB1 }))).rejects.toThrow(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------------------
// Invariant 7 — holding a capability in ANOTHER org is denied.
// ---------------------------------------------------------------------------------------

describe('invariant 7 — cross-org access is denied', () => {
  it('adminA (org A) cannot act on org B\'s resource, store-scoped capability', async () => {
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(
      asPerson(orgA, (tx) => authorize(tx, actor, 'create_expense', { storeId: storeB1, orgId: orgB })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('adminA (org A) cannot act on org B\'s resource, org-scoped capability', async () => {
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'manage_price_lists', { orgId: orgB }))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('the same admin, same-org, still passes (control — the denial above is about the org mismatch, not the admin)', async () => {
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'manage_price_lists', {}))).resolves.toBeUndefined();
  });

  it('platform-scoped capabilities are exempt from the org check by design — super_admin, any orgId', async () => {
    const actor: Actor = { personId: superA, orgId: orgA };
    await expect(
      asPerson(orgA, (tx) => authorize(tx, actor, 'cross_org_access', { orgId: orgB })),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Invariant 8 — close_period is denied to a manager whose store scope is not org-wide
// (CAPABILITY-MATRIX.md §Open 2 — the row-101/row-114 resolution).
// ---------------------------------------------------------------------------------------

describe('invariant 8 — close_period requires a manager to cover the WHOLE org', () => {
  it('managerA (storeA1 only) is denied — does not cover storeA2/storeA3', async () => {
    const actor: Actor = { personId: managerA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'close_period', {}))).rejects.toThrow(AuthorizationError);
  });

  it('managerAFull (all three stores) passes', async () => {
    const actor: Actor = { personId: managerAFull, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'close_period', {}))).resolves.toBeUndefined();
  });

  it('admin passes regardless of store scope — the extra condition is manager-only', async () => {
    // adminA only holds storeA1 (same as managerA), yet is NOT subject to the whole-org
    // check — admin's `close_period` cell is a plain `true`, no extra condition attached.
    const actor: Actor = { personId: adminA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'close_period', {}))).resolves.toBeUndefined();
  });

  it('super_admin passes regardless of store scope, same reasoning', async () => {
    const actor: Actor = { personId: superA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'close_period', {}))).resolves.toBeUndefined();
  });

  it('personCoversWholeOrg is vacuously true for an org with zero stores (no false negative on an empty org)', async () => {
    const emptyOrg = await insertOrg('empty');
    const lonelyManager = await insertPerson(emptyOrg, 'Lonely Manager');
    await insertRoleRaw(lonelyManager, emptyOrg, 'manager');
    const covers = await asPerson(emptyOrg, (tx) => accessRepo.personCoversWholeOrg(tx, lonelyManager, emptyOrg));
    expect(covers).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Invariants 9-11 — the grant-time fallback. Each test builds its OWN fresh org/persons
// (never touching orgA/B above), so this block needs no truncate between tests.
// ---------------------------------------------------------------------------------------

describe('invariants 9-11 — the grant-time fallback (bible rows 115-116)', () => {
  it('invariant 9 — a manager appointed in an admin-less org receives the elevated grants AT CREATION', async () => {
    const org = await insertOrg('fallback-9');
    const person = await insertPerson(org, 'New Manager');

    expect(await asPerson(org, (tx) => accessRepo.hasActiveAdmin(tx, org))).toBe(false);

    const result = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'manager', grantedBy: null }));

    expect([...result.elevatedGrants].sort()).toEqual([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort());
    expect(result.elevatedGrants.length).toBeGreaterThan(0);

    // Real, queryable rows — not an in-memory fact. "manage_users" specifically, because
    // CAPABILITY-MATRIX.md §B.1 names it as the capability this closes §Open 3 with.
    const grantRows = await sql<{ grant_name: string; revoked_at: Date | null }[]>`
      select grant_name, revoked_at from person_grants where person_id = ${person}
    `;
    expect(grantRows.every((r) => r.revoked_at === null)).toBe(true);
    expect(grantRows.map((r) => r.grant_name).sort()).toEqual([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort());
    expect(grantRows.map((r) => r.grant_name)).toContain('manage_users');

    // And authorize() actually honours it — manage_users is matrix-false for a plain
    // manager, so this only passes via the grant.
    expect(CAPABILITY_MATRIX.manage_users.manager).toBe(false);
    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).resolves.toBeUndefined();
  });

  it('a manager appointed in an org that DOES have an admin receives NO elevated grants', async () => {
    const org = await insertOrg('fallback-9b');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');

    const person = await insertPerson(org, 'Ordinary Manager');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'manager', grantedBy: admin }));
    expect(result.elevatedGrants).toEqual([]);

    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).rejects.toThrow(AuthorizationError);
  });

  it('DEF-237 — a manager appointed in an org whose only administrator is a super_admin receives NO elevated grants', async () => {
    // ⛔ Before T-244, `hasActiveAdmin` matched the literal role 'admin' only, so an org run
    // solely by a super_admin read as "adminless" and the next manager appointed there was
    // elevated as if the org had nobody in charge. Sibling to the test above, which proves the
    // 'admin' case; this proves the 'super_admin' case DEF-237 names.
    const org = await insertOrg('fallback-9c-super-admin-only');
    const superAdmin = await insertPerson(org, 'Only Super Admin');
    await insertRoleRaw(superAdmin, org, 'super_admin');

    expect(await asPerson(org, (tx) => accessRepo.hasActiveAdmin(tx, org))).toBe(true);

    const person = await insertPerson(org, 'Ordinary Manager');
    const result = await asPerson(org, (tx) =>
      assignRole(tx, { personId: person, orgId: org, role: 'manager', grantedBy: superAdmin }),
    );
    expect(result.elevatedGrants).toEqual([]);

    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).rejects.toThrow(AuthorizationError);
  });

  it('invariant 10 — removing the org\'s admin leaves an already-elevated manager\'s grants UNCHANGED', async () => {
    const org = await insertOrg('fallback-10');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');

    // This manager is elevated MANUALLY (bible row 116's "super-admin, by an explicit
    // tick" path) despite the org currently having an admin — modelling a manager who
    // already holds the elevated set for whatever reason, so the test isolates exactly
    // one thing: does REVOKING the admin touch these rows at all.
    const manager = await insertPerson(org, 'Manager');
    await insertRoleRaw(manager, org, 'manager');
    await asPerson(org, (tx) => elevateManager(tx, { personId: manager, grantedBy: admin }));

    const before = await sql<{ grant_name: string; revoked_at: Date | null }[]>`
      select grant_name, revoked_at from person_grants where person_id = ${manager} order by grant_name
    `;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.revoked_at === null)).toBe(true);

    // The event bible row 115/116 discuss: the admin is removed.
    await asPerson(org, (tx) => accessRepo.revokeActiveRole(tx, admin, org));
    expect(await asPerson(org, (tx) => accessRepo.hasActiveAdmin(tx, org))).toBe(false);

    const after = await sql<{ grant_name: string; revoked_at: Date | null }[]>`
      select grant_name, revoked_at from person_grants where person_id = ${manager} order by grant_name
    `;
    expect(after).toEqual(before);

    // And authorize() still honours the untouched grants.
    const actor: Actor = { personId: manager, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).resolves.toBeUndefined();
  });

  it('invariant 11 — a revoked grant stops authorising, and remains queryable with its revocation date', async () => {
    const org = await insertOrg('fallback-11');
    const person = await insertPerson(org, 'Manager');
    await insertRoleRaw(person, org, 'manager');
    await asPerson(org, (tx) => elevateManager(tx, { personId: person, grantedBy: null }));

    const [row] = await sql<{ id: string }[]>`
      select id from person_grants where person_id = ${person} and grant_name = 'manage_users' and revoked_at is null
    `;
    expect(row, 'the grant must exist and be active before revoking it').toBeDefined();

    const actorBefore: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actorBefore, 'manage_users', {}))).resolves.toBeUndefined();

    await asPerson(org, (tx) => accessRepo.revokeGrantById(tx, row!.id, 'invariant 11 test — no longer needed'));

    const actorAfter: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actorAfter, 'manage_users', {}))).rejects.toThrow(AuthorizationError);

    // Still queryable, with a revocation date — never deleted.
    const [revoked] = await sql<{ revoked_at: Date | null }[]>`select revoked_at from person_grants where id = ${row!.id}`;
    expect(revoked).toBeDefined();
    expect(revoked!.revoked_at).not.toBeNull();
  });

  it('re-granting after a revocation inserts a NEW row rather than reviving the old one', async () => {
    const org = await insertOrg('fallback-11b');
    const person = await insertPerson(org, 'Manager');
    await insertRoleRaw(person, org, 'manager');
    const { id: firstGrantId } = await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: person, grantName: 'manage_price_lists', grantedBy: null, grantSource: 'grant' }),
    );
    await asPerson(org, (tx) => accessRepo.revokeGrantById(tx, firstGrantId, 're-grant test — no longer needed'));

    const { id: secondGrantId } = await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: person, grantName: 'manage_price_lists', grantedBy: null, grantSource: 'grant' }),
    );
    expect(secondGrantId).not.toBe(firstGrantId);

    const rows = await sql<{ id: string; revoked_at: Date | null }[]>`
      select id, revoked_at from person_grants where person_id = ${person} and grant_name = 'manage_price_lists' order by granted_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.revoked_at).not.toBeNull(); // the original, still queryable
    expect(rows[1]!.revoked_at).toBeNull(); // the new one, active
  });
});

// ---------------------------------------------------------------------------------------
// T-248 / DEF-237, bible row 188 — "the elevation is a stand-in for a missing administrator,
// and it ends when the administrator arrives." Each test builds its own fresh org, same
// convention as the grant-time-fallback block above.
//
// ⛔ Cases 4 and 6 below are the ones that matter more than the rest: a hand-granted capability
// and a NULL-source (pre-existing) row must each survive an arrival UNTOUCHED. If either is
// swept, this task has done the exact harm it exists to prevent, and it would look like success
// — every other assertion in this file would still be green. Both were watched failing against
// a deliberately naive revocation (matching by grant_name membership in
// ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER instead of by grant_source) before the real,
// source-filtered query was restored — see the READY report for the captured red.
// ---------------------------------------------------------------------------------------

describe('T-248 — DEF-237: elevated grants are revoked when an administrator arrives', () => {
  /** Raw SQL, bypassing every service — the constraint is the only thing left, same technique
   *  `credentials-admin.test.ts`'s `forceRevoke` uses for `person_credentials_revoke_check`. */
  const forceRevoke = (grantId: string, reason: string | null) =>
    sql`update person_grants set revoked_at = now(), revoke_reason = ${reason} where id = ${grantId}`;

  it('⛔ case 1: a manager auto-elevated in an adminless org loses those grants the moment an ADMIN arrives', async () => {
    const org = await insertOrg('t248-elevation-admin');
    const manager = await insertPerson(org, 'Elevated Manager');
    const elevated = await asPerson(org, (tx) => assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }));
    expect(elevated.elevatedGrants).toContain('manage_users' as Capability);

    const [before] = await sql<{ grant_source: string | null; revoked_at: Date | null }[]>`
      select grant_source, revoked_at from person_grants where person_id = ${manager} and grant_name = 'manage_users'
    `;
    expect(before!.grant_source).toBe('elevation');
    expect(before!.revoked_at).toBeNull();

    const admin = await insertPerson(org, 'New Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.revokedElevatedGrants.map((g) => g.grantName).sort()).toEqual([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort());
    expect(result.revokedElevatedGrants.every((g) => g.personId === manager)).toBe(true);

    const rows = await sql<{ grant_name: string; revoked_at: Date | null; revoke_reason: string | null }[]>`
      select grant_name, revoked_at, revoke_reason from person_grants where person_id = ${manager}
    `;
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect(rows.every((r) => r.revoke_reason?.includes('DEF-237'))).toBe(true);

    const actor: Actor = { personId: manager, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).rejects.toThrow(AuthorizationError);
  });

  it('⭐ case 2: a SUPER_ADMIN arrival triggers it too', async () => {
    const org = await insertOrg('t248-elevation-super');
    const manager = await insertPerson(org, 'Elevated Manager');
    await asPerson(org, (tx) => assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }));

    const superAdmin = await insertPerson(org, 'New Super');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: superAdmin, orgId: org, role: 'super_admin', grantedBy: null }));

    expect(result.revokedElevatedGrants.length).toBeGreaterThan(0);
    const [row] = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from person_grants where person_id = ${manager} and grant_name = 'manage_users'
    `;
    expect(row!.revoked_at).not.toBeNull();
  });

  it('case 3: an arrival in an org with NO elevated managers is a no-op', async () => {
    const org = await insertOrg('t248-no-elevation');
    const staff = await insertPerson(org, 'Ordinary Staff');
    await asPerson(org, (tx) => assignRole(tx, { personId: staff, orgId: org, role: 'staff', grantedBy: null }));

    const admin = await insertPerson(org, 'First Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.revokedElevatedGrants).toEqual([]);
  });

  it('⛔ case 4: a HAND-GRANTED capability survives an arrival untouched — the trap', async () => {
    const org = await insertOrg('t248-hand-grant-survives');
    const manager = await insertPerson(org, 'Trusted Manager');
    // ⚠️ Raw role insert, NOT `assignRole` — this org is adminless, so `assignRole` would
    // auto-elevate the manager first and this test would be granting a capability the manager
    // already held (as `'elevation'`), never actually constructing the hand-grant it means to test.
    await insertRoleRaw(manager, org, 'manager');
    const grantor = await insertPerson(org, 'Grantor');
    await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: manager, grantName: 'manage_users', grantedBy: grantor, grantSource: 'grant' }),
    );

    const admin = await insertPerson(org, 'New Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.revokedElevatedGrants).toEqual([]);
    const [row] = await sql<{ revoked_at: Date | null; grant_source: string | null }[]>`
      select revoked_at, grant_source from person_grants where person_id = ${manager} and grant_name = 'manage_users'
    `;
    expect(row!.grant_source).toBe('grant');
    expect(row!.revoked_at).toBeNull();

    const actor: Actor = { personId: manager, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).resolves.toBeUndefined();
  });

  it('case 5: an OWNER-source grant (createFirstAdmin\'s equivalence) is never eligible', async () => {
    const org = await insertOrg('t248-owner-untouched');
    const owner = await insertPerson(org, 'Org Owner');
    await asPerson(org, (tx) => assignRole(tx, { personId: owner, orgId: org, role: 'admin', grantedBy: null }));
    await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: owner, grantName: 'post_journal_entry', grantedBy: null, grantSource: 'owner' }),
    );

    // A second admin arrives later — a real arrival, even though the org already had one.
    const secondAdmin = await insertPerson(org, 'Second Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: secondAdmin, orgId: org, role: 'admin', grantedBy: owner }));

    expect(result.revokedElevatedGrants).toEqual([]);
    const [row] = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from person_grants where person_id = ${owner} and grant_name = 'post_journal_entry'
    `;
    expect(row!.revoked_at).toBeNull();
  });

  it('⛔ case 6: a NULL-source (pre-existing) grant survives an arrival untouched — the backfill decision, at the mechanism level', async () => {
    const org = await insertOrg('t248-null-source-survives');
    const manager = await insertPerson(org, 'Legacy-Elevated Manager');
    // ⚠️ Raw role insert, NOT `assignRole` — same reason as case 4: this org is adminless, and
    // `assignRole` would auto-elevate the manager (with the real 'elevation' source) before the
    // raw insert below ever runs, colliding with the partial unique index on a second active row.
    await insertRoleRaw(manager, org, 'manager');
    // Simulates a row written before this migration existed: same grant, source deliberately NULL.
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${manager}, 'manage_users', null, null)`;

    const admin = await insertPerson(org, 'New Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.revokedElevatedGrants).toEqual([]);
    const [row] = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from person_grants where person_id = ${manager} and grant_name = 'manage_users' and grant_source is null
    `;
    expect(row!.revoked_at).toBeNull();
  });

  it('⭐ case 7: elevateManager\'s grants are revoked identically to the automatic path', async () => {
    const org = await insertOrg('t248-elevate-manager');
    const manager = await insertPerson(org, 'Manually Re-elevated Manager');
    await asPerson(org, (tx) => assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }));
    await asPerson(org, (tx) => elevateManager(tx, { personId: manager, grantedBy: null }));

    const [before] = await sql<{ grant_source: string | null }[]>`
      select grant_source from person_grants where person_id = ${manager} and grant_name = 'manage_users'
    `;
    expect(before!.grant_source).toBe('elevation');

    const admin = await insertPerson(org, 'New Admin');
    const result = await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.revokedElevatedGrants.some((g) => g.personId === manager && g.grantName === 'manage_users')).toBe(true);
  });

  it('case 8: a repeat arrival (a second admin appointed later) is idempotent', async () => {
    const org = await insertOrg('t248-idempotent');
    const manager = await insertPerson(org, 'Elevated Manager');
    await asPerson(org, (tx) => assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }));

    const firstAdmin = await insertPerson(org, 'First Admin');
    const first = await asPerson(org, (tx) => assignRole(tx, { personId: firstAdmin, orgId: org, role: 'admin', grantedBy: null }));
    expect(first.revokedElevatedGrants.length).toBeGreaterThan(0);

    const secondAdmin = await insertPerson(org, 'Second Admin');
    const second = await asPerson(org, (tx) => assignRole(tx, { personId: secondAdmin, orgId: org, role: 'admin', grantedBy: firstAdmin }));
    expect(second.revokedElevatedGrants).toEqual([]);
  });

  it("⭐ case 12 (lane D follow-up): a hand-grant of a capability already held via elevation is not left sweepable", async () => {
    // The hole: `grantCapability`'s idempotent branch used to return an already-active row
    // untouched, so a deliberate hand-grant of a capability the target already held as
    // 'elevation' left the row tagged 'elevation' — swept on the next admin arrival exactly
    // as if nobody had ever granted it deliberately. Reachable because `grant_capability`
    // itself is `{ admin: true, manager: false }`, so BOTH managers below hold it purely
    // through the adminless-org fallback, and `grantCapabilityAsActor`'s self-check allows
    // M1 to grant M2 (never M1 to grant themselves).
    const org = await insertOrg('t248-idempotent-upgrade');
    const m1 = await insertPerson(org, 'Elevated Manager One');
    const elevated1 = await asPerson(org, (tx) => assignRole(tx, { personId: m1, orgId: org, role: 'manager', grantedBy: null }));
    expect(elevated1.elevatedGrants).toContain('grant_capability' as Capability);

    const m2 = await insertPerson(org, 'Elevated Manager Two');
    const elevated2 = await asPerson(org, (tx) => assignRole(tx, { personId: m2, orgId: org, role: 'manager', grantedBy: null }));
    expect(elevated2.elevatedGrants).toContain('manage_users' as Capability);

    const [before] = await sql<{ grant_source: string | null }[]>`
      select grant_source from person_grants where person_id = ${m2} and grant_name = 'manage_users'
    `;
    expect(before!.grant_source).toBe('elevation');

    // M1 deliberately hand-grants M2 the SAME capability M2 already holds via elevation.
    await asPerson(org, (tx) =>
      grantCapabilityAsActor(tx, { personId: m1, orgId: org }, { personId: m2, capability: 'manage_users' }),
    );

    const [after] = await sql<{ grant_source: string | null; revoked_at: Date | null }[]>`
      select grant_source, revoked_at from person_grants where person_id = ${m2} and grant_name = 'manage_users'
    `;
    // ⛔ The whole point: a deliberate act by an authorised actor is new evidence, and must
    // move this row OUT of the sweepable set — never leave it silently tagged 'elevation'.
    expect(after!.grant_source).toBe('grant');
    expect(after!.revoked_at).toBeNull();

    const admin = await insertPerson(org, 'New Admin');
    await asPerson(org, (tx) => assignRole(tx, { personId: admin, orgId: org, role: 'admin', grantedBy: null }));

    const [survived] = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from person_grants where person_id = ${m2} and grant_name = 'manage_users'
    `;
    expect(survived!.revoked_at).toBeNull();
  });

  it('⭐ case 13 (lane D follow-up): the admin-arrival sweep is scoped to the arriving org by its OWN query, not merely masked by RLS', async () => {
    // Finding #2 of the read-only review: every other T-248 case builds ONE org and runs
    // under `asPerson`, so RLS's own org scoping (the `person_..._via_person` policy, keyed
    // on `app.org_id`) would mask a regression in `revokeElevationGrantsForOrg`'s own
    // `exists(...)` correlation — the test would still pass even if the application-code
    // correlation were dropped, because RLS would independently refuse the cross-org write.
    // Bible §15.11: no layer may be the only one for a given risk. Running with NO org
    // principal — the base connection role, no `set local role shareat_app`, no
    // `app.org_id` — removes that backstop, so this proves the application code's OWN
    // scoping, not merely that RLS happens to cover for it.
    const orgA = await insertOrg('t248-scope-a');
    const orgB = await insertOrg('t248-scope-b');
    const managerA = await insertPerson(orgA, 'Org A Elevated Manager');
    const managerB = await insertPerson(orgB, 'Org B Elevated Manager');
    await asPerson(orgA, (tx) => assignRole(tx, { personId: managerA, orgId: orgA, role: 'manager', grantedBy: null }));
    await asPerson(orgB, (tx) => assignRole(tx, { personId: managerB, orgId: orgB, role: 'manager', grantedBy: null }));

    // ⛔ `systemTransaction`, and it MUST stay a bypassing connection — DEF-218, DEF-287.
    //
    // This was `transaction()`, which bypassed RLS only because the harness happened to connect
    // as a superuser. Under `INTEGRATION_RESTRICTED_ROLE=1` that same call has no principal and
    // sees no rows, so the sweep revokes nothing and the case fails — **not because the scoping
    // regressed, but because the test lost the very bypass its method depends on.**
    //
    // ⚠️ The wrong repair here is `withOrgPrincipal(orgA, …)`. It makes the case pass and
    // silently destroys it: with RLS scoping the write, the `exists(...)` correlation could be
    // deleted from `revokeElevationGrantsForOrg` and this test would still be green. That is
    // precisely the masked test the comment above exists to prevent, which is why the bypass is
    // re-armed explicitly instead of being inherited from whatever the connection happens to be.
    //
    // `systemTransaction()` resolves to `SYSTEM_DATABASE_URL ?? DATABASE_URL`, so it is the
    // privileged connection with the flag on and unchanged with it off. ⭐ It does NOT widen
    // `client.ts`'s closed caller list: that guard scans `apps` and `packages/domain/src` for
    // PRODUCTION authority, and this is a test asserting a property of production code.
    const revoked = await systemTransaction((tx) =>
      accessRepo.revokeElevationGrantsForOrg(tx, orgA, 'case 13 — org-scoping proof'),
    );

    expect(revoked.every((g) => g.personId === managerA)).toBe(true);
    expect(revoked.some((g) => g.personId === managerB)).toBe(false);

    const [rowA] = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from person_grants where person_id = ${managerA} and grant_name = 'manage_users'
    `;
    const [rowB] = await sql<{ revoked_at: Date | null; grant_source: string | null }[]>`
      select revoked_at, grant_source from person_grants where person_id = ${managerB} and grant_name = 'manage_users'
    `;
    expect(rowA!.revoked_at).not.toBeNull();
    expect(rowB!.revoked_at).toBeNull();
    expect(rowB!.grant_source).toBe('elevation');
  });

  it('⚠️ the CHECK constraint refuses a revoked row with a NULL or blank reason — proven raw, not inherited from T-239', async () => {
    const org = await insertOrg('t248-check-constraint');
    const person = await insertPerson(org, 'Grant Holder');
    const { id: grantId } = await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: person, grantName: 'manage_price_lists', grantedBy: null, grantSource: 'grant' }),
    );

    // ⛔ The null-blind trap: a CHECK passes when its expression is NULL, so the naive spelling
    // `revoked_at is not null and btrim(revoke_reason) <> ''` would ACCEPT this row. This is the
    // control that proves the actual constraint's explicit `is not null` term is doing the work.
    await expect(forceRevoke(grantId, null)).rejects.toThrow(/person_grants_revoke_check/);
    await expect(forceRevoke(grantId, '   ')).rejects.toThrow(/person_grants_revoke_check/);

    const [row] = await sql<{ revoked_at: Date | null }[]>`select revoked_at from person_grants where id = ${grantId}`;
    expect(row!.revoked_at).toBeNull(); // both attempts rolled back — still live
  });
});

// ---------------------------------------------------------------------------------------
// Role assignment mechanics — REVOKE-then-INSERT, never an update-in-place (schema/access.ts's
// top comment). Not a numbered invariant on its own; exercised because assignRole's
// correctness is load-bearing for every invariant above that calls it.
// ---------------------------------------------------------------------------------------

describe('assignRole — revoke-then-insert, full history preserved', () => {
  it('changing a person\'s role revokes the old row and inserts a new one, never an UPDATE', async () => {
    const org = await insertOrg('reassign');
    const store = await insertStore(org, 'reassign-store');
    const person = await insertPerson(org, 'Changes Role');
    await insertStoreScopeRaw(person, store);
    const first = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'staff', grantedBy: null }));
    const second = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'manager', grantedBy: null }));

    expect(second.roleId).not.toBe(first.roleId);

    const rows = await sql<{ id: string; role: string; revoked_at: Date | null }[]>`
      select id, role, revoked_at from person_roles where person_id = ${person} order by granted_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first.roleId, role: 'staff' });
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ id: second.roleId, role: 'manager' });
    expect(rows[1]!.revoked_at).toBeNull();

    // And the ACTIVE role is the new one — authorize() sees 'manager', not 'staff'. T-318
    // emptied every matrix cell for 'staff' (invariant 5's comment above), so there is no
    // longer a "staff holds this, but not this" pair to contrast; void_sales_day alone still
    // makes the point — denied as staff (untested here, already covered by invariant 5),
    // granted as manager, immediately below.
    expect(CAPABILITY_MATRIX.void_sales_day.staff).toBe(false);
    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'void_sales_day', { storeId: store }))).resolves.toBeUndefined();
  });

  it('a person with no role at all is denied EVERYTHING — no implicit lowest-privilege default', async () => {
    const org = await insertOrg('norole');
    const person = await insertPerson(org, 'Unconfigured');
    const actor: Actor = { personId: person, orgId: org };
    // record_sale was the most widely granted capability in the whole matrix before T-318
    // (all four roles held it). T-318 emptied 'staff' entirely (invariant 5's comment above),
    // so record_sale is now granted to three of four roles, not all four — but that does not
    // weaken this test: axis 3a (role resolution) runs and throws BEFORE the capability is
    // ever looked up, so a person with no active role at all is refused regardless of which
    // capability's matrix cells are true. No storeId is passed: there is nothing meaningful
    // to pass once role resolution has already thrown.
    expect(ROLES.filter((r) => r !== 'staff').every((r) => CAPABILITY_MATRIX.record_sale[r])).toBe(true);
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'record_sale', {}))).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------------------
// T-256 / DEF-247 — `grantsForPerson` (the /admin/users read path) surfaces `grant_source` and
// `revoke_reason`, which it did not select before this task. Two things must be true at once:
// a real source/reason round-trips unchanged, and a NULL source (DEF-237's permanent residue,
// same raw-insert idiom `case 6` above uses) round-trips as NULL — never coerced to a string,
// never guessed from the revoke reason sitting next to it.
// ---------------------------------------------------------------------------------------

describe('T-256 — DEF-247: grantsForPerson surfaces grant_source and revoke_reason', () => {
  it('a real grant_source and revoke_reason round-trip, and revoking never touches the stored source', async () => {
    const org = await insertOrg('t256-round-trip');
    const person = await insertPerson(org, 'Grant Holder');

    const { id: grantId } = await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: person, grantName: 'post_journal_entry', grantedBy: null, grantSource: 'grant' }),
    );

    const [active] = await asPerson(org, (tx) => accessRepo.grantsForPerson(tx, person));
    expect(active).toMatchObject({ id: grantId, grantSource: 'grant', revokeReason: null, revokedAt: null });

    await asPerson(org, (tx) => accessRepo.revokeGrantById(tx, grantId, 'a real reason, typed by an administrator'));

    const [revoked] = await asPerson(org, (tx) => accessRepo.grantsForPerson(tx, person));
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.revokeReason).toBe('a real reason, typed by an administrator');
    // ⛔ Invariant 1 — a revoke writes revoked_at/revoke_reason and NOTHING else. If this task's
    // write path ever touched grant_source, this is where it would show.
    expect(revoked!.grantSource).toBe('grant');
  });

  it('⛔ a NULL grant_source (pre-existing row, DEF-237 residue) reads back as null, never a guess', async () => {
    const org = await insertOrg('t256-null-source');
    const person = await insertPerson(org, 'Legacy Grant Holder');
    // Same idiom as the T-248 block's case 6 above: simulates a row written before migration
    // 0140 existed. Not revoked, so revoke_reason is legitimately null too (the constraint only
    // demands a reason once revoked_at is set).
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${person}, 'void_sales_day', null, null)`;

    const [row] = await asPerson(org, (tx) => accessRepo.grantsForPerson(tx, person));
    expect(row!.grantSource).toBeNull();
    expect(row!.revokeReason).toBeNull();
  });
});
