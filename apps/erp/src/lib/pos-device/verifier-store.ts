/**
 * T-530a — plain storage for the **opaque verifier records** T-526 writes.
 *
 * This module stores bytes and hands them back. It does not check a secret, hash anything, or decide
 * who may sign in: those rules live in T-526's own module and on the server. Nothing here inspects
 * the contents of a record.
 *
 * The `byEmployeeId` index exists because the till knows the typed employee id first, and the person
 * id only after the record is found.
 */
import {
  VERIFIER_BY_EMPLOYEE_INDEX,
  VERIFIERS_STORE,
  openDeviceDb,
} from './db';
import type { StoredVerifier } from './types';

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

/** Stores one record, replacing any record already stored for the same person. */
export async function putVerifier(verifier: StoredVerifier): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(VERIFIERS_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(VERIFIERS_STORE).put(verifier);
    await done;
  } finally {
    db.close();
  }
}

/** The record for one employee id, or null when this device has never seen them. */
export async function getVerifierByEmployeeId(employeeId: string): Promise<StoredVerifier | null> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(VERIFIERS_STORE, 'readonly');
    const index = tx.objectStore(VERIFIERS_STORE).index(VERIFIER_BY_EMPLOYEE_INDEX);
    const stored = await asPromise<StoredVerifier | undefined>(index.get(employeeId));
    return stored ?? null;
  } finally {
    db.close();
  }
}

export async function deleteVerifier(personId: string): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(VERIFIERS_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(VERIFIERS_STORE).delete(personId);
    await done;
  } finally {
    db.close();
  }
}

export async function listVerifiers(): Promise<StoredVerifier[]> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(VERIFIERS_STORE, 'readonly');
    return await asPromise<StoredVerifier[]>(tx.objectStore(VERIFIERS_STORE).getAll());
  } finally {
    db.close();
  }
}
