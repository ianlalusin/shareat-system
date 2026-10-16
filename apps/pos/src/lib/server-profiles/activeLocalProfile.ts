"use client";

/**
 * Holds the local profile currently signed in on this device/tab so that
 * fire-and-forget loggers (writeActivityLog) can attribute actions without
 * threading the profile through every call site.
 *
 * A surface (server / KDS / cashier) sets this from its `useServerProfile`
 * state and clears it on unmount. Explicitly-passed `serverProfile` always
 * takes precedence over this fallback.
 */
export type ActiveLocalProfile = { id: string; name: string } | null;

let active: ActiveLocalProfile = null;

export function setActiveLocalProfile(profile: ActiveLocalProfile): void {
  active = profile;
}

export function getActiveLocalProfile(): ActiveLocalProfile {
  return active;
}
