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

  return { roleId: id, elevatedGrants, materialisedStoreIds };
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
export async function assignRoleAsActor(
  tx: Tx,
  actor: Actor,
  input: AssignRoleAsActorInput,
): Promise<AssignRoleResult> {
  await authorize(tx, actor, 'manage_users', {});

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

  if (input.role === 'admin' || input.role === 'super_admin') {
    const actorRole = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
    if (!(await holdsSuperAdminAuthority(tx, actor, actorRole?.role))) {
      throw new AuthorizationError(
        `assignRoleAsActor: assigning '${input.role}' requires super_admin — the role itself, or an ` +
          `admin holding every capability super_admin has and admin does not (bible row 116 — only ` +
          `a super-admin appoints an admin); actor holds '${actorRole?.role ?? 'no role'}'`,
        'manage_users',
      );
    }
  }

  const targetRole = await accessRepo.activeRoleForPerson(tx, input.personId, actor.orgId);
  if (targetRole?.role === 'admin' && input.role !== 'admin') {
    const anotherAdmin = await accessRepo.hasOtherActiveAdmin(tx, actor.orgId, input.personId);
    if (!anotherAdmin) {
      throw new AuthorizationError(
        "assignRoleAsActor: refusing to demote this org's only active admin — appoint a second admin first, or the org is left with nobody able to manage users",
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

  // ⛔ `granted_by` is the ACTOR, never null. The base case of the authority chain is
  // `createFirstAdmin` and nowhere else; every row after it names who is answerable for it.
  await accessRepo.grantCapability(tx, {
    personId: input.personId,
    grantName: input.capability,
    grantedBy: actor.personId,
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
    });
  }
  return ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER;
}
