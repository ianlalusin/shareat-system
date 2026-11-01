/**
 * T-455 S7a - the senior / PWD discount claim (docs/tasks/455-customer-lobby.md sections 2.2, 3.1, 3.2, 4.1, 4.4-4.7 and "S7a rulings").
 *
 * Three doors, one state logic (the birthday.ts template):
 *   - the DINER (submitClaim / listMyClaims / cancelMyClaim), found by the cookie hash like the entry itself;
 *   - an ERP CASHIER (`actor: Actor`, `authorize(record_sale)` at the claim's own store);
 *   - the POS TABLET (`...ForTerminal`, a `TerminalActor`: no `authorize()`, S5 ruling 2; another store's claim answers exactly like a ghost id).
 * The cashier and tablet doors call the same `*Core` with a store guard, so the state logic exists once.
 *
 * PERSONAL DATA (row 353, T-435). The holder name and ID number are stored ONLY while a claim is pending (the database CHECK nulls them on
 * approve, reject and expiry). They are returned by exactly one call, `openClaim*`, which writes a `lobby.claim_open` audit row each time. Every
 * other view shows `****last4`. No audit row, refusal message or log line carries a name or an ID number. Nothing here is a photo path (S8).
 *
 * Every function takes the caller's `tx: Tx` and opens no transaction (DEF-421). SQL lives only in `lobbyRepo`. The clock is the database's.
 */
import { auditLogRepo, lobbyRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { LOBBY_ENTRY_TTL_HOURS, type MyEntryKey } from './checkin';
import type { MoveCtx, StoreGuard } from './core';
import { lobbyRefusal, LOBBY_NAME_MAX } from './refusal';
import type { TerminalActor } from './terminal';

/** The ID number is 4..40 characters after trimming (4 so a last-4 exists; 40 so no image can ride in a text field, 4.4). */
export const LOBBY_CLAIM_ID_MIN = 4;
export const LOBBY_CLAIM_ID_MAX = 40;
/** Reject reason and the POS's statutory-diner reference are 1..80 characters after trimming. */
export const LOBBY_CLAIM_REASON_MAX = 80;
export const LOBBY_CLAIM_REF_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaimKind = 'senior' | 'pwd';
export type ClaimStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** What the diner sees of a claim. Never the name, the full ID number, the entry id or a hash. */
export interface MyClaimView {
  readonly claimId: string;
  readonly kind: ClaimKind;
  readonly status: ClaimStatus;
  readonly idMasked: string;
  readonly rejectReason: string | null;
  readonly ocrAssisted: boolean;
}

export interface SubmitClaimInput {
  readonly kind: ClaimKind;
  readonly holderName: string;
  readonly idNumber: string;
  readonly ocrAssisted?: boolean;
}

export interface ApproveClaimInput {
  readonly claimId: string;
  readonly cardSeen: boolean;
  readonly sessionRef: string;
  readonly statutoryDinerRef: string;
}

export interface RejectClaimInput {
  readonly claimId: string;
  readonly reason: string;
}

export type ClaimListRow = {
  readonly claimId: string;
  readonly entryId: string;
  readonly code: string;
  readonly displayName: string | null;
  readonly standLabel: string | null;
  readonly partySize: number;
  readonly kind: ClaimKind;
  readonly idMasked: string;
  readonly ocrAssisted: boolean;
  readonly status: 'pending';
  readonly createdAt: Date;
};

/** The one call that carries the full name and ID number (pending claims only). */
export interface OpenClaimView {
  readonly claimId: string;
  readonly entryId: string;
  readonly code: string;
  readonly kind: ClaimKind;
  readonly holderName: string;
  readonly idNumber: string;
  readonly idLast4: string;
  readonly ocrAssisted: boolean;
  readonly partySize: number;
  readonly standLabel: string | null;
  readonly sessionRef: string | null;
}

const mask = (last4: string): string => `****${last4}`;

const viewOf = (row: lobbyRepo.ClaimRow): MyClaimView => ({
  claimId: row.id,
  kind: row.kind,
  status: row.status,
  idMasked: mask(row.idLast4),
  rejectReason: row.rejectReason,
  ocrAssisted: row.ocrAssisted,
});

/** Every Unicode space (incl. NBSP, U+2000-200B, U+3000) and hyphen look-alike removed. The ONE normalisation: duplicates compare in JS, never in SQL. */
const SPACE_OR_HYPHEN = /[\s\u00a0\u2000-\u200b\u3000\ufeff\-\u2010-\u2014]/g;
const stripped = (id: string): string => id.replace(SPACE_OR_HYPHEN, '');

/** At most this many claim rows (any status) per entry, so submit/cancel loops cannot grow rows forever. */
export const LOBBY_CLAIM_ROWS_MAX = 10;

/** The diner's fields, trimmed and bounded. A refusal names nothing that was typed. */
function cleanClaim(input: { kind?: unknown; holderName?: unknown; idNumber?: unknown; ocrAssisted?: unknown }): {
  kind: ClaimKind;
  holderName: string;
  idNumber: string;
  idLast4: string;
  normalisedId: string;
  ocrAssisted: boolean;
} {
  if (input.kind !== 'senior' && input.kind !== 'pwd') throw lobbyRefusal('LOBBY_BAD_INPUT', 'claim kind');
  const holderName = typeof input.holderName === 'string' ? input.holderName.trim() : '';
  if (holderName.length < 1 || holderName.length > LOBBY_NAME_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'claim name length');
  const idNumber = typeof input.idNumber === 'string' ? input.idNumber.trim() : '';
  if (idNumber.length < LOBBY_CLAIM_ID_MIN || idNumber.length > LOBBY_CLAIM_ID_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'claim id length');
  const bare = stripped(idNumber);
  if (bare.length < LOBBY_CLAIM_ID_MIN) throw lobbyRefusal('LOBBY_BAD_INPUT', 'claim id characters');
  return {
    kind: input.kind,
    holderName,
    idNumber,
    idLast4: bare.slice(-4),
    normalisedId: bare.toUpperCase(),
    ocrAssisted: input.ocrAssisted === true,
  };
}

// ------------------------------------------------------------------------------------------------ the diner

/** The phone's own entry, found by the cookie hash only (locked: asks on one entry are serialised). A stranger or another store gets LOBBY_NOT_FOUND. */
async function myEntry(tx: Tx, key: MyEntryKey): Promise<lobbyRepo.EntryRow> {
  const row = await lobbyRepo.findLatestByDevice(tx, key.orgId, key.storeId, key.deviceHash, LOBBY_ENTRY_TTL_HOURS);
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  return row;
}

/**
 * The diner claims the senior / PWD discount for one person of the party. Only a LIVE entry (waiting or called) may claim; the store's claims switch
 * must be on; pending + approved claims never exceed the party size (the entry row is locked first, so two taps for the last slot cannot both win);
 * a second PENDING claim with the same ID number (spaces, hyphens and case ignored) in the same entry is refused (S7a ruling). The reply is masked.
 */
export async function submitClaim(tx: Tx, key: MyEntryKey, input: SubmitClaimInput): Promise<{ claimId: string; status: 'pending'; idMasked: string }> {
  const c = cleanClaim(input);
  const entry = await myEntry(tx, key);
  if ((entry.status !== 'waiting' && entry.status !== 'called') || entry.stale) throw lobbyRefusal('LOBBY_ENTRY_CLOSED');
  if (!(await lobbyRepo.isClaimsEnabled(tx, key.orgId, key.storeId))) throw lobbyRefusal('LOBBY_CLAIM_OFF', 'switch off');
  if ((await lobbyRepo.countClaimSlots(tx, key.orgId, entry.id)) >= entry.partySize) throw lobbyRefusal('LOBBY_CLAIM_FULL');
  if ((await lobbyRepo.countClaimRows(tx, key.orgId, entry.id)) >= LOBBY_CLAIM_ROWS_MAX) throw lobbyRefusal('LOBBY_CLAIM_FULL', 'row cap');
  const pending = await lobbyRepo.listPendingClaimIdNumbers(tx, key.orgId, entry.id);
  if (pending.some((p) => stripped(p).toUpperCase() === c.normalisedId)) throw lobbyRefusal('LOBBY_CLAIM_DUPLICATE');
  const claimId = await lobbyRepo.insertClaim(tx, key.orgId, entry.id, {
    kind: c.kind,
    holderName: c.holderName,
    idNumber: c.idNumber,
    idLast4: c.idLast4,
    ocrAssisted: c.ocrAssisted,
  });
  return { claimId, status: 'pending', idMasked: mask(c.idLast4) };
}

/** The phone's own claims, oldest first (any status), masked. A key that owns no entry here is LOBBY_NOT_FOUND; an owner who never claimed gets []. */
export async function listMyClaims(tx: Tx, key: MyEntryKey): Promise<MyClaimView[]> {
  const entry = await myEntry(tx, key);
  const rows = await lobbyRepo.listClaimsOfEntry(tx, key.orgId, entry.id);
  return rows.map(viewOf);
}

/**
 * The diner withdraws her own PENDING claim. The table has no 'cancelled' status, so a withdrawn claim is `expired` (name and ID NULL, slot free).
 * Another diner's claim, another store's and a junk id are LOBBY_NOT_FOUND; a decided claim is LOBBY_CLAIM_CLOSED.
 */
export async function cancelMyClaim(tx: Tx, key: MyEntryKey, claimId: string): Promise<{ claimId: string; status: 'expired' }> {
  const entry = await myEntry(tx, key);
  const row = typeof claimId === 'string' && UUID.test(claimId) ? await lobbyRepo.getClaimForUpdate(tx, key.orgId, claimId) : undefined;
  if (!row || row.entryId !== entry.id) throw lobbyRefusal('LOBBY_NOT_FOUND');
  if (row.status !== 'pending') throw lobbyRefusal('LOBBY_CLAIM_CLOSED');
  await lobbyRepo.expireClaimRow(tx, key.orgId, row.id);
  return { claimId: row.id, status: 'expired' };
}

// ------------------------------------------------------------------------------------------------ the cashier moves (one core)

const withCashier = (ctx: MoveCtx, after: Record<string, unknown>): Record<string, unknown> =>
  ctx.cashier === undefined ? after : { ...after, cashier: ctx.cashier };

/** The claim, locked, with the store guard run BEFORE anything else is decided (a ghost id is NOT_FOUND first, like an entry). */
async function claimOrRefuse(tx: Tx, ctx: MoveCtx, claimId: unknown, guard: StoreGuard): Promise<lobbyRepo.ClaimRow> {
  const row = typeof claimId === 'string' && UUID.test(claimId) ? await lobbyRepo.getClaimForUpdate(tx, ctx.orgId, claimId) : undefined;
  if (!row) throw lobbyRefusal('LOBBY_NOT_FOUND');
  await guard(row.storeId);
  return row;
}

/** The store's pending claims (live and seated entries), oldest first, masked. */
export async function listClaimsCore(tx: Tx, orgId: string, storeId: string): Promise<ClaimListRow[]> {
  const rows = await lobbyRepo.listPendingClaims(tx, orgId, storeId);
  return rows.map((r) => ({
    claimId: r.claimId,
    entryId: r.entryId,
    code: r.code,
    displayName: r.displayName,
    standLabel: r.standLabel,
    partySize: r.partySize,
    kind: r.kind,
    idMasked: mask(r.idLast4),
    ocrAssisted: r.ocrAssisted,
    status: 'pending' as const,
    createdAt: r.createdAt,
  }));
}

/** One claim's status and nothing else (no name, no ID number, no audit row). Another store's claim answers like a ghost id. */
export async function claimStatusCore(tx: Tx, ctx: MoveCtx, claimId: string, guard: StoreGuard): Promise<{ status: ClaimStatus }> {
  const row = await claimOrRefuse(tx, ctx, claimId, guard);
  return { status: row.status };
}

/** "Open claim": the only call that returns the full name and ID number. Pending claims only. One `lobby.claim_open` audit row each time (code, kind, last 4: no name, no ID). */
export async function openClaimCore(tx: Tx, ctx: MoveCtx, claimId: string, guard: StoreGuard): Promise<OpenClaimView> {
  const row = await claimOrRefuse(tx, ctx, claimId, guard);
  if (row.status !== 'pending') throw lobbyRefusal('LOBBY_CLAIM_CLOSED');
  const pii = await lobbyRepo.getClaimPii(tx, ctx.orgId, row.id);
  if (!pii || pii.holderName === null || pii.idNumber === null) throw lobbyRefusal('LOBBY_CLAIM_CLOSED', 'no personal data left');
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.claim_open',
    storeId: row.storeId,
    entityId: row.id,
    before: null,
    after: withCashier(ctx, { code: row.code, kind: row.kind, idLast4: row.idLast4 }),
    source: 'pos',
  });
  return {
    claimId: row.id,
    entryId: row.entryId,
    code: row.code,
    kind: row.kind,
    holderName: pii.holderName,
    idNumber: pii.idNumber,
    idLast4: row.idLast4,
    ocrAssisted: row.ocrAssisted,
    partySize: row.partySize,
    standLabel: row.standLabel,
    sessionRef: row.entrySessionRef,
  };
}

/**
 * pending -> approved. The entry must be SEATED and `sessionRef` must be that entry's own session (another table's or another store's session is
 * refused); `cardSeen` must be exactly true; `statutoryDinerRef` (the POS's T-426 record) is a non-blank string of at most 80 characters. A retried
 * approve finds the claim decided and is refused, not repeated. Name and ID become NULL; one `lobby.claim_approve` audit row.
 */
export async function approveClaimCore(
  tx: Tx,
  ctx: MoveCtx,
  input: ApproveClaimInput,
  guard: StoreGuard,
): Promise<{ claimId: string; status: 'approved' }> {
  const row = await claimOrRefuse(tx, ctx, input.claimId, guard);
  if (row.status !== 'pending') throw lobbyRefusal('LOBBY_CLAIM_CLOSED');
  if (row.entryStatus !== 'seated' || row.entrySessionRef === null) throw lobbyRefusal('LOBBY_CLAIM_NEEDS_SEAT', 'entry not seated');
  const sessionRef = typeof input.sessionRef === 'string' ? input.sessionRef.trim() : '';
  if (sessionRef.length === 0 || sessionRef !== row.entrySessionRef) throw lobbyRefusal('LOBBY_CLAIM_NEEDS_SEAT', 'session mismatch');
  if (input.cardSeen !== true) throw lobbyRefusal('LOBBY_CLAIM_NEEDS_CARD');
  const ref = typeof input.statutoryDinerRef === 'string' ? input.statutoryDinerRef.trim() : '';
  if (ref.length < 1 || ref.length > LOBBY_CLAIM_REF_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'statutory diner ref');
  await lobbyRepo.approveClaimRow(tx, ctx.orgId, row.id, { sessionRef, statutoryDinerRef: ref, personId: ctx.personId });
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.claim_approve',
    storeId: row.storeId,
    entityId: row.id,
    before: { status: 'pending' },
    after: withCashier(ctx, { status: 'approved', code: row.code, kind: row.kind, idLast4: row.idLast4 }),
    source: 'pos',
  });
  return { claimId: row.id, status: 'approved' };
}

/** pending -> rejected, with a reason of 1..80 characters; allowed on a live or a seated entry. Name and ID become NULL; the slot is free. One `lobby.claim_reject` audit row. */
export async function rejectClaimCore(
  tx: Tx,
  ctx: MoveCtx,
  input: RejectClaimInput,
  guard: StoreGuard,
): Promise<{ claimId: string; status: 'rejected' }> {
  const row = await claimOrRefuse(tx, ctx, input.claimId, guard);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > LOBBY_CLAIM_REASON_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'reject reason');
  if (row.status !== 'pending') throw lobbyRefusal('LOBBY_CLAIM_CLOSED');
  await lobbyRepo.rejectClaimRow(tx, ctx.orgId, row.id, reason, ctx.personId);
  await auditLogRepo.append(tx, ctx.orgId, {
    actorPersonId: ctx.personId,
    action: 'lobby.claim_reject',
    storeId: row.storeId,
    entityId: row.id,
    before: { status: 'pending' },
    after: withCashier(ctx, { status: 'rejected', code: row.code, kind: row.kind, idLast4: row.idLast4, reason }),
    source: 'pos',
  });
  return { claimId: row.id, status: 'rejected' };
}

// ------------------------------------------------------------------------------------------------ door 1: an ERP cashier

const staffCtx = (actor: Actor): MoveCtx => ({ orgId: actor.orgId, personId: actor.personId });
/** The capability is store-scoped and the store is the claim's own. */
const staffGuard = (tx: Tx, actor: Actor): StoreGuard => async (storeId) => {
  await authorize(tx, actor, 'record_sale', { storeId });
};

export async function listClaimRequests(tx: Tx, actor: Actor, storeId: string): Promise<ClaimListRow[]> {
  await authorize(tx, actor, 'record_sale', { storeId });
  return listClaimsCore(tx, actor.orgId, storeId);
}

export async function openClaim(tx: Tx, actor: Actor, claimId: string): Promise<OpenClaimView> {
  return openClaimCore(tx, staffCtx(actor), claimId, staffGuard(tx, actor));
}

export async function approveClaim(tx: Tx, actor: Actor, input: ApproveClaimInput) {
  return approveClaimCore(tx, staffCtx(actor), input, staffGuard(tx, actor));
}

export async function rejectClaim(tx: Tx, actor: Actor, input: RejectClaimInput) {
  return rejectClaimCore(tx, staffCtx(actor), input, staffGuard(tx, actor));
}

// ------------------------------------------------------------------------------------------------ door 2: the POS tablet

const terminalCtx = (a: TerminalActor): MoveCtx => ({ orgId: a.orgId, personId: a.terminalPersonId, cashier: a.cashierName });
/** Another store's claim answers exactly like a ghost id. */
const terminalGuard = (a: TerminalActor): StoreGuard => (claimStoreId) => {
  if (claimStoreId !== a.erpStoreId) throw lobbyRefusal('LOBBY_NOT_FOUND');
};

export async function listClaimsForTerminal(tx: Tx, actor: TerminalActor): Promise<ClaimListRow[]> {
  return listClaimsCore(tx, actor.orgId, actor.erpStoreId);
}

export async function openClaimForTerminal(tx: Tx, actor: TerminalActor, claimId: string): Promise<OpenClaimView> {
  return openClaimCore(tx, terminalCtx(actor), claimId, terminalGuard(actor));
}

export async function approveClaimForTerminal(tx: Tx, actor: TerminalActor, input: ApproveClaimInput) {
  return approveClaimCore(tx, terminalCtx(actor), input, terminalGuard(actor));
}

export async function claimStatusForTerminal(tx: Tx, actor: TerminalActor, claimId: string): Promise<{ status: ClaimStatus }> {
  return claimStatusCore(tx, terminalCtx(actor), claimId, terminalGuard(actor));
}

export async function rejectClaimForTerminal(tx: Tx, actor: TerminalActor, input: RejectClaimInput) {
  return rejectClaimCore(tx, terminalCtx(actor), input, terminalGuard(actor));
}
