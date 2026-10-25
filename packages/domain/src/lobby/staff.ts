/**
 * T-455 S2 - the cashier side of the customer lobby: park a walk-in, list the line, call, seat, remove (docs/tasks/455-customer-lobby.md
 * sections 2.4, 3.2). Every move writes an `audit_log` row by the cashier, in the caller's transaction (T-402: storeId, no entity or label
 * from the caller). Payloads carry the code, party size, stand and session id - never a name or phone.
 *
 * `tx: Tx` first, no transaction opened here (DEF-421). Every function authorises `record_sale` at the entry's (or the list's) store itself.
 */
import { auditLogRepo, lobbyRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { LOBBY_CODE_ATTEMPTS, LOBBY_ENTRY_TTL_HOURS, type LobbyEntryStatus } from './checkin';
import { cleanParty, lobbyRefusal } from './refusal';

/** The hand-off link lives as long as the table-session token it carries: 2 hours from seating. */
const HANDOFF_HOURS = 2;
const PHONE_MAX = 30;

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

function cleanPhone(phone: string | null | undefined): string | null {
  if (phone === undefined || phone === null) return null;
  if (typeof phone !== 'string') throw lobbyRefusal('LOBBY_BAD_INPUT', 'phone type');
  const t = phone.trim();
  if (t.length > PHONE_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'phone length');
  return t.length > 0 ? t : null;
}

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
  const party = cleanParty(input);
  const phone = cleanPhone(input.phone);
  if (!(await lobbyRepo.storeExists(tx, actor.orgId, input.storeId))) throw lobbyRefusal('LOBBY_NOT_FOUND', 'store');
  const res = await lobbyRepo.insertEntryWithCode(
    tx,
    {
      orgId: actor.orgId,
      storeId: input.storeId,
      source: 'staff',
      displayName: party.displayName,
      partySize: party.partySize,
      note: party.note,
      phone,
      deviceHash: null,
      ipHash: null,
      clientRequestId: null,
      actedByPersonId: actor.personId,
    },
    opts?.randomCode ?? lobbyRepo.randomBookingCode,
    LOBBY_CODE_ATTEMPTS,
  );
  if (res.kind !== 'created') throw lobbyRefusal('LOBBY_NO_CODE', 'every code attempt collided');
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'lobby.park',
    storeId: input.storeId,
    entityId: res.id,
    before: null,
    after: { code: res.code, partySize: party.partySize, source: 'staff' },
    source: 'pos',
  });
  return { entryId: res.id, code: res.code };
}

/** The store's live line, oldest first. The one-time hand-off link is never part of this list. */
export async function listLobbyEntries(tx: Tx, actor: Actor, storeId: string): Promise<LobbyListRow[]> {
  await authorize(tx, actor, 'record_sale', { storeId });
  const rows = await lobbyRepo.listLive(tx, actor.orgId, storeId, LOBBY_ENTRY_TTL_HOURS);
  return rows.map((r) => ({
    entryId: r.id,
    code: r.code,
    displayName: r.displayName,
    partySize: r.partySize,
    status: r.status,
    source: r.source,
    note: r.note,
    phone: r.phone,
    createdAt: r.createdAt,
    calledAt: r.calledAt,
  }));
}

async function liveEntryOrRefuse(tx: Tx, actor: Actor, entryId: string): Promise<lobbyRepo.EntryRow> {
  const row = await lobbyRepo.getEntryForUpdate(tx, actor.orgId, entryId, LOBBY_ENTRY_TTL_HOURS);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  // Org-scoped read BEFORE authorize(): the capability is store-scoped and the store is the entry's own.
  await authorize(tx, actor, 'record_sale', { storeId: row.storeId });
  if (row.status !== 'waiting' && row.status !== 'called') throw lobbyRefusal('LOBBY_ENTRY_CLOSED');
  return row;
}

/** waiting -> called. Calling an already-called entry changes nothing. A closed entry cannot be called. */
export async function callEntry(tx: Tx, actor: Actor, entryId: string): Promise<{ entryId: string; status: 'called' }> {
  const row = await liveEntryOrRefuse(tx, actor, entryId);
  if (row.status === 'called') return { entryId, status: 'called' };
  await lobbyRepo.markCalled(tx, actor.orgId, entryId, actor.personId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'lobby.call',
    storeId: row.storeId,
    entityId: entryId,
    before: { status: 'waiting' },
    after: { status: 'called', code: row.code },
    source: 'pos',
  });
  return { entryId, status: 'called' };
}

/**
 * waiting|called -> seated, only with the POS session id and the stand. The entry is closed at the same moment (the 24 h purge clock
 * runs from `closed_at`); its pending claims stay pending - approval needs a seated entry (L2). A join link, when given, is kept for the
 * owning phone's next read for 2 hours (and only for a lobby entry, which has a phone).
 */
export async function seatEntry(tx: Tx, actor: Actor, input: SeatEntryInput): Promise<{ entryId: string; status: 'seated' }> {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const standLabel = typeof input.standLabel === 'string' ? input.standLabel.trim() : '';
  if (sessionId.length === 0 || standLabel.length === 0) throw lobbyRefusal('LOBBY_SEAT_NEEDS_SESSION');
  const row = await liveEntryOrRefuse(tx, actor, input.entryId);
  const joinUrl = typeof input.joinUrl === 'string' && input.joinUrl.trim().length > 0 && row.deviceHash !== null ? input.joinUrl.trim() : null;
  await lobbyRepo.markSeated(tx, actor.orgId, input.entryId, { personId: actor.personId, sessionRef: sessionId, standLabel, joinUrl, handoffHours: HANDOFF_HOURS });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'lobby.seat',
    storeId: row.storeId,
    entityId: input.entryId,
    before: { status: row.status },
    after: { status: 'seated', code: row.code, standLabel, sessionId },
    source: 'pos',
  });
  return { entryId: input.entryId, status: 'seated' };
}

/** waiting|called -> removed (the cashier takes a party off the line). Its pending claims expire. A seated entry cannot be removed. */
export async function removeEntry(tx: Tx, actor: Actor, entryId: string): Promise<{ entryId: string; status: 'removed' }> {
  const row = await liveEntryOrRefuse(tx, actor, entryId);
  await lobbyRepo.markClosed(tx, actor.orgId, entryId, 'removed', actor.personId);
  await lobbyRepo.expirePendingClaimsOfEntry(tx, actor.orgId, entryId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'lobby.remove',
    storeId: row.storeId,
    entityId: entryId,
    before: { status: row.status },
    after: { status: 'removed', code: row.code },
    source: 'pos',
  });
  return { entryId, status: 'removed' };
}
