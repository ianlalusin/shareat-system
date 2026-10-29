/**
 * T-455 S2/S5 - the ONE implementation of each cashier move on the lobby line. `staff.ts` (an ERP person, `authorize(record_sale)`) and
 * `terminal.ts` (a POS tablet, trust chain = the route's terminal link) both call these; the store check is passed in as `guard`, so
 * the state logic exists once. Nothing here authorises anything and nothing opens a transaction (DEF-421).
 */
import { auditLogRepo, lobbyRepo, type Tx } from '@shareat/db';
import { LOBBY_CODE_ATTEMPTS, LOBBY_ENTRY_TTL_HOURS, type LobbyEntryStatus } from './checkin';
import { cleanParty, lobbyRefusal } from './refusal';

/** The hand-off link lives as long as the table-session token it carries: 2 hours from seating. */
const HANDOFF_HOURS = 2;
const PHONE_MAX = 30;

/** Who is moving the line. `cashier` (a staff name, never a diner) is added to every audit `after` when given. */
export interface MoveCtx {
  readonly orgId: string;
  readonly personId: string;
  readonly cashier?: string;
}

/** Runs once the entry's store is known and BEFORE anything is written; throws to refuse. */
export type StoreGuard = (entryStoreId: string) => Promise<void> | void;

export interface ParkInput {
  readonly displayName: string;
  readonly partySize: number;
  readonly phone?: string | null;
  readonly note?: string | null;
}

export interface SeatInput {
  readonly entryId: string;
  readonly sessionId: string;
  readonly standLabel: string;
  readonly joinUrl?: string | null;
}

export interface CoreListRow {
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

const withCashier = (ctx: MoveCtx, after: Record<string, unknown>): Record<string, unknown> =>
  ctx.cashier === undefined ? after : { ...after, cashier: ctx.cashier };

function cleanPhone(phone: string | null | undefined): string | null {
  if (phone === undefined || phone === null) return null;
  if (typeof phone !== 'string') throw lobbyRefusal('LOBBY_BAD_INPUT', 'phone type');
  const t = phone.trim();
  if (t.length > PHONE_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'phone length');
  return t.length > 0 ? t : null;
}

export async function parkCore(
  tx: Tx,
  ctx: MoveCtx,
  storeId: string,
  input: ParkInput,
  opts?: { randomCode?: () => string },
): Promise<{ entryId: string; code: string }> {
  const party = cleanParty(input);
  const phone = cleanPhone(input.phone);
  if (!(await lobbyRepo.storeExists(tx, ctx.orgId, storeId))) throw lobbyRefusal('LOBBY_NOT_FOUND', 'store');
  const res = await lobbyRepo.insertEntryWithCode(
    tx,
    {
      orgId: ctx.orgId,
      storeId,
      source: 'staff',
      displayName: party.displayName,
      partySize: party.partySize,
      note: party.note,
      phone,
      deviceHash: null,
      ipHash: null,
      clientRequestId: null,
      actedByPersonId: ctx.personId,
    },
    opts?.randomCode ?? lobbyRepo.randomBookingCode,
    LOBBY_CODE_ATTEMPTS,
  );
  if (res.kind !== 'created') throw lobbyRefusal('LOBBY_NO_CODE', 'every code attempt collided');
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.park',
    storeId,
    entityId: res.id,
    before: null,
    after: withCashier(ctx, { code: res.code, partySize: party.partySize, source: 'staff' }),
    source: 'pos',
  });
  return { entryId: res.id, code: res.code };
}

/** The store's live line, oldest first. The one-time hand-off link is never part of this list. */
export async function listCore(tx: Tx, orgId: string, storeId: string): Promise<CoreListRow[]> {
  const rows = await lobbyRepo.listLive(tx, orgId, storeId, LOBBY_ENTRY_TTL_HOURS);
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

async function liveEntryOrRefuse(tx: Tx, ctx: MoveCtx, entryId: string, guard: StoreGuard): Promise<lobbyRepo.EntryRow> {
  const row = await lobbyRepo.getEntryForUpdate(tx, ctx.orgId, entryId, LOBBY_ENTRY_TTL_HOURS);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  // Org-scoped read BEFORE the guard: the store check is against the entry's own store.
  await guard(row.storeId);
  if (row.status !== 'waiting' && row.status !== 'called') throw lobbyRefusal('LOBBY_ENTRY_CLOSED');
  return row;
}

/** waiting -> called. Calling an already-called entry changes nothing. A closed entry cannot be called. */
export async function callCore(tx: Tx, ctx: MoveCtx, entryId: string, guard: StoreGuard): Promise<{ entryId: string; status: 'called' }> {
  const row = await liveEntryOrRefuse(tx, ctx, entryId, guard);
  if (row.status === 'called') return { entryId, status: 'called' };
  await lobbyRepo.markCalled(tx, ctx.orgId, entryId, ctx.personId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.call',
    storeId: row.storeId,
    entityId: entryId,
    before: { status: 'waiting' },
    after: withCashier(ctx, { status: 'called', code: row.code }),
    source: 'pos',
  });
  return { entryId, status: 'called' };
}

/**
 * waiting|called -> seated, only with the POS session id and the stand. The entry is closed at the same moment (the 24 h purge clock
 * runs from `closed_at`); its pending claims stay pending - approval needs a seated entry (L2). A join link, when given, is kept for the
 * owning phone's next read for 2 hours (and only for a lobby entry, which has a phone).
 */
export async function seatCore(tx: Tx, ctx: MoveCtx, input: SeatInput, guard: StoreGuard): Promise<{ entryId: string; status: 'seated' }> {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const standLabel = typeof input.standLabel === 'string' ? input.standLabel.trim() : '';
  if (sessionId.length === 0 || standLabel.length === 0) throw lobbyRefusal('LOBBY_SEAT_NEEDS_SESSION');
  const row = await liveEntryOrRefuse(tx, ctx, input.entryId, guard);
  const joinUrl = typeof input.joinUrl === 'string' && input.joinUrl.trim().length > 0 && row.deviceHash !== null ? input.joinUrl.trim() : null;
  await lobbyRepo.markSeated(tx, ctx.orgId, input.entryId, { personId: ctx.personId, sessionRef: sessionId, standLabel, joinUrl, handoffHours: HANDOFF_HOURS });
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.seat',
    storeId: row.storeId,
    entityId: input.entryId,
    before: { status: row.status },
    after: withCashier(ctx, { status: 'seated', code: row.code, standLabel, sessionId }),
    source: 'pos',
  });
  return { entryId: input.entryId, status: 'seated' };
}

/** waiting|called -> removed (the cashier takes a party off the line). Its pending claims expire. A seated entry cannot be removed. */
export async function removeCore(tx: Tx, ctx: MoveCtx, entryId: string, guard: StoreGuard): Promise<{ entryId: string; status: 'removed' }> {
  const row = await liveEntryOrRefuse(tx, ctx, entryId, guard);
  await lobbyRepo.markClosed(tx, ctx.orgId, entryId, 'removed', ctx.personId);
  await lobbyRepo.expirePendingClaimsOfEntry(tx, ctx.orgId, entryId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.remove',
    storeId: row.storeId,
    entityId: entryId,
    before: { status: row.status },
    after: withCashier(ctx, { status: 'removed', code: row.code }),
    source: 'pos',
  });
  return { entryId, status: 'removed' };
}
