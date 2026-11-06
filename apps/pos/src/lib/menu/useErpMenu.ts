"use client";

/**
 * T-508 S5 (R9) - what the screens read. `useMenuSync(posStoreId)` runs ONCE app-wide (StoreContextProvider) and keeps the cache fresh;
 * `useErpMenu()` is the read side every consumer calls. With source `firestore` (the default) `erp` is false and `menu` is null:
 * consumers then run exactly their old Firestore code.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { auth } from "@/lib/firebase/client";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { getConnectivityStore, useConnectivity } from "@/hooks/useConnectivity";
import type { ErpMenu as StoreMenuV2 } from "./types";
import { createMenuStore } from "./menuStore";
import type { MenuResponse } from "./refresh";
import * as erp from "./from-erp";
import { startClock } from "./clock";

let singleton: ReturnType<typeof createMenuStore> | null = null;

async function fetchMenu(storeId: string, ifNoneMatch: string | null): Promise<MenuResponse> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) return { status: 401 };
  const res = await fetch("/api/pos2/menu", {
    method: "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "x-pos-store-id": storeId, "x-device-id": getBrowserDeviceId(), ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}) },
  });
  // T-510 S4b: the next daypart boundary rides a header on 200 AND 304, so a "nothing changed" answer still re-arms the device timer.
  const nextChangeAt = res.headers.get("x-next-change-at") || null;
  if (res.status !== 200) return { status: res.status, nextChangeAt };
  return { status: 200, body: await res.json().catch(() => null), nextChangeAt };
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

export function useErpMenu(): { erp: boolean; menu: StoreMenuV2 | null; nextChangeAt: string | null } {
  const store = getMenuStore();
  const s = useSyncExternalStore(store.subscribe, store.getState, () => SERVER_STATE);
  const on = s.source === "erp";
  return { erp: on, menu: on ? s.cached?.menu ?? null : null, nextChangeAt: on ? s.cached?.nextChangeAt ?? null : null };
}

/**
 * Everything the adapter derives, computed once per menu AND per daypart window: the clock ticks at the next boundary and when the app returns to
 * the front, so the package list flips at 17:00 with no network (T-510 S4b). Exported so a test can drive it without the singleton store.
 */
export function useAdaptedAt(on: boolean, menu: StoreMenuV2 | null, nextChangeAt: string | null) {
  const [tick, setTick] = useState(0); // only an invalidation: the clock is read fresh inside the memo
  useEffect(() => (on && menu ? startClock({ menu, nextChangeAt, onTick: () => setTick((t) => t + 1) }) : undefined), [on, menu, nextChangeAt]);
  return useMemo(() => {
    if (!on) return null;
    const now = Date.now(); // `tick` below is the trigger; the clock is read here, fresh, so a new menu never prices from an old reading
    return {
      menu, loaded: menu !== null,
      packages: menu ? erp.adaptPackages(menu, now) : [], closedPackages: menu ? erp.adaptClosedPackages(menu, now) : [],
      refills: menu ? erp.adaptRefills(menu) : [], globalRefills: menu ? erp.adaptGlobalRefills(menu) : [],
      flavors: menu ? erp.adaptFlavors(menu) : [], addons: menu ? erp.adaptAddons(menu, now) : [], kitchenLocations: menu ? erp.adaptKitchenLocations(menu) : [],
    };
  }, [on, menu, tick]);
}

export function useErpAdapted() {
  const { erp: on, menu, nextChangeAt } = useErpMenu();
  return useAdaptedAt(on, menu, nextChangeAt);
}
