/**
 * Which refills a customer may actually see — pure, no Firestore.
 *
 * Refill availability has TWO switches and they mean different things:
 *   - global  `refills/{id}.isActive`        — chain-wide kill switch
 *   - store   `storeRefills/{id}.isEnabled`  — availability at one store
 *
 * Only the second was ever enforced on the displayed list, so deactivating an
 * item in the global admin appeared to do nothing. Both are honoured here.
 */

export type RefillLike = {
  refillId: string;
  refillName?: string;
  isOther?: boolean;
  isEnabled?: boolean;
};

/**
 * Ids whose global doc EXISTS and is explicitly inactive.
 *
 * Deliberately fail-open: a storeRefill with no global doc at all is left
 * visible rather than silently disappearing from the menu. A missing global
 * doc is a data problem to surface in the admin, not a reason to hide a
 * refill the store has switched on.
 */
export function globalInactiveIds(
  globals: Array<{ id: string; isActive?: boolean }>
): Set<string> {
  const inactive = new Set<string>();
  for (const g of globals) {
    if (g && g.id && g.isActive === false) inactive.add(g.id);
  }
  return inactive;
}

/** Split the refills a customer may order into meats and "Other Refills". */
export function partitionVisibleRefills<T extends RefillLike>(
  storeRefills: T[],
  globalInactive: Set<string>,
  packageAllowed?: string[] | null
): { mains: T[]; others: T[] } {
  const allowed =
    packageAllowed && packageAllowed.length ? new Set(packageAllowed) : null;

  const visible = (storeRefills || []).filter((r) => {
    if (!r || !r.refillId) return false;
    if (r.isEnabled === false) return false;
    if (globalInactive.has(r.refillId)) return false;
    if (allowed && !allowed.has(r.refillId)) return false;
    return true;
  });

  return {
    mains: visible.filter((r) => !r.isOther),
    others: visible.filter((r) => !!r.isOther),
  };
}

/**
 * Ids a package still grants that the editor can no longer show — because the
 * refill was disabled per-store, retired globally, or deleted outright.
 *
 * These are invisible in the package editor today: not listed, not unticked,
 * silently retained. That is how a package can keep pointing at a refill
 * nobody can order.
 */
export function stalePackageIds(
  refillsAllowed: string[] | null | undefined,
  selectableIds: Iterable<string>
): string[] {
  const selectable = new Set(selectableIds);
  const seen = new Set<string>();
  const stale: string[] = [];

  for (const id of refillsAllowed || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!selectable.has(id)) stale.push(id);
  }
  return stale;
}
