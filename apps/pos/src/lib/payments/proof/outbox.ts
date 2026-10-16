"use client";

/**
 * Offline outbox for payment-proof photos.
 *
 * The proof DOCUMENT is written straight through Firestore's persistent cache
 * and replays on reconnect, but a photo Blob cannot ride in a Firestore write.
 * So it is parked here and uploaded when the network returns.
 *
 * INDEXEDDB, NOT LOCALSTORAGE, DELIBERATELY. `offline_payment_queue` already
 * lives in localStorage under a ~5 MB origin quota. A proof photo is ~150-250
 * KB, and base64 in localStorage inflates that by a third again. A handful of
 * queued proofs would evict or corrupt the payment queue — and corrupting THAT
 * breaks payments, which is far worse than a missing photo.
 */

const DB_NAME = "pos-payment-proofs";
const DB_VERSION = 1;
const STORE = "photos";

export type QueuedProofPhoto = {
  /** PaymentProof.id — also the Storage object name. */
  proofId: string;
  storeId: string;
  storagePath: string;
  contentType: string;
  blob: Blob;
  queuedAtMs: number;
  attempts: number;
};

/**
 * Given up on after this many failures. The proof document survives with
 * imageUploadStatus 'failed', so the record remains — only the photo is lost.
 */
export const MAX_UPLOAD_ATTEMPTS = 6;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "proofId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Parks a photo for later upload. Never throws — a failed park is logged. */
export async function enqueueProofPhoto(
  entry: Omit<QueuedProofPhoto, "queuedAtMs" | "attempts">,
): Promise<void> {
  try {
    await tx("readwrite", (store) =>
      store.put({ ...entry, queuedAtMs: Date.now(), attempts: 0 } satisfies QueuedProofPhoto),
    );
  } catch (error) {
    console.warn("[proof-outbox] could not queue photo:", error);
  }
}

export async function listQueuedProofPhotos(): Promise<QueuedProofPhoto[]> {
  try {
    return (await tx<QueuedProofPhoto[]>("readonly", (store) => store.getAll())) ?? [];
  } catch (error) {
    console.warn("[proof-outbox] could not read queue:", error);
    return [];
  }
}

export async function removeQueuedProofPhoto(proofId: string): Promise<void> {
  try {
    await tx("readwrite", (store) => store.delete(proofId));
  } catch (error) {
    console.warn("[proof-outbox] could not remove entry:", error);
  }
}

export async function markProofPhotoAttempted(entry: QueuedProofPhoto): Promise<void> {
  try {
    await tx("readwrite", (store) => store.put({ ...entry, attempts: entry.attempts + 1 }));
  } catch {
    /* Attempt counting is diagnostic only. */
  }
}
