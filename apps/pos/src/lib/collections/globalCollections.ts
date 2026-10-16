import {
  type Firestore,
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import type { GlobalDiscount, GlobalCharge, Discount } from "@/lib/types";

/**
 * Today's date as YYYY-MM-DD in LOCAL time. Used to gate date-scoped discounts.
 * Takes an optional `now` for deterministic testing.
 */
export function todayDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns true when a discount's optional availability window (startDate/endDate)
 * currently includes `now`. Discounts without any date fields are always in-window.
 */
export function isDiscountDateActive(
  d: Pick<Discount, "startDate" | "endDate"> | Pick<GlobalDiscount, "startDate" | "endDate">,
  now: Date = new Date(),
): boolean {
  const today = todayDateString(now);
  if (d.startDate && today < d.startDate) return false;
  if (d.endDate && today > d.endDate) return false;
  return true;
}

/**
 * Status label for the availability window. Use for UI badges.
 */
export function discountDateStatus(
  d: Pick<Discount, "startDate" | "endDate"> | Pick<GlobalDiscount, "startDate" | "endDate">,
  now: Date = new Date(),
): "always-on" | "scheduled" | "active" | "expired" {
  if (!d.startDate && !d.endDate) return "always-on";
  const today = todayDateString(now);
  if (d.startDate && today < d.startDate) return "scheduled";
  if (d.endDate && today > d.endDate) return "expired";
  return "active";
}

const GLOBAL_DISCOUNTS = "globalDiscounts";
const GLOBAL_CHARGES = "globalCharges";

export async function fetchApplicableGlobalDiscounts(
  db: Firestore,
  storeId: string
): Promise<GlobalDiscount[]> {
  if (!storeId) return [];
  const q = query(
    collection(db, GLOBAL_DISCOUNTS),
    where("applicableStoreIds", "array-contains", storeId),
    where("isArchived", "==", false)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalDiscount));
}

export async function fetchApplicableGlobalCharges(
  db: Firestore,
  storeId: string
): Promise<GlobalCharge[]> {
  if (!storeId) return [];
  const q = query(
    collection(db, GLOBAL_CHARGES),
    where("applicableStoreIds", "array-contains", storeId),
    where("isArchived", "==", false)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalCharge));
}

export function subscribeApplicableGlobalDiscounts(
  db: Firestore,
  storeId: string,
  onUpdate: (items: GlobalDiscount[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, GLOBAL_DISCOUNTS),
    where("applicableStoreIds", "array-contains", storeId),
    where("isArchived", "==", false)
  );
  return onSnapshot(
    q,
    snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalDiscount))),
    err => onError?.(err)
  );
}

export function subscribeApplicableGlobalCharges(
  db: Firestore,
  storeId: string,
  onUpdate: (items: GlobalCharge[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, GLOBAL_CHARGES),
    where("applicableStoreIds", "array-contains", storeId),
    where("isArchived", "==", false)
  );
  return onSnapshot(
    q,
    snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalCharge))),
    err => onError?.(err)
  );
}
