/**
 * T-424 slice T - stand-in for `firebase-admin/firestore`, the ONLY thing the vendored v1 server files import that is not
 * already in apps/pos. `FieldValue` returns the in-memory fake's sentinels (see test-helpers/fakeFirestore.ts) so v1's REAL delta
 * code runs unchanged against the fake. Not v1 code: written for the tests.
 */
export const FieldValue = {
  serverTimestamp: () => ({ __s: 'serverTimestamp' as const }),
  increment: (n: number) => ({ __s: 'increment' as const, n }),
  delete: () => ({ __s: 'deleteField' as const }),
  arrayUnion: (...v: unknown[]) => ({ __s: 'arrayUnion' as const, v }),
  arrayRemove: (...v: unknown[]) => ({ __s: 'arrayRemove' as const, v }),
};
export interface Transaction {
  get(ref: any): Promise<any>;
  set(ref: any, data: any, options?: any): Transaction;
  update(ref: any, data: any): Transaction;
}
export interface Firestore {
  doc(path: string): any;
  collection(path: string): any;
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
