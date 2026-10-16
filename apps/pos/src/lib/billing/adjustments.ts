import { arrayUnion, doc, getDoc, increment, serverTimestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { Adjustment, Charge } from "@/lib/types";
import { GRILLER_CHARGE_ID } from "./constants";

/**
 * Resolves the live "Additional Griller" charge, preferring the store's
 * cached storeConfig (what the cashier UI actually reads), falling back to
 * the raw globalCharges doc if the store's cache hasn't been rebuilt yet.
 * Returns null if the charge is missing/disabled/archived — callers must
 * treat that as "can't add automatically", not throw.
 */
export async function resolveGrillerCharge(db: Firestore, storeId: string): Promise<Charge | null> {
  const configSnap = await getDoc(doc(db, "stores", storeId, "storeConfig", "current"));
  const cached = ((configSnap.data()?.charges as Charge[] | undefined) || []).find(
    (c) => c.id === GRILLER_CHARGE_ID && c.isEnabled && !c.isArchived,
  );
  if (cached) return cached;

  const globalSnap = await getDoc(doc(db, "globalCharges", GRILLER_CHARGE_ID));
  const global = globalSnap.data() as (Charge & { applicableStoreIds?: string[] }) | undefined;
  if (global?.isEnabled && !global.isArchived && global.applicableStoreIds?.includes(storeId)) return global;

  return null;
}

/**
 * Builds an Adjustment for a charge, suffixing the id with a caller-supplied
 * unique value (e.g. the triggering request's doc id) so applying the same
 * charge more than once in one session doesn't collide under
 * session-detail-view.tsx's filter-by-id adjustment removal.
 */
export function buildChargeAdjustment(
  charge: Pick<Charge, "id" | "name" | "value" | "type" | "appliesTo">,
  uniqueSuffix: string,
): Adjustment {
  return {
    id: `${charge.id}__${uniqueSuffix}`,
    note: charge.name,
    amount: charge.value,
    type: charge.type,
    source: "charge",
    sourceId: charge.id,
    appliesTo: charge.appliesTo,
  };
}

/**
 * Appends one adjustment to a session's bill. Pure append via arrayUnion —
 * safe against a cashier concurrently editing the same bill, and doesn't
 * require subscribing to the session doc just for this one-directional
 * write.
 */
export async function appendSessionAdjustment(
  db: Firestore,
  storeId: string,
  sessionId: string,
  adjustment: Adjustment,
): Promise<void> {
  const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
  await updateDoc(sessionRef, {
    customAdjustments: arrayUnion(adjustment),
    billingRevision: increment(1),
    updatedAt: serverTimestamp(),
  });
}
