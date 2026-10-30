import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, interEntityRepo, tradeRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { money, toCentavos } from '@shareat/core/money';
import { confirmTradeOrder, createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, voidTradeOrder } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';
import { api, asOrg, buyer, dispatch, fixture, freezeClock, payNow, sayOf, thawClock, uid, type Fx } from './_fixtures/t433-b2b';

/**
 * T-398 S5c (TESTER) - the SELLER side of the Padre Garcia (inter-entity) sale.
 * docs/tasks/398-s5/TESTS.md "S5c - seller side", S5-REFRESH.md sections 1, 2, 6, 7, 8, QUESTIONS.md (rulings + audit fixes).
 * Real Postgres (TEST_DATABASE_URL, `_test` guard). Seller = org f (Ian's commissary); buyer = org g (Padre Garcia, a second full org).
 * Clock frozen at 2026-10-16. Every leg names the mutant it must turn red.
 *
 * The worked order (one shape for every leg): 10.000 kg pork belly at 310.00 (cost 250.0000/kg) + 2.500 kg salt at 41.20 (cost 20.0000/kg)
 *   = billed 3203.00, cost 2550.00 (2500.00 + 50.00).
 *
 * ASSUMPTIONS THE BUILDER MUST MEET (spec is silent; flagged in the hand-back): refusals are RefusalError (`userMessage` set);
 *   E10 names the receipt date as YYYY-MM-DD (Manila), the same shape as the database's "already received on" sentence;
 *   E23's wording is not pinned (meaning only: it talks about paying).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------------------------------------ helpers
const BILLED = '3203.00';
const COST = '2550.00';
const cents = (v: string) => toCentavos(money(v)).toString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The buyer's principal: the receive definer needs `app.person_id`. */
async function asPerson<T>(orgId: string, personId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`select set_config('app.person_id', ${personId}, true)`);
    return fn(tx);
  });
}

interface World { f: Fx; g: Fx }
async function world(hint: string): Promise<World> {
  return { f: await fixture(sql, `${hint}a`), g: await fixture(sql, `${hint}b`) };
}

async function mkItem(f: Fx, name: string) {
  const full = `${name} ${uid('n')}`;
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name: full, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  return { id: item.id, name: full };
}

async function stockAt(f: Fx, itemId: string, qty: string, unitCost: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId: f.locationId }],
    }),
  );
}

/** DEF-747 (T-398 S7d): a customer may only point at another company when a franchise agreement joins the two. Written as the owner, like onboarding does. */
async function agree(franchisorOrgId: string, franchiseeOrgId: string, franchisorPersonId: string): Promise<void> {
  await sql`
    insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
    values (${franchiseeOrgId}, ${franchisorOrgId}, ${franchisorPersonId}, '2026-01-01') on conflict do nothing`;
}

/** Padre Garcia as the seller's customer: linked to the buyer org (that link, not the group label, is what makes it inter-entity). */
async function pgCustomer(w: World, opts: { group?: 'franchise' | 'wholesale'; creditLimit?: string } = {}) {
  await agree(w.f.orgId, w.g.orgId, w.g.manager.personId);
  const c = await asOrg(w.f.orgId, (tx) =>
    createCustomer(tx, w.f.admin, {
      name: `Padre Garcia ${uid('pg')}`, customerGroup: opts.group ?? 'franchise', counterpartyOrgId: w.g.orgId, priceListId: null,
    }),
  );
  if (opts.creditLimit !== undefined) await sql`update customers set credit_limit = ${opts.creditLimit} where id = ${c.id}`;
  return c.id;
}

interface MadeOrder { orderId: string; total: string; pork: { id: string; name: string }; salt: { id: string; name: string } }
async function makeOrder(
  f: Fx, customerId: string, opts: { deliveryFee?: string; otherFees?: string; birInvoiceNo?: string } = {},
): Promise<MadeOrder> {
  const pork = await mkItem(f, 'Pork belly');
  const salt = await mkItem(f, 'Salt');
  await stockAt(f, pork.id, '20', '250.0000');
  await stockAt(f, salt.id, '10', '20.0000');
  const o = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId, orderDate: '2026-10-10',
      lines: [{ itemId: pork.id, quantity: '10', rate: '310.00' }, { itemId: salt.id, quantity: '2.5', rate: '41.20' }],
      ...(opts.deliveryFee ? { deliveryFee: opts.deliveryFee } : {}),
      ...(opts.otherFees ? { otherFees: opts.otherFees } : {}),
    }),
  );
  if (opts.birInvoiceNo) await sql`update trade_orders set bir_invoice_no = ${opts.birInvoiceNo} where id = ${o.orderId}`;
  return { orderId: o.orderId, total: o.totalAmount, pork, salt };
}

/** Every ledger leg the sale wrote in `orgId`, as normalised strings (account, centavos, party kind) - sorted, so two orders compare. */
async function legsOf(orgId: string, orderId: string, chargeId: string, customerId: string) {
  const rows = await sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null; entry_org: string }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_type, jl.party_id, je.org_id as entry_org
    from journal_entries je join journal_lines jl on jl.entry_id = je.id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and ((je.source_type = 'ar_charge' and je.source_id = ${chargeId})
        or (je.source_type = 'trade_order_dispatch' and je.source_id like ${`${orderId}:%`}))`;
  return rows
    .map((r) => {
      const party = r.party_type === null ? '-' : r.party_id === customerId ? `${r.party_type}:THE-CUSTOMER` : `${r.party_type}:OTHER`;
      return `${r.code} D${cents(r.debit)} C${cents(r.credit)} ${party}`;
    })
    .sort();
}

/** Σ debit = Σ credit per entry, to the centavo (M2), for every entry the sale wrote in `orgId`. */
async function expectBalanced(orgId: string, orderId: string, chargeId: string) {
  const rows = await sql<{ entry_id: string; d: string; c: string }[]>`
    select je.id as entry_id, sum(jl.debit)::text as d, sum(jl.credit)::text as c
    from journal_entries je join journal_lines jl on jl.entry_id = je.id
    where je.org_id = ${orgId}
      and ((je.source_type = 'ar_charge' and je.source_id = ${chargeId})
        or (je.source_type = 'trade_order_dispatch' and je.source_id like ${`${orderId}:%`}))
    group by je.id`;
  expect(rows.length).toBeGreaterThanOrEqual(2); // the sale and the cost
  for (const r of rows) expect(cents(r.d)).toBe(cents(r.c));
}

/** Row counts that must not move when a call is refused. Seller and buyer books both. */
async function snap(w: World) {
  const one = async (orgId: string) => {
    const [r] = await sql<Record<string, number>[]>`
      select
        (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
        (select count(*)::int from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${orgId}) as journal_lines,
        (select count(*)::int from stock_movements where org_id = ${orgId}) as movements,
        (select count(*)::int from ar_charges where org_id = ${orgId}) as charges,
        (select count(*)::int from ar_collections where org_id = ${orgId}) as collections,
        (select count(*)::int from inter_entity_shipments where org_id = ${orgId}) as shipments,
        (select count(*)::int from inter_entity_shipment_lines where org_id = ${orgId}) as shipment_lines,
        (select count(*)::int from deliveries where org_id = ${orgId}) as deliveries,
        (select count(*)::int from trade_orders where org_id = ${orgId}) as orders`;
    return r!;
  };
  return { seller: await one(w.f.orgId), buyer: await one(w.g.orgId) };
}

const shipOf = (f: Fx, orderId: string) => asOrg(f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, f.orgId, orderId));
const shipCount = async (orderId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from inter_entity_shipments where trade_order_id = ${orderId}`)[0]!.n;
const onHand = async (f: Fx, itemId: string) =>
  (await sql<{ q: string }[]>`select coalesce(sum(quantity), 0)::text as q from stock_movements where org_id = ${f.orgId} and store_id = ${f.storeId} and item_id = ${itemId}`)[0]!.q;
const chargeStatus = async (chargeId: string) => (await sql<{ s: string }[]>`select status as s from ar_charges where id = ${chargeId}`)[0]!.s;
const orderStatus = async (orderId: string) => (await sql<{ s: string }[]>`select status as s from trade_orders where id = ${orderId}`)[0]!.s;
const receiptDate = async (shipmentId: string) =>
  (await sql<{ d: string }[]>`select to_char(received_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as d from inter_entity_shipments where id = ${shipmentId}`)[0]!.d;

/** Padre Garcia counts everything it was sent and receives (the S5b definer; S5d wraps it). */
async function pgReceivesAll(w: World, shipmentId: string, hold?: () => Promise<void>) {
  const lines = await asOrg(w.g.orgId, (tx) => interEntityRepo.linesOf(tx, shipmentId));
  return asPerson(w.g.orgId, w.g.manager.personId, async (tx) => {
    const total = await interEntityRepo.receive(tx, shipmentId, lines.map((l) => ({ lineId: l.id, receivedQuantity: quantity(l.quantity) })));
    if (hold) await hold();
    return total;
  });
}

/** A dispatched inter-entity order, ready for the void / receive legs. */
async function dispatchedToPg(w: World, o: { creditLimit?: string } = {}) {
  const customerId = await pgCustomer(w, o);
  const order = await makeOrder(w.f, customerId);
  const r = await dispatch(w.f, w.f.manager, order.orderId);
  const ship = await shipOf(w.f, order.orderId);
  return { customerId, order, r, ship: ship! };
}

const REFUSED_NOT_RAW = /violates|constraint|SQLSTATE|duplicate key/i;

// ================================================================================================ E1, E2
describe('E1/E2 dispatch to Padre Garcia: a real sale, plus one shipment note, in the same transaction', () => {
  it('E1. the legs are identical to an external order of the same lines (no payNow, no override on the control); accounts, centavos, parties exact; nothing in the buyer books', async () => {
    const w = await world('e1');
    const pgId = await pgCustomer(w);
    const extId = await buyer(sql, w.f); // a plain wholesale customer, no counterparty
    const pgOrder = await makeOrder(w.f, pgId);
    const extOrder = await makeOrder(w.f, extId);
    expect(pgOrder.total).toBe(BILLED);
    expect(extOrder.total).toBe(BILLED);

    const before = await snap(w);
    const pg = await dispatch(w.f, w.f.manager, pgOrder.orderId); // control and subject: no payNow, no creditOverrideReason
    const ext = await dispatch(w.f, w.f.manager, extOrder.orderId);
    expect(pg.chargeId).not.toBeNull();
    expect(pg.treatment).toBe('inter_entity'); // ruling 3; never the branch-transfer shape

    const pgLegs = await legsOf(w.f.orgId, pgOrder.orderId, pg.chargeId!, pgId);
    const extLegs = await legsOf(w.f.orgId, extOrder.orderId, ext.chargeId!, extId);
    // exact, by value: AR to the customer, wholesale revenue, COGS, inventory. Never 1340 / 1250 / 2150.
    expect(pgLegs).toEqual([
      `1210 D${cents(BILLED)} C0 customer:THE-CUSTOMER`,
      `1310 D0 C${cents(COST)} -`,
      `4300 D0 C${cents(BILLED)} -`,
      `5100 D${cents(COST)} C0 -`,
    ].sort());
    expect(pgLegs).toEqual(extLegs); // identical to the control of the same lines
    await expectBalanced(w.f.orgId, pgOrder.orderId, pg.chargeId!);

    // M3: everything the dispatch wrote is in the seller org; the buyer's books did not move.
    const after = await snap(w);
    expect(after.buyer).toEqual(before.buyer);
    const [foreign] = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries where source_id like ${`${pgOrder.orderId}%`} and org_id <> ${w.f.orgId}`;
    expect(foreign!.n).toBe(0);
    // the receivable is the customer's, in centavos
    const [ar] = await sql<{ b: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${w.f.orgId} and jl.party_type = 'customer' and jl.party_id = ${pgId} and a.code = '1210'`;
    expect(cents(ar!.b)).toBe(cents(BILLED));
    // stock really left
    expect(await onHand(w.f, pgOrder.pork.id)).toBe('10.000');
    expect(await onHand(w.f, pgOrder.salt.id)).toBe('7.500');
    // the control wrote no shipment
    expect(await shipCount(extOrder.orderId)).toBe(0);
  });

  it('E2. one shipment + its lines, written by the same dispatch; snapshot = the order lines (name, unit, qty, rate, line total); billed_total = order total; addressed to Padre Garcia', async () => {
    const w = await world('e2');
    const { order, ship, customerId } = await dispatchedToPg(w);
    expect(await shipCount(order.orderId)).toBe(1);
    expect(ship).toMatchObject({
      orgId: w.f.orgId, buyerOrgId: w.g.orgId, tradeOrderId: order.orderId, storeId: w.f.storeId,
      billedTotal: BILLED, creditedTotal: '0.00', status: 'in_transit', receivedAt: null, receivedBy: null, receivedTotal: null,
    });
    expect(customerId).toBeTruthy();
    const lines = await asOrg(w.f.orgId, (tx) => interEntityRepo.linesOf(tx, ship.id));
    const orderLines = await asOrg(w.f.orgId, (tx) => tradeRepo.linesFor(tx, w.f.orgId, order.orderId));
    const idOf = (itemId: string) => orderLines.find((l) => l.itemId === itemId)!.id;
    expect(lines).toHaveLength(2);
    const byName = (n: string) => lines.find((l) => l.itemName === n)!;
    expect(byName(order.pork.name)).toMatchObject({
      unit: 'kg', quantity: '10.000', rate: '310.00', lineTotal: '3100.00', receivedQuantity: null, tradeOrderLineId: idOf(order.pork.id),
    });
    expect(byName(order.salt.name)).toMatchObject({
      unit: 'kg', quantity: '2.500', rate: '41.20', lineTotal: '103.00', receivedQuantity: null, tradeOrderLineId: idOf(order.salt.id),
    });
    expect([...lines.map((l) => l.lineNo)].sort()).toEqual([1, 2]);
    // Σ lines = header, to the centavo
    expect(lines.reduce((s, l) => s + BigInt(cents(l.lineTotal)), 0n).toString()).toBe(cents(ship.billedTotal));
    // the buyer can read the note, and nothing of the seller's cost is on it
    const seenByPg = await asOrg(w.g.orgId, (tx) => interEntityRepo.findById(tx, ship.id));
    expect(seenByPg?.id).toBe(ship.id);
    expect(JSON.stringify(lines)).not.toMatch(/250\.0000|2500\.00|2550\.00/);
  });

  it('E2b. a dispatch that fails writes no shipment (same transaction): the over-limit refusal leaves zero shipment rows', async () => {
    const w = await world('e2b');
    const customerId = await pgCustomer(w, { creditLimit: '1000.00' });
    const order = await makeOrder(w.f, customerId);
    await expect(dispatch(w.f, w.f.manager, order.orderId)).rejects.toThrow();
    expect(await shipCount(order.orderId)).toBe(0);
  });
});

// ================================================================================================ E13
describe('E13 the treatment comes from the counterparty link, never from the group label', () => {
  it('a franchise-group customer with NO counterparty_org_id posts as external and writes no shipment (mutant: derive treatment from customer_group)', async () => {
    const w = await world('e13');
    const c = await asOrg(w.f.orgId, (tx) =>
      createCustomer(tx, w.f.admin, { name: `Franchise no link ${uid('fr')}`, customerGroup: 'franchise', priceListId: null }),
    );
    const order = await makeOrder(w.f, c.id);
    const r = await dispatch(w.f, w.f.manager, order.orderId);
    expect(r.treatment).toBe('external');
    expect(r.chargeId).not.toBeNull();
    expect(await shipCount(order.orderId)).toBe(0);
    expect(await legsOf(w.f.orgId, order.orderId, r.chargeId!, c.id)).toEqual([
      `1210 D${cents(BILLED)} C0 customer:THE-CUSTOMER`,
      `1310 D0 C${cents(COST)} -`,
      `4300 D0 C${cents(BILLED)} -`,
      `5100 D${cents(COST)} C0 -`,
    ].sort());
  });

  it('the other way: a WHOLESALE-group customer that carries counterparty_org_id still ships a note (group decides nothing)', async () => {
    const w = await world('e13b');
    const customerId = await pgCustomer(w, { group: 'wholesale' });
    const order = await makeOrder(w.f, customerId);
    const r = await dispatch(w.f, w.f.manager, order.orderId);
    expect(r.treatment).toBe('inter_entity');
    expect(await shipCount(order.orderId)).toBe(1);
  });
});

// ================================================================================================ E18
describe('E18 a retried dispatch', () => {
  it('returns what the first did: one shipment, one charge, one set of entries (mutant: drop the early-return shipment guard)', async () => {
    const w = await world('e18');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId);
    const first = await dispatch(w.f, w.f.manager, order.orderId);
    const mid = await snap(w);
    const again = await dispatch(w.f, w.f.manager, order.orderId); // must resolve, not throw a unique violation
    expect(again.chargeId).toBe(first.chargeId);
    expect(again.entryId).toBe(first.entryId);
    expect(await snap(w)).toEqual(mid);
    expect(await shipCount(order.orderId)).toBe(1);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from ar_charges where customer_id = ${customerId}`;
    expect(n!.n).toBe(1);
    const lines = await sql<{ n: number }[]>`
      select count(*)::int as n from inter_entity_shipment_lines l join inter_entity_shipments s on s.id = l.shipment_id where s.trade_order_id = ${order.orderId}`;
    expect(lines[0]!.n).toBe(2);
  });
});

// ================================================================================================ E22
describe('E22 the seller does not receive for Padre Garcia', () => {
  it('receiveTradeOrder on a dispatched inter-entity order is refused in words; nothing is written (mutant: remove the refusal)', async () => {
    const w = await world('e22');
    const { order, ship } = await dispatchedToPg(w);
    const before = await snap(w);
    const r = await sayOf(asOrg(w.f.orgId, (tx) => receiveTradeOrder(tx, w.f.manager, { orderId: order.orderId })));
    expect(r.said).not.toBeNull();
    expect(r.said).toMatch(/Padre Garcia.*confirms receipt in its own books/);
    expect(r.message).toMatch(/Padre Garcia.*confirms receipt in its own books/);
    expect(await snap(w)).toEqual(before);
    expect(await orderStatus(order.orderId)).toBe('dispatched');
    const after = await shipOf(w.f, order.orderId);
    expect(after).toMatchObject({ id: ship.id, status: 'in_transit', receivedAt: null });
  });
});

// ================================================================================================ E23
describe('E23 no pay-now on a Padre Garcia dispatch (bible row 370)', () => {
  it('refused in words before any write: zero entries, zero stock moves, no shipment, no collection (mutant: drop the refusal)', async () => {
    const w = await world('e23');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId);
    const before = await snap(w);
    const r = await sayOf(dispatch(w.f, w.f.manager, order.orderId, payNow('1000.00', w.f.drawerA)));
    expect(r.said).not.toBeNull();
    expect(r.said).toMatch(/pa(y|id|yment)/i);
    expect(r.message).not.toMatch(REFUSED_NOT_RAW);
    expect(await snap(w)).toEqual(before); // entries, lines, movements, charges, collections, shipments all unchanged
    expect(await orderStatus(order.orderId)).not.toBe('dispatched');
    expect(await shipCount(order.orderId)).toBe(0);
    // and the same order dispatches fine without the payment (the refusal is about the payment, not the order)
    const ok = await dispatch(w.f, w.f.manager, order.orderId);
    expect(ok.chargeId).not.toBeNull();
    expect(await shipCount(order.orderId)).toBe(1);
  });
});

// ================================================================================================ E25
describe('E25 the booklet number rides the shipment', () => {
  it('an order with a bir_invoice_no -> the shipment carries it; without -> NULL (mutant: never copy it)', async () => {
    const w = await world('e25');
    const customerId = await pgCustomer(w);
    const withNo = await makeOrder(w.f, customerId, { birInvoiceNo: `BIR-${Date.now()}` });
    const withoutNo = await makeOrder(w.f, customerId);
    const [stored] = await sql<{ b: string }[]>`select bir_invoice_no as b from trade_orders where id = ${withNo.orderId}`;
    await dispatch(w.f, w.f.manager, withNo.orderId);
    await dispatch(w.f, w.f.manager, withoutNo.orderId);
    expect((await shipOf(w.f, withNo.orderId))!.birInvoiceNo).toBe(stored!.b);
    expect((await shipOf(w.f, withoutNo.orderId))!.birInvoiceNo).toBeNull();
  });

  it('E25b. the number set AFTER dispatch updates the order shipment (ruling 2), and changing it after Padre Garcia received updates it too (mutant: leave the note stale)', async () => {
    const w = await world('e25b');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId);
    await dispatch(w.f, w.f.manager, order.orderId);
    expect((await shipOf(w.f, order.orderId))!.birInvoiceNo).toBeNull();
    const n1 = `BIR-${Date.now()}-1`;
    await asOrg(w.f.orgId, (tx) => api.setBirInvoiceNo(tx, w.f.manager, { orderId: order.orderId, value: n1 }));
    const ship = (await shipOf(w.f, order.orderId))!;
    expect(ship.birInvoiceNo).toBe(n1);
    await pgReceivesAll(w, ship.id);
    const n2 = `BIR-${Date.now()}-2`;
    await asOrg(w.f.orgId, (tx) => api.setBirInvoiceNo(tx, w.f.manager, { orderId: order.orderId, value: n2 }));
    const after = (await shipOf(w.f, order.orderId))!;
    expect(after.birInvoiceNo).toBe(n2);
    expect(after).toMatchObject({ status: 'received', billedTotal: BILLED, creditedTotal: '0.00' });
    const seen = await asOrg(w.g.orgId, (tx) => interEntityRepo.findById(tx, ship.id));
    expect(seen!.birInvoiceNo).toBe(n2);
  });
});

// ================================================================================================ E27
describe('E27 the credit limit applies to Padre Garcia like any customer', () => {
  it('over the limit, no override -> refused as for an external customer, nothing written; with a manager override -> posts and ships (mutant: skip the gate when inter-entity)', async () => {
    const w = await world('e27');
    const customerId = await pgCustomer(w, { creditLimit: '1000.00' });
    const order = await makeOrder(w.f, customerId);
    const before = await snap(w);
    const r = await sayOf(dispatch(w.f, w.f.manager, order.orderId));
    expect(r.message).toMatch(/limit of ₱1000\.00/); // the same sentence an external customer gets (t433-s3)
    expect(await snap(w)).toEqual(before);
    expect(await shipCount(order.orderId)).toBe(0);

    const ok = await dispatch(w.f, w.f.manager, order.orderId, { creditOverrideReason: 'Owner agreed, pays Friday.' });
    expect(ok.creditOverridden).toBe(true);
    expect(await shipCount(order.orderId)).toBe(1);
    const o = await asOrg(w.f.orgId, (tx) => tradeRepo.getOrderById(tx, w.f.orgId, order.orderId));
    expect(o!.creditOverrideReason).toBe('Owner agreed, pays Friday.');
  });
});

// ================================================================================================ F1, T890 companion
describe('F1 no delivery fee on an inter-entity order (QO-6 default)', () => {
  it('creating one with a delivery fee is refused in the franchise-price words; nothing written (mutant: allow the fee)', async () => {
    const w = await world('f1');
    const customerId = await pgCustomer(w);
    const pork = await mkItem(w.f, 'Pork belly');
    const before = await snap(w);
    const r = await sayOf(
      asOrg(w.f.orgId, (tx) =>
        createTradeOrder(tx, w.f.manager, {
          storeId: w.f.storeId, customerId, orderDate: '2026-10-10', deliveryFee: '150.00',
          lines: [{ itemId: pork.id, quantity: '1', rate: '310.00' }],
        }),
      ),
    );
    expect(r.said).not.toBeNull();
    expect(r.said).toMatch(/Delivery charges to Padre Garcia.* go into the franchise price/);
    expect(await snap(w)).toEqual(before);
  });

  it('other fees are refused too (S5-REFRESH section 6: "Fees refused on inter-entity"); an EXTERNAL customer may still carry a delivery fee (guard against a blanket refusal)', async () => {
    const w = await world('f1b');
    const customerId = await pgCustomer(w);
    const pork = await mkItem(w.f, 'Pork belly');
    await expect(
      asOrg(w.f.orgId, (tx) =>
        createTradeOrder(tx, w.f.manager, {
          storeId: w.f.storeId, customerId, orderDate: '2026-10-10', otherFees: '20.00',
          lines: [{ itemId: pork.id, quantity: '1', rate: '310.00' }],
        }),
      ),
    ).rejects.toThrow(/fee|charge/i);
    const ext = await buyer(sql, w.f);
    const o = await asOrg(w.f.orgId, (tx) =>
      createTradeOrder(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: ext, orderDate: '2026-10-10', deliveryFee: '150.00',
        lines: [{ itemId: pork.id, quantity: '1', rate: '310.00' }],
      }),
    );
    expect(o.totalAmount).toBe('460.00');
  });
});

// ================================================================================================ E10, E11
describe('E10/E11 voiding a dispatched Padre Garcia order', () => {
  it('E10. after Padre Garcia received: refused, naming the receipt date; nothing reversed, nothing written', async () => {
    const w = await world('e10');
    const { order, r, ship } = await dispatchedToPg(w);
    await pgReceivesAll(w, ship.id);
    const day = await receiptDate(ship.id);
    const before = await snap(w);
    const res = await sayOf(asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Changed our mind.' })));
    expect(res.said).not.toBeNull();
    expect(res.said).toContain(day); // names the receipt date (YYYY-MM-DD, Manila)
    expect(res.said).toMatch(/received/i);
    expect(await snap(w)).toEqual(before);
    expect(await chargeStatus(r.chargeId!)).toBe('posted');
    expect(await orderStatus(order.orderId)).toBe('dispatched');
    expect(await onHand(w.f, order.pork.id)).toBe('10.000');
    expect((await shipOf(w.f, order.orderId))!.status).toBe('received');
  });

  it('E11. before receipt: charge reversed, stock back, shipment void; Padre Garcia\'s inbound list no longer shows it, and receiving it is refused (mutant: leave the shipment in_transit)', async () => {
    const w = await world('e11');
    const { order, r, ship, customerId } = await dispatchedToPg(w);
    const inboundBefore = await asOrg(w.g.orgId, (tx) => interEntityRepo.listInbound(tx, w.g.orgId));
    expect(inboundBefore.map((s) => s.id)).toContain(ship.id);

    const buyerBooks = (await snap(w)).buyer;
    const res = await asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Wrong item sent.' }));
    expect(res.reversedEntryId).not.toBeNull();
    expect(await chargeStatus(r.chargeId!)).toBe('voided');
    expect(await orderStatus(order.orderId)).toBe('void');
    expect(await onHand(w.f, order.pork.id)).toBe('20.000'); // 10 kg given back to the layers
    expect(await onHand(w.f, order.salt.id)).toBe('10.000');
    const [ar] = await sql<{ b: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${w.f.orgId} and jl.party_type = 'customer' and jl.party_id = ${customerId} and a.code = '1210'`;
    expect(cents(ar!.b)).toBe('0');

    const after = await shipOf(w.f, order.orderId);
    expect(after).toMatchObject({ id: ship.id, status: 'void', voidReason: 'Wrong item sent.' });
    expect(after!.voidedAt).not.toBeNull();
    const inbound = await asOrg(w.g.orgId, (tx) => interEntityRepo.listInbound(tx, w.g.orgId));
    expect(inbound.map((s) => s.id)).not.toContain(ship.id);
    const all = await asOrg(w.g.orgId, (tx) => interEntityRepo.listInbound(tx, w.g.orgId, { includeVoid: true }));
    expect(all.find((s) => s.id === ship.id)?.status).toBe('void');
    expect((await snap(w)).buyer).toEqual(buyerBooks); // Padre Garcia's books never moved

    // and Padre Garcia can no longer receive it (the S5b definer, in words)
    await expect(pgReceivesAll(w, ship.id)).rejects.toThrow(/cancelled by the sender/);
  });
});

// ================================================================================================ E17
describe('E17 void (Ian) against receive (Padre Garcia), two connections', () => {
  it('deterministic half: Padre Garcia holds the shipment lock mid-receive; the void must WAIT, then be refused naming the receipt (mutant: drop FOR UPDATE -> the void finishes early or reverses a received sale)', async () => {
    const w = await world('e17d');
    const { order, r, ship } = await dispatchedToPg(w);
    let unlocked!: () => void;
    const held = new Promise<void>((res) => (unlocked = res));
    let locked!: () => void;
    const lockedP = new Promise<void>((res) => (locked = res));
    const receiving = pgReceivesAll(w, ship.id, async () => {
      locked();
      await held;
    });
    await lockedP; // receive has run and holds the shipment row FOR UPDATE, uncommitted

    let voidSettled = false;
    const voiding = sayOf(asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Race.' }))).then(
      (x) => { voidSettled = true; return x; },
      (e) => { voidSettled = true; throw e; },
    );
    voiding.catch(() => undefined);
    await sleep(500);
    expect(voidSettled, 'the void did not wait for Padre Garcia\'s in-flight receive').toBe(false);
    unlocked();
    await receiving;
    const res = await voiding;
    expect(res.said).toContain(await receiptDate(ship.id));
    expect(await chargeStatus(r.chargeId!)).toBe('posted');
    expect((await shipOf(w.f, order.orderId))!.status).toBe('received');
    expect(await orderStatus(order.orderId)).toBe('dispatched');
  }, 60_000);

  it('x20 with a barrier: exactly one of void / receive wins, the other is refused in words, and the books agree with the winner', async () => {
    const w = await world('e17x');
    const customerId = await pgCustomer(w);
    const outcomes = { received: 0, voided: 0 };
    for (let i = 0; i < 20; i++) {
      const order = await makeOrder(w.f, customerId);
      const r = await dispatch(w.f, w.f.manager, order.orderId);
      const ship = (await shipOf(w.f, order.orderId))!;
      const lines = await asOrg(w.g.orgId, (tx) => interEntityRepo.linesOf(tx, ship.id));

      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      const barrier = async () => {
        if (++arrived === 2) release();
        await gate;
      };
      const settle = async <T,>(fn: () => Promise<T>) => {
        await barrier();
        try {
          return { ok: true as const, value: await fn() };
        } catch (err) {
          const e = err as { userMessage?: string; message?: string };
          return { ok: false as const, said: e.userMessage ?? e.message ?? String(err) };
        }
      };
      const [v, rcv] = await Promise.all([
        settle(() => asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: `Race ${i}` }))),
        settle(() =>
          asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
            interEntityRepo.receive(tx, ship.id, lines.map((l) => ({ lineId: l.id, receivedQuantity: quantity(l.quantity) }))),
          ),
        ),
      ]);
      expect(Number(v.ok) + Number(rcv.ok), `round ${i}: both or neither won (void ok=${v.ok}, receive ok=${rcv.ok})`).toBe(1);
      const final = (await shipOf(w.f, order.orderId))!;
      if (rcv.ok) {
        outcomes.received++;
        expect(v.ok === false && v.said, `round ${i}: void refusal`).toContain(await receiptDate(ship.id));
        expect(final.status).toBe('received');
        expect(await chargeStatus(r.chargeId!)).toBe('posted');
        expect(await onHand(w.f, order.pork.id)).toBe('10.000');
      } else {
        outcomes.voided++;
        expect(rcv.ok === false && rcv.said, `round ${i}: receive refusal`).toMatch(/cancelled by the sender/);
        expect(final.status).toBe('void');
        expect(await chargeStatus(r.chargeId!)).toBe('voided');
        expect(await onHand(w.f, order.pork.id)).toBe('20.000');
      }
    }
    expect(outcomes.received + outcomes.voided).toBe(20);
  }, 300_000);
});

// ================================================================================================ S5c audit
describe('S5c audit', () => {
  it('V1. a void racing a dispatch: the void waits for the open dispatch, then fully reverses it (or is refused in words); never order void with the charge live / shipment in_transit', async () => {
    const w = await world('v1');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId);
    await asOrg(w.f.orgId, (tx) => confirmTradeOrder(tx, w.f.manager, { orderId: order.orderId }));

    let commit!: () => void;
    const held = new Promise<void>((res) => (commit = res));
    let written!: () => void;
    const writtenP = new Promise<void>((res) => (written = res));
    const dispatching = asOrg(w.f.orgId, async (tx) => {
      const r = await dispatchTradeOrder(tx, w.f.manager, { orderId: order.orderId });
      written(); // the dispatch has written; its transaction stays open (the order row is held, uncommitted)
      await held;
      return r;
    });
    await writtenP;

    let voidSettled = false;
    const voiding = sayOf(asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Race with dispatch.' })))
      .then((x) => { voidSettled = true; return { ok: false as const, said: x.said ?? x.message }; }, () => { voidSettled = true; return { ok: true as const }; });
    await sleep(500);
    expect(voidSettled, 'the void did not wait for the open dispatch').toBe(false);
    commit();
    const disp = await dispatching;
    await voiding;

    const [o] = await sql<{ status: string; ar: string | null }[]>`select status, ar_charge_id as ar from trade_orders where id = ${order.orderId}`;
    const ship = await shipOf(w.f, order.orderId);
    if (o!.status === 'void') {
      // the void won after the dispatch: everything the dispatch did is reversed
      expect(await chargeStatus(disp.chargeId!), 'order void but the charge is live').toBe('voided');
      expect(await onHand(w.f, order.pork.id)).toBe('20.000');
      expect(await onHand(w.f, order.salt.id)).toBe('10.000');
      expect(ship?.status, 'order void but the shipment is not').toBe('void');
    } else {
      // refused in words: the dispatch stands whole
      expect(o!.status).toBe('dispatched');
      expect(await chargeStatus(disp.chargeId!)).toBe('posted');
      expect(ship?.status).toBe('in_transit');
    }
  }, 60_000);

  it('V1b. markVoided on an already-void order changes nothing (status guard): the first void reason and time stand, no second reversal', async () => {
    const w = await world('v1b');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId);
    await dispatch(w.f, w.f.manager, order.orderId);
    await asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'First reason.' }));
    const [before] = await sql<{ r: string; at: Date; by: string }[]>`select void_reason as r, voided_at as at, voided_by as by from trade_orders where id = ${order.orderId}`;
    const snapBefore = await snap(w);
    await asOrg(w.f.orgId, (tx) => tradeRepo.markVoided(tx, w.f.orgId, order.orderId, { voidedBy: w.f.admin.personId, voidReason: 'Second reason.' })).catch(() => undefined);
    const [after] = await sql<{ r: string; at: Date; by: string }[]>`select void_reason as r, voided_at as at, voided_by as by from trade_orders where id = ${order.orderId}`;
    expect(after).toEqual(before);
    expect(await snap(w)).toEqual(snapBefore);
    await expect(asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Again.' }))).rejects.toThrow(/already void/);
  });

  it('V2. voiding a dispatched Padre Garcia order that carried a booklet number frees it on the note too: the void shipment bir_invoice_no is NULL', async () => {
    const w = await world('v2');
    const customerId = await pgCustomer(w);
    const order = await makeOrder(w.f, customerId, { birInvoiceNo: `BIR-${Date.now()}` });
    await dispatch(w.f, w.f.manager, order.orderId);
    expect((await shipOf(w.f, order.orderId))!.birInvoiceNo).not.toBeNull();
    await asOrg(w.f.orgId, (tx) => voidTradeOrder(tx, w.f.manager, { orderId: order.orderId, reason: 'Wrong buyer.' }));
    const [o] = await sql<{ b: string | null }[]>`select bir_invoice_no as b from trade_orders where id = ${order.orderId}`;
    expect(o!.b).toBeNull();
    const ship = (await shipOf(w.f, order.orderId))!;
    expect(ship.status).toBe('void');
    expect(ship.birInvoiceNo).toBeNull();
  });
});
