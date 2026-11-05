"use client";

/**
 * T-508 S5 (R9) - the `{ id, printOnOutage }` list the offline kitchen-ticket backup print reads. Source `erp`: the cached projection's stations.
 * Source `firestore` (default): the same `stores/{id}/kitchenLocations` read the call sites made before, unchanged.
 */
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMenuStore } from "./useErpMenu";
import { adaptKitchenLocations } from "./from-erp";

export type PrintLocation = { id: string; printOnOutage?: boolean };

export async function loadPrintLocations(
  storeId: string,
  d: { state: () => { source: string; cached: { menu: Parameters<typeof adaptKitchenLocations>[0] } | null }; firestore: (storeId: string) => Promise<PrintLocation[]> } = {
    state: () => getMenuStore().getState(),
    firestore: async (id) => (await getDocs(collection(db, "stores", id, "kitchenLocations"))).docs.map((x) => ({ id: x.id, printOnOutage: (x.data() as any).printOnOutage })),
  },
): Promise<PrintLocation[]> {
  const s = d.state();
  if (s.source === "erp") return s.cached ? adaptKitchenLocations(s.cached.menu).map((k) => ({ id: k.id, printOnOutage: k.printOnOutage })) : [];
  return d.firestore(storeId);
}
