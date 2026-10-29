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
  /**
   * T-477 (DEF-771): the terminal number the device is registered for at that POS store, from the trusted ERP link (the same lookup as the PIN
   * path, but no PIN). `null` when the device has no active link. Other failures propagate. Never read from Firestore (B1).
   */
  resolveTerminalNo(input: { posStoreId: string; deviceId: string }): Promise<number | null>;
  /** The ERP till shift open for that POS store, if any. */
  openTillShift(posStoreId: string): Promise<{ openedAtMs: number } | null>;
  /** T-455 S5: the customer-lobby moves a tablet makes (see `Pos2LobbyPort`). */
  lobby: Pos2LobbyPort;
  /** The server clock. */
  nowMs(): number;
  /** A fresh Firestore document id. */
  newId(): string;
}

/** T-455 S5 - who a lobby move is made as: the tablet's live link (never the request body) plus the signed-in staffer's name. */
export interface LobbyTablet {
  erpStoreId: string;
  terminalPersonId: string;
  cashierName: string;
}

/**
 * T-455 S5 - the lobby port. Production wraps `resolvePosTerminalLink` and the domain's terminal moves inside `withOrgPrincipal(POS_ORG_ID)`;
 * a domain `LobbyRefusal` is rethrown as an Error whose `name` is 'LobbyRefusal' and whose `userMessage` is its one plain sentence.
 */
export interface Pos2LobbyPort {
  /** null = no live store link, or no ACTIVE terminal link for this device. */
  resolveTablet(input: { posStoreId: string; deviceId: string }): Promise<{ erpStoreId: string; terminalPersonId: string } | null>;
  list(a: LobbyTablet): Promise<{ lobbyEnabled: boolean; paused: boolean; entries: unknown[] }>;
  park(a: LobbyTablet, i: { displayName: string; partySize: number; phone: string | null; note: string | null }): Promise<{ entryId: string; code: string }>;
  call(a: LobbyTablet, i: { entryId: string }): Promise<{ entryId: string; status: 'called' }>;
  seat(a: LobbyTablet, i: { entryId: string; sessionId: string; standLabel: string; joinUrl: string | null }): Promise<{ entryId: string; status: 'seated' }>;
  remove(a: LobbyTablet, i: { entryId: string }): Promise<{ entryId: string; status: 'removed' }>;
  pause(a: LobbyTablet, i: { paused: boolean }): Promise<{ paused: boolean }>;
}
