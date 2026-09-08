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
import {
  assignRole,
  assignRoleAsActor,
  AuthorizationError,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  grantCapabilityAsActor,
  type Actor,
  type Capability,
  type Role,
} from '@shareat/auth';

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

/**
 * A live `firebase` credential — the cheapest way to say "this person can sign in".
 *
 * ⭐ T-238: the lockout guard counts administrators who can ACTUALLY GET IN, not role rows, so a
 * fixture that grants a role and stops has not created another administrator in the sense the guard
 * means. Two tests below were written under the old rule and had to gain this line.
 */
async function giveCredential(personId: string): Promise<void> {
  await sql`insert into person_credentials (person_id, kind, external_id)
            values (${personId}, 'firebase', ${uid('cred')})`;
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

  it('REFUSES demoting the last administrator who can SIGN IN — a credential-less role row is not another way in', async () => {
    // ⭐ T-238. This passed before too, and for the wrong reason: the guard counted only the literal
    // role 'admin', so the super_admin was invisible to it. Now the super_admin IS counted, and the
    // refusal rests on their holding no credential — the next test is this fixture plus one
    // credential, and it is ALLOWED.
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
    // ⚠️ T-238 — this line is the expectation flipping into view. "A second admin still holds the
    // role" is no longer enough: the guard asks whether anybody can still sign in AND manage users,
    // and a role row with no credential answers no.
    await giveCredential(adminTwo);

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
    await giveCredential(keeper); // T-238 — the keeper must be able to sign in, or they are not a keeper
    const demoted = await insertPerson(org, 'Demoted');

    await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: demoted, role: 'admin' }));
    expect(await scopeRowsFor(demoted)).toEqual([s1]);

    await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: demoted, role: 'manager' }));

    expect(await scopeRowsFor(demoted)).toEqual([s1]);
  });
});

// -----------------------------------------------------------------------------------------
// T-238 — DEF-232 and the two holes DEF-232 did not know about
// -----------------------------------------------------------------------------------------

describe('T-238 — the lockout guard asks whether anyone is LEFT who can manage users', () => {
  it('⭐ ALLOWS demoting the last admin when a super_admin who can sign in remains — was a false refusal', async () => {
    // ⛔ Before T-238 this was REFUSED: `hasOtherActiveAdmin` counted the literal role 'admin', so an
    // organisation that still held a super_admin — matrix-true for `manage_users` — was told it
    // would be left with nobody able to manage users. It would not have been.
    const org = await insertOrg('t238-false-refusal');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    await giveCredential(superAdmin);
    const onlyAdmin = await insertPerson(org, 'Only Admin');
    await insertRoleRaw(onlyAdmin, org, 'admin');

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: onlyAdmin, role: 'manager' }),
    );

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, onlyAdmin, org));
    expect(row?.role).toBe('manager');
  });

  it('⛔ REFUSES demoting a SUPER_ADMIN when nobody able to sign in is left — was unguarded entirely', async () => {
    // ⛔ Before T-238 the branch read `targetRole?.role === 'admin'`, so a super_admin target skipped
    // the guard completely — no lock could have helped, because there was no check to serialise.
    //
    // ⚠️ The actor holds NO credential. That is an odd state on purpose: it is the only way, in one
    // transaction, to reach "the target is the last administrator who can sign in" while somebody
    // still has the authority to issue the demotion. The guard is about the state, not about how
    // the state was reached.
    //
    // ⭐ **T-242 changed the actor's ROLE here, from `admin` to `super_admin`, and the reason
    // matters.** DEF-234 added a rank check that runs BEFORE this guard, so an *admin* actor is now
    // refused for outranking — a different, more specific refusal — and this case would have stopped
    // exercising the thing it was written for. Its subject is the LOCKOUT GUARD covering a
    // `super_admin` TARGET (before T-238 the branch read `targetRole?.role === 'admin'` and skipped
    // it entirely), so the actor becomes a peer: rank passes, and the guard is once again the thing
    // that fires. ⛔ The assertion is unchanged. `DEF-234 — removal requires rank` case 7 is the
    // case that now owns the admin-actor version of this fixture, and it asserts the rank message.
    const org = await insertOrg('t238-superadmin-target');
    const actorAdmin = await insertPerson(org, 'Super Admin With No Way In');
    await insertRoleRaw(actorAdmin, org, 'super_admin');
    const onlySuper = await insertPerson(org, 'Only Super');
    await insertRoleRaw(onlySuper, org, 'super_admin');
    await giveCredential(onlySuper);

    await expect(
      asPerson(org, (tx) =>
        assignRoleAsActor(tx, actorOf(actorAdmin, org), { personId: onlySuper, role: 'staff' }),
      ),
    ).rejects.toThrow(/only active admin who can sign in/);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, onlySuper, org));
    expect(row?.role).toBe('super_admin');
  });

  it('⭐ two administrators demoting EACH OTHER at once: exactly one succeeds, and the org keeps an administrator', async () => {
    /**
     * DEF-232's end state, asserted. Whichever transaction wins is fine: exactly one succeeds, and —
     * the invariant that actually matters — somebody who can manage users is still standing.
     *
     * ⛔ **Stated honestly: this is NOT the lock's proof, and it was checked.** With
     * `lockOrgAccess` commented out, this case still passed: the two transactions are fast enough
     * that they usually do not overlap at all, so the defect it describes does not reproduce on
     * demand. Making it reproduce would mean interleaving the two transactions' statements by hand,
     * which stops testing `assignRoleAsActor` and starts testing hand-written SQL.
     *
     * ⭐ **The lock's proof is the next test**, which fails with the lock removed. This one is the
     * invariant that must hold however the two interleave — worth having, and worth not overclaiming.
     */
    const org = await insertOrg('t238-race');
    const first = await insertPerson(org, 'Admin One');
    await insertRoleRaw(first, org, 'admin');
    await giveCredential(first);
    const second = await insertPerson(org, 'Admin Two');
    await insertRoleRaw(second, org, 'admin');
    await giveCredential(second);

    const results = await Promise.allSettled([
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(first, org), { personId: second, role: 'staff' })),
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(second, org), { personId: first, role: 'staff' })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    /**
     * ⭐ **WHICH refusal is worth reading, and it is not the one I expected.** The loser is refused
     * by `authorize` — not by the lockout guard — because the winner's commit removed the loser's
     * own admin role before its transaction got the lock, so by the time it runs it no longer holds
     * `manage_users` at all. That is the serialisation working, one layer earlier than the guard: an
     * actor demoted a moment ago cannot demote anybody.
     *
     * ⚠️ The assertion is therefore on the CLASS, not on a sentence. Pinning the guard's wording here
     * would have pinned an outcome that depends on which transaction won the lock.
     */
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AuthorizationError);

    const roles = await Promise.all([
      asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, first, org)),
      asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, second, org)),
    ]);
    expect(roles.filter((r) => r?.role === 'admin')).toHaveLength(1);
  });

  /**
   * ⭐ **Pinned rather than reasoned.** `isAdministrative` on BOTH halves means a move between the
   * two administrative roles never enters the guard at all — the organisation is not losing an
   * administrator, so there is nothing to protect. That was verified by reading during review, and a
   * behaviour verified by reading is verified once.
   *
   * ⛔ **What these two cases actually catch**: the next person who "simplifies" the condition to
   * something like `targetRole?.role !== input.role`. That version enters the branch on a promotion,
   * finds no OTHER administrator who can sign in, and refuses — a false refusal on every
   * admin↔super_admin change, with a green suite behind it. Which is the exact shape this task
   * exists to close.
   *
   * ⚠️ Both fixtures give the ACTOR the administrative role and NO credential, deliberately: it is
   * what makes the target the only administrator who can sign in, so a wrongly-written condition has
   * something to trip over. The fixture is a state, not a story.
   */
  it('⭐ an admin → super_admin change never trips the lockout guard — the org is not losing an administrator', async () => {
    const org = await insertOrg('t238-promote');
    const actorSuper = await insertPerson(org, 'Super Without A Way In');
    await insertRoleRaw(actorSuper, org, 'super_admin');
    const onlyWayIn = await insertPerson(org, 'The Only Administrator Who Can Sign In');
    await insertRoleRaw(onlyWayIn, org, 'admin');
    await giveCredential(onlyWayIn);

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(actorSuper, org), { personId: onlyWayIn, role: 'super_admin' }),
    );

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, onlyWayIn, org));
    expect(row?.role).toBe('super_admin');
  });

  it('⭐ and a super_admin → admin change does not either — the same rule, the other direction', async () => {
    const org = await insertOrg('t238-demote-sideways');
    const actorSuper = await insertPerson(org, 'Super Without A Way In');
    await insertRoleRaw(actorSuper, org, 'super_admin');
    const onlyWayIn = await insertPerson(org, 'The Only Administrator Who Can Sign In');
    await insertRoleRaw(onlyWayIn, org, 'super_admin');
    await giveCredential(onlyWayIn);

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(actorSuper, org), { personId: onlyWayIn, role: 'admin' }),
    );

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, onlyWayIn, org));
    expect(row?.role).toBe('admin');
  });

  it('⭐ assignRoleAsActor really TAKES the org lock — asserted through the call, not through the helper', async () => {
    // ⚠️ The before check is the control: a connection already holding an advisory lock would
    // satisfy the after check no matter what the call did. Same shape T-237 ended up with, after a
    // first version there proved the helper and claimed the caller.
    const org = await insertOrg('t238-lock');
    const superAdmin = await insertPerson(org, 'Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    await giveCredential(superAdmin);
    const target = await insertPerson(org, 'Target');

    const advisoryLocks = async (tx: Tx): Promise<number> => {
      const rows = await tx.execute(
        dsql`select count(*)::int as n from pg_locks
             where locktype = 'advisory' and pid = pg_backend_pid()`,
      );
      return Number((rows as unknown as { n: number }[])[0]!.n);
    };

    await asPerson(org, async (tx) => {
      expect(await advisoryLocks(tx)).toBe(0);
      await assignRoleAsActor(tx, actorOf(superAdmin, org), { personId: target, role: 'staff' });
      expect(await advisoryLocks(tx)).toBeGreaterThan(0);
    });
  });
});

// -----------------------------------------------------------------------------------------
// T-232 slice 2 §2.2's residual consequence — the role-literal check, widened to a capability
// -----------------------------------------------------------------------------------------

/**
 * ⭐ **Why this exists.** T-232's first admin cannot hold two role rows —
 * `person_roles_active_person_org_unique` allows exactly one active role per (person, org) — so
 * `createFirstAdmin` gives them the `admin` role **plus** the capabilities `super_admin` holds and
 * `admin` does not, as explicit `person_grants` rows. That is an exact capability equivalence (no
 * capability is `admin: true, super_admin: false`), and `authorize` honours it directly.
 *
 * ⛔ **But `assignRoleAsActor` gated on the role LITERAL, so a grant row could not satisfy it** —
 * the owner of a brand-new organisation could appoint managers and staff and could not appoint a
 * second admin. §2.2 named that as the one residual consequence; this is the fix and its tests.
 *
 * ⚠️ **The set is DERIVED here, independently of the production constant**, from `CAPABILITIES`
 * and `CAPABILITY_MATRIX` — the same discipline `first-run-setup.test.ts` uses. A test that
 * imported `roles.ts`'s own list would agree with it by construction and prove nothing.
 */
const SUPER_ADMIN_ONLY: readonly Capability[] = CAPABILITIES.filter(
  (c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin,
);

describe('assignRoleAsActor — an admin with super_admin-equivalent grants (T-232 §2.2)', () => {
  /** Direct SQL, for the same reason `insertRoleRaw` is: the fixture persona gets exactly these
   *  rows and no grant-time side effects. `granted_by` NULL is the shape `createFirstAdmin` writes. */
  async function grantRaw(personId: string, capabilities: readonly Capability[]): Promise<void> {
    for (const capability of capabilities) {
      await sql`insert into person_grants (person_id, grant_name) values (${personId}, ${capability})`;
    }
  }

  it('the derived set is non-empty — without this, "holds every one" is vacuously true', () => {
    // ⛔ `every()` over an empty array is TRUE. If the matrix ever lost its super_admin-only
    // capabilities, the widened check would silently admit every admin and every assertion below
    // would still pass. This is the sweep's non-zero control.
    expect(SUPER_ADMIN_ONLY.length).toBeGreaterThan(0);
    for (const capability of SUPER_ADMIN_ONLY) {
      expect(CAPABILITY_MATRIX[capability].super_admin).toBe(true);
      expect(CAPABILITY_MATRIX[capability].admin).toBe(false);
    }
  });

  it('ALLOWS an admin holding every super_admin-only capability to appoint a second admin', async () => {
    const org = await insertOrg('t232-owner');
    const store = await insertStore(org, 's1');
    // Exactly the shape `createFirstAdmin` writes: the `admin` role, plus the grants, granted_by NULL.
    const owner = await insertPerson(org, 'First Admin');
    await insertRoleRaw(owner, org, 'admin');
    await grantRaw(owner, SUPER_ADMIN_ONLY);
    const target = await insertPerson(org, 'Second Admin');

    const result = await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(owner, org), { personId: target, role: 'admin' }),
    );

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row?.role).toBe('admin');
    expect(row?.grantedBy).toBe(owner);
    // And §C.2's fan-out still runs for the admin they just appointed.
    expect(result.materialisedStoreIds).toEqual([store]);
  });

  it('ALLOWS that same admin to appoint a super_admin', async () => {
    const org = await insertOrg('t232-super');
    const owner = await insertPerson(org, 'First Admin');
    await insertRoleRaw(owner, org, 'admin');
    await grantRaw(owner, SUPER_ADMIN_ONLY);
    const target = await insertPerson(org, 'New Super');

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(owner, org), { personId: target, role: 'super_admin' }),
    );

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row?.role).toBe('super_admin');
  });

  it('⛔ REFUSES an admin holding all but ONE of them — every, not any', async () => {
    const org = await insertOrg('t232-partial');
    const owner = await insertPerson(org, 'Nearly');
    await insertRoleRaw(owner, org, 'admin');
    await grantRaw(owner, SUPER_ADMIN_ONLY.slice(1));
    const target = await insertPerson(org, 'Would-be Admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(owner, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(AuthorizationError);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row).toBeUndefined();
  });

  it('⛔ REFUSES an admin whose grants were REVOKED — active rows only', async () => {
    const org = await insertOrg('t232-revoked');
    const owner = await insertPerson(org, 'Former Owner');
    await insertRoleRaw(owner, org, 'admin');
    await grantRaw(owner, SUPER_ADMIN_ONLY);
    await sql`update person_grants set revoked_at = now() where person_id = ${owner}`;
    const target = await insertPerson(org, 'Would-be Admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(owner, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔ REFUSES a MANAGER holding all of them — the equivalence is admin + the delta, nothing else', async () => {
    // ⚠️ A manager appointed into an org with no active admin already receives `manage_users` as an
    // elevated grant, so a manager really can reach this check. `manager` + this delta is NOT
    // super_admin — manager lacks most of what admin holds — so it must not appoint one.
    const org = await insertOrg('t232-manager');
    const manager = await insertPerson(org, 'Elevated Manager');
    await insertRoleRaw(manager, org, 'manager');
    await grantRaw(manager, [...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER, ...SUPER_ADMIN_ONLY]);
    const target = await insertPerson(org, 'Would-be Admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(manager, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(AuthorizationError);

    const row = await asPerson(org, (tx) => accessRepo.activeRoleForPerson(tx, target, org));
    expect(row).toBeUndefined();
  });

  it('leaves the ordinary refusal untouched — a PLAIN admin still may not appoint an admin', async () => {
    const org = await insertOrg('t232-plain');
    const admin = await insertPerson(org, 'Plain Admin');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Would-be Admin');

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(/requires super_admin/);
  });
});

// -----------------------------------------------------------------------------------------
// DEF-223 — nobody grants themselves a capability
// -----------------------------------------------------------------------------------------

/**
 * ⛔ **The hole this closes, and why it only became urgent today.**
 *
 * `grant_capability` is matrix-true for `admin`, and
 * `apps/erp/src/app/admin/users/actions.ts` wrote `person_grants` rows straight from the form with
 * **no self-check** — so an admin could grant capabilities to themselves. That already let a rogue
 * admin take every POWER a `super_admin` has.
 *
 * ⚠️ What it could not do was mint the role NAME — until T-232 §2.2 widened
 * `assignRoleAsActor` to accept `admin` + the super_admin-only grants. Self-grant those four and
 * the widened check passes, so the same admin can now appoint further admins and super_admins:
 * bible row 116's chain, hollow on the capability axis, would have gone hollow on the role axis
 * too. The escalation is closed **at its source** rather than by narrowing the widened check,
 * because the missing self-check is the actual defect and the widening is not.
 *
 * ⭐ The rule already existed one function away — `assignRoleAsActor`: *"an actor may not change
 * their own role — ask another admin, so a mistake here cannot lock the org out."* This is the
 * same rule about the other half of the same screen.
 */
describe('grantCapabilityAsActor — nobody grants themselves a capability (DEF-223)', () => {
  const grantsFor = async (personId: string): Promise<string[]> => {
    const rows = await sql<{ grant_name: string }[]>`
      select grant_name from person_grants where person_id = ${personId} and revoked_at is null
      order by grant_name`;
    return rows.map((r) => r.grant_name);
  };

  it('⛔ REFUSES an admin granting a capability to THEMSELVES — the escalation, closed', async () => {
    const org = await insertOrg('def223-self');
    const admin = await insertPerson(org, 'Self-serving Admin');
    await insertRoleRaw(admin, org, 'admin');

    await expect(
      asPerson(org, (tx) =>
        grantCapabilityAsActor(tx, actorOf(admin, org), { personId: admin, capability: 'post_journal_entry' }),
      ),
    ).rejects.toThrow(AuthorizationError);

    // ⭐ The row must not exist. A refusal that still wrote would be the defect with a message.
    expect(await grantsFor(admin)).toEqual([]);
  });

  it('⛔ and so the self-grant route to appointing an admin is closed end to end', async () => {
    // ⚠️ This is the *chain*, not a second copy of the test above: refused the grant, therefore
    // refused the appointment. Without the first refusal this admin would now pass
    // `assignRoleAsActor`'s widened check, which is exactly what made the missing self-check
    // urgent rather than merely untidy.
    const org = await insertOrg('def223-chain');
    const admin = await insertPerson(org, 'Would-be Super');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Would-be Admin');

    for (const capability of SUPER_ADMIN_ONLY) {
      await expect(
        asPerson(org, (tx) =>
          grantCapabilityAsActor(tx, actorOf(admin, org), { personId: admin, capability }),
        ),
      ).rejects.toThrow(AuthorizationError);
    }

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: target, role: 'admin' })),
    ).rejects.toThrow(/requires super_admin/);
  });

  it('ALLOWS granting to somebody ELSE, and records who granted it', async () => {
    const org = await insertOrg('def223-other');
    const admin = await insertPerson(org, 'Granting Admin');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Recipient');
    await insertRoleRaw(target, org, 'manager');

    await asPerson(org, (tx) =>
      grantCapabilityAsActor(tx, actorOf(admin, org), { personId: target, capability: 'post_journal_entry' }),
    );

    expect(await grantsFor(target)).toEqual(['post_journal_entry']);
    // ⛔ `granted_by` is the ACTOR, never null — the authority chain is only a base case at
    // `createFirstAdmin`, and every row after it names who is answerable for it.
    const [row] = await sql<{ granted_by: string | null }[]>`
      select granted_by from person_grants where person_id = ${target}`;
    expect(row!.granted_by).toBe(admin);
  });

  it('⛔ REFUSES a manager outright — the authorize() gate is still the first check', async () => {
    // The non-zero control for the two ALLOW paths: without it, this suite would pass against a
    // function that had lost its `authorize` call and kept only the self-check.
    const org = await insertOrg('def223-manager');
    const manager = await insertPerson(org, 'Manager');
    await insertRoleRaw(manager, org, 'manager');
    const target = await insertPerson(org, 'Target');

    await expect(
      asPerson(org, (tx) =>
        grantCapabilityAsActor(tx, actorOf(manager, org), { personId: target, capability: 'approve_item' }),
      ),
    ).rejects.toThrow(AuthorizationError);

    expect(await grantsFor(target)).toEqual([]);
  });

  it('⛔ REFUSES a capability name that is not a real capability', async () => {
    // ⚠️ The screen casts a form string to `Capability`, so the type is a promise the browser did
    // not make. An unknown name would sit in `person_grants` forever, matching nothing in
    // `authorize` and reading as a granted permission on the very screen that wrote it.
    const org = await insertOrg('def223-bogus');
    const admin = await insertPerson(org, 'Admin');
    await insertRoleRaw(admin, org, 'admin');
    const target = await insertPerson(org, 'Target');

    await expect(
      asPerson(org, (tx) =>
        grantCapabilityAsActor(tx, actorOf(admin, org), {
          personId: target,
          capability: 'become_god' as Capability,
        }),
      ),
    ).rejects.toThrow(/not a known capability/i);

    expect(await grantsFor(target)).toEqual([]);
  });
});

// =========================================================================================
// T-242 / DEF-234 — removing a role requires RANK, not only granting one
// =========================================================================================

/**
 * ⭐ **Ian's rule, 2026-09-08: peer removal.** *An actor may not remove or demote a role SENIOR to
 * their own; a peer may.* An admin may demote an admin; only a super-admin may demote a super-admin.
 *
 * ⛔ **The rule is NOT "the authority to unmake a role is the authority to make it."** That mnemonic
 * was in the register row and it is wrong: making an `admin` requires super-admin authority (row
 * 116), so built literally it would forbid admin-demotes-admin — which is the junior-only option Ian
 * explicitly rejected, on the argument that *"two admins and no super_admin would mean neither could
 * ever remove the other."* He cannot have chosen both. **Case 2 below is what fails if somebody
 * rebuilds the slogan by "simplifying" the ladder into `holdsSuperAdminAuthority`.**
 *
 * ## ⛔ Why a rank ladder rather than a check for a super_admin target
 *
 * A narrow *"is the target a super_admin?"* patch closes the case the register describes and leaves
 * a second door wide open — case 5. `manage_users` is `{admin: true, manager: false}`, so it sits
 * inside `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`, which `assignRole` applies automatically to any
 * manager appointed while `hasActiveAdmin` is false — and `hasActiveAdmin` matches the literal
 * `'admin'`, so a **super_admin-only organisation counts as adminless**. Those grants are never
 * revoked when an admin arrives. A junior can then remove a senior with no admin actor anywhere in
 * the story. Rank closes it because a `manager` is rank 1 and an `admin` is rank 2.
 */
describe('DEF-234 — removal requires rank', () => {
  /** Direct SQL, same reasoning as `insertRoleRaw`: exactly these rows, no grant-time side effects. */
  async function grantRawHere(personId: string, capabilities: readonly Capability[]): Promise<void> {
    for (const capability of capabilities) {
      await sql`insert into person_grants (person_id, grant_name) values (${personId}, ${capability})`;
    }
  }

  /** Two spare administrators who can sign in, so T-238's lockout guard is never the thing that
   *  fires. ⛔ Load-bearing: without them a rank case would pass for the lockout's reason. */
  async function padWithAdmins(orgId: string, howMany = 2): Promise<void> {
    for (let i = 0; i < howMany; i++) {
      const spare = await insertPerson(orgId, `Spare Admin ${i}`);
      await insertRoleRaw(spare, orgId, 'admin');
      await giveCredential(spare);
    }
  }

  const roleOf = (personId: string, orgId: string) =>
    asPerson(orgId, (tx) => accessRepo.activeRoleForPerson(tx, personId, orgId));

  it('⛔ case 1: an ADMIN may not demote a SUPER_ADMIN, even with other admins standing', async () => {
    // ⚠️ The spare admins are the point. Remove them and T-238's guard refuses first, and this case
    // would go green while proving nothing about rank.
    const org = await insertOrg('d234-admin-v-super');
    const actor = await insertPerson(org, 'Ordinary Admin');
    await insertRoleRaw(actor, org, 'admin');
    await giveCredential(actor);
    const target = await insertPerson(org, 'The Super Admin');
    await insertRoleRaw(target, org, 'super_admin');
    await giveCredential(target);
    await padWithAdmins(org);

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(actor, org), { personId: target, role: 'staff' })),
    ).rejects.toThrow(AuthorizationError);

    expect((await roleOf(target, org))?.role).toBe('super_admin');
  });

  it('⭐ case 2: an ADMIN MAY demote a peer ADMIN — the rule is peer removal, not the slogan', async () => {
    // ⛔ THE case that fails if 5b is "simplified" into holdsSuperAdminAuthority. Under the slogan
    // this refuses; under Ian's rule it succeeds, and Ian's rule is the one that was chosen.
    const org = await insertOrg('d234-admin-v-admin');
    const actor = await insertPerson(org, 'Admin One');
    await insertRoleRaw(actor, org, 'admin');
    await giveCredential(actor);
    const target = await insertPerson(org, 'Admin Two');
    await insertRoleRaw(target, org, 'admin');
    await giveCredential(target);
    await padWithAdmins(org);

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(actor, org), { personId: target, role: 'manager' }),
    );
    expect((await roleOf(target, org))?.role).toBe('manager');
  });

  it('⭐ case 3: a SUPER_ADMIN may demote a SUPER_ADMIN — peer removal, upward', async () => {
    const org = await insertOrg('d234-super-v-super');
    const actor = await insertPerson(org, 'Super One');
    await insertRoleRaw(actor, org, 'super_admin');
    await giveCredential(actor);
    const target = await insertPerson(org, 'Super Two');
    await insertRoleRaw(target, org, 'super_admin');
    await giveCredential(target);
    await padWithAdmins(org);

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(actor, org), { personId: target, role: 'staff' }),
    );
    expect((await roleOf(target, org))?.role).toBe('staff');
  });

  it('⭐ case 4: an ADMIN + every super_admin-only grant MAY demote a SUPER_ADMIN', async () => {
    /**
     * ⛔ The new organisation's owner. `createFirstAdmin` cannot give them a `super_admin` role row
     * (one active role per person+org), so they hold `admin` plus the four grants — an exact
     * capability equivalence T-232 §2.2 already taught the APPOINTMENT check to accept.
     *
     * ⚠️ A rank ladder built from the role literal alone would refuse this, and the owner would be
     * locked out of removing a super-admin they themselves appointed. The symptom would arrive
     * months later, on a screen, with nothing pointing here.
     */
    const org = await insertOrg('d234-owner-v-super');
    const owner = await insertPerson(org, 'Org Owner');
    await insertRoleRaw(owner, org, 'admin');
    await grantRawHere(owner, SUPER_ADMIN_ONLY);
    await giveCredential(owner);
    const target = await insertPerson(org, 'Appointed Super');
    await insertRoleRaw(target, org, 'super_admin');
    await giveCredential(target);
    await padWithAdmins(org);

    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(owner, org), { personId: target, role: 'manager' }),
    );
    expect((await roleOf(target, org))?.role).toBe('manager');
  });

  it('⛔ case 5: a MANAGER holding manage_users by grant may not demote an ADMIN — but may demote STAFF', async () => {
    /**
     * ⭐ **The second door, and the reason this is a ladder rather than a super_admin check.**
     *
     * Built the way it actually happens rather than by hand-granting: the org's only administrator
     * holds `super_admin`, so `hasActiveAdmin` — which matches the literal `'admin'` — is FALSE, and
     * `assignRole` hands the incoming manager every capability admin has and manager does not.
     * `manage_users` is one of them. Nothing revokes it when an admin is appointed afterwards.
     *
     * ⚠️ The elevation is asserted rather than assumed: if `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
     * ever stopped containing `manage_users`, this test would otherwise quietly stop testing
     * anything — passing because the manager was refused at `authorize` instead of at the ladder.
     */
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain('manage_users' as Capability);

    const org = await insertOrg('d234-manager-v-admin');
    const superAdmin = await insertPerson(org, 'Only Super');
    await insertRoleRaw(superAdmin, org, 'super_admin');
    await giveCredential(superAdmin);

    // Step 1: appointed while the org is "adminless" in `hasActiveAdmin`'s literal sense.
    const manager = await insertPerson(org, 'Elevated Manager');
    const elevated = await asPerson(org, (tx) =>
      assignRole(tx, { personId: manager, orgId: org, role: 'manager', grantedBy: null }),
    );
    expect(elevated.elevatedGrants).toContain('manage_users' as Capability);

    // Step 2: an admin arrives afterwards. The manager keeps the grant.
    const admin = await insertPerson(org, 'Later Admin');
    await insertRoleRaw(admin, org, 'admin');
    await giveCredential(admin);
    await padWithAdmins(org);

    // Step 3: junior reaching for senior — refused by rank, not by `authorize`.
    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(manager, org), { personId: admin, role: 'staff' })),
    ).rejects.toThrow(AuthorizationError);
    expect((await roleOf(admin, org))?.role).toBe('admin');

    // ⭐ The other half: the elevation still WORKS for what it was for. A ladder that broke this
    //    would have replaced an authority gap with an authority outage.
    const junior = await insertPerson(org, 'A Staffer');
    await insertRoleRaw(junior, org, 'staff');
    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(manager, org), { personId: junior, role: 'manager' }),
    );
    expect((await roleOf(junior, org))?.role).toBe('manager');
  });

  it('⛔ case 6: the refusal names who CAN, and never says "requires super_admin"', async () => {
    /**
     * ⛔ A string contract with `apps/erp/src/app/admin/users/actions.ts`. That file matches
     * `/requires super_admin/` and returns *"Only a super-admin can APPOINT an admin"* — so a
     * removal refusal carrying that phrase would answer the wrong question on the screen, with a
     * green build and green tests. The DEF-177 shape. This assertion is the only thing that catches
     * it, which is why it asserts the ABSENCE as well as the presence.
     */
    const org = await insertOrg('d234-message');
    const actor = await insertPerson(org, 'Ordinary Admin');
    await insertRoleRaw(actor, org, 'admin');
    await giveCredential(actor);
    const target = await insertPerson(org, 'The Super Admin');
    await insertRoleRaw(target, org, 'super_admin');
    await giveCredential(target);
    await padWithAdmins(org);

    const refusal = await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(actor, org), { personId: target, role: 'staff' }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    // ⛔ First: it was refused at all. Without this the assertions below would read `undefined`
    //    against a call that quietly SUCCEEDED, and `undefined` matches nothing — a green test over
    //    the exact defect. Same shape as the NULL-blind CHECK in T-239.
    expect(refusal, 'the demotion was not refused at all').not.toBeNull();
    const message = refusal!.message;

    expect(message).toMatch(/outranks you/);
    expect(message).not.toMatch(/requires super_admin/);
    // It has to say who CAN, or the person reading it has no next step.
    expect(message).toMatch(/system owner/);
  });

  it('⭐ case 7: when BOTH guards would fire, the RANK refusal comes back — not the lockout one', async () => {
    /**
     * ⛔ The ordering, asserted through the call. An admin demoting the org's only super-admin
     * violates rank AND would leave nobody able to manage users. The lockout sentence would send
     * them to appoint another admin — real work that does not help, followed by a second refusal.
     * A wrong-first-refusal is a loop, and this file has already learned that once (T-238's
     * `/only active admin/` sentence had to name both halves for the same reason).
     */
    const org = await insertOrg('d234-order');
    const actor = await insertPerson(org, 'Admin With No Way In');
    await insertRoleRaw(actor, org, 'admin'); // deliberately NO credential
    const onlySuper = await insertPerson(org, 'Only Super');
    await insertRoleRaw(onlySuper, org, 'super_admin');
    await giveCredential(onlySuper);

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(actor, org), { personId: onlySuper, role: 'staff' })),
    ).rejects.toThrow(/outranks you/);

    expect((await roleOf(onlySuper, org))?.role).toBe('super_admin');
  });

  it('case 8: T-238 unbroken — a SUPER_ADMIN demoting the last administrator is still refused', async () => {
    // Rank passes (peer), so the lockout guard is what has to fire. If 5b ever swallowed this case,
    // an org could be left with nobody able to manage users.
    const org = await insertOrg('d234-lockout-intact');
    const actor = await insertPerson(org, 'Super Actor');
    await insertRoleRaw(actor, org, 'super_admin'); // no credential: not another way in
    const onlyAdmin = await insertPerson(org, 'Only Admin Who Can Sign In');
    await insertRoleRaw(onlyAdmin, org, 'admin');
    await giveCredential(onlyAdmin);

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(actor, org), { personId: onlyAdmin, role: 'manager' })),
    ).rejects.toThrow(/only active admin who can sign in/);

    expect((await roleOf(onlyAdmin, org))?.role).toBe('admin');
  });

  it('case 9: self-demotion is still refused by the SELF check, with the self check message', async () => {
    // ⚠️ Proves 5b did not quietly take over a case that was already covered. A super_admin stepping
    // down needs a peer — and if there is none, that is the system owner. Same dependency Ian
    // accepted for removal, arriving from the other side.
    const org = await insertOrg('d234-self');
    const actor = await insertPerson(org, 'Super Stepping Down');
    await insertRoleRaw(actor, org, 'super_admin');
    await giveCredential(actor);
    await padWithAdmins(org);

    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(actor, org), { personId: actor, role: 'staff' })),
    ).rejects.toThrow(/may not change their own role/);

    expect((await roleOf(actor, org))?.role).toBe('super_admin');
  });
  it('⭐ case 10: a roleless actor is stopped by authorize, and appointing a roleless PERSON still works', async () => {
    /**
     * ⚠️ **Beyond the nine cases in the spec — added in self-review, and it corrected the
     * implementation's own comment.** `actorRank` returns **-1** for an actor with no active role,
     * and the comment there originally claimed somebody could reach it that way holding
     * `manage_users` as a bare grant. **They cannot**, and this case is how that was established:
     * `authorize` refuses a roleless actor outright, before rank is ever consulted. The -1 is
     * defence in depth, not a live path — and a comment claiming otherwise is the DEF-175 shape,
     * a doc describing something the code does not do.
     *
     * ⭐ The second half is the live one, and it is the boundary of the whole rule: appointing a
     * person who holds NO role must still work. Nothing is being unmade, so the rank check must not
     * fire at all — a ladder that refused this would have turned a removal rule into an appointment
     * rule and broken every first appointment in an organisation.
     */
    const org = await insertOrg('d234-roleless');
    const roleless = await insertPerson(org, 'Granted But Unranked');
    await grantRawHere(roleless, ['manage_users' as Capability]);
    await giveCredential(roleless);
    const staffer = await insertPerson(org, 'A Staffer');
    await insertRoleRaw(staffer, org, 'staff');
    await padWithAdmins(org);

    // ⛔ `authorize`, not the ladder — asserted by the sentence, so that if the capability layer
    //    ever starts admitting a bare grant-holder this case says so instead of quietly passing.
    await expect(
      asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(roleless, org), { personId: staffer, role: 'manager' })),
    ).rejects.toThrow(/has no active role in org/);
    expect((await roleOf(staffer, org))?.role).toBe('staff');

    // ⭐ And an ordinary admin may still appoint somebody who holds nothing at all.
    const appointer = await insertPerson(org, 'Ordinary Admin');
    await insertRoleRaw(appointer, org, 'admin');
    await giveCredential(appointer);
    const newcomer = await insertPerson(org, 'Newcomer With No Role');
    await asPerson(org, (tx) =>
      assignRoleAsActor(tx, actorOf(appointer, org), { personId: newcomer, role: 'staff' }),
    );
    expect((await roleOf(newcomer, org))?.role).toBe('staff');
  });
});
