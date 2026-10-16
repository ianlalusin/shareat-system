import 'server-only';
/**
 * T-424 - the ports the POS v2 server routes run against. Production builds them from firebase-admin and @shareat/auth (`deps.ts`);
 * the tests inject an in-memory Firestore (`test-helpers/fakeFirestore.ts`'s `.admin`) and fake approval / till-shift ports.
 * Contract: the header of `src/test-helpers/pos2.ts`.
 */

/** The firebase-admin shaped Firestore the handlers use. Loosely typed on purpose: the real SDK and the test fake both satisfy it. */
export interface Pos2Db {
  doc(path: string): any;
  collection(path: string): any;
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  FieldValue: {
    serverTimestamp(): unknown;
    increment(n: number): unknown;
    delete(): unknown;
    arrayUnion(...v: unknown[]): unknown;
    arrayRemove(...v: unknown[]): unknown;
  };
  FieldPath: { documentId(): unknown };
}

/** `terminalNo` is the registered link's terminal number (when the port knows it); a request that names a different one is refused. */
export type ApprovalResult = { ok: true; approverPersonId: string; terminalNo?: number } | { ok: false; message: string };

export interface Pos2Deps {
  db: Pos2Db;
  /** Verifies a Firebase ID token (project `shareat-hub-v2`); rejects for an invalid token or one from another project. */
  verifyIdToken(token: string): Promise<{ uid: string }>;
  /**
   * Manager PIN check. `posStoreId` is the Firestore store id the caller is authorised for (the request's `storeId`); `deviceId` is the
   * request's device id. NOTHING from Firestore (a terminals/{TT} claim doc) is consulted for the store or the bucket (B1).
   */
  approveManagerPin(input: { posStoreId: string; deviceId: string; pin: string }): Promise<ApprovalResult>;
  /** The ERP till shift open for that POS store, if any. */
  openTillShift(posStoreId: string): Promise<{ openedAtMs: number } | null>;
  /** The server clock. */
  nowMs(): number;
  /** A fresh Firestore document id. */
  newId(): string;
}
