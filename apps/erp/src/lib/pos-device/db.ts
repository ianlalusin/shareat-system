/**
 * T-530a — the **only** module that opens the POS v2 device database.
 *
 * One database, `shareat-pos-v2`, version 1, four stores:
 * - `outbox`     — the events waiting to reach the server, keyed by the device's `seq`;
 * - `meta`       — the two counters (`nextSeq`, `nextTerminalSeq`) and the `app.*` values of
 *                  `meta.ts`; out-of-line keys;
 * - `snapshot`   — the last good menu + settings, under the single key `'current'`;
 * - `verifiers`  — opaque records from T-526, keyed by `personId`, with an index `byEmployeeId`.
 *
 * ⚠️ **`indexedDB` is read lazily inside `openDeviceDb`**, never at module load, so importing this
 * file works in Node and in a test that has not installed a fake yet.
 *
 * ⚠️ **No other file may call `indexedDB.open`** — the "one opener" rule carried over from
 * `apps/pos/src/lib/terminal/db.ts`. A second opener makes version upgrades ambiguous.
 */
import type { CachedSnapshot } from './types';

export const DB_NAME = 'shareat-pos-v2';
export const DB_VERSION = 1;

export const OUTBOX_STORE = 'outbox';
export const META_STORE = 'meta';
export const SNAPSHOT_STORE = 'snapshot';
export const VERIFIERS_STORE = 'verifiers';

/** The single row key in `snapshot`. There is only ever one snapshot. */
export const SNAPSHOT_KEY = 'current';

/** `meta` keys that hold the two counters. `outbox.ts` is the only module allowed to touch them. */
export const COUNTER_NEXT_SEQ = 'nextSeq';
export const COUNTER_NEXT_TERMINAL_SEQ = 'nextTerminalSeq';

/** The index on `verifiers` that `verifier-store.ts` looks a person up by. */
export const VERIFIER_BY_EMPLOYEE_INDEX = 'byEmployeeId';

/** The exact refusal when the device has no IndexedDB at all (tested word for word). */
export const NO_INDEXED_DB_MESSAGE = 'This device cannot store sales (no IndexedDB).';

function factory(): IDBFactory | undefined {
  return (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
}

/**
 * Opened per operation and closed after it. The queue is small and every write resolves on the
 * transaction's `complete`, so a short-lived connection keeps the fake and the browser honest.
 */
export function openDeviceDb(): Promise<IDBDatabase> {
  const indexedDb = factory();
  if (!indexedDb) return Promise.reject(new Error(NO_INDEXED_DB_MESSAGE));

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'seq' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        // Out-of-line keys: `put(value, key)`. Holds counters and app.* values, never events.
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(VERIFIERS_STORE)) {
        db.createObjectStore(VERIFIERS_STORE, { keyPath: 'personId' });
      }
      // Create the index on its own store handle so it also works on an existing `verifiers` store
      // (an upgrade from a build that created the store without it).
      const verifiers = request.transaction?.objectStore(VERIFIERS_STORE);
      if (verifiers && !verifiers.indexNames.contains(VERIFIER_BY_EMPLOYEE_INDEX)) {
        verifiers.createIndex(VERIFIER_BY_EMPLOYEE_INDEX, 'employeeId');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab opening a newer version must not block forever: let go of this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the device store.'));
  });
}

/** A stored snapshot row, as it comes back from IndexedDB. */
export type StoredSnapshot = CachedSnapshot;
