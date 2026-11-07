/**
 * T-530a — the **snapshot cache**: the last good menu + settings, so the tablet can sell offline.
 *
 * ⚠️ **There is deliberately no function that clears or blanks the snapshot** (design A6). A failed
 * refresh must leave the last good copy in place — a tablet that wiped its menu because one GET
 * timed out cannot sell at all. `saveSnapshot` is called only after a 200; a 304 calls
 * `touchSnapshot`.
 */
import { SNAPSHOT_KEY, SNAPSHOT_STORE, openDeviceDb } from './db';
import type { CachedSnapshot } from './types';

function asPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('The device store request failed.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('The device store transaction was aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('The device store transaction failed.'));
  });
}

/** Replaces the stored snapshot. Call only after a successful 200. */
export async function saveSnapshot(snapshot: CachedSnapshot): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY);
    await done;
  } finally {
    db.close();
  }
}

/** After a 304: only the fetch time moves. With nothing stored this does nothing. */
export async function touchSnapshot(fetchedAtMs: number): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(SNAPSHOT_STORE);
    const existing = await asPromise<CachedSnapshot | undefined>(store.get(SNAPSHOT_KEY));
    if (existing !== undefined) store.put({ ...existing, fetchedAtMs }, SNAPSHOT_KEY);
    await done;
  } finally {
    db.close();
  }
}

export async function readSnapshot(): Promise<CachedSnapshot | null> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
    const stored = await asPromise<CachedSnapshot | undefined>(tx.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY));
    return stored ?? null;
  } finally {
    db.close();
  }
}

/**
 * Pure. The age limit is the caller's argument, never a constant here: how long a menu may be sold
 * from is a business decision, not a device one.
 */
export function isSnapshotUsable(snapshot: CachedSnapshot | null, nowMs: number, maxAgeMs: number): boolean {
  if (snapshot === null) return false;
  return nowMs - snapshot.fetchedAtMs <= maxAgeMs;
}
