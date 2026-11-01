/**
 * T-455 S6a - the birthday-song request (docs/tasks/455-customer-lobby.md sections 2.4, 3.1, 3.2, 4.1, 4.6 and "S6a rulings").
 *
 * Three doors, one state logic:
 *   - the DINER (requestBirthday / getMyBirthday / cancelMyBirthday), found by the cookie hash like the entry itself;
 *   - an ERP CASHIER (`...Birthday` with `actor: Actor`, `authorize(record_sale)` at the request's own store);
 *   - the POS TABLET (`...ForTerminal`, a `TerminalActor`: no `authorize()`, the trust chain is the route's terminal link, S5 ruling 2;
 *     another store's request answers exactly like a ghost id).
 * The cashier and tablet doors call the same internal `*Core` with a store guard, so the state logic exists once.
 *
 * Every function takes the caller's `tx: Tx` and opens no transaction (DEF-421). SQL lives only in `lobbyRepo`. The clock is the database's.
 * Audit rows carry the booking code, the status and the time, never a celebrant name, diner name or phone (4.6).
 */
import { auditLogRepo, lobbyRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { LOBBY_ENTRY_TTL_HOURS, type MyEntryKey } from './checkin';
import type { MoveCtx, StoreGuard } from './core';
import { lobbyRefusal, LOBBY_NAME_MAX } from './refusal';
import type { TerminalActor } from './terminal';

/** An accepted request whose time passed this long ago and was never played is expired. */
export const LOBBY_BIRTHDAY_EXPIRE_MINUTES = 30;
/** The decline reason is free text, 1..80 characters after trimming (S6a ruling 6). */
export const LOBBY_BIRTHDAY_REASON_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BirthdayStatus = 'requested' | 'accepted' | 'declined' | 'played' | 'expired' | 'cancelled';

export interface MyBirthdayView {
  readonly requestId: string;
  readonly status: BirthdayStatus;
  readonly celebrantName: string | null;
  readonly scheduledAt: Date | null;
  readonly declineReason: string | null;
}

export interface AcceptBirthdayInput {
  readonly requestId: string;
  readonly scheduledAt: Date;
}

export interface DeclineBirthdayInput {
  readonly requestId: string;
  readonly reason: string;
}

export type BirthdayListRow = lobbyRepo.BirthdayListRow;

const viewOf = (row: lobbyRepo.BirthdayRow): MyBirthdayView => ({
  requestId: row.id,
  status: row.status,
  celebrantName: row.celebrantName,
  scheduledAt: row.scheduledAt,
  declineReason: row.declineReason,
});

/** Accepted and 30 minutes past their time (database clock) -> expired. Returns the count. Runs on every birthday read and list, and nightly. */
export async function expireStaleBirthdayRequests(tx: Tx, orgId: string): Promise<number> {
  return lobbyRepo.expireStaleBirthdays(tx, orgId, LOBBY_BIRTHDAY_EXPIRE_MINUTES);
}

/** Unanswered (requested or accepted) requests on a SEATED entry that closed more than 3 hours ago (database clock) -> expired. Nightly only. */
export async function expireSeatedBirthdayRequests(tx: Tx, orgId: string): Promise<number> {
  return lobbyRepo.expireSeatedEntryBirthdays(tx, orgId, 180);
}

function cleanCelebrant(name: unknown): string | null {
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string') throw lobbyRefusal('LOBBY_BAD_INPUT', 'celebrant type');
  const t = name.trim();
  if (t.length > LOBBY_NAME_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'celebrant length');
  return t.length > 0 ? t : null;
}

// ------------------------------------------------------------------------------------------------ the diner

/** The phone's own entry, found by the cookie hash only. A stranger (or another store) gets LOBBY_NOT_FOUND. Locked: asks on one entry are serialised. */
async function myEntry(tx: Tx, key: MyEntryKey): Promise<lobbyRepo.EntryRow> {
  const row = await lobbyRepo.findLatestByDevice(tx, key.orgId, key.storeId, key.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  return row;
}

/**
 * The diner asks for the birthday song. Only a LIVE entry (waiting or called) may ask; the store's birthday switch must be on; one request per
 * entry (a cancelled one frees the slot). The name is optional, trimmed, at most 40 characters; blank is NULL.
 */
export async function requestBirthday(tx: Tx, key: MyEntryKey, input: { celebrantName?: string | null }): Promise<{ requestId: string; status: 'requested' }> {
  const celebrantName = cleanCelebrant(input.celebrantName);
  const entry = await myEntry(tx, key);
  if ((entry.status !== 'waiting' && entry.status !== 'called') || entry.stale) throw lobbyRefusal('LOBBY_ENTRY_CLOSED');
  if (!(await lobbyRepo.isBirthdayEnabled(tx, key.orgId, key.storeId))) throw lobbyRefusal('LOBBY_BIRTHDAY_OFF', 'switch off');
  const current = await lobbyRepo.findBirthdayOfEntry(tx, key.orgId, entry.id);
  if (current && current.status !== 'cancelled') throw lobbyRefusal('LOBBY_BIRTHDAY_EXISTS');
  const id = await lobbyRepo.insertBirthday(tx, key.orgId, entry.id, celebrantName);
  if (!id) throw lobbyRefusal('LOBBY_BIRTHDAY_EXISTS', 'lost the race');
  return { requestId: id, status: 'requested' };
}

/** The phone's own request (the live one, else the newest cancelled one), or null when it never asked. A stale accepted one reads as expired. */
export async function getMyBirthday(tx: Tx, key: MyEntryKey): Promise<MyBirthdayView | null> {
  const entry = await lobbyRepo.findLatestByDevice(tx, key.orgId, key.storeId, key.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (!entry) return null;
  await expireStaleBirthdayRequests(tx, key.orgId);
  const row = await lobbyRepo.findBirthdayOfEntry(tx, key.orgId, entry.id);
  return row ? viewOf(row) : null;
}

/**
 * What the phone's screen reads: like `getMyBirthday`, but a key that owns NO entry at the store is LOBBY_NOT_FOUND (a stranger or another
 * store's cookie), while an owner who never asked gets null - the screen can tell "nothing asked yet" from "no place in line".
 */
export async function readMyBirthday(tx: Tx, key: MyEntryKey): Promise<MyBirthdayView | null> {
  await myEntry(tx, key); // LOBBY_NOT_FOUND when the key owns no entry here
  return getMyBirthday(tx, key);
}

/** The diner withdraws the request: requested or accepted only. Played, declined, expired and cancelled ones are closed. */
export async function cancelMyBirthday(tx: Tx, key: MyEntryKey): Promise<{ requestId: string; status: 'cancelled' }> {
  const entry = await myEntry(tx, key);
  await expireStaleBirthdayRequests(tx, key.orgId);
  const row = await lobbyRepo.findBirthdayOfEntry(tx, key.orgId, entry.id);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  if (row.status !== 'requested' && row.status !== 'accepted') throw lobbyRefusal('LOBBY_BIRTHDAY_CLOSED');
  // Lock the row and look again: a staff move (played) that commits between the read above and the update would hit the forward-only trigger.
  const locked = await lobbyRepo.getBirthdayForUpdate(tx, key.orgId, row.id);
  if (!locked || (locked.status !== 'requested' && locked.status !== 'accepted')) throw lobbyRefusal('LOBBY_BIRTHDAY_CLOSED');
  await lobbyRepo.cancelBirthday(tx, key.orgId, row.id);
  return { requestId: row.id, status: 'cancelled' };
}

// ------------------------------------------------------------------------------------------------ the cashier moves (one core)

const withCashier = (ctx: MoveCtx, after: Record<string, unknown>): Record<string, unknown> =>
  ctx.cashier === undefined ? after : { ...after, cashier: ctx.cashier };

/** The request, locked, with the store guard run BEFORE anything else is decided (a ghost id is NOT_FOUND first, like an entry). */
async function requestOrRefuse(tx: Tx, ctx: MoveCtx, requestId: string, guard: StoreGuard): Promise<lobbyRepo.BirthdayRow> {
  const row = typeof requestId === 'string' && UUID.test(requestId) ? await lobbyRepo.getBirthdayForUpdate(tx, ctx.orgId, requestId) : undefined;
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  await guard(row.storeId);
  return row;
}

function cleanTime(input: { scheduledAt?: unknown }): Date {
  const t = input.scheduledAt;
  if (t === undefined || t === null) throw lobbyRefusal('LOBBY_BIRTHDAY_NEEDS_TIME');
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) throw lobbyRefusal('LOBBY_BAD_INPUT', 'time');
  return t;
}

function cleanReason(reason: unknown): string {
  const t = typeof reason === 'string' ? reason.trim() : '';
  if (t.length < 1 || t.length > LOBBY_BIRTHDAY_REASON_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'decline reason');
  return t;
}

/** The open requests (requested + accepted) of one store, oldest first. Stale accepted ones are expired first and so drop out. */
export async function listBirthdayCore(tx: Tx, orgId: string, storeId: string): Promise<BirthdayListRow[]> {
  await expireStaleBirthdayRequests(tx, orgId);
  return lobbyRepo.listOpenBirthdays(tx, orgId, storeId);
}

/** requested -> accepted, only with a time. A past time is allowed ("Now"). */
export async function acceptBirthdayCore(
  tx: Tx,
  ctx: MoveCtx,
  input: AcceptBirthdayInput,
  guard: StoreGuard,
): Promise<{ requestId: string; status: 'accepted'; scheduledAt: Date }> {
  const scheduledAt = cleanTime(input);
  const row = await requestOrRefuse(tx, ctx, input.requestId, guard);
  if (row.status !== 'requested') throw lobbyRefusal('LOBBY_BIRTHDAY_CLOSED');
  await lobbyRepo.acceptBirthdayRow(tx, ctx.orgId, row.id, scheduledAt, ctx.personId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.birthday_accept',
    storeId: row.storeId,
    entityId: row.id,
    before: { status: 'requested' },
    after: withCashier(ctx, { status: 'accepted', code: row.code, scheduledAt: scheduledAt.toISOString() }),
    source: 'pos',
  });
  return { requestId: row.id, status: 'accepted', scheduledAt };
}

/** requested -> declined, with a free-text reason of 1..80 characters. */
export async function declineBirthdayCore(
  tx: Tx,
  ctx: MoveCtx,
  input: DeclineBirthdayInput,
  guard: StoreGuard,
): Promise<{ requestId: string; status: 'declined' }> {
  const reason = cleanReason(input.reason);
  const row = await requestOrRefuse(tx, ctx, input.requestId, guard);
  if (row.status !== 'requested') throw lobbyRefusal('LOBBY_BIRTHDAY_CLOSED');
  await lobbyRepo.declineBirthdayRow(tx, ctx.orgId, row.id, reason, ctx.personId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.birthday_decline',
    storeId: row.storeId,
    entityId: row.id,
    before: { status: 'requested' },
    after: withCashier(ctx, { status: 'declined', code: row.code, reason }),
    source: 'pos',
  });
  return { requestId: row.id, status: 'declined' };
}

/** accepted -> played (the tablet played the song, or the cashier pressed the manual button). Not time-gated here (S6a ruling 7). */
export async function markBirthdayPlayedCore(tx: Tx, ctx: MoveCtx, requestId: string, guard: StoreGuard): Promise<{ requestId: string; status: 'played' }> {
  await expireStaleBirthdayRequests(tx, ctx.orgId);
  const row = await requestOrRefuse(tx, ctx, requestId, guard);
  if (row.status !== 'accepted') throw lobbyRefusal('LOBBY_BIRTHDAY_CLOSED');
  await lobbyRepo.playBirthdayRow(tx, ctx.orgId, row.id, ctx.personId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.birthday_play',
    storeId: row.storeId,
    entityId: row.id,
    before: { status: 'accepted' },
    after: withCashier(ctx, { status: 'played', code: row.code }),
    source: 'pos',
  });
  return { requestId: row.id, status: 'played' };
}

// ------------------------------------------------------------------------------------------------ door 1: an ERP cashier

const staffCtx = (actor: Actor): MoveCtx => ({ orgId: actor.orgId, personId: actor.personId });
/** The capability is store-scoped and the store is the request's own. */
const staffGuard = (tx: Tx, actor: Actor): StoreGuard => async (storeId) => {
  await authorize(tx, actor, 'record_sale', { storeId });
};

export async function listBirthdayRequests(tx: Tx, actor: Actor, storeId: string): Promise<BirthdayListRow[]> {
  await authorize(tx, actor, 'record_sale', { storeId });
  return listBirthdayCore(tx, actor.orgId, storeId);
}

export async function acceptBirthday(tx: Tx, actor: Actor, input: AcceptBirthdayInput) {
  return acceptBirthdayCore(tx, staffCtx(actor), input, staffGuard(tx, actor));
}

export async function declineBirthday(tx: Tx, actor: Actor, input: DeclineBirthdayInput) {
  return declineBirthdayCore(tx, staffCtx(actor), input, staffGuard(tx, actor));
}

export async function markBirthdayPlayed(tx: Tx, actor: Actor, requestId: string) {
  return markBirthdayPlayedCore(tx, staffCtx(actor), requestId, staffGuard(tx, actor));
}

// ------------------------------------------------------------------------------------------------ door 2: the POS tablet

const terminalCtx = (a: TerminalActor): MoveCtx => ({ orgId: a.orgId, personId: a.terminalPersonId, cashier: a.cashierName });
/** Another store's request answers exactly like a ghost id. */
const terminalGuard = (a: TerminalActor): StoreGuard => (requestStoreId) => {
  if (requestStoreId !== a.erpStoreId) throw lobbyRefusal('LOBBY_NOT_FOUND');
};

export async function listBirthdayForTerminal(tx: Tx, actor: TerminalActor): Promise<BirthdayListRow[]> {
  return listBirthdayCore(tx, actor.orgId, actor.erpStoreId);
}

export async function acceptBirthdayForTerminal(tx: Tx, actor: TerminalActor, input: AcceptBirthdayInput) {
  return acceptBirthdayCore(tx, terminalCtx(actor), input, terminalGuard(actor));
}

export async function declineBirthdayForTerminal(tx: Tx, actor: TerminalActor, input: DeclineBirthdayInput) {
  return declineBirthdayCore(tx, terminalCtx(actor), input, terminalGuard(actor));
}

export async function markBirthdayPlayedForTerminal(tx: Tx, actor: TerminalActor, requestId: string) {
  return markBirthdayPlayedCore(tx, terminalCtx(actor), requestId, terminalGuard(actor));
}
