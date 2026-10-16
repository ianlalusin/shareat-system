"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";

import { db } from "@/lib/firebase/client";
import type { SavedQrCode } from "@/lib/types";

export type SavedQrCodesState = {
  qrCodes: SavedQrCode[];
  loading: boolean;
  error: string | null;
};

/**
 * Live list of the store's saved QR codes.
 *
 * NO server-side filter or sort, on purpose. The wallet is a handful of
 * documents per store, so ordering and the isActive filter both happen in
 * memory below.
 *
 * This is not a style preference — every server-side alternative needs a
 * COMPOSITE INDEX, and an index that has not been deployed fails the query
 * outright rather than degrading. That is what a `where('isActive','==',true)`
 * would cost, and it is exactly what an earlier version of this hook hit by
 * combining orderBy('sortOrder') with orderBy('name'): the wallet showed
 * "Couldn't load the wallet. The query requires an index." for every user
 * until someone with console access created it.
 *
 * Reading the whole (tiny) collection and sorting here has no index to deploy,
 * no failure mode, and works from the offline cache. Revisit only if a store
 * ever accumulates enough saved QRs for this to matter, which is unlikely —
 * they are wallets, not a catalogue.
 *
 * Sorted by sortOrder then name so the tile grid stays stable between renders;
 * a wallet whose tiles move around is one a cashier cannot build muscle memory
 * for. Inactive entries are returned to callers, which hide them from the grid.
 */
export function useSavedQrCodes(storeId: string | null): SavedQrCodesState {
  const [qrCodes, setQrCodes] = useState<SavedQrCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) {
      setQrCodes([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const unsubscribe = onSnapshot(
      collection(db, "stores", storeId, "savedQrCodes"),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SavedQrCode);
        rows.sort(
          (a, b) =>
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
            (a.name ?? "").localeCompare(b.name ?? ""),
        );
        setQrCodes(rows);
        setLoading(false);
      },
      (err) => {
        console.warn("[useSavedQrCodes] snapshot failed:", err);
        setError(err.message);
        setQrCodes([]);
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [storeId]);

  return useMemo(() => ({ qrCodes, loading, error }), [qrCodes, loading, error]);
}
