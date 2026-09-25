/**
 * position_capability_defaults — the only place SQL is written for it. T-289.
 * `docs/tasks/289-position-access-defaults-spine.md`.
 *
 * DELIBERATELY NO CAPABILITY KNOWLEDGE HERE, same rule as `repo/access.ts`'s own top comment:
 * `capability` is a plain `text` column and this file never imports `@shareat/auth`.
 *
 * This file also reads (and, once, writes) `positions`/`employments`/`employment_positions`
 * (`schema/employment.ts`) and `person_grants` (`schema/access.ts`) — not because it owns those
 * tables, but because the fan-out this feature needs ("who has an open employment at this store
 * holding this position", "which of this person's grants trace back to a default at this
 * store") is new SQL this task adds, and `packages/db/src/repo/employment.ts` /
 * `packages/db/src/repo/access.ts` are outside this task's file list (spec's Files-this-task-
 * may-touch — see the task report). Every function still takes a `Tx`, never the base
 * connection, same convention as every other repo file.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { personGrants } from '../../schema/access';
import { employmentPositions, employments, positions } from '../../schema/employment';
import { positionCapabilityDefaults } from '../../schema/position-capability-defaults';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';
import { recordGone } from './record-gone';

export interface PositionCapabilityDefaultRow {
  id: string;
  orgId: string;
  positionId: string;
  storeId: string;
  capability: string;
  setBy: string;
  setAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

// -----------------------------------------------------------------------------------------
// The defaults themselves — append-and-revoke, never delete (Invariant 2).
// -----------------------------------------------------------------------------------------

/** The active default row for this exact (position, store, capability) cell, if any — the
 *  idempotent target for toggling on, and the row toggling off revokes. */
export async function findActiveDefault(
  tx: Tx,
  input: { positionId: string; storeId: string; capability: string },
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: positionCapabilityDefaults.id })
    .from(positionCapabilityDefaults)
    .where(
      and(
        eq(positionCapabilityDefaults.positionId, input.positionId),
        eq(positionCapabilityDefaults.storeId, input.storeId),
        eq(positionCapabilityDefaults.capability, input.capability),
        isNull(positionCapabilityDefaults.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

export async function insertDefault(
  tx: Tx,
  input: { orgId: string; positionId: string; storeId: string; capability: string; setBy: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(positionCapabilityDefaults)
    .values(input)
    .returning({ id: positionCapabilityDefaults.id });
  if (!row) throw new Error('insertDefault: insert returned no row');
  return row;
}

/** T-336 §5 step 1 — the virgin-store guard: true if this store already carries ANY default row,
 *  active or revoked. `seedStoreAccessDefaults` throws rather than seed or re-seed when this is
 *  true, which is what keeps every existing store's rows (including production's `0152` rows)
 *  unreachable by this path even if a future caller tries. */
export async function anyDefaultAtStore(tx: Tx, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: positionCapabilityDefaults.id })
    .from(positionCapabilityDefaults)
    .where(eq(positionCapabilityDefaults.storeId, storeId))
    .limit(1);
  return row !== undefined;
}

export interface InsertDefaultsForNewStoreInput {
  orgId: string;
  storeId: string;
  setBy: string;
  pairs: readonly { positionId: string; capability: string }[];
}

/**
 * T-336 §5 step 4 — one insert per ruled (position, capability) pair on a brand-new store.
 * Explicit conflict target on `position_capability_defaults_active_unique`
 * (`position_id, store_id, capability where revoked_at is null`) — T-335 §4's lesson: an implicit
 * `on conflict do nothing` swallows ANY unique violation, not just this one, which would make
 * `inserted` under-report. Idempotent: a second call with the same pairs inserts 0.
 */
export async function insertDefaultsForNewStore(
  tx: Tx,
  input: InsertDefaultsForNewStoreInput,
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const pair of input.pairs) {
    const result = await tx.execute(sql`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
      values (${input.orgId}, ${pair.positionId}, ${input.storeId}, ${pair.capability}, ${input.setBy})
      on conflict (position_id, store_id, capability) where revoked_at is null
      do nothing
      returning id`);
    inserted += (result as unknown as { id: string }[]).length;
  }
  return { inserted };
}

/** Revokes one default row by id. Throws if it does not exist or is already revoked, the same
 *  posture as `accessRepo.revokeGrantById` — a caller revoking a default should know which one. */
export async function revokeDefaultById(tx: Tx, id: string, revokedBy: string, reason: string): Promise<void> {
  const updated = await tx
    .update(positionCapabilityDefaults)
    .set({ revokedAt: sql`now()`, revokedBy, revokeReason: reason })
    .where(and(eq(positionCapabilityDefaults.id, id), isNull(positionCapabilityDefaults.revokedAt)))
    .returning({ id: positionCapabilityDefaults.id });
  if (updated.length === 0) {
    throw recordGone(`revokeDefaultById: default ${id} does not exist or is already revoked`, 'position default');
  }
}

/** Every ACTIVE default row for a position, regardless of store — retiring a position revokes
 *  all of them (§C8/§C9 moment 6). A canonical position is never retired (refused in the
 *  domain), so in practice this is always exactly one store's rows. */
export async function activeDefaultsForPosition(
  tx: Tx,
  positionId: string,
): Promise<{ id: string; storeId: string; capability: string }[]> {
  return tx
    .select({
      id: positionCapabilityDefaults.id,
      storeId: positionCapabilityDefaults.storeId,
      capability: positionCapabilityDefaults.capability,
    })
    .from(positionCapabilityDefaults)
    .where(and(eq(positionCapabilityDefaults.positionId, positionId), isNull(positionCapabilityDefaults.revokedAt)));
}

// -----------------------------------------------------------------------------------------
// The reconcile primitive's two reads — §C7 steps 2 and 3.
// -----------------------------------------------------------------------------------------

export interface WantedDefaultRow {
  id: string;
  positionId: string;
  capability: string;
}

/**
 * §C7 step 2 — the "wanted" set: every ACTIVE default at `storeId` whose position is among
 * `personId`'s OPEN employment positions at that same store. Empty when there is no open
 * employment there. Joined in one statement rather than fetching position ids first and
 * filtering in TypeScript, so the caller never has to keep the two queries' scoping in step.
 */
export async function wantedDefaultsForPersonAtStore(
  tx: Tx,
  input: { personId: string; storeId: string },
): Promise<WantedDefaultRow[]> {
  return tx
    .selectDistinct({
      id: positionCapabilityDefaults.id,
      positionId: positionCapabilityDefaults.positionId,
      capability: positionCapabilityDefaults.capability,
    })
    .from(positionCapabilityDefaults)
    .innerJoin(employmentPositions, eq(employmentPositions.positionId, positionCapabilityDefaults.positionId))
    .innerJoin(employments, eq(employments.id, employmentPositions.employmentId))
    .where(
      and(
        eq(positionCapabilityDefaults.storeId, input.storeId),
        isNull(positionCapabilityDefaults.revokedAt),
        eq(employments.personId, input.personId),
        eq(employments.storeId, input.storeId),
        isNull(employments.endedOn),
      ),
    );
}

export interface HeldPositionGrantRow {
  id: string;
  sourceRef: string;
  grantName: string;
  positionName: string;
  storeName: string;
}

/**
 * §C7 step 3 — the "held" set: this person's ACTIVE `'position'`-sourced grants whose ref
 * belongs to a default row of `storeId` — active OR revoked (⛔ a switched-off default's grant
 * rows must stay reachable here, or they become unreachable orphans — never write `WHERE
 * position_capability_defaults.revoked_at IS NULL` into this query). Carries the position and
 * store name so the caller can write `"Position default no longer applies: <position> at
 * <store>"` without a second round trip.
 */
export async function heldPositionGrantsForPersonAtStore(
  tx: Tx,
  input: { personId: string; storeId: string },
): Promise<HeldPositionGrantRow[]> {
  const rows = await tx
    .select({
      id: personGrants.id,
      sourceRef: personGrants.sourceRef,
      grantName: personGrants.grantName,
      positionName: positions.name,
      storeName: stores.name,
    })
    .from(personGrants)
    .innerJoin(positionCapabilityDefaults, eq(positionCapabilityDefaults.id, personGrants.sourceRef))
    .innerJoin(positions, eq(positions.id, positionCapabilityDefaults.positionId))
    .innerJoin(stores, eq(stores.id, positionCapabilityDefaults.storeId))
    .where(
      and(
        eq(personGrants.personId, input.personId),
        eq(personGrants.grantSource, 'position'),
        isNull(personGrants.revokedAt),
        eq(positionCapabilityDefaults.storeId, input.storeId),
      ),
    );
  return rows.map((r) => ({ ...r, sourceRef: r.sourceRef as string }));
}

// -----------------------------------------------------------------------------------------
// The fan-out population — §C8 step 6, §C9 moments 1/2/6.
// -----------------------------------------------------------------------------------------

/** Every person with an OPEN employment at `storeId` holding `positionId` — who
 *  `setPositionDefault` and `retireStorePosition` reconcile. */
export async function openEmploymentPersonIdsForPosition(
  tx: Tx,
  input: { storeId: string; positionId: string },
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ personId: employments.personId })
    .from(employments)
    .innerJoin(employmentPositions, eq(employmentPositions.employmentId, employments.id))
    .where(
      and(
        eq(employments.storeId, input.storeId),
        eq(employmentPositions.positionId, input.positionId),
        isNull(employments.endedOn),
      ),
    );
  return rows.map((r) => r.personId);
}

// -----------------------------------------------------------------------------------------
// Retiring a position — §C8, §C9 moment 6.
// -----------------------------------------------------------------------------------------

/** Retiring a position never deletes it (Invariant 2) — this is its FIRST writer (§C9;
 *  `schema/employment.ts`'s comment beside `positions.isActive`). */
export async function deactivatePosition(tx: Tx, positionId: string): Promise<void> {
  await tx.update(positions).set({ isActive: false, updatedAt: sql`now()` }).where(eq(positions.id, positionId));
}

// -----------------------------------------------------------------------------------------
// The read T-291 needs — §C15.
// -----------------------------------------------------------------------------------------

export interface PositionDefaultSource {
  id: string;
  positionId: string;
  positionName: string;
  storeId: string;
  storeName: string;
  revokedAt: Date | null;
}

/** The source facts T-291 renders `"via Cashier at Lipa"` from. Returns `[]` for an empty
 *  input — never an `inArray` on an empty array, the shape
 *  `employmentRepo.listEmploymentPositionsFor` already uses. */
export async function describeSources(tx: Tx, refIds: string[]): Promise<PositionDefaultSource[]> {
  if (refIds.length === 0) return [];
  return tx
    .select({
      id: positionCapabilityDefaults.id,
      positionId: positionCapabilityDefaults.positionId,
      positionName: positions.name,
      storeId: positionCapabilityDefaults.storeId,
      storeName: stores.name,
      revokedAt: positionCapabilityDefaults.revokedAt,
    })
    .from(positionCapabilityDefaults)
    .innerJoin(positions, eq(positions.id, positionCapabilityDefaults.positionId))
    .innerJoin(stores, eq(stores.id, positionCapabilityDefaults.storeId))
    .where(inArray(positionCapabilityDefaults.id, refIds));
}
