"use client";

/**
 * T-508 S5 (R9) - what the screens read. `useMenuSync(posStoreId)` runs ONCE app-wide (StoreContextProvider) and keeps the cache fresh;
 * `useErpMenu()` is the read side every consumer calls. With source `firestore` (the default) `erp` is false and `menu` is null:
 * consumers then run exactly their old Firestore code.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { auth } from "@/lib/firebase/client";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { getConnectivityStore, useConnectivity } from "@/hooks/useConnectivity";
import type { ErpMenu as StoreMenuV2 } from "./types";
import { createMenuStore } from "./menuStore";
import type { MenuResponse } from "./refresh";
import * as erp from "./from-erp";

let singleton: ReturnType<typeof createMenuStore> | null = null;

async function fetchMenu(storeId: string, ifNoneMatch: string | null): Promise<MenuResponse> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) return { status: 401 };
  const res = await fetch("/api/pos2/menu", {
    method: "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "x-pos-store-id": storeId, "x-device-id": getBrowserDeviceId(), ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}) },
  });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, body: await res.json().catch(() => null) };
}

export function getMenuStore() {
  if (!singleton) singleton = createMenuStore({ connectivity: getConnectivityStore(), fetchMenu });
  return singleton;
}

/** Mount once, in the app-wide provider. Also keeps the connectivity probe running so the source is learned. */
export function useMenuSync(posStoreId: string | null | undefined): void {
  useConnectivity(); // holds the probe running (and tells us the source)
  useEffect(() => {
    const stop = posStoreId ? getMenuStore().start(posStoreId) : undefined;
    return () => { stop?.(); };
  }, [posStoreId]);
}

const SERVER_STATE = { source: "firestore", cached: null } as const;

export function useErpMenu(): { erp: boolean; menu: StoreMenuV2 | null } {
  const store = getMenuStore();
  const s = useSyncExternalStore(store.subscribe, store.getState, () => SERVER_STATE);
  return { erp: s.source === "erp", menu: s.source === "erp" ? s.cached?.menu ?? null : null };
}

/** Everything the adapter derives, computed once per menu. */
export function useErpAdapted() {
  const { erp: on, menu } = useErpMenu();
  return useMemo(() => !on ? null : {
    menu, loaded: menu !== null,
    packages: menu ? erp.adaptPackages(menu) : [], refills: menu ? erp.adaptRefills(menu) : [], globalRefills: menu ? erp.adaptGlobalRefills(menu) : [],
    flavors: menu ? erp.adaptFlavors(menu) : [], addons: menu ? erp.adaptAddons(menu) : [], kitchenLocations: menu ? erp.adaptKitchenLocations(menu) : [],
  }, [on, menu]);
}
