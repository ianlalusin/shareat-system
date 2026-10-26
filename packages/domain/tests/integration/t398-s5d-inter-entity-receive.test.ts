import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { apRepo, closeDb, interEntityRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { money, toCentavos } from '@shareat/core/money';
import * as domain from '@shareat/domain';
import { createItem } from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';
import { asOrg, fixture, freezeClock, sayOf, thawClock, uid, wholesaleItem, type Fx } from './_fixtures/t433-b2b';

/**
 * T-398 S5d (TESTER) - the BUYER side: Padre Garcia (org g) receives the commissary's (org f) inter-entity shipment in its own books.
 * docs/tasks/398-s5/TESTS.md "S5d - buyer side" (E6 E7a E8 E9 E20 B1 B2 G1), S5-REFRESH.md sections 1-8, QUESTIONS.md (QO-1, QI-1 a,
 * "Audit fixes landed" finding 4). Real Postgres (TEST_DATABASE_URL, `_test` guard). Shipments are seeded as the table OWNER (the S5b
 * shape), so this file does not depend on S5c's dispatch. Clock frozen at 2026-10-16 (JS Date only; the database's now() is real).
 *
 * THE CONTRACT THIS FILE PINS (the spec is silent on names; every one is flagged in the hand-back). Reached through `api`, a namespace cast,
 * so a missing export reads "not a function", never a compile error:
 *   receiveInterEntityShipment(tx, actor, { shipmentId, storeId, lines: [{ shipmentLineId, itemId, receivedQuantity }] })
 *     - exported from @shareat/domain (packages/domain/src/deliveries/inter-entity.ts), runs under the buyer's principal;
 *     - authorize(receive_delivery, store); itemId = the buyer's own item the line is mapped to, and it must be declared in
 *       supplier_items for the buyer's supplier row of the commissary (suppliers.counterparty_org_id = seller org);
 *     - posts DR 1310 / CR 2120 (source_type stock_receipt) then DR 2120 / CR 2110 party supplier (source_type stock_receipt_invoice),
 *       both at received quantity x shipment rate, writes one deliveries row (kind inter_entity, inter_entity_shipment_id), a layer per
 *       line at the shipment rate, and calls the receive_inter_entity_shipment definer - all in the caller's transaction.
 *   listInboundShipments(tx, actor) -> rows; getInboundShipment(tx, actor, shipmentId) -> row | null. Rows (camelCase): id, shippedOn,
 *     status, billedTotal, receivedAt, receivedTotal, lines[]: { id, lineNo, itemName, unit, quantity, rate, lineTotal, receivedQuantity }.
 *     They are served by a SECURITY DEFINER function (finding 4), so NO void_reason / voided_by / store_id / trade-order id reaches the buyer.
 * Every refusal is a RefusalError (`userMessage` set), the project convention; B1's direct definer call is the one raw-database sentence.
 *
 * MUTANTS (each names the leg that must turn red): post CR 2120 only, no bill -> E6, E6c; post at dispatched quantity -> E7a, E7b;
 *   drop the partial UNIQUE on deliveries.inter_entity_shipment_id -> E8b; drop the "already received" refusal -> E8; skip authorize -> E9;
 *   drop the over-receipt refusal -> E20; drop the buyer check in the receive path -> B1 (see the hand-back: RLS alone also hides the row,
 *   so only dropping both reds B1); skip the supplier_items check -> B2, B2b; read the table instead of the definer in the buyer's read -> F4a, F4b.
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

const api = domain as unknown as {
  receiveInterEntityShipment: (tx: unknown, actor: unknown, input: Record<string, unknown>) => Promise<unknown>;
  listInboundShipments: (tx: unknown, actor: unknown, opts?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  getInboundShipment: (tx: unknown, actor: unknown, shipmentId: string) => Promise<Record<string, unknown> | null>;
};

// ------------------------------------------------------------------------------------------------ helpers
const cents = (v: string) => toCentavos(money(v)).toString();

/** The buyer's principal: the receive definer reads `app.person_id` (the app sets it in withOrgPrincipal). */
async function asPerson<T>(orgId: string, personId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`select set_config('app.person_id', ${personId}, true)`);
    return fn(tx);
  });
}

/** Everything a person is shown of a failure: the sentence plus, for a wrapped database error, its cause. */
const rawText = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ''} | ${e.cause?.message ?? ''}`;
};

/** A refusal is a refusal, not a missing function: a TypeError "is not a function" must never count as one. */
const notMissing = (err: unknown) => expect(rawText(err), 'the behaviour does not exist yet (missing export), which is not a refusal').not.toMatch(/is not a function|is not defined|Cannot read/);

interface World {
  f: Fx; // seller: the commissary
  g: Fx; // buyer: Padre Garcia
  sellerItem: string;
  supplierId: string; // g's supplier row for the commissary
  pork: { id: string; name: string }; // g's items
  salt: { id: string; name: string };
}

async function mkBuyerItem(g: Fx, name: string) {
  const full = `${name} ${uid('pg')}`;
  const item = await asOrg(g.orgId, (tx) =>
    createItem(tx, g.superAdmin, { code: testItemCode(), name: full, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: false }),
  );
  return { id: item.id, name: full };
}

async function world(hint: string): Promise<World> {
  const f = await fixture(sql, `${hint}f`);
  const g = await fixture(sql, `${hint}g`);
  const sellerItem = await wholesaleItem(f, 'Pork');
  const [sup] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, status, created_by, counterparty_org_id)
    values (${g.orgId}, ${uid('Commissary')}, 'active', ${g.manager.personId}, ${f.orgId}) returning id`;
  const pork = await mkBuyerItem(g, 'Pork belly');
  const salt = await mkBuyerItem(g, 'Salt');
  for (const it of [pork, salt]) {
    await sql`insert into supplier_items (org_id, supplier_id, item_id, created_by) values (${g.orgId}, ${sup!.id}, ${it.id}, ${g.manager.personId})`;
  }
  return { f, g, sellerItem, supplierId: sup!.id, pork, salt };
}

interface Seeded {
  shipmentId: string;
  porkLine: string;
  saltLine: string | null;
  porkName: string;
  saltName: string;
  billed: string;
  orderId: string;
}

/**
 * A shipment f -> `buyerOrgId` written as the owner (the S5b helper's shape). 'two': 10.000 kg pork belly at 310.00 (3100.00) + 2.500 kg
 * salt at 41.20 (103.00) = 3203.00. 'one': the pork line only (3100.00). `void` stamps a voided shipment with a secret reason.
 */
async function seed(w: World, o: { lines?: 'one' | 'two'; buyerOrgId?: string; void?: { reason: string } } = {}): Promise<Seeded> {
  const buyerOrgId = o.buyerOrgId ?? w.g.orgId;
  const two = (o.lines ?? 'two') === 'two';
  const billed = two ? '3203.00' : '3100.00';
  const tag = uid('t');
  const porkName = `Pork belly ${tag}`;
  const saltName = `Salt ${tag}`;
  const [cu] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, counterparty_org_id, created_by) values (${w.f.orgId}, ${uid('PG')}, ${buyerOrgId}, ${w.f.admin.personId}) returning id`;
  const [ord] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
    values (${w.f.orgId}, ${w.f.storeId}, ${cu!.id}, '2026-10-10', 'draft', ${billed}, ${w.f.manager.personId}) returning id`;
  const [ol1] = await sql<{ id: string }[]>`
    insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
    values (${w.f.orgId}, ${ord!.id}, ${w.sellerItem}, '10.000', 'kg', '310.00', '3100.00') returning id`;
  const ol2 = two
    ? (await sql<{ id: string }[]>`
        insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
        values (${w.f.orgId}, ${ord!.id}, ${w.sellerItem}, '2.500', 'kg', '41.20', '103.00') returning id`)[0]!.id
    : null;
  // header and lines in ONE transaction: the billed-total = sum(lines) check is deferred to its end
  const { shId, l1Id, l2Id } = await sql.begin(async (t0) => {
    const t = t0 as unknown as postgres.Sql;
    const [sh] = await t<{ id: string }[]>`
      insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
      values (${w.f.orgId}, ${buyerOrgId}, ${ord!.id}, ${w.f.storeId}, '2026-10-16', ${billed}, 'in_transit') returning id`;
    const [l1] = await t<{ id: string }[]>`
      insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.f.orgId}, ${buyerOrgId}, ${sh!.id}, ${ol1!.id}, 1, ${porkName}, 'kg', '10.000', '310.00', '3100.00') returning id`;
    let l2: string | null = null;
    if (ol2) {
      const [r] = await t<{ id: string }[]>`
        insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
        values (${w.f.orgId}, ${buyerOrgId}, ${sh!.id}, ${ol2}, 2, ${saltName}, 'kg', '2.500', '41.20', '103.00') returning id`;
      l2 = r!.id;
    }
    return { shId: sh!.id, l1Id: l1!.id, l2Id: l2 };
  });
  if (o.void) {
    await sql`update inter_entity_shipments set status = 'void', voided_at = now(), voided_by = ${w.f.manager.personId}, void_reason = ${o.void.reason} where id = ${shId}`;
  }
  return { shipmentId: shId, porkLine: l1Id, saltLine: l2Id, porkName, saltName, billed, orderId: ord!.id };
}

/** PG's count: pork and salt quantities (a one-line shipment has no salt). `itemOf` overrides the mapped item per line. */
function receiveInput(w: World, s: Seeded, q: { pork: string; salt?: string }, over: { porkItem?: string | null } = {}) {
  const lines: Record<string, unknown>[] = [
    { shipmentLineId: s.porkLine, ...(over.porkItem === null ? {} : { itemId: over.porkItem ?? w.pork.id }), receivedQuantity: q.pork },
  ];
  if (s.saltLine) lines.push({ shipmentLineId: s.saltLine, itemId: w.salt.id, receivedQuantity: q.salt ?? '2.500' });
  return { shipmentId: s.shipmentId, storeId: w.g.storeId, lines };
}

const pgReceives = (w: World, input: Record<string, unknown>, who = w.g.manager) =>
  asPerson(w.g.orgId, who.personId, (tx) => api.receiveInterEntityShipment(tx, who, input));

/** Row counts that must not move when a call is refused. Both organisations' books, plus the shipment's own state. */
async function snap(orgIds: string[], shipmentId?: string) {
  const one = async (orgId: string) => {
    const [r] = await sql<Record<string, number>[]>`
      select
        (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
        (select count(*)::int from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${orgId}) as journal_lines,
        (select count(*)::int from stock_movements where org_id = ${orgId}) as movements,
        (select count(*)::int from stock_layers where org_id = ${orgId}) as layers,
        (select count(*)::int from deliveries where org_id = ${orgId}) as deliveries,
        (select count(*)::int from supplier_invoices where org_id = ${orgId}) as supplier_invoices,
        (select count(*)::int from expenses where org_id = ${orgId}) as expenses`;
    return r!;
  };
  const books = await Promise.all(orgIds.map(one));
  const ship = shipmentId
    ? (await sql<{ status: string; received_at: string | null; counted: number }[]>`
        select s.status, s.received_at::text as received_at,
               (select count(*)::int from inter_entity_shipment_lines l where l.shipment_id = s.id and l.received_quantity is not null) as counted
        from inter_entity_shipments s where s.id = ${shipmentId}`)[0]
    : null;
  return { books, ship };
}

/** Σ per (source_type, account): debit and credit in centavos, for one org's receipt entries; plus the 2110 party. */
async function receiptTotals(orgId: string) {
  const rows = await sql<{ source_type: string; code: string; d: string; c: string }[]>`
    select je.source_type, a.code, sum(jl.debit)::text as d, sum(jl.credit)::text as c
    from journal_entries je join journal_lines jl on jl.entry_id = je.id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_type in ('stock_receipt', 'stock_receipt_invoice') and je.status = 'posted'
    group by je.source_type, a.code`;
  return Object.fromEntries(rows.map((r) => [`${r.source_type}|${r.code}`, `D${cents(r.d)} C${cents(r.c)}`]));
}

async function expectEntriesBalanced(orgId: string) {
  const rows = await sql<{ d: string; c: string }[]>`
    select sum(jl.debit)::text as d, sum(jl.credit)::text as c
    from journal_entries je join journal_lines jl on jl.entry_id = je.id
    where je.org_id = ${orgId} and je.source_type in ('stock_receipt', 'stock_receipt_invoice') group by je.id`;
  expect(rows.length, 'the receipt wrote its two entries').toBeGreaterThanOrEqual(2);
  for (const r of rows) expect(cents(r.d)).toBe(cents(r.c));
}

const deliveriesOf = (orgId: string, shipmentId: string) =>
  sql<{ id: string; kind: string; status: string; supplier_id: string; store_id: string }[]>`
    select id, kind, status, supplier_id, store_id from deliveries where org_id = ${orgId} and inter_entity_shipment_id = ${shipmentId}`;
const receiptDate = async (shipmentId: string) =>
  (await sql<{ d: string }[]>`select to_char(received_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as d from inter_entity_shipments where id = ${shipmentId}`)[0]!.d;
const openItemsOf = (w: World) => asOrg(w.g.orgId, (tx) => apRepo.openItems(tx, w.g.orgId, w.supplierId, w.g.storeId));
const layerOf = async (orgId: string, deliveryId: string, itemId: string) =>
  (await sql<{ unit_cost: string; quantity: string }[]>`
    select unit_cost::text, quantity::text from stock_layers where org_id = ${orgId} and source = 'delivery' and source_id = ${deliveryId} and item_id = ${itemId}`)[0];

// ================================================================================================ E6, E6b, E6c
describe('E6 PG receives in full: the shipment is the bill (QO-1 a)', () => {
  it('E6. DR 1310 / CR 2120, then DR 2120 / CR 2110 party = the commissary supplier, all 3203.00; layers at the shipment rate; delivery links the shipment; ONE AP open item = 3203.00; the seller books do not move (kills: CR 2120 only, no bill)', async () => {
    const w = await world('e6');
    const s = await seed(w);
    const before = await snap([w.f.orgId], s.shipmentId);
    await pgReceives(w, receiveInput(w, s, { pork: '10', salt: '2.5' }));

    // accounts and amounts, in centavos, per entry kind
    expect(await receiptTotals(w.g.orgId), 'PG books: receipt then bill').toEqual({
      'stock_receipt|1310': 'D320300 C0',
      'stock_receipt|2120': 'D0 C320300',
      'stock_receipt_invoice|2120': 'D320300 C0',
      'stock_receipt_invoice|2110': 'D0 C320300',
    });
    await expectEntriesBalanced(w.g.orgId);
    // the party on 2110 is PG's supplier row for the commissary, and 2120 nets to zero
    const ap = await sql<{ party_type: string | null; party_id: string | null; credit: string }[]>`
      select jl.party_type, jl.party_id, jl.credit::text from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${w.g.orgId} and a.code = '2110' and jl.credit > 0`;
    expect(ap.map((r) => [r.party_type, r.party_id, cents(r.credit)])).toEqual([['supplier', w.supplierId, '320300']]);
    const [grni] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as net from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${w.g.orgId} and a.code = '2120'`;
    expect(cents(grni!.net), 'goods-received-not-invoiced is cleared').toBe('0');

    // the delivery links the shipment; layers cost the SHIPMENT rate (never the commissary cost)
    const d = await deliveriesOf(w.g.orgId, s.shipmentId);
    expect(d.map((r) => [r.kind, r.status, r.supplier_id, r.store_id])).toEqual([['inter_entity', 'received', w.supplierId, w.g.storeId]]);
    expect(await layerOf(w.g.orgId, d[0]!.id, w.pork.id)).toEqual({ unit_cost: '310.0000', quantity: '10.000' });
    expect(await layerOf(w.g.orgId, d[0]!.id, w.salt.id)).toEqual({ unit_cost: '41.2000', quantity: '2.500' });

    // the shipment is stamped by the definer, by PG's person; counts recorded per line (QI-1 a)
    const [sh] = await sql<{ status: string; received_by: string; received_total: string }[]>`
      select status, received_by, received_total::text from inter_entity_shipments where id = ${s.shipmentId}`;
    expect([sh!.status, sh!.received_by, cents(sh!.received_total)]).toEqual(['received', w.g.manager.personId, '320300']);

    // ap.openItems: one open item, the whole shipment
    const open = await openItemsOf(w);
    expect(open.map((o) => [o.supplierId, o.outstanding])).toEqual([[w.supplierId, '3203.00']]);

    // nothing was written into the commissary's books
    const after = await snap([w.f.orgId], s.shipmentId);
    expect(after.books, 'the seller books are untouched').toEqual(before.books);
  });

  it('E6b. the seller can read, through the S5b definer, exactly what PG posted: 3203.00 for this shipment (the receipt entry, not the bill)', async () => {
    const w = await world('e6b');
    const s = await seed(w);
    await pgReceives(w, receiveInput(w, s, { pork: '10', salt: '2.5' }));
    const rows = await asOrg(w.f.orgId, (tx) => interEntityRepo.buyerPosted(tx, [s.shipmentId]));
    expect(rows.map((r) => [r.shipmentId, cents(r.postedTotal)])).toEqual([[s.shipmentId, '320300']]);
  });

  it('E6c. PG can pay the commissary from its ordinary AP screen: the open item carries the supplier, the store and the full outstanding (kills: 2110 credit with no bill row)', async () => {
    const w = await world('e6c');
    const s = await seed(w, { lines: 'one' });
    await pgReceives(w, receiveInput(w, s, { pork: '10' }));
    const open = await openItemsOf(w);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ supplierId: w.supplierId, storeId: w.g.storeId, outstanding: '3100.00' });
    const [inv] = await sql<{ status: string; n: number }[]>`
      select min(status) as status, count(*)::int as n from supplier_invoices where org_id = ${w.g.orgId} and supplier_id = ${w.supplierId}`;
    expect(inv!.n, 'one system bill for the shipment').toBe(1);
  });
});

// ================================================================================================ E7a, E7b
describe('E7 PG receives LESS than was shipped: AP is for what arrived, to the centavo', () => {
  it('E7a. 8.000 of 10.000 kg at 310.00: stock 8, layer cost 310.0000, 1310 DR 2480.00, 2110 CR 2480.00, open item 2480.00 (kills: post at dispatched quantity)', async () => {
    const w = await world('e7a');
    const s = await seed(w, { lines: 'one' });
    await pgReceives(w, receiveInput(w, s, { pork: '8' }));
    expect(await receiptTotals(w.g.orgId)).toEqual({
      'stock_receipt|1310': 'D248000 C0',
      'stock_receipt|2120': 'D0 C248000',
      'stock_receipt_invoice|2120': 'D248000 C0',
      'stock_receipt_invoice|2110': 'D0 C248000',
    });
    await expectEntriesBalanced(w.g.orgId);
    const d = (await deliveriesOf(w.g.orgId, s.shipmentId))[0]!;
    expect(await layerOf(w.g.orgId, d.id, w.pork.id)).toEqual({ unit_cost: '310.0000', quantity: '8.000' });
    const [mv] = await sql<{ q: string }[]>`select coalesce(sum(quantity), 0)::text as q from stock_movements where org_id = ${w.g.orgId} and item_id = ${w.pork.id}`;
    expect(mv!.q).toBe('8.000');
    const open = await openItemsOf(w);
    expect(open.map((o) => o.outstanding)).toEqual(['2480.00']);
    const [sh] = await sql<{ received_total: string; q: string }[]>`
      select s.received_total::text, (select received_quantity::text from inter_entity_shipment_lines where shipment_id = s.id) as q from inter_entity_shipments s where s.id = ${s.shipmentId}`;
    expect([sh!.received_total, sh!.q]).toEqual(['2480.00', '8.000']);
  });

  it('E7b. a rounding fixture: salt 2.333 of 2.500 kg at 41.20 = 96.1196 -> 96.12 per line; AP = 3100.00 + 96.12 = 3196.12 exactly (kills: post at dispatched quantity; kills: round the rate)', async () => {
    const w = await world('e7b');
    const s = await seed(w);
    await pgReceives(w, receiveInput(w, s, { pork: '10', salt: '2.333' }));
    expect((await receiptTotals(w.g.orgId))['stock_receipt_invoice|2110']).toBe('D0 C319612');
    expect((await receiptTotals(w.g.orgId))['stock_receipt|1310']).toBe('D319612 C0');
    expect((await openItemsOf(w)).map((o) => o.outstanding)).toEqual(['3196.12']);
    const [sh] = await sql<{ received_total: string }[]>`select received_total::text from inter_entity_shipments where id = ${s.shipmentId}`;
    expect(sh!.received_total).toBe('3196.12');
  });
});

// ================================================================================================ E8
describe('E8 receiving twice', () => {
  it('E8. the second receive is refused in words with the date it was received; one delivery, one bill, nothing else written (kills: drop the already-received refusal)', async () => {
    const w = await world('e8');
    const s = await seed(w, { lines: 'one' });
    await pgReceives(w, receiveInput(w, s, { pork: '10' }));
    const on = await receiptDate(s.shipmentId);
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '10' })));
    expect(r.said, `not a RefusalError sentence: ${rawText(r.err)}`).not.toBeNull();
    expect(r.said).toMatch(new RegExp(`already received on ${on}`, 'i'));
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
    expect(await deliveriesOf(w.g.orgId, s.shipmentId)).toHaveLength(1);
    expect((await openItemsOf(w)).map((o) => o.outstanding)).toEqual(['3100.00']);
  });

  it('E8b. the database backstop: two live deliveries for one shipment are refused 23505 (kills: drop the partial unique)', async () => {
    const w = await world('e8b');
    const s = await seed(w, { lines: 'one' });
    const ins = () => sql`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, created_by, inter_entity_shipment_id)
      values (${w.g.orgId}, ${w.g.storeId}, 'inter_entity', ${w.supplierId}, '2026-10-16', ${w.g.manager.personId}, ${s.shipmentId})`;
    await ins();
    const err = await ins().then(() => undefined, (e: { code?: string }) => e);
    expect(err, 'the second live delivery was ACCEPTED').toBeDefined();
    expect(err!.code).toBe('23505');
  });
});

// ================================================================================================ E9
describe('E9 who may receive', () => {
  it('E9. a PG person without receive_delivery gets AuthorizationError; nothing is written and the shipment stays in transit (the check: skip authorize -> red)', async () => {
    const w = await world('e9');
    const s = await seed(w, { lines: 'one' });
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    // the collector holds record_ar_collection and nothing of the stock path
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '10' }), w.g.collector));
    expect(r.err, `expected AuthorizationError, got ${rawText(r.err)}`).toBeInstanceOf(AuthorizationError);
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
    expect(before.ship!.status).toBe('in_transit');
  });

  it('E9b. a seller-side manager cannot receive for PG: the seller org is not the buyer, nothing is written', async () => {
    const w = await world('e9b');
    const s = await seed(w, { lines: 'one' });
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    const r = await sayOf(asPerson(w.f.orgId, w.f.manager.personId, (tx) => api.receiveInterEntityShipment(tx, w.f.manager, receiveInput(w, s, { pork: '10' }))));
    notMissing(r.err);
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
  });
});

// ================================================================================================ E20
describe('E20 over-receipt', () => {
  it('E20. 11.000 of 10.000 kg: refused in words naming the line and the shipped quantity; nothing written in either book (kills: drop the over-receipt refusal)', async () => {
    const w = await world('e20');
    const s = await seed(w);
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '11', salt: '2.5' })));
    expect(r.said, `not a RefusalError sentence: ${rawText(r.err)}`).not.toBeNull();
    expect(r.said).toContain(s.porkName);
    expect(r.said).toMatch(/10(\.000)?/);
    expect(r.said).not.toMatch(/SQLSTATE|violates|constraint/i);
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
    expect(before.ship).toMatchObject({ status: 'in_transit', counted: 0 });
    expect(await deliveriesOf(w.g.orgId, s.shipmentId)).toHaveLength(0);
  });
});

// ================================================================================================ B1
describe('B1 a forged shipment id', () => {
  it('B1. PG receives a shipment addressed to org C: refused, nothing written in PG, the commissary or C; the direct definer call says it is not addressed to PG', async () => {
    const w = await world('b1');
    const c = await fixture(sql, 'b1c');
    const s = await seed(w, { lines: 'one', buyerOrgId: c.orgId });
    const before = await snap([w.f.orgId, w.g.orgId, c.orgId], s.shipmentId);
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '10' })));
    notMissing(r.err);
    expect(rawText(r.err)).not.toMatch(/SQLSTATE/);
    expect(await snap([w.f.orgId, w.g.orgId, c.orgId], s.shipmentId)).toEqual(before);
    expect(before.ship).toMatchObject({ status: 'in_transit', counted: 0 });

    // the definer itself, called as PG with the forged id and a real line id of that shipment
    const direct = await sayOf(
      asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
        interEntityRepo.receive(tx, s.shipmentId, [{ lineId: s.porkLine, receivedQuantity: '10.000' as never }]),
      ),
    );
    expect(rawText(direct.err)).toMatch(/not addressed to your organisation/i);
    expect((await snap([w.f.orgId, w.g.orgId, c.orgId], s.shipmentId)).ship).toMatchObject({ status: 'in_transit', counted: 0 });
  });
});

// ================================================================================================ B2
describe('B2 the item mapping (supplier_items)', () => {
  it('B2. a line mapped to a PG item that is NOT declared in supplier_items for the commissary: refused naming the line and asking to map the item; nothing written (kills: skip the mapping check)', async () => {
    const w = await world('b2');
    const s = await seed(w, { lines: 'one' });
    const stray = await mkBuyerItem(w.g, 'Unmapped pork'); // exists, never declared for this supplier
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '10' }, { porkItem: stray.id })));
    expect(r.said, `not a RefusalError sentence: ${rawText(r.err)}`).not.toBeNull();
    expect(r.said).toContain(s.porkName);
    expect(r.said).toMatch(/map/i);
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
  });

  it('B2b. a line sent with no item at all: refused naming the line, same words about mapping; nothing written', async () => {
    const w = await world('b2b');
    const s = await seed(w, { lines: 'one' });
    const before = await snap([w.f.orgId, w.g.orgId], s.shipmentId);
    const r = await sayOf(pgReceives(w, receiveInput(w, s, { pork: '10' }, { porkItem: null })));
    expect(r.said, `not a RefusalError sentence: ${rawText(r.err)}`).not.toBeNull();
    expect(r.said).toContain(s.porkName);
    expect(r.said).toMatch(/map/i);
    expect(await snap([w.f.orgId, w.g.orgId], s.shipmentId)).toEqual(before);
  });
});

// ================================================================================================ FINDING 4 (QI-1 a)
/** Every key anywhere in a value, lower-cased with underscores removed (voidReason and void_reason both -> voidreason). */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k.toLowerCase().replace(/_/g, ''));
      keysDeep(x, out);
    }
  }
  return out;
}
const FORBIDDEN_KEYS = ['voidreason', 'voidedby', 'storeid', 'tradeorderid', 'tradeorderlineid'];

describe('F4 the buyer reads a shipment through a definer function that returns only what QI-1 (a) allows (audit finding 4)', () => {
  const SECRET = 'SECRET-VOID-REASON-the-customer-changed-their-mind';

  it('F4a. the inbound list: per-item names, quantities, rates, line totals, billed total, dates, status are there; void_reason, voided_by, store_id and trade-order ids are not (kills: read the table, not the definer)', async () => {
    const w = await world('f4a');
    const open = await seed(w);
    const gone = await seed(w, { lines: 'one', void: { reason: SECRET } });
    const rows = await asPerson(w.g.orgId, w.g.manager.personId, (tx) => api.listInboundShipments(tx, w.g.manager, { includeVoid: true }));
    const mine = rows.find((r) => r.id === open.shipmentId) as Record<string, unknown> | undefined;
    expect(mine, 'the in-transit shipment is listed').toBeDefined();

    // what PG is meant to see
    expect(mine).toMatchObject({ status: 'in_transit', billedTotal: '3203.00', shippedOn: '2026-10-16' });
    const lines = (mine!.lines as Record<string, unknown>[]).slice().sort((a, b) => Number(a.lineNo) - Number(b.lineNo));
    expect(lines.map((l) => [l.itemName, l.unit, l.quantity, l.rate, l.lineTotal])).toEqual([
      [open.porkName, 'kg', '10.000', '310.00', '3100.00'],
      [open.saltName, 'kg', '2.500', '41.20', '103.00'],
    ]);

    // what PG must never see - by key and by value, in the whole result (voided rows included)
    const keys = keysDeep(rows);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `the buyer's list exposes "${k}"`).toBe(false);
    const blob = JSON.stringify(rows);
    for (const [what, v] of [
      ['the void reason', SECRET],
      ['the seller store id', w.f.storeId],
      ['the trade order id', open.orderId],
      ['the voided trade order id', gone.orderId],
      ['the person who voided', w.f.manager.personId],
    ] as const) {
      expect(blob.includes(v), `the buyer's list leaks ${what}`).toBe(false);
    }
  });

  it('F4b. one shipment by id (the receipt form): same fields, same exclusions; a void shipment shows no reason; after receipt the buyer\'s own counts are in the lines', async () => {
    const w = await world('f4b');
    const live = await seed(w, { lines: 'one' });
    const dead = await seed(w, { lines: 'one', void: { reason: SECRET } });
    await pgReceives(w, receiveInput(w, live, { pork: '8' }));
    const one = await asPerson(w.g.orgId, w.g.manager.personId, (tx) => api.getInboundShipment(tx, w.g.manager, live.shipmentId));
    expect(one).toMatchObject({ id: live.shipmentId, status: 'received', billedTotal: '3100.00', receivedTotal: '2480.00' });
    expect(((one!.lines as Record<string, unknown>[])[0]!).receivedQuantity).toBe('8.000');
    for (const k of FORBIDDEN_KEYS) expect(keysDeep(one).has(k), `the buyer's detail exposes "${k}"`).toBe(false);
    expect(JSON.stringify(one).includes(w.f.storeId)).toBe(false);
    expect(JSON.stringify(one).includes(live.orderId)).toBe(false);

    // a void one: either shown as void with no reason, or not shown - never with the seller's private detail
    const gone = await asPerson(w.g.orgId, w.g.manager.personId, (tx) => api.getInboundShipment(tx, w.g.manager, dead.shipmentId)).catch(() => null);
    const g = JSON.stringify(gone);
    expect(g.includes(SECRET), 'the void reason reached the buyer').toBe(false);
    expect(g.includes(w.f.manager.personId), 'the voiding person reached the buyer').toBe(false);
    expect(g.includes(dead.orderId)).toBe(false);
  });

  it('F4c. another organisation\'s shipment is not served: the buyer asking for a shipment addressed to C gets null or a refusal, never the rows', async () => {
    const w = await world('f4c');
    const c = await fixture(sql, 'f4cc');
    const s = await seed(w, { lines: 'one', buyerOrgId: c.orgId });
    const got = await asPerson(w.g.orgId, w.g.manager.personId, (tx) => api.getInboundShipment(tx, w.g.manager, s.shipmentId)).catch((e: unknown) => ({ refused: rawText(e) }));
    expect(got === null || (typeof got === 'object' && 'refused' in (got as object)), `PG was served C's shipment: ${JSON.stringify(got)}`).toBe(true);
    const list = await asPerson(w.g.orgId, w.g.manager.personId, (tx) => api.listInboundShipments(tx, w.g.manager, { includeVoid: true }));
    expect(list.map((r) => r.id)).not.toContain(s.shipmentId);
  });
});
