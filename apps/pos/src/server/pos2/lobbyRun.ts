import 'server-only';
/**
 * T-455 S5/S6b - the shared runner of every /api/pos2/lobby/* route: `authenticate()`, a uuid `deviceId` resolving to this store's ACTIVE
 * terminal link (else 403), then the move. `LobbyRefusal` -> 409 with its one sentence; anything else -> plain 500 (log carries the error NAME only).
 */
import { fail, isUuid, UNEXPECTED_ERROR } from './http';
import { authenticate } from './identity';
import type { LobbyTablet, Pos2Deps } from './types';

const LOBBY_NOT_REGISTERED = 'This tablet is not registered for the lobby.';

export interface Ctx {
  tablet: LobbyTablet;
  body: Record<string, unknown>;
  lobby: Pos2Deps['lobby'];
}

export async function run(req: Request, deps: Pos2Deps, move: (c: Ctx) => Promise<Response>): Promise<Response> {
  try {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const deviceId = caller.body.deviceId;
    if (!isUuid(deviceId)) return fail(403, LOBBY_NOT_REGISTERED);
    const link = await deps.lobby.resolveTablet({ posStoreId: caller.storeId, deviceId });
    if (!link) return fail(403, LOBBY_NOT_REGISTERED);
    const tablet: LobbyTablet = { erpStoreId: link.erpStoreId, terminalPersonId: link.terminalPersonId, cashierName: caller.name };
    return await move({ tablet, body: caller.body, lobby: deps.lobby });
  } catch (err) {
    const e = err as { name?: unknown; userMessage?: unknown } | null;
    if (e && e.name === 'LobbyRefusal' && typeof e.userMessage === 'string') return fail(409, e.userMessage);
    console.error('[pos2] lobby error', err instanceof Error ? err.name : 'non-error thrown');
    return fail(500, UNEXPECTED_ERROR);
  }
}
