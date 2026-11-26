'use server';

/**
 * T-644 S1 - the cashier's waiting line, as Server Actions (docs/tasks/644-lobby-in-erp-pos.md, rulings 1-3). Online only. Each call is the T-455 staff twin
 * (`listLobby`, `parkWalkIn`, `callEntry`, `removeEntry`, `setLobbyPaused`), which authorizes `record_sale` at the store and owns every refusal sentence.
 * ⛔ No rule here. The store is `actionStore(...)`: on a paired tablet the pairing's store wins and a different `storeId` in the body is refused, never obeyed;
 * call and remove also pass it as `onlyStoreId`, so an entry id of another store answers like a ghost id. A domain refusal comes back as a RESULT, never a thrown error.
 * ⛔ `listLobbyAction` stamps `lobby_stores.pos_seen_at` (inside `listLobby`): the shell polls it on every tab, and diners cannot check in without that stamp.
 */
import { authorize, type Actor } from '@shareat/auth';
import { refuse, type Tx } from '@shareat/db';
import { acceptBirthday, approveClaim, approvedClaimsForSession, callEntry, claimStatus, declineBirthday, listBirthdayRequests, listClaimRequests, listLobby, markBirthdayPlayed, openClaim, parkWalkIn, rejectClaim, removeEntry, seatEntry, setLobbyPaused } from '@shareat/domain';
import { requireActor } from '@/lib/session';
import { tabletPairing } from '@/lib/pos-api';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';
import { actionStore } from '../_shell/action-store';
import { BAD_BIRTHDAY, BAD_BIRTHDAY_REASON, BIRTHDAY_DECLINE_PRESETS, strictIso, type BirthdayView } from '../_lobby/birthday';
import {
  BAD_CLAIM,
  BAD_CLAIM_DINER,
  BAD_CLAIM_REASON,
  CLAIM_FREE_TEXT_KEYS,
  DINER_NO_MAX,
  claimRejectText,
  dinerNoOfRef,
  dinerRefOf,
  type ApprovedClaimView,
  type ClaimView,
  type OpenedClaimView,
} from '../_lobby/claims';
import { BAD_ENTRY, type LobbyListView, type LobbyResult } from '../_lobby/logic';

const ROUTE = '/pos/lobby';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_PAIRED = "Open the lobby on the store's paired tablet.";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The one shape of every action: who is signed in, which store this tablet works at, then the domain call; a refusal becomes `{ ok: false, error }`. */
async function atStore<T extends object>(input: unknown, run: (tx: Tx, actor: Actor, storeId: string) => Promise<T>, needsPairing = false): Promise<LobbyResult<T>> {
  const actor = await requireActor(ROUTE);
  const store = await actionStore(actor, isRecord(input) ? input.storeId : undefined);
  if ('error' in store) return { ok: false, error: store.error };
  if (needsPairing) {
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== actor.orgId || pairing.storeId.toLowerCase() !== store.storeId) return { ok: false, error: NOT_PAIRED };
  }
  try {
    return { ok: true, ...(await withOrgPrincipal(actor.orgId, (tx) => run(tx, actor, store.storeId))) };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    // The birthday request or discount claim is closed, or not this store's: a later try cannot succeed (the tablet drops its report). Anything else may be a passing fault.
    return { ok: false, error: errorMessage(err), ...(code === 'LOBBY_BIRTHDAY_CLOSED' || code === 'LOBBY_CLAIM_CLOSED' || code === 'LOBBY_NOT_FOUND' ? { final: true as const } : {}) };
  }
}

const entryIdOf = (input: unknown): string | null => (isRecord(input) && typeof input.entryId === 'string' && UUID.test(input.entryId) ? input.entryId.toLowerCase() : null);

/** The live line with each party's lines, JSON-safe. Stamps `pos_seen_at`. */
export async function listLobbyAction(input: { storeId: string }): Promise<LobbyResult<LobbyListView>> {
  return atStore(input, async (tx, actor, storeId) => {
    const r = await listLobby(tx, actor, { storeId });
    return {
      lobbyEnabled: r.lobbyEnabled,
      paused: r.paused,
      entries: r.entries.map((e) => ({
        entryId: e.entryId,
        code: e.code,
        displayName: e.displayName,
        partySize: e.partySize,
        status: e.status === 'called' ? ('called' as const) : ('waiting' as const),
        source: e.source,
        note: e.note,
        phone: e.phone,
        createdAt: e.createdAt.toISOString(),
        calledAt: e.calledAt ? e.calledAt.toISOString() : null,
        lines: e.lines.map((l) => ({ lineKind: l.lineKind, qty: l.qty, variantId: l.variantId, optionValueIds: l.optionValueIds, label: l.label, posItemKey: l.posItemKey })),
      })),
    };
  }, true);
}

/** The cashier parks a walk-in on the line. The domain trims and bounds the name, party size, phone and note. */
export async function parkWalkInAction(input: { storeId: string; displayName: string; partySize: number; phone?: string | null; note?: string | null }): Promise<LobbyResult<{ code: string }>> {
  return atStore(input, async (tx, actor, storeId) => {
    const r = await parkWalkIn(tx, actor, { storeId, displayName: input.displayName, partySize: input.partySize, phone: input.phone ?? null, note: input.note ?? null });
    return { code: r.code };
  });
}

export async function callEntryAction(input: { storeId: string; entryId: string }): Promise<LobbyResult> {
  const entryId = entryIdOf(input);
  if (!entryId) return { ok: false, error: BAD_ENTRY };
  return atStore(input, async (tx, actor, storeId) => {
    await callEntry(tx, actor, entryId, { onlyStoreId: storeId });
    return {};
  });
}

export async function removeEntryAction(input: { storeId: string; entryId: string }): Promise<LobbyResult> {
  const entryId = entryIdOf(input);
  if (!entryId) return { ok: false, error: BAD_ENTRY };
  return atStore(input, async (tx, actor, storeId) => {
    await removeEntry(tx, actor, entryId, { onlyStoreId: storeId });
    return {};
  });
}

/**
 * T-644 S2 - record that a party sits at a table the cashier has just opened (`stand.opened` is already in the outbox). `joinUrl` is always null: the ERP has no join-link
 * source, so the diner's phone shows the counter message. The body names no store: it is the pairing's (`needsPairing`), and `onlyStoreId` makes another store's entry
 * answer like a ghost id. The stand label is bounded by the domain after the store check.
 */
export async function seatLobbyEntryAction(input: { entryId: string; sessionId: string; standLabel: string }): Promise<LobbyResult<{ entryId: string }>> {
  const entryId = entryIdOf(input);
  const sessionId = isRecord(input) && typeof input.sessionId === 'string' && UUID.test(input.sessionId) ? input.sessionId.toLowerCase() : null;
  if (!entryId || !sessionId) return { ok: false, error: BAD_ENTRY };
  const standLabel = typeof input.standLabel === 'string' ? input.standLabel : '';
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const r = await seatEntry(tx, actor, { entryId, sessionId, standLabel, joinUrl: null }, { onlyStoreId: storeId });
      return { entryId: r.entryId };
    },
    true,
  );
}

export async function setLobbyPausedAction(input: { storeId: string; paused: boolean }): Promise<LobbyResult<{ paused: boolean }>> {
  if (!isRecord(input) || typeof input.paused !== 'boolean') return { ok: false, error: 'Choose pause or resume.' };
  const paused = input.paused;
  return atStore(input, (tx, actor, storeId) => setLobbyPaused(tx, actor, { storeId, paused }));
}

/**
 * T-644 S3 - the birthday-song requests, as Server Actions (docs/tasks/644-lobby-in-erp-pos.md, S3). Each call is the T-455 staff twin (`listBirthdayRequests`, `acceptBirthday`,
 * `declineBirthday`, `markBirthdayPlayed`), which authorizes `record_sale` and owns every state refusal. Online only, and only from the store's PAIRED tablet: none of them names
 * a store in the body (it is the pairing's, `needsPairing`), and accept / decline / played pass it as `onlyStoreId`, so another store's request id answers like a ghost id.
 * The time and the decline reason are bounded by the domain AFTER the store check; the reason must also be one of the three fixed ones (no free text from this screen).
 */
const requestIdOf = (input: unknown): string | null => (isRecord(input) && typeof input.requestId === 'string' && UUID.test(input.requestId) ? input.requestId.toLowerCase() : null);

/** The store's open requests, oldest first. Times are ISO text. Never a phone, a hash or a hand-off link. */
export async function listBirthdaysAction(): Promise<LobbyResult<{ birthdays: BirthdayView[] }>> {
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const rows = await listBirthdayRequests(tx, actor, storeId);
      return {
        birthdays: rows.map((r) => ({
          requestId: r.requestId,
          code: r.code,
          displayName: r.displayName,
          standLabel: r.standLabel,
          celebrantName: r.celebrantName,
          status: r.status,
          scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
    true,
  );
}

/** requested -> accepted at a time ("Now" is the current time). A time that is not a strict ISO timestamp reaches the domain as an invalid date and is refused there. */
export async function acceptBirthdayAction(input: { requestId: string; scheduledAt: string }): Promise<LobbyResult<{ scheduledAt: string }>> {
  const requestId = requestIdOf(input);
  if (!requestId) return { ok: false, error: BAD_BIRTHDAY };
  const raw = isRecord(input) ? input.scheduledAt : undefined;
  // No time stays absent (the domain asks for one); a bad one becomes an invalid Date. Either way the domain judges it after the store check.
  const scheduledAt = (raw === undefined || raw === null ? undefined : (strictIso(raw) ?? new Date(Number.NaN))) as Date;
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const r = await acceptBirthday(tx, actor, { requestId, scheduledAt }, { onlyStoreId: storeId });
      return { scheduledAt: r.scheduledAt.toISOString() };
    },
    true,
  );
}

/** requested -> declined with one of the three fixed reasons; anything else is refused before the database is touched. */
export async function declineBirthdayAction(input: { requestId: string; reason: string }): Promise<LobbyResult> {
  const requestId = requestIdOf(input);
  if (!requestId) return { ok: false, error: BAD_BIRTHDAY };
  const reason = isRecord(input) && typeof input.reason === 'string' ? input.reason : '';
  return atStore(
    {},
    async (tx, actor, storeId) => {
      // Access first: a person who may not act here must not learn which reasons are allowed.
      await authorize(tx, actor, 'record_sale', { storeId });
      if (!BIRTHDAY_DECLINE_PRESETS.includes(reason)) throw refuse('birthday decline reason is not a preset', BAD_BIRTHDAY_REASON);
      await declineBirthday(tx, actor, { requestId, reason }, { onlyStoreId: storeId });
      return {};
    },
    true,
  );
}

/** accepted -> played: the tablet started the song. Not time-gated here (S6a ruling 7); the tablet's scheduler owns the clock. */
export async function markBirthdayPlayedAction(input: { requestId: string }): Promise<LobbyResult> {
  const requestId = requestIdOf(input);
  if (!requestId) return { ok: false, error: BAD_BIRTHDAY };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      await markBirthdayPlayed(tx, actor, requestId, { onlyStoreId: storeId });
      return {};
    },
    true,
  );
}

/**
 * T-644 S4 - the senior / PWD discount claims, as Server Actions (docs/tasks/644-lobby-in-erp-pos.md, S4 and ruling 6). Each call is the T-455 staff twin (`listClaimRequests`, `openClaim`,
 * `approveClaim`, `rejectClaim`, `claimStatus`, `approvedClaimsForSession`), which authorizes `record_sale` and owns every state refusal. Online only, and only from the store's PAIRED tablet: none of
 * them names a store in the body (it is the pairing's, `needsPairing`), and every claim id passes it as `onlyStoreId`, so another store's claim answers like a ghost id.
 * ⛔ Personal data: `listClaimsAction` projects named fields only (a masked ID, never a name or a number); `openClaimAction` is the ONE call that returns a name and an ID number, and the dialog keeps them in
 * its own memory. Approving never applies a discount: it records the claim against the table (`statutoryDinerRef` = `${sessionId}:${dinerNo}`) and the cashier still adds the discount at payment.
 * Field rules (diner number, session, reject reason) are judged AFTER `authorize`, so a person who may not act here learns nothing about them.
 */
const claimIdOf = (input: unknown): string | null => (isRecord(input) && typeof input.claimId === 'string' && UUID.test(input.claimId) ? input.claimId.toLowerCase() : null);

/** The store's pending claims on live and seated parties, oldest first. A masked ID only. */
export async function listClaimsAction(): Promise<LobbyResult<{ claims: ClaimView[] }>> {
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const rows = await listClaimRequests(tx, actor, storeId);
      return {
        claims: rows.map((r) => ({
          claimId: r.claimId,
          entryId: r.entryId,
          code: r.code,
          displayName: r.displayName,
          standLabel: r.standLabel,
          partySize: r.partySize,
          kind: r.kind,
          idMasked: r.idMasked,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
    true,
  );
}

/** "Open claim": the name and ID number, for the cashier to compare with the card. One audit row each time. */
export async function openClaimAction(input: { claimId: string }): Promise<LobbyResult<{ claim: OpenedClaimView }>> {
  const claimId = claimIdOf(input);
  if (!claimId) return { ok: false, error: BAD_CLAIM };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const r = await openClaim(tx, actor, claimId, { onlyStoreId: storeId });
      return { claim: { claimId: r.claimId, kind: r.kind, holderName: r.holderName, idNumber: r.idNumber, code: r.code, standLabel: r.standLabel, partySize: r.partySize, sessionRef: r.sessionRef } };
    },
    true,
  );
}

/** One claim's status and nothing else: the cashier's check after an answer was lost. */
export async function claimStatusAction(input: { claimId: string }): Promise<LobbyResult<{ status: string }>> {
  const claimId = claimIdOf(input);
  if (!claimId) return { ok: false, error: BAD_CLAIM };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const r = await claimStatus(tx, actor, claimId, { onlyStoreId: storeId });
      return { status: r.status };
    },
    true,
  );
}

/**
 * pending -> approved for the diner number the cashier picked at the party's seated table. The reference the domain stores is `${sessionId}:${dinerNo}` (ruling 6); the domain checks the party is
 * seated on that very session, the card tick, and that no other claim of the party holds the same diner.
 */
export async function approveClaimAction(input: { claimId: string; sessionId: string; dinerNo: number; cardSeen: boolean }): Promise<LobbyResult> {
  const claimId = claimIdOf(input);
  if (!claimId) return { ok: false, error: BAD_CLAIM };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      // Access first: a person who may not act here must not learn what a good session or diner number looks like.
      await authorize(tx, actor, 'record_sale', { storeId });
      const sessionId = typeof input.sessionId === 'string' && UUID.test(input.sessionId) ? input.sessionId.toLowerCase() : null;
      const dinerNo = input.dinerNo;
      if (sessionId === null || typeof dinerNo !== 'number' || !Number.isInteger(dinerNo) || dinerNo < 1 || dinerNo > DINER_NO_MAX) throw refuse('claim session or diner number is not valid', BAD_CLAIM_DINER);
      await approveClaim(tx, actor, { claimId, cardSeen: input.cardSeen === true, sessionRef: sessionId, statutoryDinerRef: dinerRefOf(sessionId, dinerNo) }, { onlyStoreId: storeId });
      return {};
    },
    true,
  );
}

/** pending -> rejected with one of the four fixed reasons (sent by code). Free text, in any key, is refused: nothing typed by hand reaches the database. */
export async function rejectClaimAction(input: { claimId: string; reasonCode: string }): Promise<LobbyResult> {
  const claimId = claimIdOf(input);
  if (!claimId) return { ok: false, error: BAD_CLAIM };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      await authorize(tx, actor, 'record_sale', { storeId });
      const reason = !CLAIM_FREE_TEXT_KEYS.some((k) => k in input) ? claimRejectText(input.reasonCode) : null;
      if (reason === null) throw refuse('claim reject reason is not a preset', BAD_CLAIM_REASON);
      await rejectClaim(tx, actor, { claimId, reason }, { onlyStoreId: storeId });
      return {};
    },
    true,
  );
}

/**
 * The paying screen of one table asks: which senior / PWD claims were approved for this session? Only the kind, the card's last 4 and the diner number come back (the database keeps no
 * name or ID number after approval). The cashier still picks and confirms the discount; this read changes nothing.
 */
export async function approvedClaimsForSessionAction(input: { sessionId: string }): Promise<LobbyResult<{ claims: ApprovedClaimView[] }>> {
  const sessionId = isRecord(input) && typeof input.sessionId === 'string' && UUID.test(input.sessionId) ? input.sessionId.toLowerCase() : null;
  if (sessionId === null) return { ok: false, error: BAD_CLAIM };
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const rows = await approvedClaimsForSession(tx, actor, { storeId, sessionId });
      return {
        claims: rows.flatMap((r) => {
          const dinerNo = dinerNoOfRef(sessionId, r.statutoryDinerRef);
          return dinerNo === null ? [] : [{ kind: r.kind, idLast4: r.idLast4, dinerNo }];
        }),
      };
    },
    true,
  );
}
