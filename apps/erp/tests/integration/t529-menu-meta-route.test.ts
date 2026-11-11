import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-529 ruling 1 - GET /api/pos/menu-meta: the stations and each package's refills, for a kitchen browser or a phone (no snapshot).
 * Needs a person session and ANY ONE of serve_pos_ticket, request_pos_refill, confirm_pos_heads at the store; the store is effectiveStore; ETag and 304.
 * Real Postgres on a scratch "_test" database. Only the session, next/cache and next/navigation are replaced.
 */
const HOLD = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string }, token: null as string | null }));
vi.mock('../../src/lib/session', () => {
  const resolved = () => (HOLD.actor ? { actor: HOLD.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') } : null);
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

import { closeAll, fixture, makeServer0240 } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { GET } from '../../src/app/api/pos/menu-meta/route';

afterAll(closeAll);
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

const get = (storeId: string, headers: Record<string, string> = {}) => GET(new Request(`http://localhost:9008/api/pos/menu-meta?storeId=${storeId}`, { headers }));

describe('GET /api/pos/menu-meta', () => {
  it('a Server gets the stations (name, SLA, print flag) and the refills of each package, with an ETag; the same ETag back is a 304', async () => {
    const f = await fixture();
    HOLD.actor = await makeServer0240(f);
    const res = await get(f.storeId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stations: { id: string; name: string; slaMinutes: number; printOnOutage: boolean }[]; refillCatalog: Record<string, { itemId: string; name: string }[]> };
    expect(body.ok).toBe(true);
    expect(body.stations.map((s) => s.id)).toContain(f.grill);
    for (const s of body.stations) expect(Object.keys(s).sort()).toEqual(['id', 'name', 'printOnOutage', 'slaMinutes']);
    expect(body.refillCatalog[f.menu.unli.variantId]!.map((m) => m.itemId)).toContain(f.menu.refillRice.itemId);
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await get(f.storeId, { 'if-none-match': etag! });
    expect(again.status).toBe(304);
  });

  it('a kitchen person (serve_pos_ticket only) is allowed too', async () => {
    const f = await fixture();
    HOLD.actor = f.kitchen;
    expect((await get(f.storeId)).status).toBe(200);
  });

  it('a Cashier on everyday access (none of the three words) is 403', async () => {
    const f = await fixture();
    HOLD.actor = f.counter;
    expect((await get(f.storeId)).status).toBe(403);
  });

  it('another store is 403: a store-B manager asking for store A', async () => {
    const f = await fixture();
    HOLD.actor = f.managerOther;
    expect((await get(f.storeId)).status).toBe(403);
  });

  it('on a paired tablet a different storeId is 403 with the one sentence', async () => {
    const f = await fixture();
    HOLD.actor = f.admin;
    HOLD.token = f.pairingToken;
    const res = await get(f.store2Id);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('This tablet works at one store only.');
  });

  it('no session is 401, and a missing or malformed store is 400', async () => {
    const f = await fixture();
    expect((await get(f.storeId)).status).toBe(401);
    HOLD.actor = f.kitchen;
    expect((await get('not-an-id')).status).toBe(400);
  });
});
