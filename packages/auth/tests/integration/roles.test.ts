import { config } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-219 — role MUTATION behaviour, against real PostgreSQL (PROJECT_BIBLE.md §9 rule 3).
 *
 * Separate from `authorize.test.ts`, which proves T-121's thirteen invariants about the
 * CHECK. This file covers the two things a role WRITE must do that no check can:
 *
 * 1. **`assignRole` materialises an admin's store scope** — `CAPABILITY-MATRIX.md` §C.2,
 *    decided 2026-08-25 and never implemented (DEF-180). *"Assigning the admin role
 *    materialises a `person_store_scope` row for every store in that org, at assignment
 *    time"*, keeping it **rows, never a bypass** (bible row 114).
 * 2. **`assignRoleAsActor` enforces the authority chain and the two lockout guards** —
 *    §C.1: `manage_users` is one boolean, so an admin holding it can assign *another
 *    admin*, the exact lateral move bible row 116 forbids. §C.1's own words: *"a capability
 *    answers 'what may you do', never 'to whom'. Where the target's own level matters, the
 *    check belongs at the call site and must be tested there."*
 *
 * ⚠️ **Why the chain is enforced in `packages/auth` and not in the Next server action**, which
 * is the literal reading of §C.1's "the role-assignment server action carries that extra
 * condition": a rule that lives in one caller is a rule the second caller re-discovers. That
 * is precisely how DEF-180 happened — §C.2 was decided in a document and never written into
 * the function it described. `assignRoleAsActor` is the one gated entry point every caller
 * must pass through, and unlike a server action it is testable here against real Postgres
 * with no Next runtime. `assignRole` itself stays the ungated primitive T-121 deliberately
 * made it (see `roles.ts`'s own top comment about the one-way layering).
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
import { assignRole, assignRoleAsActor, AuthorizationError, type Actor, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 5 });

/** Same RLS context every real mutation runs under (T-120), mirroring `authorize.test.ts`. */
async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`roles-${hint}`);
  const [row] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

async function insertStore(orgId: string, hint: string, isActive = true): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, is_active) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${isActive}) returning id
  `;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  return row!.id;
}

/** Direct SQL, so a fixture persona gets exactly this row and no grant-time side effects —
 *  the same reasoning `authorize.test.ts`'s own `insertRoleRaw` states. */
async function insertRoleRaw(personId: string, orgId: string, role: Role): Promise<void> {
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
}

async function scopeRowsFor(personId: string): Promise<string[]> {
  const rows = await sql<{ store_id: string }[]>`select store_id from person_store_scope where person_id = ${personId} order by store_id`;
  return rows.map((r) => r.store_id);
}

const actorOf = (personId: string, orgId: string): Actor => ({ personId, orgId });

beforeAll(async () => {
  await sql`truncate table person_grants, person_store_scope, person_roles, persons, stores, organizations restart identity cascade`;
});

// -----------------------------------------------------------------------------------------
// DEF-180 / CAPABILITY-MATRIX.md §C.2
// -----------------------------------------------------------------------------------------

describe('assignRole — appointing an admin materialises their store scope (§C.2)', () => {
  it('grants a scope row for every ACTIVE store in the org', async () => {
    const org = await insertOrg('c2');
    const s1 = await insertStore(org, 's1');
    const s2 = await insertStore(org, 's2');
    const s3 = await insertStore(org, 's3');
    const person = await insertPerson(org, 'New Admin');

    const result = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.materialisedStoreIds.slice().sort()).toEqual([s1, s2, s3].sort());
    expect(await scopeRowsFor(person)).toEqual([s1, s2, s3].sort());
  });

  it('excludes an INACTIVE store — "all" means every ACTIVE row', async () => {
    const org = await insertOrg('c2-inactive');
    const live = await insertStore(org, 'live');
    await insertStore(org, 'closed', false);
    const person = await insertPerson(org, 'Admin');

    const result = await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'admin', grantedBy: null }));

    expect(result.materialisedStoreIds).toEqual([live]);
  });

  it('does NOT materialise scope for a manager or a staff member', async () => {
    const org = await insertOrg('c2-nonadmin');
    await insertStore(org, 's1');
    const manager = await insertPerson(org, 'Manager');
    const staff = await insertPerson(org, 'Staff');

    const m = await asPerson(org, (tx) => assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }));
    const s = await asPerson(org, (tx) => assignRole(tx, { personId: staff, orgId: org, role: 'staff', grantedBy: null }));

    expect(m.materialisedStoreIds).toEqual([]);
    expect(s.materialisedStoreIds).toEqual([]);
    expect(await scopeRowsFor(manager)).toEqual([]);
    expect(await scopeRowsFor(staff)).toEqual([]);
  });

  it('is idempotent — re-appointing an admin who already holds scope adds no duplicate row', async () => {
    const org = await insertOrg('c2-idem');
    const s1 = await insertStore(org, 's1');
    const person = await insertPerson(org, 'Admin');

    await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'admin', grantedBy: null }));
    await asPerson(org, (tx) => assignRole(tx, { personId: person, orgId: org, role: 'admin', grantedBy: null }));

    expect(await scopeRowsFor(person)).toEqual([s1]);
  });
});

// -----------------------------------------------------------------------------------------
// CAPABILITY-MATRIX.md §C.1 — the authority chain
// -----------------------------------------------------------------------------------------

describe('assignRoleAsActor — the authority chain (§C.1)', () => {
  it('lets an admin assign a manager', async () => {
    const org = await insertOrg('c1-ok');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Target');

    const result = await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(admin, org), { personId: target, role: 'manager' }),
    );

    expect(result.roleId).toBeTruthy();
    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row?.role).toBe('manager');
  });

  it('REFUSES an admin appointing another admin — the lateral move bible row 116 forbids', async () => {
    const org = await insertOrg('c1-lateral');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Would-be Admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(AuthorizationError);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row).toBeUndefined();
  });

  it('lets a super_admin assign an admin', async () => {
    const org = await insertOrg('c1-super');
    await insertStore(org, 's1');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    const target = await insertPerson(org, 'New Admin');

    const result = await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: target, role: 'admin' }),
    );

    expect(result.materialisedStoreIds).toHaveLength(1);
    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row?.role).toBe('admin');
  });

  it('REFUSES a manager outright — manage_users is matrix-false for manager', async () => {
    const org = await insertOrg('c1-manager');
    const manager = await insertPerson(org, 'Manager');
    await insertRoleRaw(manager, org, 'manager');
    const target = await insertPerson(org, 'Target');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(manager, org), { personId: target, role: 'staff' })),
    ).rejects.toThrow(AuthorizationError);
  });
});

// -----------------------------------------------------------------------------------------
// The two lockout guards
// -----------------------------------------------------------------------------------------

describe('assignRoleAsActor — cross-org targets', () => {
  /**
   * ⚠️ The one access table whose RLS policy cannot catch this. `person_store_scope` and
   * `person_grants` derive their org THROUGH the person
   * (`... EXISTS (SELECT 1 FROM persons p WHERE p.id = ... AND p.org_id = app_current_org())`,
   * with an explicit `WITH CHECK`), so a cross-org write to either is refused by Postgres.
   * `person_roles` carries its OWN `org_id` and its policy is `org_id = app_current_org()` —
   * satisfied by a row that names this org and a person belonging to a different one. The FK
   * to `persons` is satisfied too, because the person genuinely exists.
   *
   * The row grants nothing (`authorize()` looks the target's role up under THEIR org, where it
   * does not exist) but it is a cross-org write, invisible on both orgs' screens, and bible
   * invariant 7 says cross-org access is denied. Closed at the call site because closing it in
   * the policy would be a migration, and T-219 changes no schema.
   */
  it('REFUSES assigning a role to a person who belongs to another org', async () => {
    const orgA = await insertOrg('xorg-a');
    const orgB = await insertOrg('xorg-b');
    const admin = await insertPerson(orgA, 'Org A Admin');
    await insertRoleRaw(admin, orgA, 'admin');
    const outsider = await insertPerson(orgB, 'Org B Person');

    await expect(
      asPerson(orgA, (tx) => assignRoleAsActor(tx, actorOf(admin, orgA), { personId: outsider, role: 'manager' })),
    ).rejects.toThrow(AuthorizationError);

    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from person_roles where person_id = ${outsider}`;
    expect(row!.n).toBe(0);
  });
});

describe('assignRoleAsActor — lockout guards', () => {
  it('REFUSES an actor changing their own role', async () => {
    const org = await insertOrg('guard-self');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: admin, role: 'staff' })),
    ).rejects.toThrow(AuthorizationError);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, admin, org));
    expect(row?.role).toBe('admin');
  });

  it('REFUSES demoting the org\'s only active admin', async () => {
    const org = await insertOrg('guard-last');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    const onlyAdmin = await insertPerson(org, 'Only Admin');
    await insertRoleRaw(onlyAdmin, org, 'admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: onlyAdmin, role: 'manager' })),
    ).rejects.toThrow(AuthorizationError);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, onlyAdmin, org));
    expect(row?.role).toBe('admin');
  });

  it('ALLOWS demoting one admin when a second still holds the role', async () => {
    const org = await insertOrg('guard-two');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    const adminOne = await insertPerson(org, 'Admin One');
    await insertRoleRaw(adminOne, org, 'admin');
    const adminTwo = await insertPerson(org, 'Admin Two');
    await insertRoleRaw(adminTwo, org, 'admin');

    await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: adminOne, role: 'manager' }));

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, adminOne, org));
    expect(row?.role).toBe('manager');
  });

  it('leaves a demoted admin\'s store scope in place — visible, not silently cut', async () => {
    const org = await insertOrg('guard-scope');
    const s1 = await insertStore(org, 's1');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    const keeper = await insertPerson(org, 'Keeper Admin');
    await insertRoleRaw(keeper, org, 'admin');
    const demoted = await insertPerson(org, 'Demoted');

    await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: demoted, role: 'admin' }));
    expect(await scopeRowsFor(demoted)).toEqual([s1]);

    await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: demoted, role: 'manager' }));

    expect(await scopeRowsFor(demoted)).toEqual([s1]);
  });
});
