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
