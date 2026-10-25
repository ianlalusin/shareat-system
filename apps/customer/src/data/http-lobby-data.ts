/**
 * T-455 S3 - the client side of the lobby: the ONLY file that talks to /api/lobby (the skeleton guard allows `fetch(` only in src/data/http-*).
 * The diner is identified by an HttpOnly cookie the server sets; this layer never sees it, never sends a code or an entry id, and never
 * keeps the hand-off link past the screen that shows it. `base` is '' on the web (same origin); the APK passes the server origin.
 */

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
