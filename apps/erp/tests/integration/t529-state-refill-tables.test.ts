import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-529 ruling 2 - the `refillTables` leg of the state poll, through `readPosState` (the domain) AND GET /api/pos/state (the route):
 * a person who holds NEITHER request_pos_refill nor confirm_pos_heads (a kitchen-only person) gets null, a Server and a confirm_pos_heads-only holder get the
 * list (one row per table, with every package variant), and another store is refused. Real Postgres on a scratch "_test" database.
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

import { addLines, openStand, readPosState } from '../../../../packages/domain/src/pos';
import { actorOf, asOrg, closeAll, fixture, makeServer0240, makeStaff, newStand, nowIso, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { GET } from '../../src/app/api/pos/state/route';

afterAll(closeAll);
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

async function packageTable(f: Fx) {
  const stand = await newStand(f);
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso() }] });
  });
  return { sessionId, standNumber: stand.number };
}
const viaRoute = async (f: Fx, who: { orgId: string; personId: string }, storeId = f.storeId) => {
  HOLD.actor = who;
  const res = await GET(new Request(`http://localhost:9008/api/pos/state?since=-1&storeId=${storeId}`));
  return { status: res.status, body: (await res.json()) as { refillTables?: unknown[] | null; kitchenQueue?: unknown[] | null } };
};
const row = (t: { sessionId: string; standNumber: number }, f: Fx) => ({
  sessionId: t.sessionId, standNumber: t.standNumber, packageVariantId: f.menu.unli.variantId, packageVariantIds: [f.menu.unli.variantId], headsCashier: 2, headsServer: null,
});

describe('refillTables in the state poll', () => {
  it('a Server (request_pos_refill + confirm_pos_heads) gets the list, in the domain and on the route', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const answer = await readPosState(server, { storeId: f.storeId, since: -1 });
    expect(answer.status).toBe('ok');
    if (answer.status === 'ok') expect(answer.body.refillTables).toEqual([row(t, f)]);
    const r = await viaRoute(f, server);
    expect(r.status).toBe(200);
    expect(r.body.refillTables).toEqual([row(t, f)]);
  });

  it('a holder of confirm_pos_heads ONLY gets the list too (a phone that may confirm heads needs the tables)', async () => {
    const f = await fixture();
    const heads = actorOf(f.orgId, await makeStaff(f, 'Hank Heads', ['confirm_pos_heads']));
    const t = await packageTable(f);
    const r = await viaRoute(f, heads);
    expect(r.status).toBe(200);
    expect(r.body.refillTables).toEqual([row(t, f)]);
  });

  it('a kitchen-only person (serve_pos_ticket, neither of the two words) gets null, not a refusal, and still gets the kitchen queue', async () => {
    const f = await fixture();
    const kitchenOnly = actorOf(f.orgId, await makeStaff(f, 'Kay Kitchen', ['serve_pos_ticket']));
    await packageTable(f);
    const answer = await readPosState(kitchenOnly, { storeId: f.storeId, since: -1 });
    expect(answer.status).toBe('ok');
    if (answer.status === 'ok') {
      expect(answer.body.refillTables).toBeNull();
      expect(answer.body.kitchenQueue).not.toBeNull();
    }
    const r = await viaRoute(f, kitchenOnly);
    expect(r.status).toBe(200);
    expect(r.body.refillTables).toBeNull();
    expect(r.body.kitchenQueue).not.toBeNull();
  });

  it('a cashier on everyday access gets null', async () => {
    const f = await fixture();
    await packageTable(f);
    expect((await viaRoute(f, f.counter)).body.refillTables).toBeNull();
  });

  it('another store is refused: forbidden in the domain, 403 on the route, and never a list', async () => {
    const f = await fixture();
    await packageTable(f);
    expect(await readPosState(f.managerOther, { storeId: f.storeId, since: -1 })).toEqual({ status: 'forbidden' });
    const r = await viaRoute(f, f.managerOther);
    expect(r.status).toBe(403);
    expect(r.body.refillTables).toBeUndefined();
  });
});
