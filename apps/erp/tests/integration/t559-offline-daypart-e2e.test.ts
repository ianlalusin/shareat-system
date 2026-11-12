import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-559 R4 (TESTER) - the integration test: a table worked OFFLINE across 17:00. A line added at 16:59 and another at 17:01 are priced on the tablet
 * (projectOrders -> projectBill -> priceBill, from the cached snapshot menu and no network), then everything is sent through the REAL POST /api/pos/events.
 * The server re-prices each line at its own `addedAtDevice` (T-524 `menus.at(lineTime)`), so the two agree to the centavo and NO
 * `pos.sale_recompute_mismatch` audit row is written. The control proves the test has teeth: the same table priced the OLD way (the cached live price for
 * every line) DOES write a mismatch row. Real Postgres on a scratch "_test" database (any name). docs/tasks/559-pos-offline-daypart-switch.md R4.
 */
const state = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      for (const part of state.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return { name, value: part.slice(i + 1).trim() };
      }
      return undefined;
    },
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - the routes must return their own responses');
  },
}));

import { POS_TABLET_COOKIE } from '@shareat/auth';
import { projectBill, toPriceLines } from '../../src/app/pos/_payment/bill';
import { priceBill, saleCompletedEvent } from '../../src/app/pos/_payment/logic';
import { addLinesEvent, seatEvent, setHeadsEvent, type CartLine } from '../../src/app/pos/_orders/payloads';
import { projectOrders, type SessionBody } from '../../src/app/pos/_orders/project';
import type { NewPosEvent, PosEvent } from '../../src/lib/pos-device';
import { insDaypart, insDaypartOffer, insRule, newItem } from '../../../../packages/db/tests/integration/_fixtures/t401-menu';
import { setHeadsCashier } from '../../../../packages/domain/src/pos';
import { asOrg, auditRows, closeAll, fixture, newStand, pinSession, sql, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const EVENTS = '../../src/app/api/pos/events/route';
const SNAPSHOT = '../../src/app/api/pos/snapshot/route';
const tabletCookie = (f: Fx) => `${POS_TABLET_COOKIE}=${f.pairingToken}`;

async function callRoute(path: string, method: 'GET' | 'POST', cookie: string, body?: unknown, ctx?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ path)) as Record<string, (r: Request, c?: unknown) => Promise<Response>>;
  state.cookie = cookie;
  const req = new Request('http://localhost:9008/api/pos/x', {
    method,
    headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return mod[method]!(req, ctx);
}

/**
 * Store-local (Asia/Manila, UTC+8, no daylight saving) wall clock on the Manila date 36 hours AHEAD: menu offers are never back-dated (they start now), so the
 * lines must be stamped after them, and the whole table sits on one business day.
 */
const MANILA_DATE = new Date(Date.now() + 36 * 3_600_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const manila = (hhmm: string): Date => {
  const [y, mo, d] = MANILA_DATE.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};

interface World {
  f: Fx;
  pkg: { itemId: string; variantId: string };
  dish: { itemId: string; variantId: string };
  snapshot: { menu: { menu: Record<string, unknown> }; stands: { id: string; number: number }[]; rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number }; tenders: { id: string; kind: string }[]; store: { vatRegistered: boolean }; discountPresets: [] };
}

/** One store with lunch 08:00-17:00 and dinner 17:00-08:00: a package (449.00 / 549.00 per head) and a dish (100.00 / 150.00), all priced per daypart. */
async function world(): Promise<World> {
  const f = await fixture();
  await pinSession(f, f.counterId); // the cashier has signed in with a PIN on this tablet (the inbox checks it for every event)
  const lunch = (await insDaypart(f, { name: 'Lunch', start: '08:00', end: '17:00' }))[0]!.id;
  const dinner = (await insDaypart(f, { name: 'Dinner', start: '17:00', end: '08:00' }))[0]!.id;
  const sellable = async (type: 'a_la_carte' | 'package', name: string, lunchPrice: string, dinnerPrice: string) => {
    const it = await newItem(f, type, name);
    await insRule(f, it.variantId);
    await insDaypartOffer(f, it.variantId, lunch, lunchPrice);
    await insDaypartOffer(f, it.variantId, dinner, dinnerPrice);
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${it.itemId}, ${f.grill}, ${f.personId})`;
    return it;
  };
  const pkg = await sellable('package', 'Unli Grill daypart', '449.00', '549.00');
  const dish = await sellable('a_la_carte', 'Pork special daypart', '100.00', '150.00');
  const res = await callRoute(SNAPSHOT, 'GET', tabletCookie(f));
  expect(res.status).toBe(200);
  const snapshot = (await res.json()) as World['snapshot'];
  return { f, pkg, dish, snapshot };
}

/** The tablet, offline: it builds events and the bill from the cached snapshot alone. `menu` is what the device holds (the real snapshot menu, or a stripped copy). */
async function tableOffline(w: World, menu: unknown, stand: { id: string }) {
  const personId = w.f.counterId;
  const base = { personId, menu: menu as never, newId: uuid, standId: stand.id, heads: 2 };
  const cart = (...lines: CartLine[]) => lines;
  const opened = seatEvent({ ...base, now: manila('16:58'), cart: [] as CartLine[] });
  // the party is seated with an empty cart; the lines are added at 16:59 and 17:01
  const sessionId = (opened.payload as { sessionId: string }).sessionId;
  const first = addLinesEvent({ personId, menu: menu as never, newId: uuid, sessionId, heads: 2, now: manila('16:59'), cart: cart({ itemId: w.pkg.itemId, variantId: w.pkg.variantId, qty: 1 }, { itemId: w.dish.itemId, variantId: w.dish.variantId, qty: 1 }) });
  const second = addLinesEvent({ personId, menu: menu as never, newId: uuid, sessionId, heads: 2, now: manila('17:01'), cart: cart({ itemId: w.dish.itemId, variantId: w.dish.variantId, qty: 1 }) });
  const outbox: PosEvent[] = [opened, first, second].map((e: NewPosEvent, i) => ({ ...e, seq: i + 1 }));

  // the Payment screen's own steps
  const view = projectOrders({ openStands: null, sessions: {} }, outbox, { stands: w.snapshot.stands, menu: menu as never });
  const bill = projectBill({ sessionId, view: view.sessions[sessionId], body: undefined, pending: outbox, menu: menu as never, presets: [], extraIds: {} });
  expect(bill.problem, 'the device could price the bill').toBeNull();
  const priced = priceBill({ lines: toPriceLines(bill.lines), rules: w.snapshot.rules, vatRegistered: w.snapshot.store.vatRegistered });
  return { sessionId, outbox, bill, priced };
}

async function sendAndPay(w: World, t: Awaited<ReturnType<typeof tableOffline>>, terminalSeq: number) {
  const receiptId = uuid();
  const sale = saleCompletedEvent({
    personId: w.f.counterId, sessionId: t.sessionId, receiptId, terminalNo: 1, terminalSeq, now: manila('17:05'), online: false, priced: t.priced,
    tenders: w.snapshot.tenders as never, seniors: [], rows: [{ tenderId: w.f.cash, amount: '2000.00' }],
  });
  const events = [...t.outbox.map(({ seq, ...e }) => ({ seq, ...e })), { seq: 10, ...sale }];
  const res = await callRoute(EVENTS, 'POST', tabletCookie(w.f), { events });
  expect(res.status).toBe(200);
  const results = ((await res.json()) as { results: { seq: number; status: string; error?: string }[] }).results;
  return { receiptId, results };
}

const receiptRow = async (receiptId: string) =>
  (await sql<{ subtotal: string; total: string; device_total: string; offline: boolean }[]>`select subtotal::text, total::text, device_total::text, offline from pos_sales_receipts where id = ${receiptId}`)[0];
const lineRows = (receiptId: string) =>
  sql<{ name: string; qty: string; gross: string }[]>`select name, qty::text, gross::text from pos_sales_receipt_lines where receipt_id = ${receiptId} order by line_no`;

describe('the snapshot the tablet caches carries the daypart slots (T-510 S4b), the premise of this task', () => {
  it('hours (Asia/Manila) and a lunch and a dinner slot on each variant', async () => {
    const w = await world();
    const menu = w.snapshot.menu.menu as { hours?: { timeZone: string; dayparts: unknown[] }; items: { id: string; variants: { slots?: { daypartId: string }[] }[] }[] };
    expect(menu.hours?.timeZone).toBe('Asia/Manila');
    expect(menu.hours?.dayparts).toHaveLength(2);
    expect(menu.items.find((i) => i.id === w.dish.itemId)!.variants[0]!.slots).toHaveLength(2);
  });
});

describe('a table worked offline across 17:00, sent through the real /api/pos/events', () => {
  it('16:59 lines are priced at lunch and the 17:01 line at dinner: device total = server total, NO mismatch audit row', async () => {
    const w = await world();
    const stand = await newStand(w.f);
    const t = await tableOffline(w, w.snapshot.menu, stand);
    // the device bill: 2 heads x 449.00 + 100.00 (16:59) + 150.00 (17:01)
    // lines of one order share a time, so their order is by id: compare as a set
    expect(t.bill.lines.map((l) => `${l.qty} x ${l.unitPrice}`).sort()).toEqual(['1 x 100.00', '1 x 150.00', '2 x 449.00']);
    expect(t.priced.total).toBe('1148.00');

    const { receiptId, results } = await sendAndPay(w, t, 4301);
    expect(results.map((r) => r.status), JSON.stringify(results)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect((await lineRows(receiptId)).map((r) => `${r.name} ${r.gross}`).sort()).toEqual(['Pork special daypart 100.00', 'Pork special daypart 150.00', 'Unli Grill daypart 898.00']);
    expect(await receiptRow(receiptId)).toMatchObject({ offline: true, total: '1148.00', device_total: '1148.00' });
    expect(await auditRows(w.f, 'pos.sale_recompute_mismatch'), 'the device and the server priced each line at its own slot').toHaveLength(0);
  });

  it('CONTROL: the same table priced the OLD way (every line at the cached live price, no slots) DOES write a mismatch row, and the sale is still recorded at the server\'s figures', async () => {
    const w = await world();
    const stand = await newStand(w.f);
    const stale = structuredClone(w.snapshot.menu) as { menu: { hours?: unknown; items: { variants: { slots?: unknown }[] }[] } };
    delete stale.menu.hours;
    for (const i of stale.menu.items) for (const v of i.variants) delete v.slots;
    const t = await tableOffline(w, stale, stand);
    const { receiptId, results } = await sendAndPay(w, t, 4302);
    expect(results.at(-1), JSON.stringify(results)).toMatchObject({ status: 'applied' });
    const row = (await receiptRow(receiptId))!;
    expect(row.total, 'the server priced 17:01 at dinner').toBe('1148.00');
    expect(row.device_total).not.toBe(row.total);
    expect(await auditRows(w.f, 'pos.sale_recompute_mismatch')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The extra-head line of a heads.set queued offline is priced at the heads event's device time, on the server too (audit fix 1).
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A store zone in which the real "now" is evening (dinner), so a heads.set stamped 16:58 (lunch) differs from what the server would read if it priced at its own
 * clock. Whole-hour zones only; the same zone is stored on the store, so the device (snapshot `hours`) and the server read the same wall clock.
 */
function eveningZone(): { zone: string; offset: number } {
  const utcHour = new Date().getUTCHours();
  let offset = 20 - utcHour;
  if (offset > 12) offset -= 24;
  if (offset < -11) offset += 24;
  return { zone: offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`, offset };
}

async function bundleWorld() {
  const { zone, offset } = eveningZone();
  const f = await fixture();
  const session = await pinSession(f, f.counterId);
  await sql`update stores set timezone = ${zone} where id = ${f.storeId}`;
  const lunch = (await insDaypart(f, { name: 'Lunch', start: '08:00', end: '17:00' }))[0]!.id;
  const dinner = (await insDaypart(f, { name: 'Dinner', start: '17:00', end: '08:00' }))[0]!.id;
  const bundle = await newItem(f, 'package', 'Party Bundle daypart');
  await insRule(f, bundle.variantId);
  for (const [dp, amount, extra] of [[lunch, '1999.00', '300.00'], [dinner, '2399.00', '400.00']] as const) {
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${bundle.variantId}, 'store', ${dp}, ${amount}, ${6}, ${extra}, false, ${f.personId})`;
  }
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${bundle.itemId}, ${f.grill}, ${f.personId})`;
  await new Promise((r) => setTimeout(r, 25)); // the menu rows carry the database's microsecond now(); the server's own clock must read after them
  const res = await callRoute(SNAPSHOT, 'GET', tabletCookie(f));
  expect(res.status).toBe(200);
  const snapshot = (await res.json()) as World['snapshot'];
  const date = new Date(Date.now() + 36 * 3_600_000).toLocaleDateString('en-CA', { timeZone: zone });
  const local = (hhmm: string): Date => {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(y!, mo! - 1, d!, h! - offset, mi!, 0));
  };
  return { f, bundle, snapshot, local, cookies: `${tabletCookie(f)}; shareat_session=${session}` };
}
type BundleWorld = Awaited<ReturnType<typeof bundleWorld>>;

describe('audit fix 1: a heads.set queued offline prices its extra-head line at its OWN device time', () => {
  /** A table seated for 6 heads, a bundle (up to 6) added at 16:55, and the cashier raises it to 8 heads at 16:58: the outbox the tablet holds offline. */
  const prepare = async (w: BundleWorld) => {
    const stand = await newStand(w.f);
    const personId = w.f.counterId;
    const menu = w.snapshot.menu as never;
    const opened = seatEvent({ personId, menu, newId: uuid, now: w.local('16:50'), standId: stand.id, heads: 6, cart: [] as CartLine[] });
    const sessionId = (opened.payload as { sessionId: string }).sessionId;
    const added = addLinesEvent({ personId, menu, newId: uuid, sessionId, heads: 6, now: w.local('16:55'), cart: [{ itemId: w.bundle.itemId, variantId: w.bundle.variantId, qty: 1 }] });
    const heads = setHeadsEvent({ personId, sessionId, heads: 8, now: w.local('16:58') });
    const outbox: PosEvent[] = [opened, added, heads].map((e: NewPosEvent, i) => ({ ...e, seq: i + 1 }));
    return { sessionId, outbox };
  };
  /** What the Payment screen would show on the tablet BEFORE anything synced. */
  const predicted = (w: BundleWorld, sessionId: string, outbox: PosEvent[]) => {
    const view = projectOrders({ openStands: null, sessions: {} }, outbox, { stands: w.snapshot.stands, menu: w.snapshot.menu as never });
    const bill = projectBill({ sessionId, view: view.sessions[sessionId], body: undefined, pending: outbox, menu: w.snapshot.menu as never, presets: [], extraIds: {} });
    expect(bill.problem).toBeNull();
    return bill;
  };
  const send = async (w: BundleWorld, events: PosEvent[]) => {
    const res = await callRoute(EVENTS, 'POST', tabletCookie(w.f), { events });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { seq: number; status: string; error?: string }[] }).results;
  };
  const serverBody = async (w: BundleWorld, sessionId: string): Promise<SessionBody> => {
    const res = await callRoute('../../src/app/api/pos/session/[sessionId]/route', 'GET', w.cookies, undefined, { params: Promise.resolve({ sessionId }) });
    expect(res.status).toBe(200);
    return (await res.json()) as SessionBody;
  };
  /** Pays with what the tablet PREDICTED, the synthetic extra-heads line swapped for the id the server gave it (only the price can then differ). */
  const payPredicted = async (w: BundleWorld, sessionId: string, bill: ReturnType<typeof predicted>, body: SessionBody, terminalSeq: number) => {
    const serverExtra = body.lines.find((l) => l.kind === 'package' && l.bundleHeads === null)!;
    const lines = bill.lines.map((l) => (l.lineId.startsWith('pending-extra-heads') ? { ...l, lineId: serverExtra.id } : l));
    const priced = priceBill({ lines: toPriceLines(lines), rules: w.snapshot.rules, vatRegistered: w.snapshot.store.vatRegistered });
    const sale = saleCompletedEvent({
      personId: w.f.counterId, sessionId, receiptId: uuid(), terminalNo: 1, terminalSeq, now: w.local('17:06'), online: true, priced,
      tenders: w.snapshot.tenders as never, seniors: [], rows: [{ tenderId: w.f.cash, amount: '5000.00' }],
    });
    const [r] = await send(w, [{ seq: 50, ...sale } as PosEvent]);
    return { priced, result: r! };
  };

  it('bundle for 6, heads.set to 8 queued at 16:58, synced after 17:00: the extra heads cost the LUNCH 300.00 on the tablet and on the server, and no mismatch row', async () => {
    const w = await bundleWorld();
    const { sessionId, outbox } = await prepare(w);
    const bill = predicted(w, sessionId, outbox);
    expect(bill.lines.map((l) => `${l.qty} x ${l.unitPrice}`).sort()).toEqual(['1 x 1999.00', '2 x 300.00']); // the tablet's prediction: both at lunch

    const results = await send(w, outbox);
    expect(results.map((r) => r.status), JSON.stringify(results)).toEqual(['applied', 'applied', 'applied']);
    const body = await serverBody(w, sessionId);
    const extra = body.lines.find((l) => l.kind === 'package' && l.bundleHeads === null)!;
    expect(extra, 'the server made the extra-head line').toBeDefined();
    expect([extra.qty, extra.unitPrice], 'priced at 16:58 (lunch), not at the server clock (evening = dinner 400.00)').toEqual([2, '300.00']);

    const { priced, result } = await payPredicted(w, sessionId, bill, body, 4401);
    expect(result).toMatchObject({ status: 'applied' });
    expect(priced.total).toBe('2599.00');
    expect(await auditRows(w.f, 'pos.sale_recompute_mismatch'), 'the tablet and the server priced the extra heads at the same slot').toHaveLength(0);
  });

  it('CONTROL: the OLD behaviour (the heads change priced at the server clock, no atDevice) prices the extra heads at dinner 400.00, and the same payment writes a mismatch row', async () => {
    const w = await bundleWorld();
    const { sessionId, outbox } = await prepare(w);
    const bill = predicted(w, sessionId, outbox);
    const results = await send(w, outbox.slice(0, 2));
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    await asOrg(w.f.orgId, (tx) => setHeadsCashier(tx, w.f.counter, { storeId: w.f.storeId, pairingId: w.f.pairingId, sessionId, headsCashier: 8 })); // no atDevice: priced "now"
    const body = await serverBody(w, sessionId);
    const extra = body.lines.find((l) => l.kind === 'package' && l.bundleHeads === null)!;
    expect(extra.unitPrice).toBe('400.00');
    const { result } = await payPredicted(w, sessionId, bill, body, 4402);
    expect(result).toMatchObject({ status: 'applied' });
    expect(await auditRows(w.f, 'pos.sale_recompute_mismatch')).toHaveLength(1);
  });
});
