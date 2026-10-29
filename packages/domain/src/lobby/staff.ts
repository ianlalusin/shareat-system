/**
 * T-455 S2 - the cashier side of the customer lobby: park a walk-in, list the line, call, seat, remove (docs/tasks/455-customer-lobby.md
 * sections 2.4, 3.2). Every move writes an `audit_log` row by the cashier, in the caller's transaction (T-402: storeId, no entity or label
 * from the caller). Payloads carry the code, party size, stand and session id - never a name or phone.
 *
 * `tx: Tx` first, no transaction opened here (DEF-421). Every function authorises `record_sale` at the entry's (or the list's) store itself.
 * The state logic is `core.ts`, shared with the POS tablet's `terminal.ts` (T-455 S5): this file only adds the capability check.
 */
import type { Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import type { LobbyEntryStatus } from './checkin';
import { callCore, listCore, parkCore, removeCore, seatCore, type MoveCtx } from './core';

export interface ParkWalkInInput {
  readonly storeId: string;
  readonly displayName: string;
  readonly partySize: number;
  readonly phone?: string | null;
  readonly note?: string | null;
}

export interface LobbyListRow {
  readonly entryId: string;
  readonly code: string;
  readonly displayName: string | null;
  readonly partySize: number;
  readonly status: LobbyEntryStatus;
  readonly source: 'lobby' | 'staff';
  readonly note: string | null;
  readonly phone: string | null;
  readonly createdAt: Date;
  readonly calledAt: Date | null;
}

export interface SeatEntryInput {
  readonly entryId: string;
  readonly sessionId: string;
  readonly standLabel: string;
  /** The session's join link from POS v1, for the waiting phone's one-time hand-off. */
  readonly joinUrl?: string | null;
}

const ctxOf = (actor: Actor): MoveCtx => ({ orgId: actor.orgId, personId: actor.personId });
/** The capability is store-scoped and the store is the entry's own. */
const guardFor = (tx: Tx, actor: Actor) => async (storeId: string) => {
  await authorize(tx, actor, 'record_sale', { storeId });
};

/**
 * The cashier parks a walk-in on the same list as lobby check-ins (v1's "Park"). Staff stand in front of the guest, so this ignores the
 * customer limits (network, paused, stale POS) AND the live cap (S2 ruling 4); the database rules (one live code, party 1-30) still hold.
 */
export async function parkWalkIn(
  tx: Tx,
  actor: Actor,
  input: ParkWalkInInput,
  opts?: { randomCode?: () => string },
): Promise<{ entryId: string; code: string }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  return parkCore(tx, ctxOf(actor), input.storeId, input, opts);
}

/** The store's live line, oldest first. The one-time hand-off link is never part of this list. */
export async function listLobbyEntries(tx: Tx, actor: Actor, storeId: string): Promise<LobbyListRow[]> {
  await authorize(tx, actor, 'record_sale', { storeId });
  return listCore(tx, actor.orgId, storeId);
}

/** waiting -> called. Calling an already-called entry changes nothing. A closed entry cannot be called. */
export async function callEntry(tx: Tx, actor: Actor, entryId: string): Promise<{ entryId: string; status: 'called' }> {
  return callCore(tx, ctxOf(actor), entryId, guardFor(tx, actor));
}

/** waiting|called -> seated, with the POS session id and the stand (see `seatCore`). */
export async function seatEntry(tx: Tx, actor: Actor, input: SeatEntryInput): Promise<{ entryId: string; status: 'seated' }> {
  return seatCore(tx, ctxOf(actor), input, guardFor(tx, actor));
}

/** waiting|called -> removed (the cashier takes a party off the line). Its pending claims expire. A seated entry cannot be removed. */
export async function removeEntry(tx: Tx, actor: Actor, entryId: string): Promise<{ entryId: string; status: 'removed' }> {
  return removeCore(tx, ctxOf(actor), entryId, guardFor(tx, actor));
}
