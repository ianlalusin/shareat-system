/**
 * T-424 slice T - caller identity, missing credentials, CORS and the base-URL shim.
 * Acceptance 2 (every route refuses: no token 401, unassigned store 403, inactive 403, a body `role` is ignored),
 * Acceptance 3 (missing credentials -> 503 with the plain sentence), Ruling 1 (CORS, second API base), Acceptance 10 (non-uuid deviceId = 400).
 * The module contract (paths, names, shapes) is in the header of `@/test-helpers/pos2`.
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/*` and `@/app/api/pos2/*` do not exist yet, so every case fails on "Failed to resolve import".
 * MUTANTS: M1 trust body.role; M2 skip the assignedStoreIds check; M3 skip status === 'active'; M4 approve before identity;
 *          M5 crash instead of 503; M6 CORS allows any origin; M7 skip the uuid check (500 from the DB layer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, OTHER_STORE, PIN_OK, STORE, createFakeFirestore, json, makeDeps, post, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

type Handler = (req: Request, deps: any) => Promise<Response>;
const ROUTES: { name: string; path: string; load: () => Promise<Handler>; route: () => Promise<{ POST: (req: Request) => Promise<Response> }>; body: Record<string, unknown> }[] = [
  {
    name: 'refunds', path: 'refunds', route: () => import('@/app/api/pos2/refunds/route'), load: async () => (await import('@/server/pos2/refunds')).handleRefund,
    body: { storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'wrong order', terminalNo: 1, terminalSeq: 2, receiptNumber: 'SHT-01-000002', pin: PIN_OK, deviceId: DEVICE },
  },
  {
    name: 'tender-corrections', path: 'tender-corrections', route: () => import('@/app/api/pos2/tender-corrections/route'), load: async () => (await import('@/server/pos2/tender-corrections')).handleTenderCorrection,
    body: { storeId: STORE, receiptId: 'r1', fromMethod: 'Cash', toMethod: 'GCash', amount: 10000, reference: 'R-1', reason: 'wrong tender', pin: PIN_OK, requestId: '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6', deviceId: DEVICE },
  },
  {
    name: 'session-voids', path: 'session-voids', route: () => import('@/app/api/pos2/session-voids/route'), load: async () => (await import('@/server/pos2/session-voids')).handleSessionVoid,
    body: { storeId: STORE, sessionId: 'sess1', reason: 'walk-out', pin: PIN_OK, deviceId: DEVICE },
  },
  {
    name: 'analytics/apply-delta', path: 'analytics/apply-delta', route: () => import('@/app/api/pos2/analytics/apply-delta/route'), load: async () => (await import('@/server/pos2/apply-delta')).handleApplyDelta,
    body: { storeId: STORE, receiptId: 'r1', op: 'payment' },
  },
];

let fs: FakeFirestore;
beforeEach(() => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
});
afterEach(() => vi.unstubAllEnvs());

describe.each(ROUTES)('Acceptance 2 - $name refuses an unproven caller', (route) => {
  const run = async (body: unknown, token: string | null) => {
    const { deps, calls } = makeDeps(fs);
    const handler = await route.load();
    const res = await handler(post(route.path, body, token), deps);
    return { res, calls, body: await json(res) };
  };
  const untouched = (calls: { approve: unknown[] }) => {
    expect(fs.commits, 'nothing was written').toHaveLength(0);
    expect(calls.approve, 'the approval port is not reached before identity passes (M4)').toHaveLength(0);
  };

  it('no token: 401 (M1)', async () => {
    const r = await run(route.body, null);
    expect(r.res.status).toBe(401);
    expect(r.body.ok).toBe(false);
    untouched(r.calls);
  });

  it('a token the Admin SDK rejects: 401', async () => {
    const r = await run(route.body, 'garbage');
    expect(r.res.status).toBe(401);
    untouched(r.calls);
  });

  it('a valid token with no staff doc: 403', async () => {
    const r = await run(route.body, 'tok-nobody');
    expect(r.res.status).toBe(403);
    untouched(r.calls);
  });

  it("a staff doc not assigned to the request's store: 403 (M2)", async () => {
    const r = await run(route.body, 'tok-elsewhere');
    expect(r.res.status).toBe(403);
    untouched(r.calls);
  });

  it('an inactive staff doc: 403 (M3)', async () => {
    const r = await run(route.body, 'tok-inactive');
    expect(r.res.status).toBe(403);
    untouched(r.calls);
  });

  it("a body `role: 'admin'` from a cashier token changes nothing: still no write, no success (M1)", async () => {
    const { pin: _pin, ...noPin } = route.body as Record<string, unknown>;
    const r = await run({ ...noPin, role: 'admin', staffRole: 'admin', uid: 'admin' }, 'tok-cashier');
    if (route.name === 'analytics/apply-delta') {
      // no PIN on this route; the receipt does not exist, so the cashier gets a not-found - never a role upgrade
      expect(r.res.status).not.toBe(200);
    } else {
      expect(r.res.status, 'a cashier without a PIN is refused whatever the body claims').toBeGreaterThanOrEqual(400);
      expect(r.res.status).toBeLessThan(500);
      expect(r.body.ok).toBe(false);
    }
    expect(fs.commits).toHaveLength(0);
  });

  it('a body that is not JSON: 400, nothing written', async () => {
    const { deps, calls } = makeDeps(fs);
    const handler = await route.load();
    const res = await handler(post(route.path, '{not json', 'tok-cashier'), deps);
    expect(res.status).toBe(400);
    expect(fs.commits).toHaveLength(0);
    expect(calls.approve).toHaveLength(0);
  });

  it('a body without storeId: 400', async () => {
    const { storeId: _s, ...rest } = route.body as Record<string, unknown>;
    const r = await run(rest, 'tok-cashier');
    expect(r.res.status).toBe(400);
    untouched(r.calls);
  });

  it.runIf(route.name !== 'analytics/apply-delta')('a deviceId that is not a uuid is a 400, not a 500, and the approval port is never called (M7)', async () => {
    const r = await run({ ...route.body, deviceId: 'not-a-uuid' }, 'tok-manager');
    expect(r.res.status).toBe(400);
    expect(r.body.error).toMatch(/device/i);
    untouched(r.calls);
  });
});

describe('Acceptance 3 - missing credentials answer 503 with the plain sentence', () => {
  it('getPos2Deps with no env: ok:false, 503, "POS server is not configured" (M5)', async () => {
    const { getPos2Deps, POS2_NOT_CONFIGURED } = await import('@/server/pos2/deps');
    expect(POS2_NOT_CONFIGURED).toBe('POS server is not configured');
    for (const env of [{}, { POS_FIREBASE_SA_KEY_FILE: 'x.json' }, { DATABASE_URL: 'postgres://x' }, { POS_FIREBASE_SA_KEY_FILE: ' ', DATABASE_URL: ' ' }]) {
      const r = await getPos2Deps(env);
      expect(r.ok, JSON.stringify(env)).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(503);
        expect(r.error).toBe('POS server is not configured');
      }
    }
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))('the %s route handler answers 503, never a crash, when the box is not configured', async (_n, r) => {
    vi.stubEnv('POS_FIREBASE_SA_KEY_FILE', '');
    vi.stubEnv('DATABASE_URL', '');
    const mod = await r.route();
    const res = await mod.POST(post(r.path, { storeId: STORE }, 'tok-cashier'));
    expect(res.status).toBe(503);
    const b = await json(res);
    expect(b).toMatchObject({ ok: false, error: 'POS server is not configured' });
  });
});

describe('Ruling 1 - CORS for the APK origin only', () => {
  it("exports config.matcher '/api/:path*' and a middleware function", async () => {
    const mod = await import('@/middleware');
    expect(mod.config.matcher).toBe('/api/:path*');
    expect(typeof mod.middleware).toBe('function');
  });

  it('an OPTIONS preflight from https://localhost is allowed; any other origin gets no CORS header (M6)', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('@/middleware');
    const ask = (origin: string) =>
      middleware(new NextRequest('http://pos2.test/api/pos2/refunds', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } }));
    const ok = await ask('https://localhost');
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    const bad = await ask('https://evil.example');
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const star = await ask('*');
    expect(star.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Ruling 1 - the second API base (/api/pos2/ goes to the POS server, everything else keeps v1)', () => {
  const seen: string[] = [];
  beforeEach(() => {
    seen.length = 0;
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_API_BASE', 'https://app.shareat.net');
    vi.stubEnv('NEXT_PUBLIC_POS2_API_BASE', 'https://pos2.example.test');
    const w: any = { fetch: async (u: any) => { seen.push(String(u)); return new Response('{}'); }, location: { origin: 'https://localhost' } };
    vi.stubGlobal('window', w);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('/api/pos2/refunds -> POS2 base; /api/loyalty/x -> app base', async () => {
    const { installApiBaseFetch } = await import('@/lib/api-base');
    installApiBaseFetch();
    await (globalThis as any).window.fetch('/api/pos2/refunds');
    await (globalThis as any).window.fetch('/api/loyalty/x');
    expect(seen).toEqual(['https://pos2.example.test/api/pos2/refunds', 'https://app.shareat.net/api/loyalty/x']);
  });

  it('the POS2 base defaults to https://pos2.shareat.net', async () => {
    vi.stubEnv('NEXT_PUBLIC_POS2_API_BASE', '');
    vi.resetModules();
    const { installApiBaseFetch } = await import('@/lib/api-base');
    installApiBaseFetch();
    await (globalThis as any).window.fetch('/api/pos2/refunds');
    expect(seen).toEqual(['https://pos2.shareat.net/api/pos2/refunds']);
  });
});

describe('Acceptance 12 (client half) - production builds keep calling v1 apply-delta', () => {
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.resetModules();
    vi.doMock('@/lib/firebase/client', () => ({ auth: { currentUser: { getIdToken: async () => 'tok' } } }));
    vi.stubGlobal('fetch', async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('@/lib/firebase/client'); });

  it.each(['payment', 'void'] as const)("without NEXT_PUBLIC_POS2_ANALYTICS a %s delta goes to v1's /api/analytics/apply-delta", async (op) => {
    vi.stubEnv('NEXT_PUBLIC_POS2_ANALYTICS', '');
    const { applyReceiptDeltaServerFirst } = await import('@/lib/analytics/applyReceiptDeltaServerFirst');
    await applyReceiptDeltaServerFirst(STORE, 'r1', op, async () => {});
    expect(urls).toEqual(['/api/analytics/apply-delta']);
  });

  it.each(['payment', 'void'] as const)('with NEXT_PUBLIC_POS2_ANALYTICS=1 a %s delta goes to /api/pos2/analytics/apply-delta', async (op) => {
    vi.stubEnv('NEXT_PUBLIC_POS2_ANALYTICS', '1');
    const { applyReceiptDeltaServerFirst } = await import('@/lib/analytics/applyReceiptDeltaServerFirst');
    await applyReceiptDeltaServerFirst(STORE, 'r1', op, async () => {});
    expect(urls).toEqual(['/api/pos2/analytics/apply-delta']);
  });
});

void OTHER_STORE;
