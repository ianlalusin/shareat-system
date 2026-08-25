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
 * ## ⭐ Invariant 5 — every one of the 38 capabilities, not a sample
 *
 * CAPABILITY-MATRIX.md and the task spec's prose both say "36" — the table itself has 38
 * rows (tests/unit/capability-matrix.test.ts pins this and the task report explains it as
 * a found spec defect). This file tests against the ACTUAL 38, generated from
 * `CAPABILITY_MATRIX` itself via `it.each` rather than hand-written per capability — the
 * same "parsed/derived, not hand-compared" discipline invariant 3 applies to the matrix's
 * CONTENT applied here to the TEST COVERAGE: a hand-written list of 38 `it()` blocks could
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

import { accessRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import {
  authorize,
  assignRole,
  elevateManager,
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

describe('invariant 5 — every capability denies a role that lacks it (all 38)', () => {
  const denialCases: { capability: Capability; role: Role }[] = CAPABILITIES.flatMap((capability) =>
    ROLES.filter((role) => !CAPABILITY_MATRIX[capability][role]).map((role) => ({ capability, role })),
  );

  // Seven capabilities are held by ALL FOUR roles (record_sale, submit_sales_day,
  // create_expense, edit_own_expense, record_stock_movement, record_wastage,
  // create_wholesale_order — the "everyone on shift" set) and so have NO role to deny;
  // invariant 5 is vacuously satisfied for these, not violated. This is a floor: it pins
  // the KNOWN, reasoned-about set exactly, so a broken CAPABILITY_MATRIX import (e.g.
  // resolving to an empty object, or a capability silently losing its one denying role)
  // is caught here rather than passing vacuously one level up.
  const UNIVERSALLY_GRANTED: readonly Capability[] = [
    'record_sale',
    'submit_sales_day',
    'create_expense',
    'edit_own_expense',
    'record_stock_movement',
    'record_wastage',
    'create_wholesale_order',
  ];

  it('every capability EXCEPT the universally-granted 7 has at least one denial case', () => {
    const covered = new Set(denialCases.map((c) => c.capability));
    const missing = CAPABILITIES.filter((c) => !covered.has(c));
    expect(missing.sort()).toEqual([...UNIVERSALLY_GRANTED].sort());
  });

  it('the universally-granted 7 really are true for all four roles (why they are exempt)', () => {
    for (const c of UNIVERSALLY_GRANTED) {
      expect(ROLES.every((r) => CAPABILITY_MATRIX[c][r]), `${c} is not actually universal`).toBe(true);
    }
  });

  it('every OTHER capability (31 of 38) has a denial case for EVERY role that lacks it, not just one', () => {
    // Stronger than the letter of invariant 5 ("a role", singular) — proves the sweep
    // below is exhaustive over false cells, not merely non-empty.
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

describe('invariant 4 — a role holding the capability, in scope, passes (all 38)', () => {
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

  it('staffA holds create_expense but not storeA2 — denied', async () => {
    expect(CAPABILITY_MATRIX.create_expense.staff).toBe(true);
    const actor: Actor = { personId: staffA, orgId: orgA };
    await expect(asPerson(orgA, (tx) => authorize(tx, actor, 'create_expense', { storeId: storeA2 }))).rejects.toThrow(
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

    await asPerson(org, (tx) => accessRepo.revokeGrantById(tx, row!.id));

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
      accessRepo.grantCapability(tx, { personId: person, grantName: 'manage_price_lists', grantedBy: null }),
    );
    await asPerson(org, (tx) => accessRepo.revokeGrantById(tx, firstGrantId));

    const { id: secondGrantId } = await asPerson(org, (tx) =>
      accessRepo.grantCapability(tx, { personId: person, grantName: 'manage_price_lists', grantedBy: null }),
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

    // And the ACTIVE role is the new one — authorize() sees 'manager', not 'staff'.
    expect(CAPABILITY_MATRIX.create_wholesale_order.staff).toBe(true);
    expect(CAPABILITY_MATRIX.void_sales_day.staff).toBe(false);
    const actor: Actor = { personId: person, orgId: org };
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'void_sales_day', { storeId: store }))).resolves.toBeUndefined();
  });

  it('a person with no role at all is denied EVERYTHING — no implicit lowest-privilege default', async () => {
    const org = await insertOrg('norole');
    const person = await insertPerson(org, 'Unconfigured');
    const actor: Actor = { personId: person, orgId: org };
    // record_sale is the most widely granted capability in the whole matrix (all four
    // roles hold it) — if even THIS is denied, "no role" really does mean "nothing". No
    // storeId is passed: role resolution fails and throws before the store check is ever
    // reached, so there is nothing meaningful to pass.
    expect(ROLES.every((r) => CAPABILITY_MATRIX.record_sale[r])).toBe(true);
    await expect(asPerson(org, (tx) => authorize(tx, actor, 'record_sale', {}))).rejects.toThrow(AuthorizationError);
  });
});
