import { createFixtureLobbyData } from './fixture-lobby-data';
import { createHttpLobbyData } from './http-lobby-data';
import type { LobbyData } from './lobby-data';

/**
 * T-455 S4 - which LobbyData the lobby screens use: the real server by default; NEXT_PUBLIC_LOBBY_DEMO=1 swaps in (never in a production build) the in-memory fixture
 * (a phone-sized walk-through with no server). NEXT_PUBLIC_LOBBY_BASE is the server origin for the APK; '' on the web.
 */
let cached: LobbyData | null = null;

export function getLobbyData(): LobbyData {
  if (!cached) {
    cached = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_LOBBY_DEMO === '1' ? createFixtureLobbyData() : createHttpLobbyData(process.env.NEXT_PUBLIC_LOBBY_BASE ?? '');
  }
  return cached;
}
