/**
 * T-425 slice T - reachability (Ruling 4, ✎R). Acceptance 10 (captive portal, two-failure flip). DEF-017.
 *
 * CONTRACT for the builder (S3) - file `apps/pos/src/hooks/useConnectivity.ts` ("use client"; the pure store and the probe have NO React and NO
 * `navigator.onLine`; only the hook is React). Exports exactly:
 *   HEALTH_PATH = '/api/pos2/health'   PROBE_TIMEOUT_MS = 4000   ONLINE_INTERVAL_MS = 30_000   OFFLINE_INTERVAL_MS = 10_000   FAILURES_TO_OFFLINE = 2
 *   probeHealth(fetchFn: typeof fetch, apiBase: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; version?: string }>
 *        GET `${apiBase}/api/pos2/health` (no credentials needed) with an AbortController limit. ok === true ONLY when the HTTP status is 2xx AND the
 *        body parses as JSON whose `ok` is exactly boolean true (an HTML 200 from a captive portal, `{"ok":"true"}`, `{"ok":false}`, a 5xx, a
 *        network error and a timeout are all ok:false). It never throws. `version` is the body's `version` string when present.
 *   interface ConnectivityState { online: boolean; consecutiveFailures: number; lastCheckedMs: number | null; version: string | null }
 *   createConnectivityStore(d: { fetch: typeof fetch; apiBase?: string /* default '' *\/ }): {
 *        getState(): ConnectivityState; subscribe(listener: () => void): () => void;
 *        probe(): Promise<void>      - one probe now; success -> online:true, failures 0; a failure -> failures + 1, and online:false once failures >= 2
 *        start(): void               - probe at once, then every ONLINE_INTERVAL_MS while online / OFFLINE_INTERVAL_MS while offline (setTimeout chain)
 *        stop(): void                - clears the timer; no further fetch
 *        reportNetworkError(): void  - an /api call just failed with a network error: probe immediately (does not wait for the interval) }
 *      Initial state: online true (optimistic), failures 0, lastCheckedMs null. Listeners fire only when `online`, `version` or the failure count changes.
 *   getConnectivityStore(): the app singleton (real fetch, NEXT_PUBLIC_POS2_API_BASE)       useConnectivity(): ConnectivityState   (React hook over the singleton)
 * `use-online-status.ts` becomes a thin wrapper `useOnlineStatus() => useConnectivity().online`; OfflineBanner and firestore.ts use the same store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as conn from '@/hooks/useConnectivity';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const html = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, text: async () => '<html>Login to Wi-Fi</html>' }) as unknown as Response;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { onLine: true }); // the browser's flag claims "online" the whole time
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('probeHealth', () => {
  it('calls GET {apiBase}/api/pos2/health and accepts exactly {"ok":true,...}', async () => {
    const f = vi.fn(async () => json({ ok: true, version: '1.2.3' }));
    expect(await conn.probeHealth(f as any, 'https://pos.example.test')).toEqual({ ok: true, version: '1.2.3' });
    expect(String((f.mock.calls[0] as any[])[0])).toBe('https://pos.example.test/api/pos2/health');
    const init = ((f.mock.calls[0] as any[])[1] ?? {}) as RequestInit;
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(conn.HEALTH_PATH).toBe('/api/pos2/health');
  });

  it.each([
    ['an HTML 200 (captive portal)', () => html()],
    ['{"ok":false}', () => json({ ok: false })],
    ['{"ok":"true"} (not the boolean)', () => json({ ok: 'true' })],
    ['a JSON body without ok', () => json({ version: '1' })],
    ['a 500', () => json({ ok: true }, 500)],
    ['a 404', () => json({ ok: true }, 404)],
  ])('is NOT ok for %s', async (_n, make) => {
    expect((await conn.probeHealth((async () => make()) as any, '')).ok).toBe(false);
  });

  it('is not ok (and never throws) on a network error', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(conn.probeHealth(f as any, '')).resolves.toMatchObject({ ok: false });
  });

  it('gives up after 4 seconds: aborts the request and answers not ok', async () => {
    let aborted = false;
    const f = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; rej(new DOMException('aborted', 'AbortError')); });
    }));
    const p = conn.probeHealth(f as any, '');
    await vi.advanceTimersByTimeAsync(3999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(aborted).toBe(true);
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(conn.PROBE_TIMEOUT_MS).toBe(4000);
  });
});

describe('the connectivity store (Acceptance 10)', () => {
  const make = (f: any) => conn.createConnectivityStore({ fetch: f, apiBase: '' });

  it('starts optimistic; navigator.onLine true + an HTML 200 -> offline after TWO probes, not one', async () => {
    const s = make(async () => html());
    expect(s.getState()).toMatchObject({ online: true, consecutiveFailures: 0, lastCheckedMs: null });
    await s.probe();
    expect(s.getState()).toMatchObject({ online: true, consecutiveFailures: 1 });
    await s.probe();
    expect(s.getState()).toMatchObject({ online: false, consecutiveFailures: 2 });
    expect(s.getState().lastCheckedMs).not.toBeNull();
  });

  it('{ok:true} -> online, and ONE success flips an offline tablet back online', async () => {
    let up = false;
    const s = make(async () => (up ? json({ ok: true, version: '9.9.9' }) : html()));
    await s.probe(); await s.probe();
    expect(s.getState().online).toBe(false);
    up = true;
    await s.probe();
    expect(s.getState()).toMatchObject({ online: true, consecutiveFailures: 0, version: '9.9.9' });
  });

  it('failures must be CONSECUTIVE: fail, succeed, fail stays online', async () => {
    const seq = [html(), json({ ok: true }), html()];
    const s = make(async () => seq.shift());
    await s.probe(); await s.probe(); await s.probe();
    expect(s.getState()).toMatchObject({ online: true, consecutiveFailures: 1 });
  });

  it('probes at once on start, then every 30 s while online', async () => {
    const f = vi.fn(async () => json({ ok: true }));
    const s = make(f);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f).toHaveBeenCalledTimes(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(3);
    expect([conn.ONLINE_INTERVAL_MS, conn.OFFLINE_INTERVAL_MS, conn.FAILURES_TO_OFFLINE]).toEqual([30_000, 10_000, 2]);
  });

  it('probes every 10 s while offline', async () => {
    const f = vi.fn(async () => html());
    const s = make(f);
    s.start();
    await vi.advanceTimersByTimeAsync(0);          // failure 1 (still "online"): next probe after 30 s
    await vi.advanceTimersByTimeAsync(30_000);     // failure 2 -> offline
    expect(s.getState().online).toBe(false);
    const n = f.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(f.mock.calls.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.mock.calls.length).toBe(n + 2);
    s.stop();
  });

  it('reportNetworkError probes immediately, without waiting for the interval', async () => {
    const f = vi.fn(async () => json({ ok: true }));
    const s = make(f);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    s.reportNetworkError();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('listeners fire when the state changes and stop firing after unsubscribe', async () => {
    let up = true;
    const s = make(async () => (up ? json({ ok: true }) : html()));
    const l = vi.fn();
    const off = s.subscribe(l);
    await s.probe(); // nothing changed except lastChecked
    const afterFirst = l.mock.calls.length;
    up = false;
    await s.probe(); await s.probe();
    expect(l.mock.calls.length).toBeGreaterThan(afterFirst);
    off();
    const n = l.mock.calls.length;
    up = true;
    await s.probe();
    expect(l.mock.calls.length).toBe(n);
  });
});
