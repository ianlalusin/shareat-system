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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { personGrants, personRoles, personStoreScope } from '../../schema/access';
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

/** Whether this org currently has an ACTIVE admin. Drives the grant-time fallback (bible
 * row 115): a manager appointed while this is false receives the elevated grants then. */
export async function hasActiveAdmin(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personRoles.id })
    .from(personRoles)
    .where(and(eq(personRoles.orgId, orgId), eq(personRoles.role, 'admin'), isNull(personRoles.revokedAt)))
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
 * bug (revoking the wrong id, or double-revoking) that matters for an authority chain. */
export async function revokeRoleById(tx: Tx, roleId: string): Promise<void> {
  const updated = await tx
    .update(personRoles)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personRoles.id, roleId), isNull(personRoles.revokedAt)))
    .returning({ id: personRoles.id });
  if (updated.length === 0) {
    throw new Error(`revokeRoleById: role ${roleId} does not exist or is already revoked`);
  }
}

// -----------------------------------------------------------------------------------------
// Store scope — rows, never a bypass (CAPABILITY-MATRIX.md, bible row 114).
// -----------------------------------------------------------------------------------------

/** Grants one store. Idempotent: re-granting an already-held store is a no-op rather than
 * a unique-constraint error, so a caller assigning "every current store" in a loop never
 * has to special-case ones already held. */
export async function grantStoreScope(
  tx: Tx,
  input: { personId: string; storeId: string; grantedBy: string | null },
): Promise<void> {
  await tx
    .insert(personStoreScope)
    .values({ personId: input.personId, storeId: input.storeId, grantedBy: input.grantedBy })
    .onConflictDoNothing({ target: [personStoreScope.personId, personStoreScope.storeId] });
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
}

/** Grants one capability. Idempotent against an ALREADY-ACTIVE identical grant (the
 * partial unique index would otherwise reject a second "elevate this manager" call); a
 * previously revoked grant is a distinct row, and re-granting inserts a new one rather
 * than reviving the old — the old row's revocation date stays intact and queryable. */
export async function grantCapability(
  tx: Tx,
  input: { personId: string; grantName: string; grantedBy: string | null },
): Promise<{ id: string }> {
  const [existing] = await tx
    .select({ id: personGrants.id })
    .from(personGrants)
    .where(and(eq(personGrants.personId, input.personId), eq(personGrants.grantName, input.grantName), isNull(personGrants.revokedAt)))
    .limit(1);
  if (existing) return existing;

  const [row] = await tx
    .insert(personGrants)
    .values({ personId: input.personId, grantName: input.grantName, grantedBy: input.grantedBy })
    .returning({ id: personGrants.id });
  if (!row) throw new Error('grantCapability: insert returned no row');
  return row;
}

/** Revokes one grant by id. Throws if it does not exist or is already revoked, for the
 * same reason as `revokeRoleById`. */
export async function revokeGrantById(tx: Tx, grantId: string): Promise<void> {
  const updated = await tx
    .update(personGrants)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personGrants.id, grantId), isNull(personGrants.revokedAt)))
    .returning({ id: personGrants.id });
  if (updated.length === 0) {
    throw new Error(`revokeGrantById: grant ${grantId} does not exist or is already revoked`);
  }
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
    })
    .from(personGrants)
    .where(eq(personGrants.personId, personId));
  return rows as GrantRow[];
}
