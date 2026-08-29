/**
 * The room model's pure rules — T-160.
 *
 * ⭐ **What is here and what is in the migration, and the split is not arbitrary.** A partial
 * unique index can refuse a second Receiving room; it cannot decide which room a receive falls
 * back to when there is no Receiving room, nor what an unknown legacy role should become. Those
 * are *decisions*, and this file is where they live — testable without a database, and therefore
 * testable at all before the migration lands.
 *
 * ⚠️ Nothing here is a substitute for the database constraint. §6.3's rule holds: *the database
 * enforces the rules, not the service layer.* These functions exist so the app can answer
 * "why not?" in a sentence, and so the decision is written down once instead of re-derived at
 * each call site. Where a rule can be a constraint, it is ALSO a constraint.
 */
import type { LocationPurpose, LocationRole, LocationStatus } from '@shareat/db/schema';

/** How a store organises stock. ⚠️ The column lives on `stores` and lands with the migration. */
export type StockModel = 'single_room' | 'multi_room';

/** The fields every rule below reads, and nothing else — so a caller may pass a full row or a
 *  projection without either drifting from this contract. */
export interface LocationLike {
  readonly id: string;
  readonly role: LocationRole;
  readonly purpose: LocationPurpose;
  readonly isDefault: boolean;
  readonly status: LocationStatus;
}

export type RuleResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const isActive = (l: LocationLike): boolean => l.status === 'active';

/**
 * Where a received line parks when nobody has chosen a room.
 *
 * ⭐ **The ordering is exact and it is v1's, kept deliberately** (`receive-allocation.ts:14-22`):
 * the Receiving room, else the default room, else any active room — and `null` only when the store
 * has no active room at all.
 *
 * ⛔ **It never guesses the default room while a Receiving room exists.** Parking an undecided
 * line is honest; filing it into the default room looks decided and is not, and v1 named this as a
 * fix over its own earlier behaviour.
 */
export function resolveReceivingLocation(locations: readonly LocationLike[]): string | null {
  const active = locations.filter(isActive);
  const receiving = active.find((l) => l.purpose === 'receiving');
  if (receiving) return receiving.id;

  const fallback = active.find((l) => l.isDefault) ?? active[0];
  return fallback ? fallback.id : null;
}

/**
 * May stock be CONSUMED from this room?
 *
 * Called by every usage, wastage and production writer in Waves 1–3 (T-164, T-168, T-176), each of
 * which carries its own test proving the refusal fires — a guard wired at four of five call sites
 * is v1's AP tile all over again.
 */
export function assertUsageSource(location: LocationLike): RuleResult {
  if (!isActive(location)) {
    return { ok: false, reason: `location ${location.id} is inactive and cannot be a usage source` };
  }
  if (location.purpose === 'receiving') {
    return {
      ok: false,
      reason: `location ${location.id} is the Receiving parking spot, not a place stock is used`,
    };
  }
  if (location.role !== 'operating') {
    return {
      ok: false,
      reason: `location ${location.id} is a storage room; only an operating room may be a usage source`,
    };
  }
  return { ok: true };
}

/**
 * ⭐ **An unknown role becomes `storage`, and the direction is the decision.**
 *
 * v1: *"a mis-migrated location can't silently drain stock."* Under-permitting surfaces as a
 * person asking why they cannot post; over-permitting surfaces as stock that left without a
 * record. Only one of those is recoverable.
 */
export function normaliseRole(role: string | null | undefined): LocationRole {
  return role === 'operating' || role === 'storage' ? role : 'storage';
}

/**
 * Which rooms lose the default flag when `incomingId` becomes the default.
 *
 * ⚠️ Includes INACTIVE rooms. A retired room keeping the flag means reactivating it later trips
 * the partial unique index, and the error surfaces at a form that has nothing to do with it.
 */
export function defaultsToClear(
  locations: readonly LocationLike[],
  incomingId: string,
): string[] {
  return locations.filter((l) => l.isDefault && l.id !== incomingId).map((l) => l.id);
}

/**
 * ⭐ v1 shipped `branch-stock-reconcile.actions.ts` to REPAIR branches that had drifted into
 * several rooms — floor the negative balances, move everything into a canonical room, delete the
 * strays. **This is that repair tool turned into an invariant**, which is the difference between
 * fixing the drift and not having it.
 *
 * The Receiving room does not count: every store needs somewhere to park a receive, including a
 * branch that keeps its stock in exactly one place.
 *
 * @returns `null` when the shape is legal, or a sentence naming the offending rooms.
 */
export function singleRoomViolation(
  model: StockModel,
  locations: readonly LocationLike[],
): string | null {
  if (model !== 'single_room') return null;

  const rooms = locations.filter((l) => isActive(l) && l.purpose !== 'receiving');
  if (rooms.length <= 1) return null;

  const extra = rooms.slice(1).map((l) => l.id);
  return `a single_room store may hold one non-Receiving room; these are extra: ${extra.join(', ')}`;
}
