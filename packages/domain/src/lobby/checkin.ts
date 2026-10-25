/**
 * T-455 S2 - the diner side of the customer lobby: check in, read my place, cancel (docs/tasks/455-customer-lobby.md sections 2.3, 2.4, 4.1).
 *
 * Every function takes the caller's `tx: Tx` (DEF-421) and opens no transaction. The domain never sees a raw cookie or IP: it receives
 * `deviceHash` and `ipHash`, already HMAC'd by the customer server (S2 ruling 1). SQL lives only in `lobbyRepo`.
 */
import { lobbyRepo, type Tx } from '@shareat/db';
import { cleanParty, lobbyRefusal } from './refusal';

/** A phone may start this many check-ins per store per hour (closed ones count). */
export const LOBBY_CHECKINS_PER_IP_HOUR = 5;
/** Booking-code attempts IN TOTAL (first try + 4 retries) before the diner is sent to the counter. */
export const LOBBY_CODE_ATTEMPTS = 5;
/** A waiting or called entry expires this long after check-in. */
export const LOBBY_ENTRY_TTL_HOURS = 3;
/** The diner side refuses when POS has not stamped `pos_seen_at` within this many minutes. */
export const LOBBY_POS_STALE_MINUTES = 5;

const MAX_LINES = 20;
const MAX_QTY = 20;
const MAX_REQUEST_ID = 64;

export type LobbyEntryStatus = 'waiting' | 'called' | 'seated' | 'cancelled' | 'removed' | 'expired';

export interface CheckInLine {
  readonly variantId: string;
  readonly qty: number;
  readonly lineKind: 'package' | 'a_la_carte';
  readonly optionValueIds?: readonly string[];
}

export interface CheckInInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly deviceHash: string;
  readonly ipHash: string;
  readonly displayName: string;
  readonly partySize: number;
  readonly note?: string | null;
  readonly clientRequestId?: string | null;
  readonly lines?: readonly CheckInLine[];
}

export interface CheckInResult {
  readonly entryId: string;
  readonly code: string;
  readonly status: LobbyEntryStatus;
  readonly partiesAhead: number;
  /** false when the phone already held a live entry (or replayed its request id) and that entry was returned. */
  readonly created: boolean;
}

export interface MyEntryKey {
  readonly orgId: string;
  readonly storeId: string;
  readonly deviceHash: string;
}

export interface MyEntryView {
  readonly entryId: string;
  readonly code: string;
  readonly status: LobbyEntryStatus;
  readonly partiesAhead: number;
  readonly displayName: string | null;
  readonly partySize: number;
  readonly standLabel: string | null;
  /** The bearer link into the table session: returned ONCE to the owning cookie, then cleared. */
  readonly handoffUrl: string | null;
}

interface CleanLine {
  variantId: string;
  qty: number;
  lineKind: 'package' | 'a_la_carte';
  optionValueIds: string[];
}

function cleanLines(lines: readonly CheckInLine[] | undefined): CleanLine[] {
  if (lines === undefined) return [];
  if (!Array.isArray(lines) || lines.length > MAX_LINES) throw lobbyRefusal('LOBBY_BAD_INPUT', 'line count');
  return lines.map((l) => {
    if (typeof l.variantId !== 'string' || l.variantId.length === 0) throw lobbyRefusal('LOBBY_BAD_INPUT', 'line variant');
    const copies: unknown = l.qty;
    if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > MAX_QTY) throw lobbyRefusal('LOBBY_BAD_INPUT', 'line qty');
    if (l.lineKind !== 'package' && l.lineKind !== 'a_la_carte') throw lobbyRefusal('LOBBY_BAD_INPUT', 'line kind');
    const opts = l.optionValueIds ?? [];
    if (!Array.isArray(opts) || opts.length > MAX_LINES || opts.some((o) => typeof o !== 'string' || o.length === 0)) {
      throw lobbyRefusal('LOBBY_BAD_INPUT', 'line options');
    }
    return { variantId: l.variantId, qty: copies, lineKind: l.lineKind, optionValueIds: [...new Set(opts)] };
  });
}

async function viewOf(tx: Tx, orgId: string, row: lobbyRepo.EntryRow, status: LobbyEntryStatus, handoffUrl: string | null): Promise<MyEntryView> {
  const live = status === 'waiting' || status === 'called';
  return {
    entryId: row.id,
    code: row.code,
    status,
    partiesAhead: live ? await lobbyRepo.partiesAhead(tx, orgId, row.id) : 0,
    displayName: row.displayName,
    partySize: row.partySize,
    standLabel: row.standLabel,
    handoffUrl,
  };
}

/** Closing an entry always expires its pending discount claims in the same run (S1 audit note 1). */
async function closeAndExpireClaims(tx: Tx, orgId: string, entryId: string, status: 'cancelled' | 'expired'): Promise<void> {
  await lobbyRepo.markClosed(tx, orgId, entryId, status, null);
  await lobbyRepo.expirePendingClaimsOfEntry(tx, orgId, entryId);
}

/**
 * A party checks itself in. Order (S2 ruling 6): validate -> the phone's own live entry (a returning cookie is answered BEFORE any limit;
 * one older than 3 h is expired and a new place is made) -> a replayed `clientRequestId` -> the store must be open -> 5 per network per
 * hour -> the live cap -> a random 4-digit code (5 attempts) -> the pre-order lines. Every refusal is a `LobbyRefusal`; the transaction
 * stays usable after one.
 */
export async function checkIn(tx: Tx, input: CheckInInput, opts?: { randomCode?: () => string }): Promise<CheckInResult> {
  const party = cleanParty(input);
  if (typeof input.deviceHash !== 'string' || input.deviceHash.length === 0 || typeof input.ipHash !== 'string' || input.ipHash.length === 0) {
    throw lobbyRefusal('LOBBY_BAD_INPUT', 'missing hash');
  }
  const requestId = input.clientRequestId ?? null;
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID)) {
    throw lobbyRefusal('LOBBY_BAD_INPUT', 'request id');
  }
  const lines = cleanLines(input.lines);
  const { orgId, storeId } = input;

  const mine = await lobbyRepo.findLiveByDevice(tx, orgId, storeId, input.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (mine) {
    if (!mine.stale) {
      return { entryId: mine.id, code: mine.code, status: mine.status, partiesAhead: await lobbyRepo.partiesAhead(tx, orgId, mine.id), created: false };
    }
    await closeAndExpireClaims(tx, orgId, mine.id, 'expired');
  }
  if (requestId !== null) {
    const same = await lobbyRepo.findByClientRequestId(tx, orgId, storeId, input.deviceHash, requestId, LOBBY_ENTRY_TTL_HOURS);
    if (same) {
      return { entryId: same.id, code: same.code, status: same.status, partiesAhead: await lobbyRepo.partiesAhead(tx, orgId, same.id), created: false };
    }
  }

  const store = await lobbyRepo.getLobbyStore(tx, orgId, storeId, LOBBY_POS_STALE_MINUTES, true);
  if (!store || !store.enabled) throw lobbyRefusal('LOBBY_DISABLED', 'store switched off');
  if (store.paused) throw lobbyRefusal('LOBBY_PAUSED', 'store paused');
  if (!store.posFresh) throw lobbyRefusal('LOBBY_POS_STALE', 'pos not seen');
  if ((await lobbyRepo.countFromIp(tx, orgId, storeId, input.ipHash, 60)) >= LOBBY_CHECKINS_PER_IP_HOUR) throw lobbyRefusal('LOBBY_IP_LIMIT', 'network limit');
  if ((await lobbyRepo.countLive(tx, orgId, storeId)) >= store.maxLiveEntries) throw lobbyRefusal('LOBBY_FULL', 'live cap');

  if (lines.length > 0) {
    const variants = [...new Set(lines.map((l) => l.variantId))];
    const values = [...new Set(lines.flatMap((l) => l.optionValueIds))];
    const variantsFound = await lobbyRepo.countVariants(tx, orgId, variants);
    const valuesFound = await lobbyRepo.countOptionValues(tx, orgId, values);
    if (variantsFound !== variants.length || valuesFound !== values.length) throw lobbyRefusal('LOBBY_BAD_INPUT', 'unknown menu choice');
  }

  const res = await lobbyRepo.insertEntryWithCode(
    tx,
    {
      orgId,
      storeId,
      source: 'lobby',
      displayName: party.displayName,
      partySize: party.partySize,
      note: party.note,
      phone: null,
      deviceHash: input.deviceHash,
      ipHash: input.ipHash,
      clientRequestId: requestId,
      actedByPersonId: null,
    },
    opts?.randomCode ?? lobbyRepo.randomBookingCode,
    LOBBY_CODE_ATTEMPTS,
  );
  if (res.kind === 'request_taken') throw lobbyRefusal('LOBBY_BAD_INPUT', 'request id already used');
  if (res.kind === 'exhausted') throw lobbyRefusal('LOBBY_NO_CODE', 'every code attempt collided');
  if (res.kind === 'exists') {
    const row = await lobbyRepo.getEntryForUpdate(tx, orgId, res.id, LOBBY_ENTRY_TTL_HOURS);
    if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
    return { entryId: row.id, code: row.code, status: row.status, partiesAhead: await lobbyRepo.partiesAhead(tx, orgId, row.id), created: false };
  }
  await lobbyRepo.insertLines(tx, orgId, res.id, lines);
  return { entryId: res.id, code: res.code, status: 'waiting', partiesAhead: await lobbyRepo.partiesAhead(tx, orgId, res.id), created: true };
}

/** Parties ahead of this entry: earlier waiting|called entries of the same store. */
export async function lobbyPartiesAhead(tx: Tx, orgId: string, entryId: string): Promise<number> {
  return lobbyRepo.partiesAhead(tx, orgId, entryId);
}

/**
 * The phone's own place, found by its cookie hash only (never by code or id). A live entry past 3 h is expired here and reported as such
 * (expiry on read). A hand-off link is returned once and cleared; an expired link is cleared and never returned. A stranger gets null.
 */
export async function getMyEntry(tx: Tx, key: MyEntryKey): Promise<MyEntryView | null> {
  const row = await lobbyRepo.findLatestByDevice(tx, key.orgId, key.storeId, key.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (!row) return null;
  if ((row.status === 'waiting' || row.status === 'called') && row.stale) {
    await closeAndExpireClaims(tx, key.orgId, row.id, 'expired');
    return viewOf(tx, key.orgId, row, 'expired', null);
  }
  let handoffUrl: string | null = null;
  if (row.handoffUrl !== null) {
    handoffUrl = row.handoffLive ? row.handoffUrl : null;
    await lobbyRepo.clearHandoff(tx, key.orgId, row.id);
  }
  return viewOf(tx, key.orgId, row, row.status, handoffUrl);
}

/** The diner leaves the line. Only the owning cookie can; a closed entry (seated, cancelled, removed, expired) cannot be cancelled. */
export async function cancelMyEntry(tx: Tx, key: MyEntryKey): Promise<{ entryId: string; status: 'cancelled' }> {
  const row = await lobbyRepo.findLatestByDevice(tx, key.orgId, key.storeId, key.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  if (row.status !== 'waiting' && row.status !== 'called') throw lobbyRefusal('LOBBY_ENTRY_CLOSED');
  await closeAndExpireClaims(tx, key.orgId, row.id, 'cancelled');
  return { entryId: row.id, status: 'cancelled' };
}
