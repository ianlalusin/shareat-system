/**
 * T-425 S1 - the ONE opener of this tablet's IndexedDB (Ruling 1, R2). The receipt counter (T-423), the sale ledger, the deferred-effects
 * store and the offline-period store all live in it, so ONE place owns the name, the version and the upgrade. Nothing else may call
 * indexedDB.open for it (tests/unit/pos-v2-offline-guards.test.ts).
 *
 * Version 1 held only `terminal` (the counter row). Version 2 adds `events`, `effects` and `meta` and never touches an existing row.
 * An OLDER build opening version 2 would fail with VersionError: the runbook forbids installing an older APK over a newer one.
 * `indexedDB` is read lazily from globalThis so tests can install a fake.
 */

export const DB_NAME = 'shareat-pos-terminal';
export const DB_VERSION = 2;
/** The counter's single row, out-of-line key 'current'. */
export const STORE_TERMINAL = 'terminal';
/** The sale ledger, keyPath [deviceId, terminalSeq]. */
export const STORE_EVENTS = 'events';
/** Deferred server effects (analytics, loyalty, PIN), keyPath id. */
export const STORE_EFFECTS = 'effects';
/** Small keyed state (offline period / X-slip), out-of-line keys. */
export const STORE_META = 'meta';

export function openTerminalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      reject(new Error('This device cannot store sales (no IndexedDB).'));
      return;
    }
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TERMINAL)) db.createObjectStore(STORE_TERMINAL);
      if (!db.objectStoreNames.contains(STORE_EVENTS)) db.createObjectStore(STORE_EVENTS, { keyPath: ['deviceId', 'terminalSeq'] });
      if (!db.objectStoreNames.contains(STORE_EFFECTS)) db.createObjectStore(STORE_EFFECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab (a newer build) wants to upgrade: close at once so its upgrade is never blocked.
      db.onversionchange = () => { try { db.close(); } catch { /* already closed */ } };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open the tablet database.'));
    req.onblocked = () => { /* another connection of an older build is still open; the open completes when it closes */ };
  });
}

/**
 * Runs `work` in ONE transaction over `stores` and settles after the transaction's `complete` (or `abort`) event.
 * `work` calls `done(value)` or `fail(error)`; a `fail` aborts the transaction so nothing it wrote is kept.
 * The connection is always closed afterwards.
 */
export async function inTerminalTransaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, done: (v: T) => void, fail: (e: Error) => void) => void,
): Promise<T> {
  const db = await openTerminalDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const st: { outcome: { ok: true; value: T } | { ok: false; error: Error } | null } = { outcome: null };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(stores, mode);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      tx.oncomplete = () => {
        const o = st.outcome;
        if (!o) reject(new Error('Tablet database transaction ended without a result.'));
        else if (o.ok) resolve(o.value);
        else reject(o.error);
      };
      tx.onabort = () => {
        const o = st.outcome;
        reject(o && !o.ok ? o.error : tx.error ?? new Error('Tablet database transaction was aborted.'));
      };
      tx.onerror = () => { /* the abort event that follows rejects */ };
      try {
        work(
          tx,
          (value) => { st.outcome = { ok: true, value }; },
          (error) => {
            st.outcome = { ok: false, error };
            try { tx.abort(); } catch { /* already finished */ }
          },
        );
      } catch (e) {
        st.outcome = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
        try { tx.abort(); } catch { /* already finished */ }
      }
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
