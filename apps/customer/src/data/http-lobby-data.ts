/**
 * T-455 S3 - the client side of the lobby: the ONLY file that talks to /api/lobby (the skeleton guard allows `fetch(` only in src/data/http-*).
 * The diner is identified by an HttpOnly cookie the server sets; this layer never sees it, never sends a code or an entry id, and never
 * keeps the hand-off link past the screen that shows it. `base` is '' on the web (same origin); the APK passes the server origin.
 */
import type { LobbyData, LobbyStoreView } from './lobby-data';

export type LobbyStatus = 'waiting' | 'called' | 'seated' | 'cancelled' | 'removed' | 'expired';

export interface LobbyCheckInLine {
  variantId: string;
  qty: number;
  lineKind: 'package' | 'a_la_carte';
  optionValueIds?: string[];
}

export interface LobbyCheckInInput {
  storeCode: string;
  displayName: string;
  partySize: number;
  note?: string | null;
  /** A fresh uuid per check-in attempt (kept across retries of the SAME attempt so a replay returns the same place). */
  clientRequestId: string;
  lines?: LobbyCheckInLine[];
}

export interface LobbyEntrySummary {
  entryId: string;
  code: string;
  status: LobbyStatus;
  partiesAhead: number;
}

export interface LobbyMyEntry extends LobbyEntrySummary {
  displayName: string | null;
  partySize: number;
  standLabel: string | null;
  /** Returned once by the server; show it, do not store it. */
  handoffUrl: string | null;
}

/** `error` is always one plain sentence meant for the diner. `status` is the HTTP status (0 when the phone could not reach the server). */
export type LobbyResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const OFFLINE = 'We could not reach the restaurant. Check your connection and try again.';

async function call<T>(base: string, path: string, init: RequestInit, pick: (body: Record<string, unknown>) => T): Promise<LobbyResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, credentials: 'include', cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, error: OFFLINE };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (res.ok && body && body.ok === true) return { ok: true, value: pick(body) };
  const error = body && typeof body.error === 'string' ? body.error : 'Please check in at the counter.';
  return { ok: false, status: res.status, error };
}

export function lobbyCheckIn(input: LobbyCheckInInput, base = ''): Promise<LobbyResult<LobbyEntrySummary & { created: boolean }>> {
  return call(
    base,
    '/api/lobby/check-in',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    (b) => ({ ...(b.entry as LobbyEntrySummary), created: b.created === true }),
  );
}

export function lobbyMyEntry(storeCode: string, base = ''): Promise<LobbyResult<LobbyMyEntry>> {
  return call(base, `/api/lobby/me?s=${encodeURIComponent(storeCode)}`, { method: 'GET' }, (b) => b.entry as LobbyMyEntry);
}

export function lobbyCancel(storeCode: string, base = ''): Promise<LobbyResult<{ entryId: string; status: 'cancelled' }>> {
  return call(
    base,
    '/api/lobby/cancel',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storeCode }) },
    (b) => b.entry as { entryId: string; status: 'cancelled' },
  );
}

/** T-455 S4: the store's public line status. A closed store answers 200 with accepting:false; that and any `error` both mean "not joinable". */
function lobbyStore(storeCode: string, base = ''): Promise<LobbyResult<LobbyStoreView>> {
  return call(base, `/api/lobby/store?s=${encodeURIComponent(storeCode)}`, { method: 'GET' }, (b) => {
    const s = (b.store ?? {}) as { storeName?: unknown; partiesWaiting?: unknown; accepting?: unknown };
    const open = s.accepting === true && typeof b.error !== 'string';
    return {
      storeCode,
      storeName: typeof s.storeName === 'string' ? s.storeName : '',
      partiesWaiting: typeof s.partiesWaiting === 'number' ? s.partiesWaiting : 0,
      accepting: open,
    };
  });
}

/** The LobbyData the screens use against the real server. `base` is '' on the web; the APK passes the server origin. */
export function createHttpLobbyData(base = ''): LobbyData {
  return {
    getStore: (storeCode) => lobbyStore(storeCode, base),
    checkIn: (input) => lobbyCheckIn(input, base),
    myEntry: (storeCode) => lobbyMyEntry(storeCode, base),
    cancel: (storeCode) => lobbyCancel(storeCode, base),
  };
}
