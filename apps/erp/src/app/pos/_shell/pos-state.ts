/**
 * T-526 R3 - usePosState as a pure reducer plus an injected `fetch` (the hook in `use-pos-state.ts` only schedules it).
 * Two failures in a row flip to Offline; a 304 keeps the body as it was; a hidden tab makes no request.
 */
export interface PosStateBody {
  stateVersion: number;
  openStands: unknown[] | null;
  kitchenQueue: unknown[] | null;
  refillQueue: unknown[] | null;
  /** T-529: the open package tables (the refill picker and heads list); null for a person who holds neither request_pos_refill nor confirm_pos_heads. */
  refillTables?: unknown[] | null;
}
export interface PosState {
  body: PosStateBody | null;
  failures: number;
  online: boolean;
  /** Clock time (ms) of the FIRST failed poll of the current streak: "No internet since HH:MM". Absent while the last poll got an answer. */
  failingSinceMs?: number;
  /** 401: the server answered, so we are online, but the session ended. Set only while true. */
  signedOut?: true;
  /** 403: the server answered and the person no longer holds this store. The last body is kept. Set only while true. */
  forbidden?: true;
  /** Any other 4xx: the server answered (so online, state kept) but refused the request. The code, for the shell's banner. */
  httpError?: number;
}
export type PosStateEvent =
  | { type: 'ok'; body: PosStateBody }
  | { type: 'not_modified' }
  | { type: 'failure'; atMs?: number }
  | { type: 'unauthorized' }
  | { type: 'forbidden' }
  | { type: 'http_error'; status: number };

export const initialPosState: PosState = { body: null, failures: 0, online: true };

/** Failures in a row before the pill says Offline (about 6 s at the 3 s poll). A protocol rhythm, not a setting. */
const OFFLINE_AFTER_FAILURES = 2;

export function reducePosState(state: PosState, event: PosStateEvent): PosState {
  if (event.type === 'ok') return { body: event.body, failures: 0, online: true };
  if (event.type === 'not_modified') return { body: state.body, failures: 0, online: true };
  // 401 and 403 are answers from the server: reachable, so never "offline" and the failure streak resets.
  if (event.type === 'unauthorized') return { body: state.body, failures: 0, online: true, signedOut: true };
  if (event.type === 'forbidden') return { body: state.body, failures: 0, online: true, forbidden: true };
  if (event.type === 'http_error') return { body: state.body, failures: 0, online: true, httpError: event.status };
  const failures = state.failures + 1;
  const since = state.failingSinceMs ?? event.atMs;
  return { body: state.body, failures, online: failures < OFFLINE_AFTER_FAILURES, ...(since === undefined ? {} : { failingSinceMs: since }) };
}

export async function pollPosState(
  deps: { fetch: typeof fetch; storeId: string; visibilityState: () => 'visible' | 'hidden'; nowMs?: () => number },
  state: PosState,
): Promise<PosState> {
  if (deps.visibilityState() === 'hidden') return state;
  const since = state.body?.stateVersion ?? -1;
  const failure = (): PosState => reducePosState(state, { type: 'failure', atMs: (deps.nowMs ?? Date.now)() });
  try {
    const res = await deps.fetch(`/api/pos/state?since=${since}&storeId=${encodeURIComponent(deps.storeId)}`, { credentials: 'same-origin' });
    if (res.status === 304) return reducePosState(state, { type: 'not_modified' });
    if (res.status === 401) return reducePosState(state, { type: 'unauthorized' });
    if (res.status === 403) return reducePosState(state, { type: 'forbidden' });
    // Only a network failure or a 5xx means the server is not usable; any other 4xx is an answer, so the state is kept and the shell says so.
    if (res.status >= 400 && res.status < 500) return reducePosState(state, { type: 'http_error', status: res.status });
    if (!res.ok) return failure();
    return reducePosState(state, { type: 'ok', body: (await res.json()) as PosStateBody });
  } catch {
    return failure();
  }
}
