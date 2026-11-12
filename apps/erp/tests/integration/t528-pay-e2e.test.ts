import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-528 (TESTER) - R5 end to end: the payment.png bill is built, discounted, priced ON THE DEVICE with `priceBill` and paid with the device's own
 * `sale.completed` through the REAL POST /api/pos/events. The server's receipt, payments, statutory rows and recompute must match the device's figures with NO
 * mismatch audit row (the two prices agree by construction); one altered device figure must write a mismatch audit row and the sale is still recorded.
 * Real Postgres on a scratch "_test" database (any name). docs/tasks/528-pos-payment-screen.md R5.
 *
 * ASSUMED API (apps/erp/src/app/pos/_payment/logic.ts, exactly as documented in tests/t528-payment-logic.test.ts): priceBill, saleCompletedEvent,
 * discountAddedEvent. The snapshot route is also expected to carry `store.vatRegistered` (R1). The inbox refuses a key it does not know and a device line
 * without gross/discountTotal/net, so a wrong payload shows up as a quarantined result, not as a pass.
 *
 * RED NOW FOR THE RIGHT REASON: _payment/logic.ts does not exist (lazy import: "MISSING MODULE ... not built"), and the snapshot has no vatRegistered.
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
import { HEADS_CHANGED_NOTICE, projectBill, toPriceLines } from '../../src/app/pos/_payment/bill';
import { extraHeadsId } from '../../src/app/pos/_payment/uuidv5';
import { projectOrders, type SessionBody } from '../../src/app/pos/_orders/project';
import type { PosEvent } from '../../src/lib/pos-device';
import { insRule, newItem } from '../../../../packages/db/tests/integration/_fixtures/t401-menu';
import { auditRows, closeAll, ev, fixture, type Ev, linesAddedPayload, newStand, pinSession, sql, standOpenedPayload, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const SESSION_COOKIE = 'shareat_session';
const REF = '4012 889 213';
const SENIOR_1 = { dinerNo: 1, kind: 'senior', idNumber: 'OSCA 04-1187', holderName: 'Lolita R.' };
const PWD_2 = { dinerNo: 2, kind: 'pwd', idNumber: 'PWD 77-3021', holderName: 'Ramon C.' };

// biome-ignore lint/suspicious/noExplicitAny: the module under test does not exist yet; its types are the builder's
async function load(path: string, label: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`MISSING MODULE: ${label} cannot be loaded (T-528 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const logic = () => load('../../src/app/pos/_payment/logic', 'apps/erp/src/app/pos/_payment/logic.ts');

async function callRoute(path: string, method: 'GET' | 'POST', cookie: string, body?: unknown, ctx?: unknown): Promise<Response> {
  const mod = await load(path, path.replace('../../src/', 'apps/erp/src/') + '.ts');
  state.cookie = cookie;
  const req = new Request('http://localhost:9008/api/pos/x', {
    method,
    headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return mod[method](req, ctx);
}
const tabletCookie = (f: Fx) => `${POS_TABLET_COOKIE}=${f.pairingToken}`;
const EVENTS = '../../src/app/api/pos/events/route';

async function dish(f: Fx, name: string, amount: string) {
  const it = await newItem(f, 'a_la_carte', name);
  await insRule(f, it.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${it.variantId}, 'store', ${null}, ${amount}, ${null}, ${null}, false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${it.itemId}, ${f.grill}, ${f.personId})`;
  return it;
}

interface Table {
  f: Fx;
  sessionId: string;
  cookies: string;
  lineIds: { pkg: string; tea: string; corn: string; rice: string };
  presetId: string;
}

/** Seats stand with 4 heads: Unli Grill x4 (449.00), Iced tea pitcher 120.00, Cheese corn x2 (99.00), Kimchi fried rice 150.00; then the discounts, all through the real inbox. */
async function seatAndDiscount(twoDiners: boolean): Promise<Table> {
  const f = await fixture();
  const { discountAddedEvent } = await logic();
  const session = await pinSession(f, f.counterId);
  const stand = await newStand(f);
  const tea = await dish(f, 'Iced tea pitcher', '120.00');
  const corn = await dish(f, 'Cheese corn', '99.00');
  const rice = await dish(f, 'Kimchi fried rice', '150.00');
  const [birthday] = await sql<{ id: string }[]>`
    insert into pos_discount_presets (org_id, store_id, name, value_type, value, status, created_by) values (${f.orgId}, ${f.storeId}, 'Birthday promo 10%', 'percent', '10', 'active', ${f.personId}) returning id`;
  // The menu rows above take the database's microsecond now(); an event stamped in the same millisecond reads as BEFORE them (JS dates are whole ms) and the item is "not on the menu".
  await new Promise((r) => setTimeout(r, 25));
  const sessionId = uuid();
  const lineIds = { pkg: uuid(), tea: uuid(), corn: uuid(), rice: uuid() };
  const at = new Date();
  const discounts = [
    discountAddedEvent({ personId: f.counterId, now: at, discountId: uuid(), lineId: lineIds.pkg, kind: 'senior', qty: 1, dinerNo: 1 }),
    discountAddedEvent({ personId: f.counterId, now: at, discountId: uuid(), lineId: lineIds.corn, kind: 'senior', qty: 1, dinerNo: 1 }),
    discountAddedEvent({ personId: f.counterId, now: at, discountId: uuid(), lineId: lineIds.rice, kind: 'preset', presetId: birthday!.id, qty: 1 }),
    ...(twoDiners ? [discountAddedEvent({ personId: f.counterId, now: at, discountId: uuid(), lineId: lineIds.pkg, kind: 'pwd', qty: 1, dinerNo: 2 })] : []),
  ];
  const events = [
    ev(1, 'stand.opened', f.counterId, {
      ...standOpenedPayload(sessionId, stand.id, 4),
      lines: linesAddedPayload(sessionId, [
        { lineId: lineIds.pkg, item: f.menu.unli, qty: 4 },
        { lineId: lineIds.tea, item: tea, qty: 1 },
        { lineId: lineIds.corn, item: corn, qty: 2 },
        { lineId: lineIds.rice, item: rice, qty: 1 },
      ]).lines,
    }),
    ...discounts.map((d: { kind: string; personId: string; occurredAtDevice: string; payload: Record<string, unknown> }, i: number) => ({ seq: i + 2, ...d })),
  ];
  const res = await callRoute(EVENTS, 'POST', tabletCookie(f), { events });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { results: { status: string }[] }).results.map((r) => r.status)).toEqual(events.map(() => 'applied'));
  return { f, sessionId, cookies: `${tabletCookie(f)}; ${SESSION_COOKIE}=${session}`, lineIds, presetId: birthday!.id };
}

/**
 * What the tablet holds: the snapshot, the table's last server body, and its OUTBOX (`pending`). The bill is built exactly as the Payment screen builds it:
 * `projectOrders` then `projectBill` (outbox on top of the server body), priced with `priceBill` using the snapshot's rules and `store.vatRegistered`.
 */
async function deviceBill(t: Table, pending: Ev[] = []) {
  const { priceBill } = await logic();
  const snap = await callRoute('../../src/app/api/pos/snapshot/route', 'GET', tabletCookie(t.f));
  expect(snap.status).toBe(200);
  const snapshot = (await snap.json()) as {
    rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number };
    tenders: { id: string; name: string; kind: string }[];
    menu: unknown;
    stands: { id: string; number: number }[];
    discountPresets: { id: string; name: string; valueType: string; value: string }[];
    store: { vatRegistered: boolean };
  };
  const res = await callRoute('../../src/app/api/pos/session/[sessionId]/route', 'GET', t.cookies, undefined, { params: Promise.resolve({ sessionId: t.sessionId }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as SessionBody;
  const stand = { sessionId: t.sessionId, standId: body.session.standId, standNumber: 1, mode: body.session.mode, headsCashier: body.session.headsCashier, headsServer: body.session.headsServer, openedAtDevice: new Date().toISOString() };
  const outbox = pending as unknown as PosEvent[];
  const view = projectOrders({ openStands: [stand], sessions: { [t.sessionId]: body } }, outbox, { stands: snapshot.stands, menu: snapshot.menu as never });
  const bill = projectBill({ sessionId: t.sessionId, view: view.sessions[t.sessionId], body, pending: outbox, menu: snapshot.menu as never, presets: snapshot.discountPresets });
  expect(bill.problem, 'the device could price the bill').toBeNull();
  const priced = priceBill({ lines: toPriceLines(bill.lines), rules: snapshot.rules, vatRegistered: snapshot.store.vatRegistered });
  return { priced, tenders: snapshot.tenders, bill };
}

async function pay(t: Table, o: { seniors: unknown[]; online?: boolean; terminalSeq: number; pending?: Ev[]; rows?: (total: string) => { tenderId: string; amount: string; referenceNo?: string }[]; tweak?: (payload: { device: { lines: { lineId: string; net: string }[] } }) => void }) {
  const { saleCompletedEvent } = await logic();
  const pending = (o.pending ?? []).map((e, i) => ({ ...e, seq: 90 + i }));
  const { priced, tenders, bill } = await deviceBill(t, pending);
  const online = o.online ?? true;
  const receiptId = uuid();
  const event = saleCompletedEvent({
    personId: t.f.counterId, sessionId: t.sessionId, receiptId, terminalNo: 1, terminalSeq: o.terminalSeq, now: new Date(), online, priced, tenders, seniors: o.seniors,
    rows: o.rows ? o.rows(priced.total) : [{ tenderId: t.f.gcash, amount: '500.00', referenceNo: REF }, { tenderId: t.f.cash, amount: '1600.00' }],
  });
  o.tweak?.(event.payload);
  // The drain sends the outbox in order: the pending changes first, the sale last.
  const res = await callRoute(EVENTS, 'POST', tabletCookie(t.f), { events: [...pending, { seq: 100, ...event }] });
  expect(res.status).toBe(200);
  const all = ((await res.json()) as { results: { seq: number; status: string; error?: string }[] }).results;
  for (const r of all.slice(0, -1)) expect(r.status, `a pending change was applied: ${JSON.stringify(r)}`).toBe('applied');
  const result = all[all.length - 1]!;
  return { priced, bill, receiptId, result, event };
}

const receiptRow = async (receiptId: string) =>
  (await sql<{ subtotal: string; discount_total: string; total: string; device_total: string; offline: boolean }[]>`
    select subtotal::text, discount_total::text, total::text, device_total::text, offline from pos_sales_receipts where id = ${receiptId}`)[0];
const paymentRows = (receiptId: string) =>
  sql<{ tender_id: string; amount: string; change_given: string; reference_no: string | null; to_check: boolean }[]>`
    select tender_id, amount::text, change_given::text, reference_no, to_check from pos_sales_receipt_payments where receipt_id = ${receiptId} order by pos_sales_receipt_payments.amount desc`;
const lineRows = (receiptId: string) =>
  sql<{ name: string; gross: string; discount_total: string; net: string }[]>`select name, gross::text, discount_total::text, net::text from pos_sales_receipt_lines where receipt_id = ${receiptId} order by line_no`;
const statutory = (f: Fx) =>
  sql<{ kind: string; gross_amount: string; discount_amount: string; id_number: string; holder_name: string }[]>`
    select kind, gross_amount::text, discount_amount::text, id_number, holder_name from statutory_discount_records where org_id = ${f.orgId} order by kind desc`;

describe('the snapshot carries what the device needs to price (R1)', () => {
  it('store.vatRegistered is true for a VAT organization', async () => {
    const f = await fixture();
    const res = await callRoute('../../src/app/api/pos/snapshot/route', 'GET', tabletCookie(f));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { store: { vatRegistered?: boolean } }).store.vatRegistered).toBe(true);
  });
});

describe('the payment.png bill, paid through the real inbox', () => {
  it('device and server agree to the centavo: receipt, payments, one statutory row for the senior diner, the recompute, and NO mismatch audit row', async () => {
    const t = await seatAndDiscount(false);
    const { priced, receiptId, result } = await pay(t, { seniors: [SENIOR_1], terminalSeq: 4231 });
    expect(priced).toMatchObject({ subtotal: '2264.00', discountTotal: '171.58', total: '2092.42' });
    expect(result, 'the sale was applied (a refusal or a quarantine would show its error here)').toMatchObject({ seq: 100, status: 'applied' });

    expect(await receiptRow(receiptId)).toEqual({ subtotal: '2264.00', discount_total: '171.58', total: '2092.42', device_total: '2092.42', offline: false });
    expect(await lineRows(receiptId)).toEqual([
      { name: 'Unli Grill', gross: '1796.00', discount_total: '128.29', net: '1667.71' },
      { name: 'Iced tea pitcher', gross: '120.00', discount_total: '0.00', net: '120.00' },
      { name: 'Cheese corn', gross: '198.00', discount_total: '28.29', net: '169.71' },
      { name: 'Kimchi fried rice', gross: '150.00', discount_total: '15.00', net: '135.00' },
    ]);
    expect((await paymentRows(receiptId)).map((p) => ({ amount: p.amount, change: p.change_given, ref: p.reference_no, toCheck: p.to_check }))).toEqual([
      { amount: '1600.00', change: '7.58', ref: null, toCheck: false },
      { amount: '500.00', change: '0.00', ref: REF, toCheck: false },
    ]);
    expect(await statutory(t.f)).toEqual([{ kind: 'senior', gross_amount: '548.00', discount_amount: '156.58', id_number: 'OSCA 04-1187', holder_name: 'Lolita R.' }]);
    expect(await auditRows(t.f, 'pos.sale_recompute_mismatch'), 'no mismatch: the device and the server priced the same bill the same').toHaveLength(0);
    expect(await auditRows(t.f, 'pos.sale_completed')).toHaveLength(1);
  });

  it('two senior/PWD diners: one statutory row each, still no mismatch audit row, receipt total equals the device total', async () => {
    const t = await seatAndDiscount(true);
    const { priced, receiptId, result } = await pay(t, { seniors: [SENIOR_1, PWD_2], terminalSeq: 4232 });
    expect(result).toMatchObject({ status: 'applied' });
    expect(priced.total).not.toBe('2092.42'); // the second diner changed the bill
    expect((await receiptRow(receiptId))!.total).toBe(priced.total);
    expect((await receiptRow(receiptId))!.device_total).toBe(priced.total);
    const rows = await statutory(t.f);
    expect(rows.map((r) => [r.kind, r.holder_name])).toEqual([['senior', 'Lolita R.'], ['pwd', 'Ramon C.']]);
    expect(await auditRows(t.f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
  });

  it('offline: a wallet payment is stored "to check" and the receipt is marked offline, with no mismatch', async () => {
    const t = await seatAndDiscount(false);
    const { receiptId, result } = await pay(t, { seniors: [SENIOR_1], terminalSeq: 4233, online: false });
    expect(result).toMatchObject({ status: 'applied' });
    expect((await receiptRow(receiptId))!.offline).toBe(true);
    expect((await paymentRows(receiptId)).map((p) => [p.amount, p.to_check])).toEqual([['1600.00', false], ['500.00', true]]);
    expect(await auditRows(t.f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
  });

  it('one device figure changed (the cheese corn net 169.71 -> 169.72): the sale is NOT refused, the server\'s figures are written, and a mismatch audit row records both sides', async () => {
    const t = await seatAndDiscount(false);
    const { receiptId, result } = await pay(t, {
      seniors: [SENIOR_1],
      terminalSeq: 4234,
      tweak: (p) => {
        p.device.lines.find((l) => l.net === '169.71')!.net = '169.72';
      },
    });
    expect(result, 'recorded, not refused (row 276)').toMatchObject({ status: 'applied' });
    expect((await receiptRow(receiptId))!.total).toBe('2092.42'); // the server's total is the truth
    expect(await statutory(t.f)).toHaveLength(1);
    expect(await paymentRows(receiptId)).toHaveLength(2);
    const mismatch = await auditRows(t.f, 'pos.sale_recompute_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.entity_id).toBe(receiptId);
    expect(JSON.stringify(mismatch[0]!.before)).toContain('169.72');
    expect(JSON.stringify(mismatch[0]!.after)).toContain('169.71');
    expect(await auditRows(t.f, 'pos.sale_completed')).toHaveLength(1);
  });
});

describe('the device bill is built from the outbox, as the screen builds it (T-528 audit)', () => {
  it('a preset discount still in the outbox (discount.added): the device prices it, the server applies it, no mismatch row', async () => {
    const { discountAddedEvent } = await logic();
    const t = await seatAndDiscount(false);
    const pending = [discountAddedEvent({ personId: t.f.counterId, now: new Date(), discountId: uuid(), lineId: t.lineIds.tea, kind: 'preset', presetId: t.presetId, qty: 1 })];
    const { priced, receiptId, result } = await pay(t, { seniors: [SENIOR_1], terminalSeq: 4241, pending });
    expect(result).toMatchObject({ status: 'applied' });
    expect(priced.total, '2,092.42 less 10% of the 120.00 pitcher').toBe('2080.42');
    expect(await receiptRow(receiptId)).toMatchObject({ total: '2080.42', device_total: '2080.42' });
    expect(await auditRows(t.f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
  });

  it('apply-to-all still in the outbox (discount.applied_to_all): same figures on both sides, no mismatch row', async () => {
    const { applyToAllEvent } = await logic();
    const t = await seatAndDiscount(false);
    const pending = [applyToAllEvent({ personId: t.f.counterId, now: new Date(), sessionId: t.sessionId, presetId: t.presetId, applyId: uuid() })];
    const { priced, receiptId, result } = await pay(t, { seniors: [SENIOR_1], terminalSeq: 4242, pending });
    expect(result).toMatchObject({ status: 'applied' });
    expect(priced.total).not.toBe('2092.42');
    expect((await receiptRow(receiptId))!.total).toBe(priced.total);
    expect((await receiptRow(receiptId))!.device_total).toBe(priced.total);
    expect(await auditRows(t.f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
  });

  it('a head-count change still in the outbox, plus a senior discount: the package line is re-made at 5 heads WITHOUT its discounts (as the server does), the notice shows, the sale is recorded and the totals are equal', async () => {
    const { discountAddedEvent } = await logic();
    const t = await seatAndDiscount(false);
    const at = new Date();
    const pending = [
      discountAddedEvent({ personId: t.f.counterId, now: at, discountId: uuid(), lineId: t.lineIds.tea, kind: 'senior', qty: 1, dinerNo: 2 }),
      { seq: 0, kind: 'heads.set', personId: t.f.counterId, occurredAtDevice: at.toISOString(), payload: { sessionId: t.sessionId, headsCashier: 5 } },
    ] as unknown as Ev[];
    const { priced, bill, receiptId, result } = await pay(t, {
      seniors: [SENIOR_1, { dinerNo: 2, kind: 'senior', idNumber: 'OSCA 07-4410', holderName: 'Tomas V.' }],
      terminalSeq: 4243,
      pending,
      rows: (total) => [{ tenderId: t.f.cash, amount: total }],
    });
    const pkg = bill.lines.find((l) => l.lineId === t.lineIds.pkg)!;
    expect(pkg.qty, 'the package line follows the new heads').toBe(5);
    expect(pkg.discounts, "the old line's senior discount is dropped, as followHeads removes it").toEqual([]);
    expect(bill.notices).toEqual([HEADS_CHANGED_NOTICE]);
    expect(result, 'recorded, not quarantined or refused as underpaid').toMatchObject({ status: 'applied' });
    expect((await receiptRow(receiptId))!.total, 'the server total equals the device total').toBe(priced.total);
    expect((await receiptRow(receiptId))!.device_total).toBe(priced.total);
    // a mismatch audit row is allowed here: the re-made line has a new id on the server
    expect((await statutory(t.f)).map((r) => r.holder_name).sort()).toEqual(['Lolita R.', 'Tomas V.']);
  });
});

describe('a bundle sold to more heads than it covers, paid offline (T-528 extra-heads id)', () => {
  it('the device derives the extra-heads line id the server derives: the sale applies with NO mismatch audit row', async () => {
    const f = await fixture();
    const { priceBill, saleCompletedEvent } = await logic();
    const session = await pinSession(f, f.counterId);
    void session;
    const stand = await newStand(f);
    const fam = await newItem(f, 'package', 'Family Pack');
    await insRule(f, fam.variantId);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${fam.variantId}, 'store', ${null}, ${'1200.00'}, ${6}, ${'199.00'}, false, ${f.personId})`;
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${fam.itemId}, ${f.grill}, ${f.personId})`;
    await new Promise((r) => setTimeout(r, 25)); // see seatAndDiscount: the menu rows' microsecond now() vs a whole-ms event time

    // What the tablet holds offline: the snapshot, and its own outbox (nothing has reached the server yet).
    const snap = await callRoute('../../src/app/api/pos/snapshot/route', 'GET', tabletCookie(f));
    expect(snap.status).toBe(200);
    const snapshot = (await snap.json()) as { menu: unknown; stands: { id: string; number: number }[]; tenders: { id: string; name: string; kind: string }[]; rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number }; store: { vatRegistered: boolean } };
    const sessionId = uuid();
    const lineId = uuid();
    const opened = ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, stand.id, 8), lines: linesAddedPayload(sessionId, [{ lineId, item: fam, qty: 8 }]).lines });
    const pending = [opened] as never[];
    const view = projectOrders({ openStands: null, sessions: {} }, pending, { stands: snapshot.stands, menu: snapshot.menu as never });
    const extraIds = { [lineId]: await extraHeadsId(lineId) };
    const bill = projectBill({ sessionId, view: view.sessions[sessionId], body: undefined, pending, menu: snapshot.menu as never, presets: [], extraIds });
    expect(bill.problem).toBeNull();
    expect(bill.needsExtraFor).toEqual([]);
    expect(bill.lines.map((l) => [l.qty, l.unitPrice, l.bundleHeads])).toEqual([[1, '1200.00', 6], [2, '199.00', null]]);
    const priced = priceBill({ lines: toPriceLines(bill.lines), rules: snapshot.rules, vatRegistered: snapshot.store.vatRegistered });
    expect(priced.total).toBe('1598.00');

    const receiptId = uuid();
    const sale = saleCompletedEvent({ personId: f.counterId, sessionId, receiptId, terminalNo: 1, terminalSeq: 4301, now: new Date(), online: false, priced, tenders: snapshot.tenders, seniors: [], rows: [{ tenderId: f.cash, amount: '1600.00' }] });
    const res = await callRoute(EVENTS, 'POST', tabletCookie(f), { events: [opened, { seq: 2, ...sale }] });
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { results: { status: string; error?: string }[] }).results;
    expect(results.map((r) => r.status), JSON.stringify(results)).toEqual(['applied', 'applied']);
    expect((await receiptRow(receiptId))).toMatchObject({ total: '1598.00', device_total: '1598.00', offline: true });
    expect(await auditRows(f, 'pos.sale_recompute_mismatch'), 'the extra-heads line id matched: no mismatch row').toHaveLength(0);
  });
});
