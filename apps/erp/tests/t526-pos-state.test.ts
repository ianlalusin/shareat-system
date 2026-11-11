// ASSUMED API (T-530a): none imported here (types only: PosEvent, SendOutcome come from the T-530a contract; no runtime import is mocked).
// ASSUMED API: apps/erp/src/app/pos/_shell/pos-state.ts exports (pure, no React)
//   initialPosState: { body: PosStateBody | null; failures: number; online: boolean }   -> { body: null, failures: 0, online: true }
//   reducePosState(state, event: { type: 'ok'; body } | { type: 'not_modified' } | { type: 'failure' }): PosState
//   pollPosState({ fetch, storeId, visibilityState }, state): Promise<PosState>
//     visibilityState: () => 'visible' | 'hidden'. Hidden returns the SAME state object and never calls fetch.
//     GET `/api/pos/state?since=<body.stateVersion, or -1 with no body>&storeId=<id>` with credentials 'same-origin'.
// ASSUMED API: apps/erp/src/app/pos/_shell/status-pill.ts exports statusPillLabel({ online, sending, pending, offlineForMs }): string
// ASSUMED API: apps/erp/src/app/pos/_shell/tabs.ts exports visibleTabs(held: ReadonlySet<string>): { key; label; href }[], tabCount(key, body): number | null
// ASSUMED API: apps/erp/src/app/pos/_shell/drain-send.ts exports makePosSend(fetch): (events) => Promise<SendOutcome>
//   (POST /api/pos/events, JSON { events }, credentials 'same-origin'; 200 -> ok, other status -> http, a throw -> network)
/**
 * T-526 R3 / R6 - usePosState as a pure reducer plus an injected fetch, the status pill sentences, which tabs a person sees, and the drain's network mapper.
 * Written BEFORE the code (tester lane).
 */
import { describe, expect, it, vi } from 'vitest';
import { initialPosState, pollPosState, reducePosState } from '@/app/pos/_shell/pos-state';
import { statusPillLabel } from '@/app/pos/_shell/status-pill';
import { tabCount, visibleTabs } from '@/app/pos/_shell/tabs';
import { makePosSend } from '@/app/pos/_shell/drain-send';

const body7 = { ok: true, stateVersion: 7, openStands: [{ id: 'a' }], kitchenQueue: [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }], refillQueue: [{ id: 'r1' }] };
const STORE = '11111111-1111-4111-8111-111111111111';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const asFetch = (f: unknown) => f as unknown as typeof fetch;

describe('T-526 R3 - the usePosState reducer', () => {
  it('starts online with no body and no failures', () => {
    expect(initialPosState).toEqual({ body: null, failures: 0, online: true });
  });

  it('a 200 replaces the body and keeps/returns the state online with 0 failures', () => {
    const s = reducePosState(initialPosState, { type: 'ok', body: body7 });
    expect(s).toEqual({ body: body7, failures: 0, online: true });
  });

  it('a 304 changes nothing about the body (same reference) and counts as reachable', () => {
    const had = reducePosState(initialPosState, { type: 'ok', body: body7 });
    const s = reducePosState(had, { type: 'not_modified' });
    expect(s.body).toBe(had.body);
    expect(s).toMatchObject({ failures: 0, online: true });
  });

  it('one failure is still online (failures 1); two in a row flip to offline; the body is kept', () => {
    const had = reducePosState(initialPosState, { type: 'ok', body: body7 });
    const one = reducePosState(had, { type: 'failure' });
    expect(one).toMatchObject({ failures: 1, online: true });
    const two = reducePosState(one, { type: 'failure' });
    expect(two).toMatchObject({ failures: 2, online: false });
    expect(two.body).toBe(had.body);
  });

  it('recovery: a success after offline puts the pill back online and zeroes the count; a success between failures resets the streak', () => {
    let s = reducePosState(reducePosState(initialPosState, { type: 'failure' }), { type: 'failure' });
    expect(s.online).toBe(false);
    s = reducePosState(s, { type: 'ok', body: body7 });
    expect(s).toMatchObject({ failures: 0, online: true });
    s = reducePosState(reducePosState(s, { type: 'failure' }), { type: 'not_modified' });
    expect(s).toMatchObject({ failures: 0, online: true });
    expect(reducePosState(s, { type: 'failure' }).online).toBe(true);
  });
});

describe('T-526 R3 - pollPosState (injected fetch)', () => {
  it('a hidden tab makes NO request and returns the same state object', async () => {
    const f = vi.fn();
    const state = reducePosState(initialPosState, { type: 'ok', body: body7 });
    const out = await pollPosState({ fetch: asFetch(f), storeId: STORE, visibilityState: () => 'hidden' }, state);
    expect(f).not.toHaveBeenCalled();
    expect(out).toBe(state);
  });

  it('a visible tab polls /api/pos/state with since and storeId and the same-origin cookie; a 200 stores the body', async () => {
    const f = vi.fn(async () => json(body7));
    const out = await pollPosState({ fetch: asFetch(f), storeId: STORE, visibilityState: () => 'visible' }, initialPosState);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url, 'http://x.test');
    expect(u.pathname).toBe('/api/pos/state');
    expect(u.searchParams.get('storeId')).toBe(STORE);
    expect(u.searchParams.get('since')).toBe('-1');
    expect(init.credentials).toBe('same-origin');
    expect(out.body).toEqual(body7);
    expect(out).toMatchObject({ failures: 0, online: true });
  });

  it('the next poll asks since=<the stateVersion it holds>', async () => {
    const f = vi.fn(async () => new Response(null, { status: 304 }));
    const state = reducePosState(initialPosState, { type: 'ok', body: body7 });
    await pollPosState({ fetch: asFetch(f), storeId: STORE, visibilityState: () => 'visible' }, state);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(new URL(url, 'http://x.test').searchParams.get('since')).toBe('7');
  });

  it('a 304 keeps the state as it was (same body reference), online, no failures', async () => {
    const state = reducePosState(initialPosState, { type: 'ok', body: body7 });
    const out = await pollPosState({ fetch: asFetch(async () => new Response(null, { status: 304 })), storeId: STORE, visibilityState: () => 'visible' }, state);
    expect(out.body).toBe(state.body);
    expect(out).toMatchObject({ failures: 0, online: true });
  });

  it('two network failures in a row flip to offline; the first leaves it online; the last good body stays', async () => {
    const boom = asFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const deps = { fetch: boom, storeId: STORE, visibilityState: () => 'visible' as const };
    const start = reducePosState(initialPosState, { type: 'ok', body: body7 });
    const one = await pollPosState(deps, start);
    expect(one).toMatchObject({ failures: 1, online: true });
    const two = await pollPosState(deps, one);
    expect(two).toMatchObject({ failures: 2, online: false });
    expect(two.body).toBe(start.body);
  });
});

describe('T-526 R3 - the status pill sentences', () => {
  it('Online', () => {
    expect(statusPillLabel({ online: true, sending: false, pending: 0, offlineForMs: 0 })).toBe('Online');
  });
  it('Offline 1h 12m · 14 waiting to send (the orders-offline.png band)', () => {
    expect(statusPillLabel({ online: false, sending: false, pending: 14, offlineForMs: 72 * 60_000 })).toBe('Offline 1h 12m · 14 waiting to send');
  });
  it('Sending… while a drain runs (with the ellipsis character)', () => {
    expect(statusPillLabel({ online: true, sending: true, pending: 3, offlineForMs: 0 })).toBe('Sending…');
  });
});

describe('T-526 R1/R3 - which tabs a person sees', () => {
  const labels = (held: string[]) => visibleTabs(new Set(held)).map((t) => t.label);
  const hrefs = (held: string[]) => visibleTabs(new Set(held)).map((t) => t.href);

  it('all three capabilities: Orders, Kitchen, Refills, Receipts, Till in that order, with their routes', () => {
    const all = ['record_sale', 'serve_pos_ticket', 'request_pos_refill'];
    expect(labels(all)).toEqual(['Orders', 'Kitchen', 'Refills', 'Receipts', 'Till']);
    expect(hrefs(all)).toEqual(['/pos', '/pos/kitchen', '/pos/refills', '/pos/receipts', '/pos/till']);
  });
  it('record_sale alone: Orders, Receipts, Till (never Kitchen or Refills)', () => {
    expect(labels(['record_sale'])).toEqual(['Orders', 'Receipts', 'Till']);
  });
  it('serve_pos_ticket alone: Kitchen only', () => {
    expect(labels(['serve_pos_ticket'])).toEqual(['Kitchen']);
  });
  it('request_pos_refill alone: Refills only', () => {
    expect(labels(['request_pos_refill'])).toEqual(['Refills']);
  });
  it('no POS capability: no tabs; an unrelated capability changes nothing', () => {
    expect(labels([])).toEqual([]);
    expect(labels(['view_financial_reports'])).toEqual([]);
  });
  it('Kitchen and Refills show their live counts from the state body; a list the person may not read, or no body yet, shows no count', () => {
    expect(tabCount('kitchen', body7)).toBe(3);
    expect(tabCount('refills', body7)).toBe(1);
    expect(tabCount('kitchen', { ...body7, kitchenQueue: null })).toBeNull();
    expect(tabCount('refills', null)).toBeNull();
  });
});

describe('T-526 R3 - the drain network mapper (makePosSend)', () => {
  const events = [{ seq: 1, kind: 'stand.opened', personId: 'p', occurredAtDevice: '2026-11-07T01:00:00.000Z', payload: {} }] as never;

  it('POSTs { events } as JSON to /api/pos/events with the same-origin cookie', async () => {
    const f = vi.fn(async () => json({ ok: true, stateVersion: 9, results: [{ seq: 1, status: 'applied' }] }));
    await makePosSend(asFetch(f))(events);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pos/events');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('content-type')).toMatch(/^application\/json/);
    expect(JSON.parse(String(init.body))).toEqual({ events });
  });

  it('a 200 maps to ok with the server stateVersion and results', async () => {
    const results = [{ seq: 1, status: 'applied' }];
    expect(await makePosSend(asFetch(async () => json({ ok: true, stateVersion: 9, results })))(events)).toEqual({ kind: 'ok', stateVersion: 9, results });
  });

  it('401, 409, 413 and 503 map to http with the status (and nothing else)', async () => {
    for (const status of [401, 409, 413, 503]) {
      expect(await makePosSend(asFetch(async () => json({ ok: false, error: 'x' }, status)))(events), String(status)).toEqual({ kind: 'http', status });
    }
  });

  it('a thrown fetch maps to network', async () => {
    const out = await makePosSend(
      asFetch(async () => {
        throw new TypeError('Failed to fetch');
      }),
    )(events);
    expect(out).toEqual({ kind: 'network' });
  });
});
