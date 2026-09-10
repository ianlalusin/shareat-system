/** T-253 / DEF-220 — which store this screen opens on when the URL names none.
 *
 * ⭐ Pure and dependency-free ON PURPOSE. The test that pins it must not import `@shareat/db`
 * (page.tsx cannot be imported at all — `@/` has no vitest alias), and a selector with no imports
 * is a selector whose test cannot go red for somebody else's reason. */
export interface StoreCandidate {
  readonly id: string;
}

/**
 * The first store that IS a commissary, or the signed-in store when that store is one.
 *
 * ⛔ Returns `undefined` when the org has no commissary — never a fallback to "some store", which
 * is DEF-220 itself. The caller renders an explicit empty state.
 *
 * ⚠️ Order comes from `stores` as given; this function never sorts, never matches a name or code,
 * and never indexes. Membership of `commissaryStoreIds` is the only thing it reads.
 */
export function selectDefaultCommissaryStoreId(
  stores: readonly StoreCandidate[],
  commissaryStoreIds: ReadonlySet<string>,
  signedInStoreId: string | null,
): string | undefined {
  // ⚠️ The signed-in store must also be IN `stores` — `commissaryStoreIds` and `signedInStoreId`
  // can in principle name a store outside this org's list; the returned id must always be one this
  // page actually knows how to render.
  if (
    signedInStoreId !== null &&
    commissaryStoreIds.has(signedInStoreId) &&
    stores.some((s) => s.id === signedInStoreId)
  ) {
    return signedInStoreId;
  }
  return stores.find((s) => commissaryStoreIds.has(s.id))?.id;
}
