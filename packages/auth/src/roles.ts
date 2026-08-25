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
import { accessRepo, type Tx } from '@shareat/db';
import { ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER, type Capability } from './capabilities';
import type { Role } from './capabilities';

export interface AssignRoleInput {
  readonly personId: string;
  readonly orgId: string;
  readonly role: Role;
  /** The person performing the assignment — null only for the very first seed row, where
   * there is no grantor yet. The AUTHORITY CHAIN itself (only super-admin assigns admin;
   * that admin sets managers; nothing assigns itself — bible row 116) is a capability
   * decision, enforced by the CALLER via `authorize()` before this function is ever
   * reached, not re-implemented here — the same "do not duplicate a DB-enforced rule"
   * precedent this codebase already applies to ledger invariants (docs/RULES.md §6). */
  readonly grantedBy: string | null;
}

export interface AssignRoleResult {
  readonly roleId: string;
  /** Non-empty only when this call just appointed a MANAGER into an org with no active
   * admin — the exact capabilities granted by the fallback, for the caller to log or
   * surface ("this manager was automatically given: ..."). Empty in every other case,
   * including every admin/staff/super_admin assignment. */
  readonly elevatedGrants: readonly Capability[];
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
  return { roleId: id, elevatedGrants };
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
