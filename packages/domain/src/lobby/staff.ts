/**
 * T-455 S2 - the cashier side of the customer lobby: park a walk-in, list the line, call, seat, remove (docs/tasks/455-customer-lobby.md
 * sections 2.4, 3.2). Every move writes an `audit_log` row by the cashier, in the caller's transaction (T-402: storeId, no entity or label
 * from the caller). Payloads carry the code, party size, stand and session id - never a name or phone.
 *
 * `tx: Tx` first, no transaction opened here (DEF-421). Every function authorises `record_sale` at the entry's (or the list's) store itself.
 * The state logic is `core.ts` (T-455 S5): this file only adds the capability check.
 */
import type { Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import type { LobbyEntryStatus } from './checkin';
import { callCore, listAndStampCore, listCore, parkCore, removeCore, seatCore, setPausedCore, type CoreLobbyList, type MoveCtx } from './core';
import { lobbyRefusal } from './refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { POS_LOBBY_SEAT_RULES, POS_LOBBY_WALKIN_RULES } from '../field-rules/pos';

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
/**
 * The capability is store-scoped and the store is the entry's own. `onlyStoreId` (T-644: the store the paired tablet works at, taken from the pairing)
 * narrows it: an entry of any other store answers exactly like a ghost id, so a paired tablet cannot act on, or probe, another store's line.
 */
const guardFor = (tx: Tx, actor: Actor, onlyStoreId?: string) => async (storeId: string) => {
  if (onlyStoreId !== undefined && storeId.toLowerCase() !== onlyStoreId.toLowerCase()) throw lobbyRefusal('LOBBY_NOT_FOUND');
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
  assertFieldRules(POS_LOBBY_WALKIN_RULES, { displayName: input.displayName ?? '', phone: input.phone ?? '', note: input.note ?? '' });
  return parkCore(tx, ctxOf(actor), input.storeId, input, opts);
}

/** The store's live line, oldest first. The one-time hand-off link is never part of this list. */
export async function listLobbyEntries(tx: Tx, actor: Actor, storeId: string): Promise<LobbyListRow[]> {
  await authorize(tx, actor, 'record_sale', { storeId });
  return listCore(tx, actor.orgId, storeId);
}

/** waiting -> called. Calling an already-called entry changes nothing. A closed entry cannot be called. */
export async function callEntry(tx: Tx, actor: Actor, entryId: string, opts?: { onlyStoreId?: string }): Promise<{ entryId: string; status: 'called' }> {
  return callCore(tx, ctxOf(actor), entryId, guardFor(tx, actor, opts?.onlyStoreId));
}

/**
 * waiting|called -> seated, with the POS session id and the stand (see `seatCore`). `onlyStoreId` as for `callEntry` (T-644 S2). The stand label is bounded
 * AFTER the store check (authorize first, then the field rule), so a person who may not act here learns nothing about the rule.
 */
export async function seatEntry(tx: Tx, actor: Actor, input: SeatEntryInput, opts?: { onlyStoreId?: string }): Promise<{ entryId: string; status: 'seated' }> {
  const allowed = guardFor(tx, actor, opts?.onlyStoreId);
  return seatCore(tx, ctxOf(actor), input, async (storeId) => {
    await allowed(storeId);
    assertFieldRules(POS_LOBBY_SEAT_RULES, { standLabel: input.standLabel ?? '' });
  });
}

/** waiting|called -> removed (the cashier takes a party off the line). Its pending claims expire. A seated entry cannot be removed. */
export async function removeEntry(tx: Tx, actor: Actor, entryId: string, opts?: { onlyStoreId?: string }): Promise<{ entryId: string; status: 'removed' }> {
  return removeCore(tx, ctxOf(actor), entryId, guardFor(tx, actor, opts?.onlyStoreId));
}

/**
 * T-644 S1 - the ERP POS's lobby list: the live line with each party's order lines, plus whether the store's lobby is on and paused.
 * ⛔ It stamps `lobby_stores.pos_seen_at` (diners can check in only while that is under 5 minutes old); the shell polls it every 10 s on every tab.
 */
export async function listLobby(tx: Tx, actor: Actor, input: { storeId: string }): Promise<CoreLobbyList> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  return listAndStampCore(tx, actor.orgId, input.storeId);
}

/** The cashier pauses or resumes the store's diner check-in (audit `lobby.pause` / `lobby.resume`). A store with no lobby row is LOBBY_NOT_FOUND. */
export async function setLobbyPaused(tx: Tx, actor: Actor, input: { storeId: string; paused: boolean }): Promise<{ paused: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  return setPausedCore(tx, ctxOf(actor), input.storeId, input.paused);
}
