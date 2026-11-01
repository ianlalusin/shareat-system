import 'server-only';
/**
 * T-455 S6b - POST /api/pos2/lobby/birthday/{list,accept,decline,play}. Same trust chain as the S5 lobby routes (`run` in ./lobby):
 * token + staff assignment, uuid deviceId, the tablet's ACTIVE terminal link. docs/tasks/455-customer-lobby.md "S6a rulings" 6, 7 and "S6b rulings".
 */
import { fail, isUuid, jsonResponse } from './http';
import { run } from './lobbyRun';
import type { Pos2Deps } from './types';

const BAD_REQUEST = 'Choose a birthday request from the list.';
const BAD_TIME = 'Choose a time for the birthday song.';
const BAD_REASON = 'Choose a reason to decline.';
const REASON_MAX = 80;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** A strict ISO 8601 timestamp: the pattern, a real date, and (for the Z form) the same instant when written back. */
function strictIso(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !ISO.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (raw.endsWith('Z') && d.toISOString().slice(0, 19) !== raw.slice(0, 19)) return null;
  return d;
}

const requestIdOf = (b: Record<string, unknown>): string | null => (isUuid(b.requestId) ? b.requestId : null);

export const handleLobbyBirthdayList = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => jsonResponse(200, { ok: true, ...(await c.lobby.birthdayList(c.tablet)) }));

export const handleLobbyBirthdayAccept = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const requestId = requestIdOf(c.body);
    if (!requestId) return fail(400, BAD_REQUEST);
    const scheduledAt = strictIso(c.body.scheduledAt);
    if (!scheduledAt) return fail(400, BAD_TIME);
    return jsonResponse(200, { ok: true, ...(await c.lobby.birthdayAccept(c.tablet, { requestId, scheduledAt })) });
  });

export const handleLobbyBirthdayDecline = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const requestId = requestIdOf(c.body);
    if (!requestId) return fail(400, BAD_REQUEST);
    const reason = typeof c.body.reason === 'string' ? c.body.reason.trim() : '';
    if (reason === '' || reason.length > REASON_MAX) return fail(400, BAD_REASON);
    return jsonResponse(200, { ok: true, ...(await c.lobby.birthdayDecline(c.tablet, { requestId, reason })) });
  });

export const handleLobbyBirthdayPlay = (req: Request, deps: Pos2Deps): Promise<Response> =>
  run(req, deps, async (c) => {
    const requestId = requestIdOf(c.body);
    if (!requestId) return fail(400, BAD_REQUEST);
    return jsonResponse(200, { ok: true, ...(await c.lobby.birthdayPlay(c.tablet, { requestId })) });
  });
