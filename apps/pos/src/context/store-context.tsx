
"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { doc, documentId, getDoc, getDocs, collection, updateDoc, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import type { Store } from "@/lib/types";
import { getDisplayName } from "@/lib/products/variants";

// ---------------------------------------------------------------------------
// Inherited add-on photos (local-overrides-global fallback, cashier side)
//
// `stores/{storeId}/inventory/{itemId}.imageUrl` is a PURE per-store override:
// null/absent means "this store has no photo of its own, show the global
// products/{id}.imageUrl", and it is deliberately never seeded with a copy of
// the global photo (see /manager/inventory's handleAddItems). The cashier
// client loads no `products` data at all — `storeAddons` below is built from
// inventory only — so without a join here, an add-on the store has not
// photographed itself shows a blank tile in the add-on / family pickers even
// when the global catalog does have a picture.
//
// This join is in-memory ONLY. It fills `imageUrl` on the JS objects held in
// the `storeAddons` state; the Firestore field itself is never written. That
// distinction is the whole point — writing the inherited value back is exactly
// the (now removed) copy-on-add behaviour that made stale local copies win over
// the global photo forever.
// ---------------------------------------------------------------------------

/** Firestore caps `where(documentId(), "in", …)` at 30 values per query. */
const PRODUCT_IMAGE_CHUNK_SIZE = 30;

/** The only fields of a `storeAddons` row this join reads. */
type AddonLike = { id?: string; productId?: string | null; imageUrl?: string | null };

/** A `storeAddons` row. The state is `any[]`; this keeps the join fields typed. */
type StoreAddonRow = Record<string, any> & AddonLike;

/**
 * True when the row has a photo of its own. An empty string counts as "no
 * photo", matching how every consumer renders it (`{addon.imageUrl && <Image
 * …>}`) — otherwise a degenerate `""` would block the inherited photo and
 * still show a blank tile.
 */
function hasLocalPhoto(item: AddonLike): boolean {
  return typeof item.imageUrl === "string" && item.imageUrl.length > 0;
}

/**
 * The global catalog id an inventory row is linked to. `productId` is the
 * authoritative field; falling back to the doc id matches how the rest of the
 * cashier path resolves it (e.g. AddonsPOSModal's option-groups lookup), since
 * the standard import paths use the product id as the inventory doc id.
 */
function linkedProductId(item: AddonLike): string {
  return (typeof item.productId === "string" && item.productId) || item.id || "";
}

/**
 * @internal Exported for tests.
 *
 * The DISTINCT product ids we still need a global photo for: rows with no local
 * photo, whose product hasn't already been resolved this session. A cached
 * `null` (product has no photo either, or no product doc) counts as resolved —
 * re-querying those on every snapshot is exactly the cost this cache exists to
 * avoid.
 */
export function collectMissingImageProductIds(
  items: StoreAddonRow[],
  cache: ReadonlyMap<string, string | null>
): string[] {
  const out = new Set<string>();
  for (const item of items) {
    if (hasLocalPhoto(item)) continue;
    const productId = linkedProductId(item);
    if (!productId || cache.has(productId)) continue;
    out.add(productId);
  }
  return Array.from(out);
}

/** @internal Exported for tests. Splits ids into `in`-sized chunks. */
export function chunkIds(ids: string[], size: number = PRODUCT_IMAGE_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * @internal Exported for tests.
 *
 * Returns a new array with the inherited global photo filled in on rows that
 * have no local one. Rows that need no change keep their identity. Never
 * mutates its input, and never overwrites a row's own photo.
 */
export function applyInheritedImages(
  items: StoreAddonRow[],
  cache: ReadonlyMap<string, string | null>
): StoreAddonRow[] {
  return items.map((item) => {
    if (hasLocalPhoto(item)) return item;
    const inherited = cache.get(linkedProductId(item));
    if (!inherited) return item;
    return { ...item, imageUrl: inherited };
  });
}

/**
 * @internal Exported for tests.
 *
 * Batch-resolves global photos for `productIds` into `cache`, in chunks of
 * `PRODUCT_IMAGE_CHUNK_SIZE`.
 *
 * OFFLINE BEHAVIOUR — the subtle part. `getDocs` does NOT reject when the
 * client is offline. Verified against this repo's installed SDK
 * (@firebase/firestore/dist/index.esm2017.js): the shared listener helper only
 * rejects on `snapshot.fromCache && source === "server"`, and `getDocs` passes
 * no source at all (only `getDocsFromServer` sets it). So offline it RESOLVES
 * from the local cache — and since the cashier path never otherwise reads
 * `products`, that cache is normally EMPTY, i.e. an empty snapshot that looks
 * exactly like "none of these products exist".
 *
 * Caching a `null` for those would permanently mark every add-on pictureless
 * for the rest of the session (the cache deliberately never re-queries a
 * resolved id), silently and with no error anywhere. So absence is only
 * trusted when the SERVER confirmed it — `metadata.fromCache === false`.
 * Anything not resolved is left uncached and stays eligible for a retry.
 *
 * A document the cache DID return is a real value and is cached as-is, even on
 * a `fromCache` result: a possibly-stale real photo beats a blank tile, and
 * refreshStoreAddons drops the whole cache if staff need to force a re-read.
 *
 * A rejection (a real error — permissions, a malformed query) still propagates;
 * nothing is cached for that chunk. Callers must handle it (see
 * fetchStoreAddons).
 */
export async function resolveProductImages(
  cache: Map<string, string | null>,
  productIds: string[]
): Promise<void> {
  for (const chunk of chunkIds(productIds)) {
    const snapshot = await getDocs(query(collection(db, "products"), where(documentId(), "in", chunk)));
    // An offline / cache-only result cannot prove a product is absent.
    const canTrustAbsence = snapshot.metadata?.fromCache === false;

    const found = new Map<string, string | null>();
    snapshot.docs.forEach((d) => {
      const url = (d.data() as any)?.imageUrl;
      found.set(d.id, typeof url === "string" && url ? url : null);
    });

    for (const id of chunk) {
      const url = found.get(id);
      if (url !== undefined) {
        cache.set(id, url); // a real document, cached or not
      } else if (canTrustAbsence) {
        cache.set(id, null); // the server confirmed: no such product
      }
      // else: leave uncached so the next enrichment run retries it.
    }
  }
}

type StoreContextValue = {
  stores: Store[];
  activeStore: Store | null;
  activeStoreId: string | null;
  loading: boolean;
  setActiveStoreById: (storeId: string) => Promise<void>;
  refreshStoresOnce: () => Promise<void>;
  storeAddons: any[];
  storeAddonsLoading: boolean;
  refreshStoreAddons: () => void;
  /**
   * Idempotent. Call from a consumer (e.g. AddonsPOSModal) on mount to opt in
   * to the store's inventory/addons subscription. Devices that never open the
   * addons picker (kitchen, dashboard, settings) avoid the initial 100+ doc
   * read entirely. Once enabled, the subscription persists for the session so
   * repeated modal opens stay instant.
   */
  enableStoreAddons: () => void;
};

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreContextProvider({ children }: { children: React.ReactNode }) {
  const { appUser } = useAuthContext();
  const [stores, setStores] = useState<Store[]>([]);
  const [activeStore, setActiveStore] = useState<Store | null>(null);
  const [loading, setLoading] = useState(true);

  // Store-specific addons — lazy. The subscription stays dormant until a
  // consumer calls `enableStoreAddons()` (typically the cashier addon picker
  // on first mount), then persists for the rest of the session.
  const [storeAddons, setStoreAddons] = useState<any[]>([]);
  const [storeAddonsLoading, setStoreAddonsLoading] = useState(false);
  const [addonsEnabled, setAddonsEnabled] = useState(false);

  // Global catalog photos, keyed by productId — see the module header above.
  //
  // A ref, not state: it must survive every onSnapshot re-fire (which happens
  // on ANY inventory write at this store, not just the first load) without
  // itself triggering a render. `products` is a global collection, so the cache
  // stays valid across store switches.
  //
  // Accepted staleness: an admin promoting or clearing a global photo mid-shift
  // is not picked up until the page reloads. A store's OWN photo is unaffected
  // — that lives on the inventory doc the subscription below already watches.
  const productImageCacheRef = useRef<Map<string, string | null>>(new Map());

  // Generation counter, so a slow product-image lookup can never overwrite a
  // newer inventory snapshot that landed while it was in flight.
  const addonImagesSeqRef = useRef(0);

  const isPlatformAdmin = useMemo(() => appUser?.isPlatformAdmin === true, [appUser]);

  const loadStoresOnce = useCallback(async () => {
    if (!appUser) {
      setStores([]);
      setActiveStore(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      let fetchedStores: Store[] = [];
      const assigned = Array.isArray(appUser.assignedStoreIds) ? appUser.assignedStoreIds : [];

      if (isPlatformAdmin) {
        const q = query(collection(db, "stores"));
        const querySnapshot = await getDocs(q);
        fetchedStores = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store));
      } else if (assigned.length > 0) {
          const storePromises = assigned.map(storeId => getDoc(doc(db, "stores", storeId)));
          const results = await Promise.all(storePromises);
          fetchedStores = results
              .filter(snap => snap.exists())
              .map(snap => ({ id: snap.id, ...snap.data() } as Store));
      }
      
      // Null-safe sort: a store doc with a missing name must NOT throw (that
      // would wipe the whole list and stick the switcher on "Loading
      // stores..."). Keep such docs visible — with a fallback label downstream —
      // so an admin can actually see and fix them instead of them vanishing.
      const validStores = fetchedStores
        .filter(s => (s as any).isActive !== false)
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      
      setStores(validStores);

      const storedId = localStorage.getItem('activeStoreId');
      let activeStoreCandidate: Store | null = null;

      // 1. Try from localStorage if it's a valid store the user can access.
      if (storedId) {
          const fromStorage = validStores.find(s => s.id === storedId);
          if (fromStorage) {
              activeStoreCandidate = fromStorage;
          }
      }

      // 2. If not found in storage, try the user's first assigned store.
      if (!activeStoreCandidate && assigned.length > 0) {
          const firstAssignedId = assigned[0];
          activeStoreCandidate = validStores.find(s => s.id === firstAssignedId) || null;
      }

      // 3. If still no candidate, fall back to the first store in the sorted list.
      if (!activeStoreCandidate && validStores.length > 0) {
          activeStoreCandidate = validStores[0];
      }

      setActiveStore(activeStoreCandidate);

    } catch (e) {
      console.error("Failed to load stores:", e);
      setStores([]);
      setActiveStore(null);
    } finally {
      setLoading(false);
    }
  }, [appUser, isPlatformAdmin]);

  useEffect(() => {
    if (!appUser) {
        // Clear stores and active store immediately on logout
        setStores([]);
        setActiveStore(null);
        setLoading(false);
    } else {
        loadStoresOnce();
    }
  }, [appUser, loadStoresOnce]);


  const fetchStoreAddons = useCallback(() => {
    if (!activeStore?.id || !appUser) {
        setStoreAddons([]);
        setStoreAddonsLoading(false);
        return () => {};
    }
    setStoreAddonsLoading(true);

    let cancelled = false;

    const addonsRef = collection(db, "stores", activeStore.id, "inventory");
    const q = query(addonsRef, where("isAddon", "==", true), where("isActive", "==", true));

    const unsubscribe = onSnapshot(q, (snapshot) => {
        const addonsData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            displayName: getDisplayName(doc.data() as any),
            groupKey: (doc.data() as any).groupId || doc.id,
        }));

        // Paint immediately with whatever the cache already knows — the add-on
        // picker must open instantly, so the products lookup below is a second,
        // async step and never gates this first render.
        const seq = ++addonImagesSeqRef.current;
        setStoreAddons(applyInheritedImages(addonsData, productImageCacheRef.current));
        setStoreAddonsLoading(false);

        const missing = collectMissingImageProductIds(addonsData, productImageCacheRef.current);
        if (missing.length === 0) return;

        void (async () => {
          try {
            await resolveProductImages(productImageCacheRef.current, missing);
          } catch (error) {
            // Non-fatal by design. This is NOT the offline path — getDocs
            // resolves (from the local cache) rather than rejecting when the
            // till has no connection; resolveProductImages handles that case by
            // declining to cache unconfirmed absences. This catch is for a real
            // error (permissions, a malformed query), and exists so one failed
            // photo lookup can never take down the add-on subscription or throw
            // an unhandled rejection. Those rows just keep showing no inherited
            // picture; prices, availability and the whole ordering flow are
            // untouched. Nothing is cached for a failed chunk, so it retries.
            console.error("Failed to resolve inherited add-on photos:", error);
          }
          // Re-derive from THIS snapshot's rows, and only while it is still the
          // newest one. A snapshot that landed while the lookup was in flight
          // has already painted and started its own lookup, so applying stale
          // rows here would roll the picker back to older inventory data.
          if (cancelled || addonImagesSeqRef.current !== seq) return;
          setStoreAddons(applyInheritedImages(addonsData, productImageCacheRef.current));
        })();
    }, (error) => {
        if(appUser) {
          console.error("Failed to fetch store addons:", error);
        }
        setStoreAddonsLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeStore?.id, appUser]);


  useEffect(() => {
      if (!addonsEnabled) return;
      const unsub = fetchStoreAddons();
      return () => { unsub(); }
  }, [addonsEnabled, fetchStoreAddons])

  /**
   * The add-on picker's manual "Refresh" button (AddonsPOSModal). Drops the
   * resolved-photo cache before re-subscribing, which is the staff-facing
   * recovery path for every case the cache cannot recover from on its own:
   *  - a till that resolved photos while offline, where a product could not be
   *    confirmed and was left unresolved — the add-ons subscription does not
   *    re-fire on reconnect alone (it has no includeMetadataChanges), so
   *    without this there is nothing to trigger a retry until a page reload;
   *  - an admin promoting or rejecting a global photo mid-shift, which the
   *    session cache otherwise would not pick up.
   */
  const refreshStoreAddons = useCallback(() => {
      productImageCacheRef.current.clear();
      return fetchStoreAddons();
  }, [fetchStoreAddons]);

  const enableStoreAddons = useCallback(() => {
      setAddonsEnabled((prev) => prev || true);
  }, []);

  const setActiveStoreById = useCallback(
    async (storeId: string) => {
      localStorage.setItem('activeStoreId', storeId);
      const next = stores.find((s) => s.id === storeId) || null;
      setActiveStore(next);
    },
    [stores]
  );

  const value = useMemo<StoreContextValue>(
    () => ({
      stores,
      activeStore,
      activeStoreId: activeStore?.id || null,
      loading,
      setActiveStoreById,
      refreshStoresOnce: loadStoresOnce,
      storeAddons,
      storeAddonsLoading,
      refreshStoreAddons,
      enableStoreAddons,
    }),
    [stores, activeStore, loading, setActiveStoreById, loadStoresOnce, storeAddons, storeAddonsLoading, refreshStoreAddons, enableStoreAddons]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStoreContext() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStoreContext must be used within a StoreContextProvider");
  return ctx;
}
