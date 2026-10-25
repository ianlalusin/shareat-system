/**
 * T-455 S2 - the nightly lobby job: expire stale entries, sweep stale pending discount claims, purge personal data
 * (docs/tasks/455-customer-lobby.md sections 2.3, 4.7, "S1 audit notes", S2 rulings 7 and 8).
 *
 * One organisation per call, inside the caller's transaction. LISTING the organisations is the scheduler glue's job under
 * `systemTransaction` (DEF-742), not this module's: nothing here opens a transaction. Rows are never deleted.
 */
import { lobbyRepo, type Tx } from '@shareat/db';
import { LOBBY_ENTRY_TTL_HOURS } from './checkin';

/** Personal columns are NULLed on entries closed longer than this. */
export const LOBBY_PURGE_AFTER_HOURS = 24;
/** A claim still pending after this long is swept even when its entry is live (S2 ruling 7). */
export const LOBBY_CLAIM_MAX_AGE_HOURS = 24;

/** Live entries older than 3 h become `expired` (closed_at set) and their pending claims expire with them. Returns the entries expired. */
export async function expireStaleLobbyEntries(tx: Tx, orgId: string): Promise<number> {
  const ids = await lobbyRepo.expireStaleEntries(tx, orgId, LOBBY_ENTRY_TTL_HOURS);
  for (const id of ids) await lobbyRepo.expirePendingClaimsOfEntry(tx, orgId, id);
  return ids.length;
}

/**
 * A pending claim is swept when its entry is closed (any age) or the claim itself is older than 24 h. Name and ID number go to NULL
 * (the database CHECK); id_last4, kind, outcome and time stay. Approved claims are the receipt record and are never touched. Returns the count.
 */
export async function sweepStalePendingClaims(tx: Tx, orgId: string): Promise<number> {
  return lobbyRepo.sweepStalePendingClaims(tx, orgId, LOBBY_CLAIM_MAX_AGE_HOURS);
}

/**
 * On entries closed more than 24 h ago: display name, phone, note, device hash, ip hash, hand-off link (and its expiry) and the
 * celebrant name go to NULL. Counts, codes, times and outcomes stay; no row is deleted; a second run changes nothing.
 */
export async function purgeLobbyPersonalData(tx: Tx, orgId: string): Promise<{ entriesPurged: number; birthdayNamesPurged: number }> {
  const birthdayNamesPurged = await lobbyRepo.purgeBirthdayNames(tx, orgId, LOBBY_PURGE_AFTER_HOURS);
  const entriesPurged = await lobbyRepo.purgeClosedEntries(tx, orgId, LOBBY_PURGE_AFTER_HOURS);
  return { entriesPurged, birthdayNamesPurged };
}

/** Expiry, then the claim sweep, then the purge, in that order (an entry closed by step 1 is purged only 24 h later). */
export async function runLobbyNightly(
  tx: Tx,
  orgId: string,
): Promise<{ entriesExpired: number; claimsExpired: number; entriesPurged: number; birthdayNamesPurged: number }> {
  const entriesExpired = await expireStaleLobbyEntries(tx, orgId);
  const claimsExpired = await sweepStalePendingClaims(tx, orgId);
  const purged = await purgeLobbyPersonalData(tx, orgId);
  return { entriesExpired, claimsExpired, ...purged };
}
