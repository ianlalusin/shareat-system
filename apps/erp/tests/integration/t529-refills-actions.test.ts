import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-529 (TESTER) - R2 / R4 integration: the Refills Server Actions (`apps/erp/src/app/pos/refills/actions.ts`) and the store tablet's `refill.requested` through the REAL
 * POST /api/pos/events, with REAL Postgres and the REAL T-524 functions. Only the session, `next/cache` and `next/navigation` are replaced. Any scratch "_test" database.
 * docs/tasks/529-pos-kitchen-refills.md R2, R4.
 *
 * ASSUMED API ('use server', apps/erp/src/app/pos/refills/actions.ts; results, never a throw for a refusal):
 *   requestRefillAction(input: { storeId: string; sessionId: string; lines: { lineId: string; menuItemId: string; qty: number }[] }): Promise<{ ok: true; wrote: boolean } | { ok: false; error: string }>
 *     authorizes request_pos_refill, calls T-524 `requestRefill` with pairingId null and addedAtDevice = now on every line. `error` = errorMessage(err), the domain's sentence.
 *   confirmHeadsAction(input: { storeId: string; sessionId: string; headsServer: number }): Promise<same>      authorizes confirm_pos_heads, T-524 `confirmHeads`, pairingId null.
 *   Both: on a PAIRED tablet the pairing's store wins and a different storeId is { ok: false, error: 'This tablet works at one store only.' }.
 * ASSUMED API (apps/erp/src/app/pos/_refills/payloads.ts, as documented in tests/t529-refills-logic.test.ts): refillEvent({ personId, sessionId, cart, now, newId }).
 * The "Served" button on a refill row reuses kitchen/actions.ts `serveLineAction` (tests/integration/t529-kitchen-actions.test.ts).
 *
 * RED NOW FOR THE RIGHT REASON: the modules do not exist (lazy import: "MISSING MODULE ... not built"), after each fixture ran.
 */
const HOLD = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string }, token: null as string | null }));
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: HOLD.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));

import { addLines, listKitchenQueue, listRefillQueue, openStand, requestRefill } from '../../../../packages/domain/src/pos';
import { errorMessage } from '../../src/lib/constraint-messages';
import { asOrg, auditRows, closeAll, ev, fixture, linesAddedPayload, makeServer0240, newStand, nowIso, pinSession, sql, standOpenedPayload, stateVersionOf, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

async function load(path: string, label: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`MISSING MODULE: ${label} cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
async function act(name: 'requestRefillAction' | 'confirmHeadsAction', as: { orgId: string; personId: string }, input: unknown, token: string | null = null) {
  const m = await load('../../src/app/pos/refills/actions', 'apps/erp/src/app/pos/refills/actions.ts');
  if (typeof m[name] !== 'function') throw new Error(`MISSING EXPORT: refills/actions.ts does not export ${name} (T-529 not built).`);
  HOLD.actor = as;
  HOLD.token = token;
  return m[name](input);
}
async function serve(as: { orgId: string; personId: string }, input: unknown) {
  const m = await load('../../src/app/pos/kitchen/actions', 'apps/erp/src/app/pos/kitchen/actions.ts');
  HOLD.actor = as;
  HOLD.token = null;
  return m.serveLineAction(input);
}

/** A dine-in table holding the Unli Grill package for `heads` guests (the refill list comes from that package). */
async function packageTable(f: Fx, heads = 2) {
  const st = await newStand(f);
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: heads, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: heads, addedAtDevice: nowIso() }] });
  });
  return { sessionId, standNumber: st.number };
}
const refillLines = (sessionId: string) =>
  sql<{ id: string; kind: string; name: string; qty: number; unit_price: string; kitchen_station_id: string | null; kitchen_status: string; added_by: string; added_on_pairing_id: string | null }[]>`
    select id, kind, name, qty, unit_price::text, kitchen_station_id, kitchen_status, added_by, added_on_pairing_id from table_session_lines where session_id = ${sessionId} and kind = 'refill' order by id`;
const headsOf = async (sessionId: string) => (await sql<{ heads_server: number | null; heads_cashier: number }[]>`select heads_server, heads_cashier from table_sessions where id = ${sessionId}`)[0]!;
const sentenceOf = (p: Promise<unknown>) => p.then(() => 'DID NOT REFUSE', (e) => errorMessage(e));
const oneSentence = (s: string) => {
  expect(typeof s).toBe('string');
  expect(s.length).toBeGreaterThan(10);
  expect(s, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
};

describe('requestRefillAction (a server\'s phone: no pairing, online only)', () => {
  it('a Server asks for two meats: ok, two price-0 refill lines queued at their station, one audit row, the state version moves', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const v0 = await stateVersionOf(f);
    const a = uuid();
    const res = await act('requestRefillAction', server, { storeId: f.storeId, sessionId: t.sessionId, lines: [{ lineId: a, menuItemId: f.menu.refillRice.itemId, qty: 2 }] });
    expect(res).toEqual({ ok: true, wrote: true });
    const rows = await refillLines(t.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a, kind: 'refill', name: 'Rice refill', qty: 2, kitchen_station_id: f.grill, kitchen_status: 'queued', added_by: server.personId, added_on_pairing_id: null });
    expect(Number(rows[0]!.unit_price)).toBe(0);
    expect(await auditRows(f, 'pos.refill_requested')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBeGreaterThan(v0);
  });

  it('the same request sent twice (a double tap, a resend) is ok the second time with wrote false and ONE line', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const input = { storeId: f.storeId, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1 }] };
    expect(await act('requestRefillAction', server, input)).toEqual({ ok: true, wrote: true });
    expect(await act('requestRefillAction', server, input)).toEqual({ ok: true, wrote: false });
    expect(await refillLines(t.sessionId)).toHaveLength(1);
    expect(await auditRows(f, 'pos.refill_requested')).toHaveLength(1);
  });

  it('a refill that is not in the table\'s package is refused with the domain\'s sentence, and nothing is written', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const res = await act('requestRefillAction', server, { storeId: f.storeId, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.pork.itemId, qty: 1 }] });
    expect(res).toEqual({ ok: false, error: "Pork belly is not a refill of this table's package." });
    expect(await refillLines(t.sessionId)).toHaveLength(0);
  });

  it('a Cashier on everyday access only (no request_pos_refill) is REFUSED with the domain\'s sentence, nothing written', async () => {
    const f = await fixture();
    const t = await packageTable(f);
    const line = { lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1 };
    const sentence = await sentenceOf(asOrg(f.orgId, (tx) => requestRefill(tx, f.counter, { storeId: f.storeId, pairingId: null, sessionId: t.sessionId, lines: [{ ...line, lineId: uuid(), addedAtDevice: nowIso() }] })));
    expect(sentence).not.toBe('DID NOT REFUSE');
    expect(await act('requestRefillAction', f.counter, { storeId: f.storeId, sessionId: t.sessionId, lines: [line] })).toEqual({ ok: false, error: sentence });
    expect(await refillLines(t.sessionId)).toHaveLength(0);
  });

  it('another store is REFUSED: a Server naming store B, and a store-B manager naming store A', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const line = { lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1 };
    const a = await act('requestRefillAction', server, { storeId: f.store2Id, sessionId: t.sessionId, lines: [line] });
    expect(a.ok).toBe(false);
    oneSentence(a.error);
    const b = await act('requestRefillAction', f.managerOther, { storeId: f.storeId, sessionId: t.sessionId, lines: [line] });
    expect(b.ok).toBe(false);
    oneSentence(b.error);
    expect(await refillLines(t.sessionId)).toHaveLength(0);
  });

  it('on a PAIRED tablet a different storeId is refused with the one sentence', async () => {
    const f = await fixture();
    const t = await packageTable(f);
    const res = await act('requestRefillAction', f.admin, { storeId: f.store2Id, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1 }] }, f.pairingToken);
    expect(res).toEqual({ ok: false, error: 'This tablet works at one store only.' });
    expect(await refillLines(t.sessionId)).toHaveLength(0);
  });

  it('a quantity of 0 is the domain\'s sentence', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f);
    const res = await act('requestRefillAction', server, { storeId: f.storeId, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 0 }] });
    expect(res).toEqual({ ok: false, error: 'The quantity must be a whole number from 1 to 999.' });
  });
});

describe('confirmHeadsAction (a server\'s phone, row 447)', () => {
  it('a Server confirms the head count: ok, the server count is saved, one heads audit row', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f, 2);
    const res = await act('confirmHeadsAction', server, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 3 });
    expect(res).toEqual({ ok: true, wrote: true });
    expect(await headsOf(t.sessionId)).toEqual({ heads_server: 3, heads_cashier: 2 });
    expect(await auditRows(f, 'pos.heads_changed')).toHaveLength(1);
  });

  it('confirming the same number again is ok with wrote false (a double tap)', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f, 2);
    expect(await act('confirmHeadsAction', server, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 4 })).toEqual({ ok: true, wrote: true });
    expect(await act('confirmHeadsAction', server, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 4 })).toEqual({ ok: true, wrote: false });
    expect(await auditRows(f, 'pos.heads_changed')).toHaveLength(1);
  });

  it('a Cashier on everyday access only (no confirm_pos_heads, 0240 defaults) is REFUSED with the domain\'s sentence; heads unchanged', async () => {
    const f = await fixture();
    const t = await packageTable(f, 2);
    const sentence = await sentenceOf(asOrg(f.orgId, (tx) => import('../../../../packages/domain/src/pos').then((m) => m.confirmHeads(tx, f.counter, { storeId: f.storeId, pairingId: null, sessionId: t.sessionId, headsServer: 3 }))));
    expect(sentence).not.toBe('DID NOT REFUSE');
    expect(await act('confirmHeadsAction', f.counter, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 3 })).toEqual({ ok: false, error: sentence });
    expect(await headsOf(t.sessionId)).toEqual({ heads_server: null, heads_cashier: 2 });
  });

  it('another store is REFUSED, heads unchanged', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f, 2);
    const a = await act('confirmHeadsAction', server, { storeId: f.store2Id, sessionId: t.sessionId, headsServer: 3 });
    expect(a.ok).toBe(false);
    oneSentence(a.error);
    const b = await act('confirmHeadsAction', f.managerOther, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 3 });
    expect(b.ok).toBe(false);
    expect(await headsOf(t.sessionId)).toEqual({ heads_server: null, heads_cashier: 2 });
  });

  it('on a PAIRED tablet a different storeId is refused with the one sentence', async () => {
    const f = await fixture();
    const t = await packageTable(f, 2);
    expect(await act('confirmHeadsAction', f.admin, { storeId: f.store2Id, sessionId: t.sessionId, headsServer: 3 }, f.pairingToken)).toEqual({ ok: false, error: 'This tablet works at one store only.' });
  });

  it('0 guests is the domain\'s sentence', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await packageTable(f, 2);
    expect(await act('confirmHeadsAction', server, { storeId: f.storeId, sessionId: t.sessionId, headsServer: 0 })).toEqual({ ok: false, error: 'The number of guests must be a whole number from 1 to 200.' });
  });
});

describe('a refill from the store tablet through the REAL /api/pos/events', () => {
  it('lands in listRefillQueue and the kitchen queue; serving it removes it from both', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    await pinSession(f, f.kitchenId);
    const { refillEvent } = await load('../../src/app/pos/_refills/payloads', 'apps/erp/src/app/pos/_refills/payloads.ts');
    const events = await load('../../src/app/api/pos/events/route', 'apps/erp/src/app/api/pos/events/route.ts');
    const stand = await newStand(f);
    const sessionId = uuid();
    const pkgLine = uuid();
    await new Promise((r) => setTimeout(r, 25)); // the menu rows take the database's microsecond now(); an event stamped in the same millisecond reads as BEFORE them
    const refill = refillEvent({ personId: f.kitchenId, sessionId, cart: [{ itemId: f.menu.refillRice.itemId, qty: 2 }], now: new Date(), newId: uuid });
    expect(refill.kind).toBe('refill.requested');
    const batch = [
      ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, stand.id, 2), lines: linesAddedPayload(sessionId, [{ lineId: pkgLine, item: f.menu.unli, qty: 2 }]).lines }),
      { seq: 2, ...refill },
    ];
    HOLD.token = f.pairingToken;
    const res: Response = await events.POST(
      new Request('http://localhost:9008/api/pos/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }) }),
    );
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { results: { seq: number; status: string; error?: string }[] }).results;
    expect(results.map((r) => [r.seq, r.status])).toEqual([[1, 'applied'], [2, 'applied']]);

    const queue = await asOrg(f.orgId, (tx) => listRefillQueue(tx, f.kitchen, { storeId: f.storeId }));
    expect(queue.tickets).toHaveLength(1);
    expect(queue.tickets[0]).toMatchObject({ sessionId, standNumber: stand.number, sessionMode: 'dine_in', kind: 'refill', name: 'Rice refill', qty: 2, stationId: f.grill });
    const kitchen = await asOrg(f.orgId, (tx) => listKitchenQueue(tx, f.kitchen, { storeId: f.storeId }));
    expect(kitchen.tickets.map((t) => t.lineId)).toContain(queue.tickets[0]!.lineId);

    expect(await serve(f.kitchen, { storeId: f.storeId, lineId: queue.tickets[0]!.lineId })).toEqual({ ok: true, wrote: true });
    expect((await asOrg(f.orgId, (tx) => listRefillQueue(tx, f.kitchen, { storeId: f.storeId }))).tickets).toEqual([]);
    expect((await asOrg(f.orgId, (tx) => listKitchenQueue(tx, f.kitchen, { storeId: f.storeId }))).tickets.map((t) => t.lineId)).not.toContain(queue.tickets[0]!.lineId);
  });

  it('a tablet refill for a meat that is not in the table\'s package is not applied and never queued (the server re-checks)', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    await pinSession(f, f.kitchenId);
    const { refillEvent } = await load('../../src/app/pos/_refills/payloads', 'apps/erp/src/app/pos/_refills/payloads.ts');
    const events = await load('../../src/app/api/pos/events/route', 'apps/erp/src/app/api/pos/events/route.ts');
    const stand = await newStand(f);
    const sessionId = uuid();
    await new Promise((r) => setTimeout(r, 25));
    // A dish is not a refill of the package: the device built it, the server must still refuse it.
    const refill = refillEvent({ personId: f.kitchenId, sessionId, cart: [{ itemId: f.menu.pork.itemId, qty: 1 }], now: new Date(), newId: uuid });
    const batch = [
      ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, stand.id, 2), lines: linesAddedPayload(sessionId, [{ lineId: uuid(), item: f.menu.unli, qty: 2 }]).lines }),
      { seq: 2, ...refill },
    ];
    HOLD.token = f.pairingToken;
    const res: Response = await events.POST(new Request('http://localhost:9008/api/pos/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }) }));
    const results = ((await res.json()) as { results: { seq: number; status: string }[] }).results;
    expect(results[0]!.status).toBe('applied');
    expect(results[1]!.status).not.toBe('applied');
    expect((await asOrg(f.orgId, (tx) => listRefillQueue(tx, f.kitchen, { storeId: f.storeId }))).tickets).toEqual([]);
  });
});
