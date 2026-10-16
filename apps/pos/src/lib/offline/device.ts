"use client";

/** Minimal synchronous key/value store (localStorage-compatible) so the
 *  device-id logic is unit-testable with an in-memory fake. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEVICE_ID_KEY = "pos_device_id";

/**
 * Returns a stable, persistent device id for this install, creating one on the
 * first call. `genId` is injectable so tests are deterministic; production
 * defaults to `crypto.randomUUID()`. Used for the session ownership stamp and
 * sync-report attribution (not for receipt numbering).
 */
export function getDeviceId(
  store: KVStore,
  genId: () => string = () => crypto.randomUUID(),
): string {
  const existing = store.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = genId();
  store.setItem(DEVICE_ID_KEY, id);
  return id;
}
