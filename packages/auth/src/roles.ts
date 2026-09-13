/**
 * Role and grant MUTATIONS — as opposed to `authorize.ts`, which only ever CHECKS.
 *
 * Not named in docs/tasks/121-roles-and-access.md Contract's literal Scope list (which
 * names only `capabilities.ts` and `authorize.ts` under `packages/auth/src`) — flagged
 * explicitly in the task report as a file touched outside the letter of Scope, kept
 * deliberately small, and justified below rather than silently added.
 *
 * ## Why this exists as its own file
 *
 * Invariants 9-11 require the grant-time fallback (bible rows 115-116,
 * CAPABILITY-MATRIX.md §B/§B.1) to be real, testable behaviour: "creating a manager in an
 * org with no admin applies the elevated grants THEN, as real rows... evaluated once, at
 * appointment, never at check time." That logic needs BOTH the `Capability` matrix (which
 * capabilities are "elevated") and database writes (`accessRepo`) — it cannot live in
 * `packages/db/src/repo/access.ts` (which deliberately has no capability knowledge, see
 * that file's own top comment and the one-way dependency it protects), and folding it into
 * `authorize.ts` would blur that file's one job, which the whole spec leans on: "the ONE
 * function every mutation calls" to CHECK, never to CHANGE, an authorization fact.
 *
 * ## Everything here composes `accessRepo` — no SQL of its own
 *
 * Same rule as `authorize.ts`: `packages/db/src/repo/access.ts` is the only place access
 * SQL is written. This file only decides WHAT to write (the elevated set, the revoke-then-
 * insert sequence for a role change) and calls the repo to write it.
 */
import { accessRepo, personsRepo, type Tx } from '@shareat/db';
import {
  CAPABILITIES,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from './capabilities';
import type { Role } from './capabilities';
import { authorize, AuthorizationError, type Actor } from './authorize';


export interface AssignRoleInput {
  readonly personId: string;
  readonly orgId: string;
  readonly role: Role;
  /** The person performing the assignment — null only for the very first seed row, where
   * there is no grantor yet.
   *
   * ⛔ **This comment used to say the AUTHORITY CHAIN (only super-admin assigns admin; that
   * admin sets managers; nothing assigns itself — bible row 116) was "enforced by the CALLER
   * via `authorize()` before this function is ever reached." That was never true and cannot
   * be** — `CAPABILITY-MATRIX.md` §C.1 proved it on 2026-08-25: `manage_users` is one
   * boolean, `authorize()` answers *"may this actor use this capability?"* and correctly says
   * yes, and the missing check is about the TARGET, which no capability can express. So
   * between T-121 and T-219 nothing enforced the chain at all, and this comment made it look
   * handled — the same "a doc comment describing the opposite of the code" shape as DEF-175.
   *
   * ⭐ The chain is now enforced in `assignRoleAsActor` below, which is the gated entry point
   * every caller should use. `assignRole` itself stays the ungated primitive. */
  readonly grantedBy: string | null;
}

export interface AssignRoleResult {
  readonly roleId: string;
  /** Non-empty only when this call just appointed a MANAGER into an org with no active
   * admin — the exact capabilities granted by the fallback, for the caller to log or
   * surface ("this manager was automatically given: ..."). Empty in every other case,
   * including every admin/staff/super_admin assignment. */
  readonly elevatedGrants: readonly Capability[];
  /** Non-empty only when this call just appointed an ADMIN — the stores whose scope rows
   * were materialised for them (CAPABILITY-MATRIX.md §C.2, DEF-180), so the caller can say
   * "this admin was given scope for 5 stores" rather than the write being invisible. Empty
   * in every other case, and empty for an admin re-appointed in an org with no active
   * stores. */
  readonly materialisedStoreIds: readonly string[];
  /** ⭐ T-248 / DEF-237. Non-empty only when this call just appointed an ADMIN or SUPER_ADMIN —
   * every `'elevation'`-sourced `person_grants` row this organisation held, now revoked, because
   * the grant-time fallback they stood in for (bible row 115) no longer has anything to stand in
   * for (bible row 188). A hand-granted or owner-equivalence grant is never in this list — see
   * `accessRepo.revokeElevationGrantsForOrg`. Empty in every other case, including an
   * admin/super_admin appointment into an org with no elevated managers to clean up. */
  readonly revokedElevatedGrants: readonly { personId: string; grantName: string }[];
}

/**
 * Assigns `input.role` to `input.personId` in `input.orgId`.
 *
 * Sequence (bible row 115 — "evaluated once, at appointment, never at check time"):
 *   1. Revoke whatever role this person currently holds in this org, if any — a role
 *      change is REVOKE + INSERT, never an UPDATE in place (see schema/access.ts's top
 *      comment), so "what was their role in March" stays answerable.
 *   2. If, AFTER that revoke, the org has no active admin AND the role being assigned is
 *      'manager', apply the elevated grant set — computed from the matrix
 *      (`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`), never hand-listed, so it can never
 *      silently drift from `CAPABILITY_MATRIX`.
 *   3. Insert the new role row.
 *
 * Checking "no admin" AFTER the revoke (not before) is deliberate: if the person being
 * reassigned WAS the org's sole admin and is being moved to manager, the org genuinely has
 * no admin the instant their old role is revoked — and per bible row 115's own logic, that
 * is exactly the moment the fallback should fire for them, not a state it should ignore.
 */
export async function assignRole(tx: Tx, input: AssignRoleInput): Promise<AssignRoleResult> {
  await accessRepo.revokeActiveRole(tx, input.personId, input.orgId);

  let elevatedGrants: readonly Capability[] = [];
  if (input.role === 'manager') {
    const orgHasAdmin = await accessRepo.hasActiveAdmin(tx, input.orgId);
    if (!orgHasAdmin) {
      for (const capability of ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER) {
        await accessRepo.grantCapability(tx, {
          personId: input.personId,
          grantName: capability,
          grantedBy: input.grantedBy,
          grantSource: 'elevation',
        });
      }
      elevatedGrants = ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER;
    }
  }

  const { id } = await accessRepo.insertRole(tx, {
    personId: input.personId,
    orgId: input.orgId,
    role: input.role,
    grantedBy: input.grantedBy,
  });

  // Step 4 — CAPABILITY-MATRIX.md §C.2, decided 2026-08-25 and unimplemented until T-219
  // (DEF-180). An admin has NO structural store-scope bypass in v2 (deliberately — v1 let
  // admin bypass and v2 should not), so without this an admin appointed here is authorized
  // for NOTHING store-scoped, contradicting "org admin = org-wide control" (bible row 114).
  // The resolution keeps it **rows, never a bypass**, so "who can see Davao?" is still a
  // select: materialise a row per active store, once, at appointment.
  //
  // ⚠️ §C.2's OTHER half is not closed by this and must not be assumed closed: "a store
  // created later appears in nobody's scope, so creating a store must add scope rows for
  // that org's existing admins." No createStore exists yet — that half belongs to whoever
  // specs store creation (DEF-180's own disposition says so).
  let materialisedStoreIds: readonly string[] = [];
  if (input.role === 'admin') {
    const storeIds = await accessRepo.activeStoreIdsForOrg(tx, input.orgId);
    for (const storeId of storeIds) {
      await accessRepo.grantStoreScope(tx, {
        personId: input.personId,
        storeId,
        grantedBy: input.grantedBy,
      });
    }
    materialisedStoreIds = storeIds;
  }

  // ⭐ T-248 / DEF-237, bible row 188 — "the elevation is a stand-in for a missing administrator,
  // and it ends when the administrator arrives." Fires unconditionally on every admin/super_admin
  // appointment, not only a detected 0→1 transition: a sweep that matches nothing costs one query
  // and changes nothing, and the unconditional form also cleans up a stray elevation grant on the
  // APPOINTEE's own person (a manager elevated earlier, now being made admin themselves) with no
  // special case. Matches ONLY `grant_source = 'elevation'` — a hand-grant or the founding owner's
  // equivalence grant is never touched (task spec §2-3).
  let revokedElevatedGrants: readonly { personId: string; grantName: string }[] = [];
  if (input.role === 'admin' || input.role === 'super_admin') {
    revokedElevatedGrants = await accessRepo.revokeElevationGrantsForOrg(
      tx,
      input.orgId,
      'Automatically revoked — this organisation gained an active administrator, so the ' +
        'grant-time fallback that created this row no longer applies (bible row 188, DEF-237).',
    );
  }

  return { roleId: id, elevatedGrants, materialisedStoreIds, revokedElevatedGrants };
}

export interface AssignRoleAsActorInput {
  readonly personId: string;
  readonly role: Role;
}

/**
 * ⭐ **May this actor appoint an `admin` or a `super_admin`?** — §C.1's authority chain, asked as
 * *"is this actor capability-equivalent to a super-admin?"* rather than *"is this actor's role
 * spelled `super_admin`?"*
 *
 * ⛔ **Why it was widened (T-232 §2.2).** The organisation's first person cannot hold a
 * `super_admin` role row: the database allows one active role per (person, org), and the role has
 * to be `admin` because `createStore`'s §C.2 fan-out grants store scope to admins only. So they
 * hold `admin` plus `SUPER_ADMIN_ONLY_CAPABILITIES` as grant rows — an exact equivalence that
 * `authorize` already honours (`matrixAllows || personHasActiveGrant`), but which a role-literal
 * check could not see. The owner of a brand-new organisation could not appoint a second admin.
 *
 * ## The two conditions, and why the second is narrower than it looks
 *
 * 1. The `super_admin` role — unchanged, and still the ordinary path.
 * 2. The `admin` role **and an active grant for every member of the derived set**.
 *
 * ⚠️ **The role must be `admin` on branch 2, not merely "any role".** A manager appointed into an
 * org with no active admin receives `manage_users` among `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`,
 * so a manager genuinely reaches this check — and `manager` + this delta is **not** super_admin:
 * manager lacks most of what admin holds. Only `admin` + the delta is the equivalence.
 *
 * ⚠️ **`every` over an empty set is TRUE.** If the matrix ever held no super_admin-only
 * capability, branch 2 would silently admit every admin — exactly the lateral move bible row 116
 * forbids, arriving with no code change and no error. The empty set therefore refuses, and
 * `roles.test.ts` asserts the set is non-empty so the day it empties is a red test, not a hole.
 */
async function holdsSuperAdminAuthority(
  tx: Tx,
  actor: Actor,
  actorRole: string | undefined,
): Promise<boolean> {
  if (actorRole === 'super_admin') return true;
  if (actorRole !== 'admin') return false;
  if (SUPER_ADMIN_ONLY_CAPABILITIES.length === 0) return false;

  for (const capability of SUPER_ADMIN_ONLY_CAPABILITIES) {
    if (!(await accessRepo.personHasActiveGrant(tx, actor.personId, capability))) return false;
  }
  return true;
}

/**
 * ⭐ **The gated entry point for changing anyone's role — what a screen, a script or any
 * future app calls.** `assignRole` above is the primitive that performs the write;
 * everything that decides whether the write is ALLOWED lives here, in one place, so a second
 * caller cannot re-discover the rules the way DEF-180 shows a second reader re-discovers an
 * unimplemented decision.
 *
 * ## Why here and not in the Next server action
 *
 * `CAPABILITY-MATRIX.md` §C.1's literal words are *"the role-assignment server action carries
 * that extra condition"* — written in 2026-08-25 when no screen existed and "the server
 * action" was hypothetical. Its actual RULE is the sentence above it: *"a capability answers
 * 'what may you do', never 'to whom'. Where the target's own level matters, the check belongs
 * at the CALL SITE and must be tested there."* A rule living in one route file is a rule the
 * second caller misses, and it cannot be integration-tested without a Next runtime. This
 * function is that call site, it is the only one, and `roles.test.ts` tests every refusal.
 *
 * ## The five checks, in order — order matters
 *
 * 1. **`authorize(manage_users)`** — may this actor manage users at all? (org-scoped;
 *    matrix-true for super_admin and admin only.)
 * 2. **Self** — nobody changes their own role. An admin who demotes themselves by accident
 *    locks the org out of `manage_users` entirely, and §"Worth being conscious of" records
 *    that re-appointing an admin depends on Ian personally. Checked before the target's
 *    level so the message names the real reason.
 * 3. **Target is in this org** — DEF-183. `person_roles`'s RLS policy checks the row's own
 *    `org_id`, never the person's, so without this a role could be assigned to another org's
 *    person and Postgres would allow it. Proved by test, not inferred.
 * 4. **§C.1, the authority chain** — assigning `admin` or `super_admin` additionally
 *    requires the actor to hold a super-admin's AUTHORITY: the `super_admin` role, or the
 *    `admin` role plus an active grant for every capability `super_admin` holds and `admin`
 *    does not (`holdsSuperAdminAuthority`, T-232 §2.2 — an organisation's first person cannot
 *    hold a `super_admin` role row, so a role-literal check locked the owner out of appointing
 *    a second admin). This is the lateral move bible row 116 forbids and the one `manage_users`
 *    cannot express.
 * 5. **Last admin** — an org must not be left with zero admins. Checked against the target's
 *    CURRENT role: only a demotion *away from* `admin` can trigger it.
 *
 * ⚠️ Deliberately does NOT revoke a demoted admin's store scope. Revoking is destructive, the
 * rows stay plainly visible (`person_store_scope` is *rows, never a bypass*), and an operator
 * trimming them deliberately is safer than a demotion silently cutting access to five stores.
 * The screen states this where it lists the scope. Revisit if it bites twice (T-219's own
 * Open questions).
 */
/**
 * The two roles `manage_users` is matrix-true for — the ones whose disappearance leaves an
 * organisation unable to manage its own people. ⚠️ Not derived from `CAPABILITY_MATRIX` on purpose:
 * this is the set of roles that can ADMINISTER, and reading it out of the matrix at runtime would
 * make a future capability edit silently redefine what a lockout is.
 */
function isAdministrative(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * ⭐ **Seniority — T-242 / DEF-234.** Ian's rule, 2026-09-08: *an actor may not remove or demote a
 * role SENIOR to their own; a peer may.* An admin may demote an admin; only a super-admin may
 * demote a super-admin.
 *
 * ⛔ **NOT "the authority to unmake a role is the authority to make it."** That mnemonic was in the
 * register row and it is wrong: making an `admin` requires super-admin authority (row 116), so built
 * literally it forbids admin-demotes-admin — which is the *junior-only* option Ian explicitly
 * rejected, on the grounds that *"two admins and no super_admin would mean neither could ever remove
 * the other."* Both cannot be true. `roles.test.ts`' case 2 is the standing guard: it fails the
 * moment somebody "simplifies" the rank check in `assignRoleAsActor` into a reuse of
 * `holdsSuperAdminAuthority`.
 *
 * ⚠️ **Not derived from `CAPABILITY_MATRIX`, on purpose** — the same reasoning `isAdministrative`
 * gives above. This is a chain of command, not a count of capabilities: two roles could hold
 * identical capability sets and still stand in a senior/junior relationship, and a matrix-derived
 * ladder would silently reorder the chain the next time a capability moved.
 */
const ROLE_RANK: Readonly<Record<Role, number>> = {
  staff: 0,
  manager: 1,
  admin: 2,
  super_admin: 3,
};

/**
 * The actor's rank for the purpose above.
 *
 * ⛔ **Super-admin AUTHORITY, not the `super_admin` literal** — the distinction T-232 §2.2 had to
 * teach the appointment check, and for the identical reason. An organisation's first person cannot
 * hold a `super_admin` role row (`person_roles_active_person_org_unique` allows one active role per
 * person+org, and the role must be `admin` for §C.2's store fan-out), so they hold `admin` plus
 * every `SUPER_ADMIN_ONLY_CAPABILITIES` grant. A ladder reading only the role literal would refuse
 * that owner the removal of a super-admin **they themselves appointed**, and the symptom would
 * surface months later on a screen with nothing pointing back here.
 *
 * ⚠️ **No active role at all ranks BELOW staff (-1), not equal to it** — standing in a chain of
 * command comes from holding a place in it. ⛔ **Defence in depth, not a live path, and the
 * difference was measured rather than assumed:** `authorize` refuses an actor with no active role
 * outright (*"has no active role in org"*), so nobody roleless reaches this line through
 * `assignRoleAsActor` today — `roles.test.ts` case 10 asserts that it is `authorize` doing the
 * refusing. The -1 is here so that if the capability layer ever admits a bare grant-holder with no
 * role, the answer is "may not unmake anybody" rather than an unranked `undefined` comparison.
 */
async function actorRank(tx: Tx, actor: Actor, actorRole: Role | undefined): Promise<number> {
  if (await holdsSuperAdminAuthority(tx, actor, actorRole)) return ROLE_RANK.super_admin;
  return actorRole === undefined ? -1 : ROLE_RANK[actorRole];
}

export async function assignRoleAsActor(
  tx: Tx,
  actor: Actor,
  input: AssignRoleAsActorInput,
): Promise<AssignRoleResult> {
  await authorize(tx, actor, 'manage_users', {});

  /**
   * ⛔ **T-238 / DEF-232 — taken before ANY of the reads below.** The lockout guard at the end of
   * this function is a read-then-write: two administrators demoting each other at the same instant
   * each read *"the other one is still an admin"*, both pass, and the organisation ends with none.
   * Sequentially it is safe, because the self-demotion check below means nobody can be their own
   * second half — so concurrency is the only way in.
   *
   * ⚠️ Placed here rather than immediately before the guard on purpose: the whole transaction's view
   * of the access tables belongs inside the critical section, not merely its last read.
   *
   * The lock is transaction-scoped and keyed on the org, so two organisations never wait on each
   * other — `accessRepo.lockOrgAccess`, the helper T-237 built for the identical race in
   * `unlinkCredential`.
   */
  await accessRepo.lockOrgAccess(tx, actor.orgId);

  if (actor.personId === input.personId) {
    throw new AuthorizationError(
      'assignRoleAsActor: an actor may not change their own role — ask another admin, so a mistake here cannot lock the org out',
      'manage_users',
    );
  }

  // ⚠️ The target must belong to the actor's org, and RLS does NOT catch this one.
  // `person_store_scope` and `person_grants` derive their org through the person they name
  // (policy `person_..._via_person`, with an explicit WITH CHECK), so Postgres refuses a
  // cross-org write to either. `person_roles` carries its OWN org_id and its policy is
  // `org_id = app_current_org()` — which a row naming THIS org and ANOTHER org's person
  // satisfies, with the FK to `persons` satisfied too because that person really exists.
  // Verified by test before this check existed: the assignment succeeded.
  //
  // The row grants nothing (`authorize()` resolves the target's role under THEIR org, where
  // it does not exist) but bible invariant 7 says cross-org access is denied, and a row that
  // is invisible on both orgs' screens is worse than one that is merely useless. Closed here
  // rather than in the policy because that would be a migration and T-219 changes no schema —
  // flagged in the task's Open questions as worth tightening at the database later.
  const target = await personsRepo.getPersonById(tx, actor.orgId, input.personId);
  if (!target) {
    throw new AuthorizationError(
      `assignRoleAsActor: person ${input.personId} does not exist in org ${actor.orgId}`,
      'manage_users',
    );
  }
  // ⛔ T-304 — a terminal (option (a)'s `persons` row for a shared store credential) holds no
  // role. Read from `target.kind` itself, never a proxy — the spec's own warning against
  // inferring "terminal" from `credential.storeId is not null` applies equally on this side.
  if (target.kind === 'terminal') {
    throw new AuthorizationError(
      'assignRoleAsActor: a terminal credential is not a person and may not hold a role',
      'manage_users',
    );
  }

  /**
   * ⭐ **Both authority checks and the lockout guard read these, so they are read ONCE — T-242.**
   * The lockout guard's `targetRole` used to be fetched further down; it moved up here so check 5b
   * can use the same value. A second `activeRoleForPerson` call would be a second read of a value
   * the guard's decision depends on, inside the very transaction `lockOrgAccess` exists to protect.
   */
  const actorRole = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  const targetRole = await accessRepo.activeRoleForPerson(tx, input.personId, actor.orgId);

  if (input.role === 'admin' || input.role === 'super_admin') {
    if (!(await holdsSuperAdminAuthority(tx, actor, actorRole?.role))) {
      throw new AuthorizationError(
        `assignRoleAsActor: assigning '${input.role}' requires super_admin — the role itself, or an ` +
          `admin holding every capability super_admin has and admin does not (bible row 116 — only ` +
          `a super-admin appoints an admin); actor holds '${actorRole?.role ?? 'no role'}'`,
        'manage_users',
      );
    }
  }

  /**
   * ⛔ **The other direction — T-242, closing DEF-234.** The check above gates *making* a role; until
   * this one, nothing gated *unmaking* one. `assignRoleAsActor(actor = an admin, { personId: the
   * super_admin, role: 'staff' })` passed every check in this function, so removal was the first
   * move of a promotion: strip the super-admin above you and — since T-232 §2.2 let an admin holding
   * the four grants appoint admins — you are unopposed. Bible row 116 gates appointment and was
   * silent on removal; **Ian's answer, 2026-09-08, is peer removal**: you may unmake an equal, never
   * someone senior.
   *
   * ⚠️ **It binds on the role being REMOVED, not the one being granted — that asymmetry was the
   * whole defect.** So it reads `targetRole`, and it does nothing when there is none: a person with
   * no active role is being *appointed*, and nothing is being unmade.
   *
   * ⚠️ **A ladder, not a check for a super_admin target**, and the difference is a second live door.
   * `manage_users` is `{admin: true, manager: false}`, so it sits inside
   * `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`, which `assignRole` applies automatically to a manager
   * appointed while `hasActiveAdmin` is false. **Until T-244 (DEF-237), `hasActiveAdmin` matched the
   * literal `'admin'`, so a super_admin-only organisation counted as adminless** and nothing revoked
   * those grants when an admin arrived later — a junior could demote an admin with no admin actor
   * anywhere in the story. Reproduced through this function before either fix (`roles.test.ts` case
   * 5). T-244 closed the literal-match bug at its source (`access.ts`'s `hasActiveAdmin`); the ladder
   * here is independent, deliberately-redundant protection — it refuses a `manage_users`-holding
   * manager regardless of *how* they hold it, automatic elevation or an explicit hand-grant alike. A
   * narrow super_admin-target check would have closed only the register's case and left this one open
   * even after T-244.
   *
   * ⭐ **Before the lockout guard below, deliberately.** Both can be true at once — an ordinary admin
   * demoting an org's only super-admin violates rank AND would leave nobody able to manage users.
   * The lockout sentence would send them to appoint another admin, which is real work that does not
   * help, and then refuse again: a wrong-first-refusal is a loop, and this file has already learned
   * that once (T-238 had to make `/only active admin/` name both halves for the same reason).
   * Authority questions before state questions — the same ordering the self check states above.
   */
  if (targetRole) {
    // ⚠️ When the assignment is an appointment to admin/super_admin AND the target already holds a
    //    role, `holdsSuperAdminAuthority` runs twice — once above, once inside `actorRank`. Seen and
    //    left alone: it is a handful of indexed reads on the rarest path here (appointing someone
    //    who already has a role), and caching it would put a stale-by-construction variable in the
    //    middle of the one function where every read must be the locked transaction's own.
    const rankOfActor = await actorRank(tx, actor, actorRole?.role);
    if (rankOfActor < ROLE_RANK[targetRole.role]) {
      // ⛔ The phrase `requires super_admin` must NEVER appear here. `apps/erp/src/app/admin/users/
      //    actions.ts` matches it and answers with "Only a super-admin can APPOINT an admin" — a
      //    sentence about appointment, in reply to a removal. Green build, green tests, wrong
      //    sentence (the DEF-177 shape). `roles.test.ts` case 6 asserts the absence.
      throw new AuthorizationError(
        `assignRoleAsActor: refusing to change this person's role — they hold ` +
          `'${targetRole.role}', which outranks you. This change needs somebody who is at least a ` +
          `'${targetRole.role}' themselves (the role, or an admin holding every capability ` +
          `super_admin has and admin does not). If nobody in this organisation holds ` +
          `'${targetRole.role}' any more, only the system owner can make it; you hold ` +
          `'${actorRole?.role ?? 'no role'}'`,
        'manage_users',
      );
    }
  }

  /**
   * ⛔ **The lockout guard — T-238, closing DEF-232 and two holes DEF-232 did not know about.**
   *
   * It asks one question: *after this write, is anybody left who can manage users?* Three things had
   * to change before it actually asked that.
   *
   * ⚠️ **1. `super_admin` counts, on both sides.** `manage_users` is matrix-true for `super_admin`
   * and `admin` (`capabilities.ts`), but this guard named the literal `'admin'` twice — so demoting
   * the last `admin` in an org that still held a super_admin was **refused** (a false refusal: that
   * org could still manage users), while demoting a **super_admin** ran no guard at all.
   *
   * ⚠️ **2. It counts administrators who can SIGN IN**, not role rows. An administrator with no live
   * credential cannot manage users in any sense a person would recognise, so counting them was a lie
   * the guard told about itself. T-237's `unlinkCredential` guard protects *the last way IN* and this
   * one protects *the last authority* — different things to protect, identical in what they count,
   * because both reduce to **a person with the authority who can actually get in**.
   *
   * ⚠️ **3. The advisory lock above is what makes any of it hold under concurrency** — and it is not
   * sufficient on its own, which is the correction this task makes to DEF-232's own remedy: with the
   * guard skipping super_admin targets, two super_admins demoting each other serialised perfectly and
   * still reached zero administrators. **A lock can order two checks; it cannot make an absent check
   * fire.**
   */
  // ⚠️ `targetRole` is read once, above the rank check — T-242. Re-reading it here would be a second
  //    read of the value this guard's decision rests on, inside the transaction the lock protects.
  if (isAdministrative(targetRole?.role) && !isAdministrative(input.role)) {
    const anotherWayIn = await accessRepo.hasOtherActiveAdminWhoCanSignIn(
      tx,
      actor.orgId,
      input.personId,
    );
    if (!anotherWayIn) {
      // ⚠️ The phrase "only active admin" is load-bearing: `apps/erp/src/app/admin/users/actions.ts`
      // matches it to turn this into a sentence on the screen. Extending around it is safe; removing
      // it would drop the mapping with a green build and green tests (the DEF-177 shape).
      throw new AuthorizationError(
        "assignRoleAsActor: refusing to demote this org's only active admin who can sign in — " +
          'appoint another admin or super_admin who holds a credential first, or the org is left ' +
          'with nobody able to manage users',
        'manage_users',
      );
    }
  }

  return assignRole(tx, {
    personId: input.personId,
    orgId: actor.orgId,
    role: input.role,
    grantedBy: actor.personId,
  });
}

export interface GrantCapabilityAsActorInput {
  readonly personId: string;
  readonly capability: Capability;
}

/**
 * ⭐ **The gated entry point for granting a capability — DEF-223.** The sibling of
 * `assignRoleAsActor`, carrying the same rule about the other half of the same screen.
 *
 * ## ⛔ What was wrong, and why the widening made it urgent
 *
 * `grant_capability` is matrix-true for `admin`, and `/admin/users`' server action wrote
 * `person_grants` straight from the form with **no self-check** — so an admin could grant
 * capabilities to *themselves*. That already let a rogue admin take every POWER a `super_admin`
 * has; `authorize` honours a grant exactly as it honours the matrix.
 *
 * ⚠️ What it could not do was mint the role NAME — until T-232 §2.2 widened
 * `assignRoleAsActor` to accept `admin` plus `SUPER_ADMIN_ONLY_CAPABILITIES`. Self-grant those
 * four and that check now passes too, so the same admin could appoint further admins and
 * super_admins. Bible row 116's chain was hollow on the capability axis and would have gone
 * hollow on the role axis with it.
 *
 * ⭐ **Closed at the source, not by narrowing the widened check.** The missing self-check is the
 * defect; the widening is correct and stays as it is. The alternative — demanding the grants carry
 * `granted_by IS NULL`, so only `createFirstAdmin`'s base case counts — was considered and
 * rejected as fragile: re-granting one of the four through `/admin/users` for any ordinary reason
 * would silently cost the owner the ability to appoint admins, with no error anywhere.
 *
 * ## The three checks, in order
 *
 * 1. **`authorize(grant_capability)`** — may this actor grant at all? (org-scoped; matrix-true for
 *    super_admin and admin only.)
 * 2. **Self** — nobody widens their own authority. Word for word the reasoning
 *    `assignRoleAsActor` gives for roles: *"ask another admin, so a mistake here cannot lock the
 *    org out."* Here the risk runs the other way — not a lock-out but a lift-out — and the answer
 *    is the same one: a second person.
 * 3. **A real capability** — the screen casts a form string to `Capability`, which is a promise the
 *    browser never made. An unknown name would sit in `person_grants` forever, matching nothing in
 *    `authorize` and reading as a granted permission on the very screen that wrote it.
 *
 * ⚠️ **Revoking is deliberately NOT gated this way and stays where it is.** Revoking your own
 * grant is self-*demotion*: it narrows authority, so it cannot escalate, and refusing it would
 * stop someone dropping a capability they no longer want to hold.
 *
 * ⚠️ **A cross-org target is left to the database, unlike `assignRoleAsActor`'s explicit check.**
 * That check exists because `person_roles` carries its own `org_id` and its policy compares that,
 * so Postgres allows a row naming this org and another org's person (DEF-183). `person_grants`
 * derives its org THROUGH the person (`person_..._via_person`, with an explicit `WITH CHECK`), so
 * the same write is refused by the policy. One layer here is the database's, and it is the right
 * one; a second would be a second source of truth for a rule the schema already holds.
 */
export async function grantCapabilityAsActor(
  tx: Tx,
  actor: Actor,
  input: GrantCapabilityAsActorInput,
): Promise<void> {
  await authorize(tx, actor, 'grant_capability', {});

  if (actor.personId === input.personId) {
    throw new AuthorizationError(
      'grantCapabilityAsActor: an actor may not grant themselves a capability — ask another admin, so nobody can widen their own authority',
      'grant_capability',
    );
  }

  if (!CAPABILITIES.includes(input.capability)) {
    throw new Error(`grantCapabilityAsActor: '${input.capability}' is not a known capability.`);
  }

  // ⛔ T-304 — same rule and same shape as `assignRoleAsActor`: existence checked first (so
  // `target.kind` below is never read on `undefined` — the same invariant, stated once, that
  // makes that function's plain `target.kind` safe), THEN a terminal holds no role AND no grant,
  // read from `target.kind` itself, never a proxy.
  const target = await personsRepo.getPersonById(tx, actor.orgId, input.personId);
  if (!target) {
    throw new AuthorizationError(
      `grantCapabilityAsActor: person ${input.personId} does not exist in org ${actor.orgId}`,
      'grant_capability',
    );
  }
  if (target.kind === 'terminal') {
    throw new AuthorizationError(
      'grantCapabilityAsActor: a terminal credential is not a person and may not hold a capability',
      'grant_capability',
    );
  }

  // ⛔ `granted_by` is the ACTOR, never null. The base case of the authority chain is
  // `createFirstAdmin` and nowhere else; every row after it names who is answerable for it.
  await accessRepo.grantCapability(tx, {
    personId: input.personId,
    grantName: input.capability,
    grantedBy: actor.personId,
    // T-248 / DEF-237 — an ordinary deliberate hand-grant, never eligible for the
    // admin-arrival revocation (`revokeElevationGrantsForOrg` matches only `'elevation'`).
    grantSource: 'grant',
  });
}

/**
 * Re-elevates a manager explicitly — bible row 116: "re-elevate managers after an admin
 * leaves" is a SUPER-ADMIN action, by an explicit tick, never inferred. This is that tick.
 * Distinct from the automatic path inside `assignRole`: this one is for a manager who was
 * appointed WHILE the org had an admin and is only now, deliberately, being elevated
 * because that admin is gone and nobody re-ran an appointment. The caller (a super-admin
 * console action) is responsible for calling `authorize()` for `manage_users` or an
 * equivalent break-glass capability first — this function performs the write only.
 *
 * ⭐ T-248 / DEF-237 — `grantSource: 'elevation'`, the SAME source `assignRole`'s automatic path
 * writes. This function grants the identical set for the identical reason (a stand-in for a
 * missing administrator, bible row 116), differing only in who triggers it and when — so it
 * lapses the same way, the moment the org gains an administrator. Tagged now, while this
 * function has zero production callers, so it cannot become a second silent gap the day a
 * console action finally calls it.
 */
export async function elevateManager(
  tx: Tx,
  input: { personId: string; grantedBy: string | null },
): Promise<readonly Capability[]> {
  for (const capability of ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER) {
    await accessRepo.grantCapability(tx, {
      personId: input.personId,
      grantName: capability,
      grantedBy: input.grantedBy,
      grantSource: 'elevation',
    });
  }
  return ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER;
}
