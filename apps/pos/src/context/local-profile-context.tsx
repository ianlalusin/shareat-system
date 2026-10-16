"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useStoreContext } from "@/context/store-context";
import { useServerProfile, type ServerProfileState } from "@/hooks/useServerProfile";
import { ServerProfileSwitcher } from "@/components/server/ServerProfileSwitcher";
import { setActiveLocalProfile } from "@/lib/server-profiles/activeLocalProfile";

interface LocalProfileContextValue {
  currentProfile: ServerProfileState | null;
  isReady: boolean;
  signIn: (profileId: string, name: string) => void;
  signOut: () => void;
  /** Opens the global local-user selector dialog. */
  openSwitcher: () => void;
}

const LocalProfileContext = createContext<LocalProfileContextValue | null>(null);

/**
 * Single source of truth for the device's local profile (server/KDS/cashier
 * stations). Holds the state once, exposes it to the navbar + pages, and mounts
 * one global ServerProfileSwitcher so signing in/out from the navbar stays in
 * sync with the page gates.
 */
export function LocalProfileProvider({ children }: { children: React.ReactNode }) {
  const { activeStore } = useStoreContext();
  const storeId = activeStore?.id ?? null;
  const { currentProfile, signIn, signOut, isReady } = useServerProfile(storeId);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Expose the local profile to fire-and-forget loggers for attribution.
  useEffect(() => {
    setActiveLocalProfile(currentProfile ? { id: currentProfile.profileId, name: currentProfile.name } : null);
    return () => setActiveLocalProfile(null);
  }, [currentProfile]);

  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);

  const value = useMemo<LocalProfileContextValue>(
    () => ({ currentProfile, isReady, signIn, signOut, openSwitcher }),
    [currentProfile, isReady, signIn, signOut, openSwitcher],
  );

  return (
    <LocalProfileContext.Provider value={value}>
      {children}
      {storeId && (
        <ServerProfileSwitcher
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          storeId={storeId}
          currentProfileId={currentProfile?.profileId ?? null}
          onSignIn={signIn}
          onSignOut={signOut}
        />
      )}
    </LocalProfileContext.Provider>
  );
}

export function useLocalProfile(): LocalProfileContextValue {
  const ctx = useContext(LocalProfileContext);
  if (!ctx) throw new Error("useLocalProfile must be used within a LocalProfileProvider");
  return ctx;
}
