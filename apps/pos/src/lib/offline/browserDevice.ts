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

/**
 * Derives a short, stable per-device tag for offline receipt numbers: the first
 * 4 alphanumeric characters of the device id, uppercased. Guarantees two devices
 * never mint the same OL receipt number in the same minute. Falls back to "0000".
 */
export function deviceReceiptTag(deviceId: string): string {
  const cleaned = deviceId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return cleaned.slice(0, 4) || "0000";
}
