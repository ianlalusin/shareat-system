import type { LobbyCheckInInput, LobbyEntrySummary, LobbyMyEntry, LobbyResult } from './http-lobby-data';

/**
 * T-455 S4 - the one door every lobby screen uses to reach data. The http client (S3 routes + the store read) and the fixture both implement it.
 * Nothing here takes an entry id or a queue code: the diner is the cookie, and the store code is the only thing a screen names.
 */

/** What the diner sees before checking in. `storeName` is empty and `accepting` is false for every store the diner cannot join. */
export interface LobbyStoreView {
  storeCode: string;
  storeName: string;
  partiesWaiting: number;
  accepting: boolean;
}

export interface LobbyData {
  getStore(storeCode: string): Promise<LobbyResult<LobbyStoreView>>;
  checkIn(input: LobbyCheckInInput): Promise<LobbyResult<LobbyEntrySummary & { created: boolean }>>;
  myEntry(storeCode: string): Promise<LobbyResult<LobbyMyEntry>>;
  cancel(storeCode: string): Promise<LobbyResult<{ entryId: string; status: 'cancelled' }>>;
}
