"use client";

/**
 * T-425 S1 - the real Firestore wiring for `runReconcilePass` (the pass itself holds no firebase import so it can be tested with a fake).
 * `getDocFromServer` bypasses the local cache on purpose: only the server can prove a sale arrived.
 */
import {
  arrayRemove,
  deleteField,
  doc,
  getDocFromServer,
  runTransaction,
  serverTimestamp,
  waitForPendingWrites,
  type DocumentReference,
  type Firestore,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { runReconcilePass, type ReconcilePort, type ReconcileResult } from "@/lib/outbox/reconcile";
import { getConnectivityStore } from "@/hooks/useConnectivity";

export const realReconcilePort: ReconcilePort = {
  db,
  doc: (d, path) => doc(d as Firestore, path),
  getDocFromServer: (ref) => getDocFromServer(ref as DocumentReference),
  waitForPendingWrites: (d) => waitForPendingWrites(d as Firestore),
  runTransaction: (d, fn) => runTransaction(d as Firestore, fn),
  serverTimestamp,
  deleteField,
  arrayRemove,
};

/** One reconcile pass against the real Firestore, gated on the connectivity store. */
export function runReconcileNow(): Promise<ReconcileResult> {
  return runReconcilePass({ port: realReconcilePort, isOnline: () => getConnectivityStore().getState().online });
}
