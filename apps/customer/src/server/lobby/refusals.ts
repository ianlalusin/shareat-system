import 'server-only';
import { LobbyRefusal, type LobbyRefusalCode } from '@shareat/domain';
/**
 * T-455 S3 - the ONE table that knows a refusal code. A diner reads the refusal's own `userMessage` and the status below; the machine code
 * never reaches a body. Every limit, switch and the code lottery share 409 so the status does not name which one stopped the diner.
 */
const STATUS: Record<LobbyRefusalCode, number> = {
  LOBBY_BAD_INPUT: 400,
  LOBBY_IP_LIMIT: 409,
  LOBBY_FULL: 409,
  LOBBY_PAUSED: 409,
  LOBBY_DISABLED: 409,
  LOBBY_POS_STALE: 409,
  LOBBY_NO_CODE: 409,
  LOBBY_NOT_FOUND: 404,
  LOBBY_ENTRY_CLOSED: 409,
  LOBBY_SEAT_NEEDS_SESSION: 409,
};

export function refusalReply(err: unknown): { status: number; error: string } | null {
  if (!(err instanceof LobbyRefusal)) return null;
  return { status: STATUS[err.code] ?? 409, error: err.userMessage };
}
