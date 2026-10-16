"use client";

import { getDeviceId, type KVStore } from "@/lib/offline/device";

/**
 * Resolves this install's persistent device id from the browser's
 * localStorage. `store` is injectable for tests; at runtime it defaults to
 * `window.localStorage` (this module is client-only). Referencing `window`
 * lazily (inside the call, not at module load) keeps the import SSR-safe.
 */
export function getBrowserDeviceId(store?: KVStore): string {
  const kv = store ?? (window.localStorage as unknown as KVStore);
  return getDeviceId(kv);
}
