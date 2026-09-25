/**
 * access repo — the ONLY place access SQL lives (PROJECT_BIBLE.md §4.3,
 * docs/tasks/121-roles-and-access.md Contract's Scope). Covers all three access-axis
 * tables: person_roles, person_store_scope, person_grants.
 *
 * DELIBERATELY NO CAPABILITY KNOWLEDGE HERE. This file has no idea what `manage_users`
 * or `close_period` mean, and must not import `@shareat/auth` — the workspace dependency
 * runs one way (`@shareat/auth` depends on `@shareat/db`), and a cycle here would be
 * exactly the kind of layering violation `tests/unit/app-boundaries.test.ts` exists to
 * catch at the apps/packages boundary, one level down. `packages/auth/src/roles.ts`
 * composes these primitives with the `Capability` matrix (the elevated-grant set,
 * the org-wide-scope check for `close_period`); this file only shapes rows.
 *
 * Every function takes a `Tx`, never the base connection (same convention as
 * `repo/journal.ts`) — so a caller cannot write outside a transaction by accident.
 */
import { and, eq, exists, inArray, isNull, ne, sql } from 'drizzle-orm';
import { personGrants, personRoles, personStoreScope } from '../../schema/access';
import { recordGone } from './record-gone';
// ⚠️ Tables outside the access axis this file touches: `personCredentials` for
// `hasOtherActiveAdminWhoCanSignIn`, `persons` for `revokeElevationGrantsForOrg`'s org scoping
// (`person_grants` carries no `org_id` of its own — same reason its RLS policy derives org
// through the person it names), and `employments` — read as raw SQL inside
// `personMaySignInAtStore` (T-302), which needs "does this person work here" and cannot import
// `repo/employment.ts` without making two repos depend on each other for one EXISTS.
import { personCredentials } from '../../schema/sessions';
import { persons } from '../../schema/persons';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';

export type RoleName = 'super_admin' | 'admin' | 'manager' | 'staff';

// -----------------------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------------------

export interface ActiveRoleRow {
  id: string;
  personId: string;
  orgId: string;
  role: RoleName;
  grantedBy: string | null;
  grantedAt: Date;
}

/** The person's currently ACTIVE (revoked_at IS NULL) role in this org, if any. At most
 * one exists per (person, org) by the partial unique index. */
export async function activeRoleForPerson(
  tx: Tx,
  personId: string,
  orgId: string,
): Promise<ActiveRoleRow | undefined> {
  const [row] = await tx
    .select({
      id: personRoles.id,
      personId: personRoles.personId,
      orgId: personRoles.orgId,
      role: personRoles.role,
      grantedBy: personRoles.grantedBy,
      grantedAt: personRoles.grantedAt,
    })
    .from(personRoles)
    .where(and(eq(personRoles.personId, personId), eq(personRoles.orgId, orgId), isNull(personRoles.revokedAt)))
    .limit(1);
  return row as ActiveRoleRow | undefined;
}

/** Whether this org currently has an ACTIVE ADMINISTRATOR — role `'admin'` OR `'super_admin'`.
 * Drives the grant-time fallback (bible row 115): a manager appointed while this is false
 * receives the elevated grants then.
 *
 * ⛔ **DEF-237.** Until T-244 this matched the literal `'admin'` only, so an organisation run
 * solely by a `super_admin` read as adminless and the next manager appointed there was elevated
 * as if nobody were in charge. `role IN ('admin', 'super_admin')` is the fix — mirroring
 * `isAdministrative()` in `packages/auth/src/roles.ts`, which asks the identical question one
 * layer up. Its one production caller is `assignRole` (`roles.ts:97`); every other admin-counting
 * helper in this file (`hasOtherActiveAdmin`, `hasOtherActiveAdminWhoCanSignIn`) asks a different
 * question and is untouched by this fix. */
export async function hasActiveAdmin(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personRoles.id })
    .from(personRoles)
    .where(
      and(
        eq(personRoles.orgId, orgId),
        inArray(personRoles.role, ['admin', 'super_admin']),
        isNull(personRoles.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether an org has an active admin OTHER than `excludePersonId` — the "is this the last
 * one?" question `hasActiveAdmin` cannot answer, because the person being demoted still
 * holds the role at the moment the guard has to decide.
 *
 * T-219's lockout guard: demoting the org's only admin leaves nobody able to `manage_users`,
 * and `CAPABILITY-MATRIX.md` §"Worth being conscious of" records that re-appointing one
 * depends on Ian personally — so an org that does this to itself is not self-recoverable.
 */
export async function hasOtherActiveAdmin(tx: Tx, orgId: string, excludePersonId: string): Promise<boolean> {
  return otherActiveRoleExists(tx, orgId, excludePersonId, ['admin']);
}

/**
 * ⭐ **Is there another way INTO this organisation?** — T-237 §5.4's lockout guard.
 *
 * Not *"is there another admin row"*: **another person who holds an administrative role AND holds a
 * live credential to sign in with.** The distinction is the whole function.
 *
 * ⛔ **The version without the credential half was wrong, and its own test proved it while passing.**
 * A role row is an authority nobody can exercise if that person cannot sign in: granting `admin` to
 * a credential-less person satisfied *"someone else is an admin"*, unblocked the unlink, and left an
 * organisation with **zero live credentials** — which is exactly the droplet-shell recovery this
 * guard exists to prevent. Found by the Opus second read of T-237; recorded there as a defect in the
 * spec's own §5.4 condition, not in its implementation.
 *
 * ⛔ **Why this is a second function and not a widening of `hasOtherActiveAdmin`.** That one belongs
 * to T-219's role-demotion guard, which asks *"will anyone still be able to `manage_users` after this
 * demotion?"* — a question about authority, where a credential is irrelevant. Changing what it counts
 * from inside another task would move a rule under a caller that never asked for it.
 *
 * ⚠️ Two filters differ from that one, and both are deliberate: it counts `super_admin` as well as
 * `admin` (every other admin-counting helper here matches the literal `'admin'`, which for the
 * fan-out is load-bearing — T-232 §2.2 — and for a lockout guard would be a false refusal on every
 * super_admin-only org); and it requires a live credential.
 *
 * ⚠️ **It is the one function in this file that reads outside the access axis.** `person_credentials`
 * belongs to the sessions tables, but *"can this person sign in"* is not answerable from
 * `person_roles` alone, and answering it in TypeScript would mean a second query and a race between
 * them.
 */
export async function hasOtherActiveAdminWhoCanSignIn(
  tx: Tx,
  orgId: string,
  excludePersonId: string,
): Promise<boolean> {
  return otherActiveRoleExists(tx, orgId, excludePersonId, ['admin', 'super_admin'], true);
}

/**
 * ⛔ **Serialises the lockout guard for one organisation** — T-237, the read-then-write race.
 *
 * `hasOtherActiveAdminWhoCanSignIn` reads and `revokeCredential` writes, and under READ COMMITTED two
 * administrators unlinking each other's last credential at the same moment each see *"someone else
 * can still get in"* and both commit. There is no single row to lock — the answer is derived from two
 * tables — so this takes an advisory lock, the same **approach** as `organizationsRepo.lockFirstRun`
 * (`repo/organizations.ts:214`) and for the same reason: that one also had no parent row to lock.
 *
 * ⚠️ The KEY differs, and deliberately: `lockFirstRun` uses a fixed constant, because first run is one
 * critical section for the whole database. This one is keyed on the **org id**, so two organisations
 * never wait on each other.
 *
 * ⚠️ Transaction-scoped (`_xact_`), so it is released at COMMIT or ROLLBACK and cannot outlive the
 * request on a pooled connection.
 */
export async function lockOrgAccess(tx: Tx, orgId: string): Promise<void> {
  // `hashtext` maps the uuid to the bigint the advisory-lock API takes. Collisions between two orgs
  // are possible in principle and harmless in practice: the cost is that two unrelated unlinks
  // serialise, which is a moment of waiting, never a wrong answer.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`);
}

/** The shared shape, so the exports above cannot drift apart unnoticed: the next person to touch
 *  one of them has to read the other. */
async function otherActiveRoleExists(
  tx: Tx,
  orgId: string,
  excludePersonId: string,
  roles: readonly RoleName[],
  mustBeAbleToSignIn = false,
): Promise<boolean> {
  const filters = [
    eq(personRoles.orgId, orgId),
    inArray(personRoles.role, [...roles]),
    isNull(personRoles.revokedAt),
    ne(personRoles.personId, excludePersonId),
  ];
  if (mustBeAbleToSignIn) {
    filters.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(personCredentials)
          .where(
            and(
              eq(personCredentials.personId, personRoles.personId),
              isNull(personCredentials.revokedAt),
            ),
          ),
      ),
    );
  }
  const [row] = await tx
    .select({ id: personRoles.id })
    .from(personRoles)
    .where(and(...filters))
    .limit(1);
  return row !== undefined;
}

/** Plain insert — no revoke-prior-role logic, no elevation logic. The orchestration that
 * revokes a prior role and decides whether to elevate lives in `@shareat/auth`'s
 * `roles.ts`, which composes this with `hasActiveAdmin` and the capability matrix. */
export async function insertRole(
  tx: Tx,
  input: { personId: string; orgId: string; role: RoleName; grantedBy: string | null },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(personRoles)
    .values({
      personId: input.personId,
      orgId: input.orgId,
      role: input.role,
      grantedBy: input.grantedBy,
    })
    .returning({ id: personRoles.id });
  if (!row) throw new Error('insertRole: insert returned no row');
  return row;
}

/** Revokes whichever role is currently active for (personId, orgId). A no-op — returns
 * false — if none is active, so callers can use it unconditionally before assigning a
 * replacement role. */
export async function revokeActiveRole(tx: Tx, personId: string, orgId: string): Promise<boolean> {
  const updated = await tx
    .update(personRoles)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personRoles.personId, personId), eq(personRoles.orgId, orgId), isNull(personRoles.revokedAt)))
    .returning({ id: personRoles.id });
  return updated.length > 0;
}

/** Revokes a specific role row by id. Throws if it does not exist or is already revoked —
 * a caller revoking a role should know which one, and a silent no-op here would hide a
 * bug (revoking the wrong id, or double-revoking) that matters for an authority chain.
 *
 * ⛔ **ZERO CALLERS as of T-242, and if you are about to write the first one, read this.**
 *
 * The rule that removing a role requires **rank** — Ian, 2026-09-08, DEF-234: *you may unmake an
 * equal, never someone senior* — lives in `assignRoleAsActor` (`packages/auth/src/roles.ts`), the
 * one gated entry point. **It does not apply here.** This function is the ungated primitive, exactly
 * as `assignRole` is, so a "remove this person's role entirely" feature wired straight to it would
 * hand any holder of `manage_users` the power to strip a super-admin — the whole of DEF-234,
 * reopened through a door the fix never covered.
 *
 * ⭐ Bring the new path through `assignRoleAsActor` instead, so it inherits the rank check, the
 * self check, the org check and the last-administrator guard rather than re-deriving them. If it
 * genuinely cannot, the rank rule has to be lifted somewhere both can reach, and that is a task with
 * a spec, not a line in a caller.
 *
 * ⚠️ Nothing will warn you: neither caller-existence guard covers `packages/db/src/repo/*`
 * (reported by lane C, T-238), so this comment is the only thing standing where a test would be. */
export async function revokeRoleById(tx: Tx, roleId: string): Promise<void> {
  const updated = await tx
    .update(personRoles)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personRoles.id, roleId), isNull(personRoles.revokedAt)))
    .returning({ id: personRoles.id });
  if (updated.length === 0) {
    throw recordGone(`revokeRoleById: role ${roleId} does not exist or is already revoked`, 'role');
  }
}

// -----------------------------------------------------------------------------------------
// Store scope — rows, never a bypass (CAPABILITY-MATRIX.md, bible row 114).
// -----------------------------------------------------------------------------------------

/**
 * Grants one store. Idempotent: re-granting an already-held store is a no-op rather than a
 * unique-constraint error, so a caller assigning "every current store" in a loop never has to
 * special-case ones already held.
 *
 * T-336 SCOPE LIFECYCLE fix, migration 0156 — `source` decides what `endEmployment` may later
 * delete, and conflicts resolve by a fixed priority: `'manual' > 'fan_out' > 'employment'`.
 *   - `'manual'` ALWAYS wins, including over an existing `'employment'` row: an admin's deliberate
 *     grant must survive that hire ending, which is exactly what an unconditional
 *     `on conflict do nothing` would have gotten wrong.
 *   - `'fan_out'` UPGRADES an existing `'employment'` row, and only that — a hire later promoted
 *     to admin/manager keeps the scope this materialises after their employment ends, but a
 *     `'manual'` or already-`'fan_out'` row is never touched.
 *   - `'employment'` never overwrites an existing row of any source — it only ever fills an empty
 *     cell (a rehire after a clean revocation).
 */
export async function grantStoreScope(
  tx: Tx,
  input: { personId: string; storeId: string; grantedBy: string | null; source: 'employment' | 'manual' | 'fan_out' },
): Promise<void> {
  if (input.source === 'manual') {
    await tx
      .insert(personStoreScope)
      .values({ personId: input.personId, storeId: input.storeId, grantedBy: input.grantedBy, source: 'manual' })
      .onConflictDoUpdate({
        target: [personStoreScope.personId, personStoreScope.storeId],
        set: { source: 'manual', grantedBy: input.grantedBy },
      });
    return;
  }
  if (input.source === 'fan_out') {
    await tx
      .insert(personStoreScope)
      .values({ personId: input.personId, storeId: input.storeId, grantedBy: input.grantedBy, source: 'fan_out' })
      .onConflictDoUpdate({
        target: [personStoreScope.personId, personStoreScope.storeId],
        set: { source: 'fan_out', grantedBy: input.grantedBy },
        // Only an 'employment' row is upgraded. Postgres leaves a conflicting row that fails this
        // WHERE untouched — the same effect as DO NOTHING for a 'manual' or already-'fan_out' row.
        setWhere: eq(personStoreScope.source, 'employment'),
      });
    return;
  }
  await tx
    .insert(personStoreScope)
    .values({ personId: input.personId, storeId: input.storeId, grantedBy: input.grantedBy, source: input.source })
    .onConflictDoNothing({ target: [personStoreScope.personId, personStoreScope.storeId] });
}

/**
 * T-336 SCOPE LIFECYCLE fix — the other half of `grantStoreScope`. Deletes exactly one
 * `person_store_scope` row, by id, never by (person, store): the caller (`endEmployment`) has
 * already decided this row is safe to remove (`source = 'employment'` and no other open
 * employment at that store) and names it, the same posture as `revokeDefaultById`.
 */
export async function deleteStoreScopeById(tx: Tx, id: string): Promise<void> {
  await tx.delete(personStoreScope).where(eq(personStoreScope.id, id));
}

/** The active scope row for (person, store), if any — what `endEmployment` reads before
 *  deciding whether it may delete it. */
export async function findStoreScope(
  tx: Tx,
  personId: string,
  storeId: string,
): Promise<{ id: string; source: string } | undefined> {
  const [row] = await tx
    .select({ id: personStoreScope.id, source: personStoreScope.source })
    .from(personStoreScope)
    .where(and(eq(personStoreScope.personId, personId), eq(personStoreScope.storeId, storeId)))
    .limit(1);
  return row;
}

/** Removes one store. Ordinary delete — CAPABILITY-MATRIX.md frames store scope as "rows,
 * never a bypass"; the audit question it answers ("who can see Davao right now?") is
 * answered by which rows exist today, not by a revocation history (contrast person_roles
 * / person_grants, which the CONTRACT explicitly asks to be append-and-revoke). */
export async function revokeStoreScope(tx: Tx, personId: string, storeId: string): Promise<void> {
  await tx
    .delete(personStoreScope)
    .where(and(eq(personStoreScope.personId, personId), eq(personStoreScope.storeId, storeId)));
}

export async function storeIdsForPerson(tx: Tx, personId: string): Promise<string[]> {
  const rows = await tx.select({ storeId: personStoreScope.storeId }).from(personStoreScope).where(eq(personStoreScope.personId, personId));
  return rows.map((r) => r.storeId);
}

export async function personHasStoreScope(tx: Tx, personId: string, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personStoreScope.id })
    .from(personStoreScope)
    .where(and(eq(personStoreScope.personId, personId), eq(personStoreScope.storeId, storeId)))
    .limit(1);
  return row !== undefined;
}

/**
 * ⭐ T-302 — may this person begin a session AT this store? **An open employment here, OR a
 * `person_store_scope` row here.** Either one, deliberately.
 *
 * ⛔ **Why not store scope alone, which is what T-302's own spec first said.** Measured when this
 * gate was built: nothing in the hire flow wrote a scope row, so a hired cashier held an
 * employment and no scope until somebody remembered to add one by hand — a scope-only gate would
 * have refused them with the flat `BAD_PIN` sentence, turning a missing provisioning step from a
 * legible mid-session `may not 'record_sale'` into an unexplainable "that PIN is not valid".
 *
 * ⭐ **T-336 (2026-09-24) closed that specific gap** — `createEmployment` now grants
 * `person_store_scope` for the hired store, `source = 'employment'`, in the same transaction as
 * the employment, so a fresh hire holds both rows from the moment they exist. The OR still earns
 * its keep: the founding admin gets scope with no employment at all (`bootstrapOrganization` →
 * `createStore`'s fan-out, `source = 'fan_out'`), an admin/manager appointed later via
 * `packages/auth/src/roles.ts`'s fan-out or `apps/erp/src/app/admin/users/actions.ts`'s
 * `setStoreScopeAction` (`source = 'manual'`) is scope with no employment there either, and even a
 * `source = 'employment'` row now survives its own employment ending if another open one remains
 * at that store — `endEmployment`'s revocation (SCOPE LIFECYCLE fix, migration 0156) deletes it
 * only when BOTH `source = 'employment'` and no other open employment covers this store. So "has
 * an open employment" and "holds scope" are still two different facts — narrower than before this
 * fix (a terminated cashier with no other role here now loses both together), never identical.
 *
 * ⚠️ **This is a sign-in gate, NOT an authorization check, and the distinction is load-bearing.**
 * It answers *"does this person work here"*; `authorize()` still answers *"may they do this"* and
 * still requires a scope row for every `'store'`-scoped capability, checked as its own axis. An
 * employment (or a scope row) gets you a session, never a capability on its own.
 *
 * ⭐ **One round trip, two EXISTS.** The PIN path runs this on every successful lookup, so it is
 * deliberately not two queries. Both legs are index-backed:
 * `person_store_scope_person_id_store_id_unique` and `employments_open_person_store_unique`.
 */
export async function personMaySignInAtStore(tx: Tx, personId: string, storeId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select (
      exists (
        select 1 from person_store_scope
        where person_id = ${personId} and store_id = ${storeId}
      )
      or exists (
        select 1 from employments
        where person_id = ${personId} and store_id = ${storeId} and ended_on is null
      )
    ) as ok
  `)) as unknown as { ok: boolean }[];
  return row?.ok === true;
}

/** Whether `storeId` belongs to `orgId` at all — a defence against `authorize()` being
 * called with a storeId from the wrong org (a caller bug, or a mis-scoped store-scope
 * row): even if a person somehow holds a scope row for a store outside their org, this
 * stops that row from ever authorizing a cross-org action. */
export async function storeBelongsToOrg(tx: Tx, storeId: string, orgId: string): Promise<boolean> {
  const [row] = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.id, storeId), eq(stores.orgId, orgId))).limit(1);
  return row !== undefined;
}

/** Every ACTIVE store in the org — the "every row" side of "all = every row". */
export async function activeStoreIdsForOrg(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.orgId, orgId), eq(stores.isActive, true)));
  return rows.map((r) => r.id);
}

/**
 * ⭐ T-222. Every person holding an **active `admin` role** in this org — the input to
 * CAPABILITY-MATRIX.md §C.2's *second* half: *"a store created later appears in nobody's scope, so
 * creating a store must add scope rows for that org's existing admins."*
 *
 * ⚠️ **`admin` only, deliberately, mirroring T-219's first half** (`roles.ts` step 4, which fans on
 * `input.role === 'admin'`). Widening this to `super_admin` here would quietly extend an ADR in the
 * task that consumes it — if super-admins should hold store scope, that is a decision about §C.2,
 * not a detail of store creation. ⛔ Note the consequence, which is real: a super_admin who creates
 * a store gets **no** scope row for it and cannot then act on it store-scoped, because `authorize`
 * gives admins no structural bypass (deliberately — v1 let admin bypass and v2 does not).
 *
 * `revoked_at is null` is what makes a role active; roles are revoked, never deleted, so "who was
 * an admin in March" stays answerable (§B).
 */
export async function activeAdminPersonIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: personRoles.personId })
    .from(personRoles)
    .where(
      and(
        eq(personRoles.orgId, orgId),
        eq(personRoles.role, 'admin'),
        isNull(personRoles.revokedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.personId))];
}

/**
 * True iff `personId`'s store-scope rows cover EVERY active store in `orgId` — the literal
 * mechanism CAPABILITY-MATRIX.md §Open 2 resolves the row-101/row-114 conflict with:
 * "a manager may close only if their store scope covers the whole org". An org with zero
 * active stores is vacuously covered (there is nothing to be missing).
 */
export async function personCoversWholeOrg(tx: Tx, personId: string, orgId: string): Promise<boolean> {
  const all = await activeStoreIdsForOrg(tx, orgId);
  if (all.length === 0) return true;
  const held = new Set(await storeIdsForPerson(tx, personId));
  return all.every((id) => held.has(id));
}

// -----------------------------------------------------------------------------------------
// Grants — additive, per-person capability overrides. Append-and-revoke, never delete
// (CAPABILITY-MATRIX.md §B): "who could do this in March" must stay answerable.
// -----------------------------------------------------------------------------------------

export interface GrantRow {
  id: string;
  personId: string;
  grantName: string;
  grantedBy: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  grantSource: GrantSource | null;
  /** T-289. The `position_capability_defaults` row that justifies this grant when
   *  `grantSource === 'position'`; may survive as history on a `'grant'` row (§C3); null for
   *  every other source. See `schema/access.ts`'s own comment on the column. */
  sourceRef: string | null;
  revokeReason: string | null;
}

/**
 * WHERE a `person_grants` row came from — T-248 / DEF-237, migration 0140; `'position'` added
 * T-289, migration 0146.
 *
 * `'elevation'` — the automatic grant-time fallback (`assignRole`, bible row 115) OR
 * `elevateManager`'s manual "explicit tick" re-elevation (bible row 116): the same reason to
 * exist, so the same eligibility to lapse when the org gains an administrator.
 * `'position'` — materialised by `reconcilePositionGrants` (`packages/domain/src/people/
 * position-defaults.ts`) from an active `position_capability_defaults` row. Never eligible for
 * the elevation-arrival sweep (`revokeElevationGrantsForOrg` matches only `'elevation'`).
 * `'owner'` — `createFirstAdmin`'s founding-person equivalence grant. Never eligible for that
 * revocation: the holder already holds `admin` themselves.
 * `'grant'` — an ordinary, deliberate hand-grant (`grantCapabilityAsActor`). Never eligible.
 */
export type GrantSource = 'elevation' | 'position' | 'owner' | 'grant';

/** The base shape every `grantCapability` call shares. */
type GrantBase = { personId: string; grantName: string; grantedBy: string | null };

/**
 * T-289 §C6. Made **unrepresentable in TypeScript**, mirroring the database CHECK: a
 * `'position'`-sourced call MUST carry a `sourceRef`; every other source MUST NOT. The four
 * pre-T-289 production call sites (`packages/auth/src/roles.ts:111,576,605`,
 * `packages/domain/src/organizations/index.ts:281`) pass no `sourceRef` and keep compiling
 * unchanged against the second arm.
 */
export type GrantCapabilityInput =
  | (GrantBase & { grantSource: 'position'; sourceRef: string })
  | (GrantBase & { grantSource: Exclude<GrantSource, 'position'>; sourceRef?: never });

/**
 * ⭐ **T-248 follow-up — lane D's read-only review, finding #1, confirmed real by the
 * orchestrator.** Ranks how eligible a `grantSource` is for the admin-arrival sweep: lower
 * is MORE eligible. `grantCapability`'s idempotent branch below may only ever move a stored
 * `grantSource` DOWN this list (more evidence, less sweepable), **never up** — that one
 * invariant is the whole safety argument for not turning the branch into a plain overwrite.
 *
 * `null` (a row written before migration 0140, provenance unknown) ranks alongside
 * `'elevation'`: the sweep's `WHERE grant_source = 'elevation'` already excludes it either
 * way, but a later deliberate `'grant'`/`'owner'` call IS real evidence over "unknown
 * origin," so it still upgrades — the direction stays downward on this rank, only the
 * starting point differs from `'elevation'`.
 *
 * T-289 inserts `'position'` between `'elevation'` and `'grant'`/`'owner'`: a hand-grant is
 * never demoted to sweepable by a later reconcile (stored `'grant'`, incoming `'position'` does
 * NOT rewrite), and a mere elevation stand-in IS superseded once a position independently
 * justifies the capability (stored `'elevation'`, incoming `'position'` DOES rewrite, and the
 * ref is written in the same UPDATE — see `reconcilePositionGrants`).
 *
 * Exported (not module-private, as it was before T-289) so `tests/unit/
 * position-defaults-offerable.test.ts` can pin the ordering and the four transitions without a
 * database, and so `reconcilePositionGrants` can decide which capabilities are genuinely NEW
 * (rather than a provenance upgrade of one already held) without re-deriving this rule.
 */
export const GRANT_SOURCE_RANK: Readonly<Record<GrantSource, number>> = {
  elevation: 0,
  position: 1,
  grant: 2,
  owner: 2,
};

export function grantSourceRank(source: GrantSource | null): number {
  return source === null ? 0 : GRANT_SOURCE_RANK[source];
}

/** Grants one capability. Idempotent against an ALREADY-ACTIVE identical grant (the
 * partial unique index would otherwise reject a second "elevate this manager" call); a
 * previously revoked grant is a distinct row, and re-granting inserts a new one rather
 * than reviving the old — the old row's revocation date stays intact and queryable.
 *
 * ⭐ **T-248 follow-up.** On the idempotent (already-active) branch, `grantSource` is
 * re-written ONLY when the incoming source outranks the stored one on `GRANT_SOURCE_RANK`
 * (strictly less sweepable) — e.g. stored `'elevation'`, incoming `'grant'`: a deliberate
 * hand-grant of a capability the target already held via the auto-elevation fallback is
 * real new evidence and must not be left tagged as still-sweepable. The reverse, and every
 * same-rank call, is UNCHANGED from before: the existing row's provenance stands, because a
 * second call is not evidence the first was wrong.
 *
 * ⛔ **Why this had to change, concretely.** `grant_capability` is itself
 * `{ admin: true, manager: false }`, so an auto-elevated manager holds it — meaning one
 * elevated manager can `grantCapabilityAsActor` a capability to ANOTHER elevated manager who
 * already holds it as `'elevation'`. Before this fix, that hand-grant vanished into the
 * idempotent branch leaving `grantSource` at `'elevation'`, and the next admin arrival swept
 * it exactly as if the deliberate act had never happened — the precise guarantee T-248
 * exists to provide, not holding.
 *
 * ⛔ **T-289 — `sourceRef` is written in the SAME UPDATE as `grantSource` on the rewrite
 * branch, and ONLY when the incoming source is `'position'`.** Writing `grantSource =
 * 'position'` alone would leave `sourceRef` null and violate `person_grants_position_source_
 * ref_check` — the row would be refused and the whole transaction rolled back (§C5 transition
 * 3's own warning). When the incoming source is `'grant'` superseding a stored `'position'`
 * row (transition 1), `sourceRef` is left UNTOUCHED — it is history, and must be kept, never
 * nulled or overwritten. */
export async function grantCapability(tx: Tx, input: GrantCapabilityInput): Promise<{ id: string }> {
  const [existing] = await tx
    .select({ id: personGrants.id, grantSource: personGrants.grantSource })
    .from(personGrants)
    .where(and(eq(personGrants.personId, input.personId), eq(personGrants.grantName, input.grantName), isNull(personGrants.revokedAt)))
    .limit(1);
  if (existing) {
    const existingSource = existing.grantSource as GrantSource | null;
    if (grantSourceRank(input.grantSource) > grantSourceRank(existingSource)) {
      await tx
        .update(personGrants)
        .set(
          input.grantSource === 'position'
            ? { grantSource: input.grantSource, sourceRef: input.sourceRef }
            : { grantSource: input.grantSource },
        )
        .where(eq(personGrants.id, existing.id));
    }
    return { id: existing.id };
  }

  const [row] = await tx
    .insert(personGrants)
    .values({
      personId: input.personId,
      grantName: input.grantName,
      grantedBy: input.grantedBy,
      grantSource: input.grantSource,
      sourceRef: input.sourceRef ?? null,
    })
    .returning({ id: personGrants.id });
  if (!row) throw new Error('grantCapability: insert returned no row');
  return row;
}

/** Revokes one grant by id. Throws if it does not exist or is already revoked, for the
 * same reason as `revokeRoleById`. `reason` is required — migration 0140's
 * `person_grants_revoke_check` refuses a revoked row with a null or blank one. */
export async function revokeGrantById(tx: Tx, grantId: string, reason: string): Promise<void> {
  const updated = await tx
    .update(personGrants)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(and(eq(personGrants.id, grantId), isNull(personGrants.revokedAt)))
    .returning({ id: personGrants.id });
  if (updated.length === 0) {
    throw recordGone(`revokeGrantById: grant ${grantId} does not exist or is already revoked`, 'grant');
  }
}

/**
 * ⭐ **T-248 / DEF-237 — the revocation itself.** Revokes every ACTIVE `'elevation'`-sourced
 * grant for every person in `orgId`, called from `assignRole` whenever an `admin` or
 * `super_admin` is appointed (bible row 188). Returns what it revoked so the caller can report
 * it rather than let it be an invisible side effect (T-219's own standard for `elevatedGrants`
 * and `materialisedStoreIds`).
 *
 * ⛔ **Matches ONLY `grant_source = 'elevation'`** — never `'owner'`, never `'grant'`, never
 * `NULL` (a pre-existing row from before this column existed). That is the entire point of
 * recording provenance at grant time instead of guessing it at revocation time.
 *
 * ⚠️ **Org-scoped explicitly, not left to RLS alone** (bible §7 rule 4, §15.11 — no layer may be
 * the only one for a given risk). `person_grants` carries no `org_id` of its own — the same
 * reason `person_..._via_person` is this table's RLS policy — so this joins through `persons`.
 *
 * ⚠️ **Unconditional on which admin/super_admin appointment triggered it**, deliberately: a
 * sweep matching nothing is a free no-op, so there is no need to first detect a 0→1
 * "did this org just gain its first administrator" transition — see the task spec §4 for why
 * that would also miss the case of a previously-elevated manager now being appointed admin
 * themselves.
 */
export async function revokeElevationGrantsForOrg(
  tx: Tx,
  orgId: string,
  reason: string,
): Promise<{ personId: string; grantName: string }[]> {
  return tx
    .update(personGrants)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(
      and(
        eq(personGrants.grantSource, 'elevation'),
        isNull(personGrants.revokedAt),
        exists(tx.select({ one: sql`1` }).from(persons).where(and(eq(persons.id, personGrants.personId), eq(persons.orgId, orgId)))),
      ),
    )
    .returning({ personId: personGrants.personId, grantName: personGrants.grantName });
}

export async function personHasActiveGrant(tx: Tx, personId: string, grantName: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personGrants.id })
    .from(personGrants)
    .where(and(eq(personGrants.personId, personId), eq(personGrants.grantName, grantName), isNull(personGrants.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/** All grant rows for a person — active and revoked — because invariant 11 requires a
 * revoked grant to "remain queryable with its revocation date". */
export async function grantsForPerson(tx: Tx, personId: string): Promise<GrantRow[]> {
  const rows = await tx
    .select({
      id: personGrants.id,
      personId: personGrants.personId,
      grantName: personGrants.grantName,
      grantedBy: personGrants.grantedBy,
      grantedAt: personGrants.grantedAt,
      revokedAt: personGrants.revokedAt,
      grantSource: personGrants.grantSource,
      sourceRef: personGrants.sourceRef,
      revokeReason: personGrants.revokeReason,
    })
    .from(personGrants)
    .where(eq(personGrants.personId, personId));
  return rows as GrantRow[];
}
