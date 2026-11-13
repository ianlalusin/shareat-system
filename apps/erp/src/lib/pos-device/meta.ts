/**
 * T-530a — small **keyed values** the device wants to remember between launches.
 *
 * The key must start with `app.`. That namespace keeps this module away from the two counters
 * (`nextSeq`, `nextTerminalSeq`), which only `outbox.ts` may touch: a stray `setMeta('nextSeq', 9)`
 * would hand out a sequence number twice, and the server would reject the second sale.
 */
import { META_PAIRING_ID, META_STORE, openDeviceDb } from './db';

/** Only this prefix is storable. Counters live in the same store without it. */
export const APP_KEY_PREFIX = 'app.';

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

function assertAppKey(key: string): void {
  if (typeof key !== 'string' || !key.startsWith(APP_KEY_PREFIX)) {
    throw new Error(`Only ${APP_KEY_PREFIX}* keys may be stored here (got ${JSON.stringify(key)}).`);
  }
}

export async function getMeta<T>(key: string): Promise<T | null> {
  assertAppKey(key);
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(META_STORE, 'readonly');
    const stored = await asPromise<T | undefined>(tx.objectStore(META_STORE).get(key));
    return stored ?? null;
  } finally {
    db.close();
  }
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  assertAppKey(key);
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(META_STORE).put(value, key);
    await done;
  } finally {
    db.close();
  }
}

/** T-563: remember which pairing this tablet is bound to. A good snapshot refresh calls it; `enqueue` stamps it on every event it queues. */
export const bindPairing = (pairingId: string): Promise<void> => setMeta(META_PAIRING_ID, pairingId);
