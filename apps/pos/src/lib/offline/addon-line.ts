import { collection, doc, writeBatch, type Firestore } from 'firebase/firestore';

/** Append a new offline intent without guessing whether an uncached grouped line exists. */
export function stageOfflineAddonLine(db: Firestore, storeId: string, sessionId: string, payload: Record<string, unknown>) {
  const lineRef = doc(collection(db, `stores/${storeId}/sessions/${sessionId}/sessionBillLines`));
  const batch = writeBatch(db);
  batch.set(lineRef, { ...payload, id: lineRef.id });
  return { lineId: lineRef.id, batch };
}
