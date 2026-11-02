import 'server-only';
/**
 * T-455 S5 - POST /api/pos2/lobby/{list,park,call,seat,remove,pause}. docs/tasks/455-customer-lobby.md "S5 rulings" 1, 3, 4, 5, 7.
 *
 * Every route runs `authenticate()` (Firebase token, `staff/{uid}` active and assigned to the body's POS `storeId`), then needs a uuid
 * `deviceId` that resolves to this store's ACTIVE terminal link; otherwise 403. The ERP store, the terminal person and the cashier's name
 * come from the link and from `staff/{uid}` - never from the body. A `LobbyRefusal` is a 409 with its one plain sentence; anything else is
 * a plain 500 whose log line carries the error NAME only (an error message could hold a diner's name or phone).
 */
import { fail, isNonBlank, isUuid, jsonResponse } from './http';
import { rejectReasonText } from '@/lib/pos2/lobbyClaims';
import { run } from './lobbyRun';
import type { Pos2Deps } from './types';

const DEFAULT_JOIN_ORIGIN = 'https://customer.shareat.net';

/**
 * The hand-off link is shown on a diner's phone, so only the customer join page is kept: https, the allowed origin
 * (POS_LOBBY_JOIN_ORIGIN, default the customer app), path exactly /join, and a non-empty 't' query value. Anything else is dropped (null), not an error.
 */
function allowedJoinUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const allowed = new URL((process.env.POS_LOBBY_JOIN_ORIGIN ?? '').trim() || DEFAULT_JOIN_ORIGIN);
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || allowed.protocol !== 'https:') return null;
    if (u.origin !== allowed.origin || u.username !== '' || u.password !== '') return null;
    if (u.pathname !== '/join' || (u.searchParams.get('t') ?? '') === '') return null;
    return raw.trim();
  } catch {
    return null;
  }
}

const BAD_ENTRY = 'Choose a party from the list.';
const entryIdOf = (b: Record<string, unknown>): string | null => (isUuid(b.entryId) ? b.entryId : null);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export const handleLobbyList = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const r = await c.lobby.list(c.tablet);
    return jsonResponse(200, { ok: true, ...r });
  });

export const handleLobbyPark = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const b = c.body;
    if (!isNonBlank(b.displayName) || typeof b.partySize !== 'number') return fail(400, 'Enter the name and the number of guests.');
    const r = await c.lobby.park(c.tablet, { displayName: b.displayName.trim(), partySize: b.partySize, phone: textOrNull(b.phone), note: textOrNull(b.note) });
    return jsonResponse(200, { ok: true, ...r });
  });

export const handleLobbyCall = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const entryId = entryIdOf(c.body);
    if (!entryId) return fail(400, BAD_ENTRY);
    return jsonResponse(200, { ok: true, ...(await c.lobby.call(c.tablet, { entryId })) });
  });

export const handleLobbyRemove = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const entryId = entryIdOf(c.body);
    if (!entryId) return fail(400, BAD_ENTRY);
    return jsonResponse(200, { ok: true, ...(await c.lobby.remove(c.tablet, { entryId })) });
  });

export const handleLobbySeat = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const b = c.body;
    const entryId = entryIdOf(b);
    if (!entryId) return fail(400, BAD_ENTRY);
    if (!isNonBlank(b.sessionId) || !isNonBlank(b.standLabel)) return fail(400, 'Start the table session first, then pick the stand and seat the party.');
    const joinUrl = allowedJoinUrl(b.joinUrl);
    return jsonResponse(200, { ok: true, ...(await c.lobby.seat(c.tablet, { entryId, sessionId: b.sessionId.trim(), standLabel: b.standLabel.trim(), joinUrl })) });
  });

export const handleLobbyPause = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    if (typeof c.body.paused !== 'boolean') return fail(400, 'Choose pause or resume.');
    return jsonResponse(200, { ok: true, ...(await c.lobby.pause(c.tablet, { paused: c.body.paused })) });
  });

// ---- T-455 S7b: senior / PWD discount claims ------------------------------------------------------------------------------------

const BAD_CLAIM = 'Choose a claim from the list.';
const claimIdOf = (b: Record<string, unknown>): string | null => (isUuid(b.claimId) ? b.claimId : null);
const pick = (src: unknown, keys: readonly string[]): Record<string, unknown> => {
  const o = (src ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
};
/** The list answers only these fields: a port that leaked a name or an ID number would not reach the tablet's list. */
const CLAIM_LIST_FIELDS = ['claimId', 'entryId', 'code', 'displayName', 'standLabel', 'partySize', 'kind', 'idMasked', 'ocrAssisted', 'status', 'createdAt'] as const;
const CLAIM_OPEN_FIELDS = ['claimId', 'entryId', 'code', 'kind', 'holderName', 'idNumber', 'idLast4', 'ocrAssisted', 'partySize', 'standLabel', 'sessionRef'] as const;

export const handleLobbyClaims = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const r = await c.lobby.claims(c.tablet);
    return jsonResponse(200, { ok: true, claims: r.claims.map((row) => pick(row, CLAIM_LIST_FIELDS)) });
  });

// jsonResponse is `no-store`: this answer carries a name and an ID number.
export const handleLobbyClaimOpen = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const claimId = claimIdOf(c.body);
    if (!claimId) return fail(400, BAD_CLAIM);
    return jsonResponse(200, { ok: true, ...pick(await c.lobby.claimOpen(c.tablet, { claimId }), CLAIM_OPEN_FIELDS) });
  });

export const handleLobbyClaimStatus = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const claimId = claimIdOf(c.body);
    if (!claimId) return fail(400, BAD_CLAIM);
    return jsonResponse(200, { ok: true, ...pick(await c.lobby.claimStatus(c.tablet, { claimId }), ['status']) });
  });

export const handleLobbyClaimApprove = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const b = c.body;
    const claimId = claimIdOf(b);
    if (!claimId) return fail(400, BAD_CLAIM);
    if (b.cardSeen !== true) return fail(400, 'Tick the box once you have seen the card.');
    if (!isNonBlank(b.sessionId) || !isNonBlank(b.statutoryDinerId) || b.statutoryDinerId.trim().length > 80) {
      return fail(400, 'Seat the party and save the diner on the bill first.');
    }
    const r = await c.lobby.claimApprove(c.tablet, { claimId, cardSeen: true, sessionRef: b.sessionId.trim(), statutoryDinerRef: b.statutoryDinerId.trim() });
    return jsonResponse(200, { ok: true, ...r });
  });

export const handleLobbyClaimReject = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const b = c.body;
    const claimId = claimIdOf(b);
    if (!claimId) return fail(400, BAD_CLAIM);
    // Free text is refused, not ignored, so a client bug is visible (S7b ruling 4). The diner only ever reads the sentence for a code.
    if (['reason', 'note', 'text', 'message'].some((k) => k in b)) return fail(400, 'Choose one of the reasons.');
    const reason = rejectReasonText(b.reasonCode);
    if (reason === null) return fail(400, 'Choose one of the reasons.');
    return jsonResponse(200, { ok: true, ...(await c.lobby.claimReject(c.tablet, { claimId, reason })) });
  });
