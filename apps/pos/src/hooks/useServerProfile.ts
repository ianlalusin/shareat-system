"use client";

import { useCallback, useEffect, useState } from "react";

export interface ServerProfileState {
  profileId: string;
  name: string;
}

const keyFor = (storeId: string) => `shareat:serverProfile:${storeId}`;

export function useServerProfile(storeId: string | null | undefined) {
  const [currentProfile, setCurrentProfile] = useState<ServerProfileState | null>(null);
  // Track which store the loaded profile corresponds to. `isReady` is then
  // DERIVED (loadedStoreId === storeId) so that the render *between* a storeId
  // change and the effect re-reading localStorage reports not-ready. Using a
  // plain `setIsReady(true)` state instead left a one-render gap where
  // currentProfile was stale-null but isReady was stale-true — which flashed the
  // local-user sign-in gate on every fresh mount/remount (e.g. opening a logs
  // session-audit deep link), even for users who were already signed in.
  const [loadedStoreId, setLoadedStoreId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!storeId) {
      setCurrentProfile(null);
      setLoadedStoreId(null);
      return;
    }
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(keyFor(storeId)) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.profileId === "string" && typeof parsed.name === "string") {
          setCurrentProfile(parsed);
        } else {
          setCurrentProfile(null);
        }
      } else {
        setCurrentProfile(null);
      }
    } catch {
      setCurrentProfile(null);
    }
    setLoadedStoreId(storeId);
  }, [storeId]);

  // Resolved only once we've read storage for the *current* store.
  const isReady = loadedStoreId === (storeId ?? null);

  const signIn = useCallback((profileId: string, name: string) => {
    if (!storeId) return;
    const next: ServerProfileState = { profileId, name };
    try {
      window.localStorage.setItem(keyFor(storeId), JSON.stringify(next));
    } catch {}
    setCurrentProfile(next);
  }, [storeId]);

  const signOut = useCallback(() => {
    if (!storeId) return;
    try {
      window.localStorage.removeItem(keyFor(storeId));
    } catch {}
    setCurrentProfile(null);
  }, [storeId]);

  return { currentProfile, signIn, signOut, isReady };
}
