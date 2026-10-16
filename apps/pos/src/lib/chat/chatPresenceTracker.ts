"use client";

/**
 * Remembers which local profile this TAB has already written a chat-presence
 * event for, per store.
 *
 * Module state, deliberately NOT a React ref: ChatInbox is mounted on five
 * separate pages (/dashboard, /pins, /cashier, /reservations,
 * /admin/online-orders), so a client-side route change unmounts one instance
 * and mounts a fresh one. A ref resets to null on every such remount, which
 * made ChatInbox log a spurious signout+signin pair on every navigation —
 * turning the presence log into a record of page views instead of shift
 * changes, and moving each cashier's "on duty since" to whenever they last
 * clicked a nav link. Module state survives the remount, so a navigation logs
 * nothing.
 *
 * It resets on a full page reload, which is the correct boundary: a fresh load
 * is a legitimate point to re-establish presence.
 *
 * Kept separate from `server-profiles/activeLocalProfile` (which the store-wide
 * LocalProfileProvider maintains for every station) on purpose — chat presence
 * must be written only from cashier-station views, never from a KDS or server
 * tablet, so it is scoped to ChatInbox's own mounts.
 *
 * Keyed by storeId: a cashier only ever watches one store's inbox in a tab, but
 * keying costs nothing and stops cross-store leakage if that ever changes.
 */
export type TrackedChatProfile = { profileId: string; profileName: string } | null;

const lastLogged = new Map<string, TrackedChatProfile>();

export function getLastLoggedProfile(storeId: string): TrackedChatProfile {
  return lastLogged.get(storeId) ?? null;
}

export function setLastLoggedProfile(storeId: string, profile: TrackedChatProfile): void {
  lastLogged.set(storeId, profile);
}

/** Test-only: drops all remembered state so cases don't bleed into each other. */
export function __resetChatPresenceTracker(): void {
  lastLogged.clear();
}
