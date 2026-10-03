import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-372 S6 (receipt discrepancy; DEF-513) — `docs/tasks/372-def-511-prepared-order-stays-prepared.md` §S6a legs D1-D4 the S6 amendment
 * (2026-10-01, planner) legs X1-X16 (Q3 (i): an over-receipt books only what was sent; the excess is an `over` discrepancy that blocks
 * day-open) and AMENDMENT 2 (2026-10-02, Ian: an over-receipt is settled by `extra_dispatch` = the commissary confirms it sent more, which POSTS;
 * a recount is `return`, note required, posts nothing; `top_up` is gone): X7'/X8'/X13' rewritten, X9-X12 and X14 deleted, E1-E7 added. Fixture is `t372-internal-freight.test.ts`'s. ⛔ TESTER, not BUILDER. Tests assert behaviour and constraint names, never the
 * migration file's name. X15 (the supplier over-receipt guards) is run, not written: receive-delivery / deliveries / t343-s5-1d-wrapper-refusals.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, tradeDiscrepanciesRepo, commissaryKpisRepo, findingsRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createSalesDay, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, resolveDiscrepancy, TransitShortfallBlockedError } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture — copied shape, trade.test.ts. `storeId` is the commissary (seller); `otherStoreId` is
// the branch (the internal customer's counterparty store, the one that RECEIVES).
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string) {
  const code = uid(`t372f-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('com');
  const otherStoreId = await mkStore('br');

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  await mkLocation(otherStoreId); // the branch's own default room — receiveTradeOrder needs one to receive into.
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;

  return {
    orgId, storeId, otherStoreId, locationId, fileId: file!.id,
    superAdmin: actor(orgId, superAdminId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, storeId: string, locationId: string, itemId: string, qty: string, unitCost = '300.0000'): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId }],
    }),
  );
}
async function mapSelf(f: Fixture, itemId: string): Promise<void> {
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
}
async function wholesaleItem(f: Fixture, name: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: uid('WS'), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }));
  return item.id;
}
async function internalCustomer(f: Fixture): Promise<string> {
  const c = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }));
  return c.id;
}


// -----------------------------------------------------------------------------------------------
// Order helpers. 30 units in stock at cost 300; an internal order of 20 units at rate 500, dispatched.
// -----------------------------------------------------------------------------------------------
async function dispatchedOrder(f: Fixture, qty = '20') {
  const customerId = await internalCustomer(f);
  const itemId = await wholesaleItem(f, 'Prepped');
  await stock(f, f.storeId, f.locationId, itemId, '30', '300.0000');
  await mapSelf(f, itemId);
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: qty, rate: '500' }] }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  const [item] = await sql<{ name: string }[]>`select name from items where id = ${itemId}`;
  return { orderId: order.orderId, lineId: line!.id, itemId, itemName: item!.name };
}
const receive = (f: Fixture, o: { orderId: string; lineId: string }, receivedQuantity: string, shortageReason?: string) =>
  asOrg(f.orgId, (tx) =>
    receiveTradeOrder(tx, f.manager, {
      orderId: o.orderId, receivedOn: '2026-01-15',
      lines: [{ lineId: o.lineId, receivedQuantity, ...(shortageReason ? { shortageReason } : {}) } as never],
    }),
  );
async function refusalOf(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage };
  }
  throw new Error(`NOT REFUSED — ${what} succeeded instead (the defect this leg targets)`);
}
const discrepancies = (orderId: string) =>
  sql<{ quantity: string; value: string; status: string; direction: string | null }[]>`
    select quantity::text, value::text, status, to_jsonb(d)->>'direction' as direction from trade_discrepancies d where order_id = ${orderId}`;
const lineRow = async (lineId: string) =>
  (await sql<{ received_quantity: string | null; dispatch_cost: string; status: string }[]>`
    select l.received_quantity::text, l.dispatch_cost::text, o.status from trade_order_lines l join trade_orders o on o.id = l.order_id where l.id = ${lineId}`)[0]!;
const receiptEntries = async (orderId: string) =>
  sql<{ id: string }[]>`select id from journal_entries where source_type = 'trade_order_receipt' and source_id = ${orderId}`;
const branchOnHand = async (f: Fixture, itemId: string) =>
  Number((await sql<{ q: string | null }[]>`
    select sum(sm.quantity)::text as q from stock_movements sm where sm.org_id = ${f.orgId} and sm.store_id = ${f.otherStoreId} and sm.item_id = ${itemId}`)[0]!.q ?? '0');

// -----------------------------------------------------------------------------------------------
// Extra helpers for the amendment legs (X1-X16)
// -----------------------------------------------------------------------------------------------

type Row = { id: string; quantity: string; value: string; status: string; direction: string | null; disposition: string | null; journal_entry_id: string | null; store_id: string; order_line_id: string };
const rowsOf = (orderId: string) =>
  sql<Row[]>`
    select id, quantity::text, value::text, status, disposition,
           to_jsonb(d)->>'direction' as direction, journal_entry_id,
           store_id, order_line_id
    from trade_discrepancies d where order_id = ${orderId} order by created_at`;
/** Sum of a receipt entry's credits/debits by account code, across every `trade_order_receipt` entry of the order. */
async function legSum(orderId: string, code: string, side: 'credit' | 'debit'): Promise<number> {
  const rows = side === 'credit'
    ? await sql<{ s: string }[]>`select coalesce(sum(l.credit),0)::text as s from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id where e.source_type = 'trade_order_receipt' and e.source_id = ${orderId} and a.code = ${code}`
    : await sql<{ s: string }[]>`select coalesce(sum(l.debit),0)::text as s from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id where e.source_type = 'trade_order_receipt' and e.source_id = ${orderId} and a.code = ${code}`;
  return Number(rows[0]!.s);
}
/** costOfQuantity(dispatchCost, q, dispatched): the uncapped half-up centavo share — computed in SQL (numeric round is half-up). */
const costShare = async (dispatchCost: string, q: string, dispatched: string) =>
  (await sql<{ v: string }[]>`select round(${dispatchCost}::numeric * ${q}::numeric / ${dispatched}::numeric, 2)::text as v`)[0]!.v;
const branchLine = async (f: Fixture, itemId: string) =>
  (await sql<{ received_quantity: string; over_receipt_allowed: boolean }[]>`
    select dl.received_quantity::text, dl.over_receipt_allowed from delivery_lines dl join deliveries d on d.id = dl.delivery_id
    where d.org_id = ${f.orgId} and d.store_id = ${f.otherStoreId} and dl.item_id = ${itemId}`)[0];
const journalCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n);
const inTransit = async (f: Fixture) =>
  Number((await sql<{ s: string }[]>`
    select coalesce(sum(l.debit - l.credit),0)::text as s from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id
    where e.org_id = ${f.orgId} and a.code = '1340'`)[0]!.s);

/** Resolve through the real domain function; `extra` carries the NEW inputs (note, chargePersonId, the new dispositions) via a cast. */
const resolveRow = (f: Fixture, discrepancyId: string, disposition: string, extra: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) =>
    resolveDiscrepancy(tx, {
      orgId: f.orgId, discrepancyId, commissaryStoreId: f.storeId, disposition, resolvedOn: '2026-01-20', resolvedBy: f.manager.personId, ...extra,
    } as never),
  ) as Promise<{ ok: boolean; reason?: string; entryId?: string | null }>;

/** A staff member at the COMMISSARY and a channel, so `createSalesDay` can be driven (the create-block exempts admins, so staff). */
async function commissaryStaff(f: Fixture) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Cook') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${f.storeId}, ${p!.id}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId: f.orgId, storeId: f.storeId, employmentId: emp!.id, personId: p!.id, setBy: f.manager.personId });
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${f.storeId}, 'Walk-in', true) returning id`;
  return { staff: actor(f.orgId, p!.id), channelId: ch!.id };
}
const openDay = (f: Fixture, c: { staff: Actor; channelId: string }, date: string) =>
  asOrg(f.orgId, (tx) =>
    createSalesDay(tx, c.staff, {
      storeId: f.storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00',
      channels: [{ channelId: c.channelId, amount: '1000.00' }],
    }),
  );

/** A fresh internal order commissary -> `branchStoreId` for `itemId`, dispatched, and (if `receiveQty` is given) received at that count. */
async function extraOrder(
  f: Fixture, o: { itemId: string; qty: string; receiveQty?: string; customerId?: string; branchStoreId?: string; mapped?: boolean; stocked?: boolean },
) {
  const branch = o.branchStoreId ?? f.otherStoreId;
  const customerId = o.customerId ?? (await internalCustomer(f));
  if (o.stocked) await stock(f, f.storeId, f.locationId, o.itemId, '30', '300.0000');
  if (o.mapped) {
    await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
              values (${f.orgId}, ${f.storeId}, ${branch}, ${o.itemId}, ${o.itemId}, ${f.superAdmin.personId})`;
  }
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-12', lines: [{ itemId: o.itemId, quantity: o.qty, rate: '500' }] }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  const ref = { orderId: order.orderId, lineId: line!.id };
  if (o.receiveQty !== undefined) await receive(f, ref, o.receiveQty, Number(o.receiveQty) < Number(o.qty) ? 'damaged_in_transit' : undefined);
  return ref;
}
/** An over-receipt (22 of 20) and its single OVER row. */
async function overCase(hint: string) {
  const f = await fixture(hint);
  const o = await dispatchedOrder(f);
  await receive(f, o, '22');
  const [row] = await rowsOf(o.orderId);
  if (!row) throw new Error('fixture: the over-receipt raised no discrepancy row');
  return { f, o, row };
}
/** Run a raw statement that must be refused; if the target schema is not there yet say so instead of a bare driver error. */
async function rawRejects(p: PromiseLike<unknown>, re: RegExp, what: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const m = String((err as Error).message);
    if (re.test(m)) return;
    if (/column .* does not exist|does not exist/.test(m)) throw new Error(`${what}: the target constraint is ABSENT (the schema it needs does not exist yet): ${m}`);
    throw new Error(`${what}: refused, but not by ${re}: ${m}`);
  }
  throw new Error(`${what}: NOT REFUSED — the target constraint is absent`);
}

const OVER_SENTENCE = "This is an over-receipt — the extra goods were never on either store's books, so there is nothing to write off or charge. Book it as an extra dispatch if the commissary sent more, or as a return if it went back or was a miscount.";
const SHORT_SENTENCE = 'This is a shortage — extra dispatch and return apply only to goods counted over what was sent.';
const RETURN_NOTE = 'A return must say what happened — who carried the extra back and when, or that the branch recounted.';

// -----------------------------------------------------------------------------------------------
// S6a — D1-D4 (spec §S6a, as amended: D1's red today is the RAW CHECK name; D2 is a green guard).
// -----------------------------------------------------------------------------------------------

describe('D1 — a NEGATIVE received quantity is refused before any write (G1)', () => {
  it('receive -5 on a 20-unit line: the exact S6a sentence (red today: the raw trigger_order_lines_received_quantity_non_negative_check text); nothing written', async () => {
    const f = await fixture('d1');
    const o = await dispatchedOrder(f);
    const refused = await refusalOf(receive(f, o, '-5', 'other'), 'a negative received quantity');
    expect(refused.userMessage, `no sentence for the person; the raw error was: ${refused.message}`).toBe(`${o.itemName} — a received quantity cannot be negative. Enter 0 if none arrived.`);
    expect(refused.message).toBe(`receiveTradeOrder: line ${o.lineId} received quantity -5 is negative`);
    expect(await receiptEntries(o.orderId)).toEqual([]);
    expect(await discrepancies(o.orderId)).toEqual([]);
    const row = await lineRow(o.lineId);
    expect(row.received_quantity).toBeNull();
    expect(row.status).toBe('dispatched');
  });
});

describe('D2 (guard, green today) — the database refuses a negative received_quantity too', () => {
  it('a raw update of received_quantity to -1 rejects trade_order_lines_received_quantity_non_negative_check', async () => {
    const f = await fixture('d2');
    const o = await dispatchedOrder(f);
    await expect(sql`update trade_order_lines set received_quantity = -1 where id = ${o.lineId}`).rejects.toThrow(/received_quantity_non_negative/);
  });
});

describe('D3 (positive) — receiving 0 is legal: everything is the discrepancy', () => {
  it('received 0 of 20: resolves; one row with quantity = dispatched (20.000) and value = dispatch_cost exactly', async () => {
    const f = await fixture('d3');
    const o = await dispatchedOrder(f);
    await receive(f, o, '0', 'not_received');
    const rows = await discrepancies(o.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe('20.000');
    expect(rows[0]!.value).toBe((await lineRow(o.lineId)).dispatch_cost);
  });
});

describe('D4 (positive, guard on T-174) — a 2-unit shortage', () => {
  it('received 18 of 20: one row with quantity 2.000 and value = dispatch_cost - dispatch_cost*18/20; the branch holds 18', async () => {
    const f = await fixture('d4');
    const o = await dispatchedOrder(f);
    await receive(f, o, '18', 'damaged_in_transit');
    const rows = await discrepancies(o.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe('2.000');
    const cost = Number((await lineRow(o.lineId)).dispatch_cost);
    expect(Number(rows[0]!.value)).toBeCloseTo(cost - (cost * 18) / 20, 2);
    expect(await branchOnHand(f, o.itemId)).toBe(18);
  });
});

// -----------------------------------------------------------------------------------------------
// S6b — the amendment's X1-X16. The domain caps the booked quantity at dispatched; the excess is an `over` row.
// -----------------------------------------------------------------------------------------------

describe('X1 — 22 of 20 at rate 500: books only what was sent; the excess is an OVER row', () => {
  it('resolves (red today: the T-166 supplier trigger refuses "received over (22.000 of 20.000) without an over-receipt approval"); stock +20, received_quantity 20.000, branch line 20.000 with over_receipt_allowed false; 2150 Cr 10,000, 1340 Cr = dispatch_cost, 5175 = 10,000 - dispatch_cost; one over row', async () => {
    const f = await fixture('x1');
    const o = await dispatchedOrder(f);
    await receive(f, o, '22');
    expect(await branchOnHand(f, o.itemId), 'the branch gained stock the commissary never relieved').toBe(20);
    const line = await lineRow(o.lineId);
    expect(line.received_quantity, 'received_quantity must be the BOOKED figure, not the count').toBe('20.000');
    const bl = await branchLine(f, o.itemId);
    expect(bl?.received_quantity).toBe('20.000');
    expect(bl?.over_receipt_allowed, 'over_receipt_allowed must never be set from code').toBe(false);
    const cost = Number(line.dispatch_cost);
    expect(await legSum(o.orderId, '2150', 'credit')).toBe(10000);
    expect(await legSum(o.orderId, '1340', 'credit')).toBeCloseTo(cost, 2);
    expect(await legSum(o.orderId, '5175', 'credit')).toBeCloseTo(10000 - cost, 2);
    const rows = await rowsOf(o.orderId);
    expect(rows, 'no discrepancy raised for the over-receipt').toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'over', quantity: '2.000', status: 'open', store_id: f.storeId });
    expect(rows[0]!.value).toBe(await costShare(line.dispatch_cost, '2', '20'));
  });
});

describe('X2 (positive) — inside the 0.005 tolerance: booked 20.000, no row', () => {
  for (const counted of ['20.004', '20.005']) {
    it(`${counted} of 20: resolves (red today: refused "received over (${counted} of 20.000)"); booked 20.000 everywhere X1 checks; no discrepancy row`, async () => {
      const f = await fixture(`x2-${counted}`);
      const o = await dispatchedOrder(f);
      await receive(f, o, counted);
      expect(await rowsOf(o.orderId)).toEqual([]);
      expect(await branchOnHand(f, o.itemId)).toBe(20);
      expect((await lineRow(o.lineId)).received_quantity).toBe('20.000');
      expect((await branchLine(f, o.itemId))?.received_quantity).toBe('20.000');
      expect(await legSum(o.orderId, '2150', 'credit')).toBe(10000);
    });
  }
});

describe('X3 — one thousandth past the tolerance raises the row', () => {
  it('20.006 of 20: one OVER row of 0.006 (red today: refused by the trigger)', async () => {
    const f = await fixture('x3');
    const o = await dispatchedOrder(f);
    await receive(f, o, '20.006');
    const rows = await rowsOf(o.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'over', quantity: '0.006' });
    expect(await branchOnHand(f, o.itemId)).toBe(20);
  });
});

describe('X4 — an over row blocks the COMMISSARY\'s next day-open (no direction filter on blocking)', () => {
  it('blocking() contains the row and createSalesDay for the commissary rejects with TransitShortfallBlockedError naming it', async () => {
    const { f, row } = await overCase('x4');
    const c = await commissaryStaff(f);
    const blocking = await asOrg(f.orgId, (tx) => tradeDiscrepanciesRepo.blocking(tx, f.orgId, f.storeId, '2026-01-20'));
    expect(blocking.map((b) => b.id)).toContain(row.id);
    const err = await openDay(f, c, '2026-01-20').then(() => null, (e: unknown) => e);
    expect(err, 'the day opened over an unresolved over-receipt').toBeInstanceOf(TransitShortfallBlockedError);
    expect((err as TransitShortfallBlockedError).discrepancyIds).toContain(row.id);
  });
});

describe('X5 (positive) — "return" with a note resolves and posts nothing; the block lifts', () => {
  it('entryId null, journal count unchanged, status resolved; then the same createSalesDay succeeds', async () => {
    const { f, row } = await overCase('x5');
    const c = await commissaryStaff(f);
    await expect(openDay(f, c, '2026-01-20'), 'control: blocked before the resolution').rejects.toBeInstanceOf(TransitShortfallBlockedError);
    const before = await journalCount(f.orgId);
    const out = await resolveRow(f, row.id, 'return', { note: 'Carried back by Mang Ben on the 16th' });
    expect(out.ok, `return was refused: ${out.reason}`).toBe(true);
    expect(out.entryId ?? null).toBeNull();
    expect(await journalCount(f.orgId)).toBe(before);
    expect((await sql<Row[]>`select status, disposition from trade_discrepancies where id = ${row.id}`)[0]).toMatchObject({ status: 'resolved', disposition: 'return' });
    expect((await openDay(f, c, '2026-01-20')).id).toBeTruthy();
  });
});

describe('X6 — "return" needs a note', () => {
  it('no note: the exact sentence; the row stays open', async () => {
    const { f, row } = await overCase('x6');
    const out = await resolveRow(f, row.id, 'return');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe(RETURN_NOTE);
    expect((await sql<{ status: string }[]>`select status from trade_discrepancies where id = ${row.id}`)[0]!.status).toBe('open');
  });
});

describe("X7' — an OVER row cannot be written off or charged", () => {
  for (const disposition of ['loss', 'charge', 'late_receipt'] as const) {
    it(`${disposition}: the exact over sentence, no entry, still open, 1340 unchanged`, async () => {
      const { f, row } = await overCase(`x7-${disposition}`);
      const before = { j: await journalCount(f.orgId), t: await inTransit(f) };
      const out = await resolveRow(f, row.id, disposition, disposition === 'charge' ? { chargePersonId: f.manager.personId } : {});
      expect(out.ok, 'an over row was written off / charged').toBe(false);
      expect(out.reason).toBe(OVER_SENTENCE);
      expect(await journalCount(f.orgId)).toBe(before.j);
      expect(await inTransit(f)).toBe(before.t);
      expect((await sql<{ status: string }[]>`select status from trade_discrepancies where id = ${row.id}`)[0]!.status).toBe('open');
    });
  }
});

describe("X8' — a SHORT row cannot be extra_dispatch or return", () => {
  for (const disposition of ['extra_dispatch', 'return'] as const) {
    it(`18 of 20 resolved as ${disposition}: the exact short sentence`, async () => {
      const f = await fixture(`x8-${disposition}`);
      const o = await dispatchedOrder(f);
      await receive(f, o, '18', 'damaged_in_transit');
      const [row] = await rowsOf(o.orderId);
      const out = await resolveRow(f, row!.id, disposition, { note: 'x' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe(SHORT_SENTENCE);
    });
  }
});

describe("X13' — the schema constraints (raw SQL as the migration role)", () => {
  it("(a) loss on an over row -> disposition_direction_check; (b) extra_dispatch on a SHORT row -> disposition_direction_check; (b2) the retired top_up value -> disposition_check; (c) flipping direction is refused, also under session_replication_role=replica", async () => {
    const { row } = await overCase('x13');
    await rawRejects(sql`update trade_discrepancies set disposition = 'loss' where id = ${row.id}`, /disposition_direction_check/, '(a) loss on an over row');
    await rawRejects(sql`update trade_discrepancies set disposition = 'top_up' where id = ${row.id}`, /disposition_check/, "(b2) 'top_up' must be gone from the disposition CHECK");
    await rawRejects(sql`update trade_discrepancies set direction = 'short' where id = ${row.id}`, /direction is fixed/, '(c) direction flip');
    await rawRejects(
      sql.begin(async (t) => {
        await t`set local session_replication_role = 'replica'`;
        await t`update trade_discrepancies set direction = 'short' where id = ${row.id}`;
      }),
      /direction is fixed/,
      '(c) direction flip under session_replication_role=replica (the trigger must be ENABLE ALWAYS)',
    );
  });

  it('(b) extra_dispatch on a SHORT row rejects disposition_direction_check', async () => {
    const f = await fixture('x13b');
    const o = await dispatchedOrder(f);
    await receive(f, o, '18', 'damaged_in_transit');
    const [short] = await rowsOf(o.orderId);
    await rawRejects(sql`update trade_discrepancies set disposition = 'extra_dispatch' where id = ${short!.id}`, /disposition_direction_check/, '(b) extra_dispatch on a short row');
  });

  it('(d) positive: an OVER row with value 0 inserts; (e) a SHORT row with value 0 rejects trade_discrepancies_value_check', async () => {
    const f = await fixture('x13de');
    const o1 = await dispatchedOrder(f);
    const o2 = await extraOrder(f, { itemId: o1.itemId, qty: '2' });
    await sql`insert into trade_discrepancies (org_id, store_id, order_id, order_line_id, quantity, value, direction)
              values (${f.orgId}, ${f.storeId}, ${o1.orderId}, ${o1.lineId}, 1.000, 0, 'over')`.catch((e: Error) => {
      throw new Error(`(d) an over row with value 0 was not accepted: ${e.message}`);
    });
    await rawRejects(
      sql`insert into trade_discrepancies (org_id, store_id, order_id, order_line_id, quantity, value, direction)
          values (${f.orgId}, ${f.storeId}, ${o2.orderId}, ${o2.lineId}, 1.000, 0, 'short')`,
      /trade_discrepancies_value_check/,
      '(e) a short row with value 0',
    );
  });
});

// -----------------------------------------------------------------------------------------------
// Amendment 2 — E1-E7: "Commissary sent more" (extra_dispatch) POSTS, and a recount is a plain return.
// -----------------------------------------------------------------------------------------------

const onHand = async (orgId: string, storeId: string, itemId: string) =>
  Number((await sql<{ q: string | null }[]>`select sum(quantity)::text as q from stock_movements where org_id = ${orgId} and store_id = ${storeId} and item_id = ${itemId}`)[0]!.q ?? '0');
const storeCode = async (id: string) => (await sql<{ code: string }[]>`select code from stores where id = ${id}`)[0]!.code;
type Leg = { code: string; store_id: string; debit: string; credit: string; party_type: string | null; party_id: string | null };
const entryFor = async (rowId: string) => {
  const [e] = await sql<{ id: string; idempotency_key: string; memo: string }[]>`select id, idempotency_key, memo from journal_entries where source_type = 'trade_discrepancy' and source_id = ${rowId}`;
  if (!e) return null;
  const legs = await sql<Leg[]>`
    select a.code, l.store_id, l.debit::text, l.credit::text, l.party_type, l.party_id from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = ${e.id} order by a.code, l.store_id`;
  return { ...e, legs };
};
const movementsOf = (rowId: string) =>
  sql<{ store_id: string; quantity: string; kind: string; source_type: string }[]>`select store_id, quantity::text, kind, source_type from stock_movements where source_type = 'trade_discrepancy' and source_id = ${rowId}`;
const leg = (e: NonNullable<Awaited<ReturnType<typeof entryFor>>>, code: string, storeId: string) => e.legs.find((l) => l.code === code && l.store_id === storeId);

describe('E1 — "Commissary sent more" books the extra: -2 at the commissary, +2 at the branch, one entry, no 1340 leg', () => {
  it('22 of 20 at rate 500 (cost 300): resolves; commissary on-hand -2.000, branch 22.000; five legs (1310 br Dr 1,000 / 2150 br Cr 1,000 party commissary / 1250 com Dr 1,000 party branch / 1310 com Cr = consume cost 600 / 5175 com Cr 400); no 1340 line, 1340 unchanged; row resolved with journal_entry_id; both movements trade_discrepancy/row.id', async () => {
    const { f, o, row } = await overCase('e1');
    const comBefore = await onHand(f.orgId, f.storeId, o.itemId);
    const transitBefore = await inTransit(f);

    const out = await resolveRow(f, row.id, 'extra_dispatch');
    expect(out.ok, `extra_dispatch was refused: ${out.reason}`).toBe(true);
    expect(await onHand(f.orgId, f.storeId, o.itemId)).toBe(comBefore - 2);
    expect(await onHand(f.orgId, f.otherStoreId, o.itemId)).toBe(22);
    expect(await inTransit(f), 'a 1340 leg moved the in-transit balance').toBe(transitBefore);

    const e = await entryFor(row.id);
    expect(e, 'no journal entry for the extra dispatch').not.toBeNull();
    expect(e!.idempotency_key).toBe(`trade_discrepancy:${row.id}:extra_dispatch`);
    expect(e!.memo).toBe('Commissary confirmed it sent more than dispatched');
    expect(e!.legs.map((l) => l.code).sort(), 'exactly five legs, none on 1340').toEqual(['1250', '1310', '1310', '2150', '5175']);
    const comCode = await storeCode(f.storeId);
    const brCode = await storeCode(f.otherStoreId);
    expect(leg(e!, '1310', f.otherStoreId)).toMatchObject({ debit: '1000.00', credit: '0.00' });
    expect(leg(e!, '2150', f.otherStoreId)).toMatchObject({ debit: '0.00', credit: '1000.00', party_type: 'store', party_id: comCode });
    expect(leg(e!, '1250', f.storeId)).toMatchObject({ debit: '1000.00', credit: '0.00', party_type: 'store', party_id: brCode });
    expect(leg(e!, '1310', f.storeId)).toMatchObject({ debit: '0.00', credit: '600.00' });
    expect(leg(e!, '5175', f.storeId), 'margin = 1,000 - the consume cost').toMatchObject({ debit: '0.00', credit: '400.00' });

    const [after] = await rowsOf(o.orderId);
    expect(after).toMatchObject({ status: 'resolved', disposition: 'extra_dispatch', journal_entry_id: e!.id });
    const moves = await movementsOf(row.id);
    expect(moves.map((m) => m.kind).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(moves.find((m) => m.kind === 'transfer_out')).toMatchObject({ store_id: f.storeId, quantity: '-2.000' });
    expect(moves.find((m) => m.kind === 'transfer_in')).toMatchObject({ store_id: f.otherStoreId, quantity: '2.000' });
    expect((await lineRow(o.lineId)).received_quantity, 'trade_order_lines is not touched').toBe('20.000');
    // the branch's new layer is at the line's RATE (500), as the receipt's is — not at the commissary's cost (300)
    const [layer] = await sql<{ unit_cost: string; quantity: string }[]>`
      select l.unit_cost::text, l.quantity::text from stock_layers l join stock_movements m on m.id = l.movement_id
      where m.source_type = 'trade_discrepancy' and m.source_id = ${row.id} and l.store_id = ${f.otherStoreId}`;
    expect(layer, 'no branch layer was created for the extra').toBeDefined();
    expect(Number(layer!.unit_cost), "the branch layer must be at the line's rate").toBe(500);
    expect(Number(layer!.quantity)).toBe(2);
  });
});

describe('E2 — the commissary cannot have sent what its books do not hold', () => {
  it('commissary holds 1.000, the row is 2.000: the exact stock sentence; no entry, no movement, row still open', async () => {
    const { f, o, row } = await overCase('e2');
    await extraOrder(f, { itemId: o.itemId, qty: '9' }); // dispatch 9 of the remaining 10 -> 1 left
    expect(await onHand(f.orgId, f.storeId, o.itemId), 'fixture: 1.000 left at the commissary').toBe(1);
    const journalBefore = await journalCount(f.orgId);
    const movesBefore = Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`)[0]!.n);

    const out = await resolveRow(f, row.id, 'extra_dispatch');
    expect(out.ok, 'the extra dispatch went through on a commissary that does not hold the goods').toBe(false);
    expect(out.reason ?? '').toMatch(new RegExp(`^${o.itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — the commissary's books hold only 1(\\.000)?, so it cannot have sent 2(\\.000)? more\\. Correct the commissary's count first, or resolve this as a return\\.$`));
    expect(await journalCount(f.orgId)).toBe(journalBefore);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`)[0]!.n)).toBe(movesBefore);
    expect((await entryFor(row.id))).toBeNull();
    expect((await rowsOf(o.orderId))[0]!.status).toBe('open');
  });
});

describe('E3 — a negative margin is a DEBIT to 5175', () => {
  it('rate 100 against cost 300, quantity 1: 5175 is a debit of 200.00 and the commissary stock credit is 300.00', async () => {
    const f = await fixture('e3');
    const customerId = await internalCustomer(f);
    const itemId = await wholesaleItem(f, 'Cheap');
    await stock(f, f.storeId, f.locationId, itemId, '30', '300.0000');
    await mapSelf(f, itemId);
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: '20', rate: '100' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    await receive(f, { orderId: order.orderId, lineId: line!.id }, '21');
    const [row] = await rowsOf(order.orderId);
    expect(row, 'fixture: the 21-of-20 over row').toMatchObject({ direction: 'over', quantity: '1.000' });

    const out = await resolveRow(f, row!.id, 'extra_dispatch');
    expect(out.ok, `extra_dispatch was refused: ${out.reason}`).toBe(true);
    const e = await entryFor(row!.id);
    expect(leg(e!, '1310', f.otherStoreId)).toMatchObject({ debit: '100.00' });
    expect(leg(e!, '1310', f.storeId)).toMatchObject({ credit: '300.00' });
    expect(leg(e!, '5175', f.storeId), 'a below-cost transfer must debit 5175').toMatchObject({ debit: '200.00', credit: '0.00' });
  });
});

describe('E4 — the reciprocal pair stays equal (invariant 6)', () => {
  it('after E1: the commissary 1250 (party branch) equals the branch 2150 (party commissary) for the entry, and org-wide sum(1250 Dr-Cr) = sum(2150 Cr-Dr)', async () => {
    const { f, o, row } = await overCase('e4');
    expect((await resolveRow(f, row.id, 'extra_dispatch')).ok).toBe(true);
    const e = await entryFor(row.id);
    expect(leg(e!, '1250', f.storeId)!.debit).toBe(leg(e!, '2150', f.otherStoreId)!.credit);
    const [t] = await sql<{ due_from: string; due_to: string }[]>`
      select coalesce(sum(case when a.code = '1250' then l.debit - l.credit end),0)::text as due_from,
             coalesce(sum(case when a.code = '2150' then l.credit - l.debit end),0)::text as due_to
      from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id where e.org_id = ${f.orgId}`;
    expect(Number(t!.due_from)).toBeCloseTo(Number(t!.due_to), 2);
    void o;
  });
});

describe('E5 — resolving twice is refused', () => {
  it('the second extra_dispatch: "already resolved … reverse it and resolve again"; one entry, one movement pair', async () => {
    const { f, row } = await overCase('e5');
    expect((await resolveRow(f, row.id, 'extra_dispatch')).ok).toBe(true);
    const second = await resolveRow(f, row.id, 'extra_dispatch');
    expect(second.ok).toBe(false);
    expect(second.reason ?? '').toMatch(/already resolved.*reverse it and resolve again/);
    const entries = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where source_type = 'trade_discrepancy' and source_id = ${row.id}`;
    expect(Number(entries[0]!.n)).toBe(1);
    expect((await movementsOf(row.id)).length).toBe(2);
  });
});

describe('E6 (positive) — a recount is a plain return: posts nothing, the books stay as they are', () => {
  it('over row as return with note "recount: branch miscounted": resolves, no entry, branch on-hand stays 20.000, commissary unchanged', async () => {
    const { f, o, row } = await overCase('e6');
    const comBefore = await onHand(f.orgId, f.storeId, o.itemId);
    const journalBefore = await journalCount(f.orgId);
    const out = await resolveRow(f, row.id, 'return', { note: 'recount: branch miscounted' });
    expect(out.ok, `return was refused: ${out.reason}`).toBe(true);
    expect(out.entryId ?? null).toBeNull();
    expect(await journalCount(f.orgId)).toBe(journalBefore);
    expect(await branchOnHand(f, o.itemId)).toBe(20);
    expect(await onHand(f.orgId, f.storeId, o.itemId)).toBe(comBefore);
    expect((await entryFor(row.id))).toBeNull();
    expect((await rowsOf(o.orderId))[0]).toMatchObject({ status: 'resolved', disposition: 'return' });
  });
});

describe('E6b — Ian (2026-10-02): the recount return is initiated by the manager of the store that is RETURNING (the branch that miscounted)', () => {
  it('the BRANCH may close its own over row as a recount return (posts nothing); the same branch may NOT book an extra dispatch — the commissary decides that', async () => {
    const { f, o, row } = await overCase('e6b');
    const asBranch = (disposition: string, extra: Record<string, unknown> = {}) =>
      asOrg(f.orgId, (tx) =>
        resolveDiscrepancy(tx, { orgId: f.orgId, discrepancyId: row.id, commissaryStoreId: f.otherStoreId, disposition, resolvedOn: '2026-01-20', resolvedBy: f.manager.personId, ...extra } as never),
      ) as Promise<{ ok: boolean; reason?: string; entryId?: string | null }>;

    const refused = await asBranch('extra_dispatch');
    expect(refused.ok, 'the branch booked an extra dispatch for the commissary').toBe(false);
    expect(await entryFor(row.id)).toBeNull();

    const journalBefore = await journalCount(f.orgId);
    const out = await asBranch('return', { note: 'recount: branch miscounted' });
    expect(out.ok, `the branch manager was refused its own recount return: ${out.reason}`).toBe(true);
    expect(out.entryId ?? null).toBeNull();
    expect(await journalCount(f.orgId)).toBe(journalBefore);
    expect(await branchOnHand(f, o.itemId)).toBe(20);
    expect((await rowsOf(o.orderId))[0]).toMatchObject({ status: 'resolved', disposition: 'return' });
  });
});

// E7 (guard, green today) is not rewritten here: "manager+ may resolve, staff may not" is pinned by tests/unit/capability-matrix.test.ts
// and tests/unit/t337-capability-areas.test.ts; this task adds no capability, so those must stay green unchanged (run and reported).

describe('X16 — the order-level total is derived per direction, never stored (DEF-075)', () => {
  it('a two-line order received 18/20 and 22/20: sum(value) by direction equals each row; no order-level discrepancy column exists', async () => {
    const f = await fixture('x16');
    const customerId = await internalCustomer(f);
    const a = await wholesaleItem(f, 'LineA');
    const b = await wholesaleItem(f, 'LineB');
    for (const item of [a, b]) {
      await stock(f, f.storeId, f.locationId, item, '30', '300.0000');
      await mapSelf(f, item);
    }
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId: a, quantity: '20', rate: '500' }, { itemId: b, quantity: '20', rate: '500' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    const lineA = lines.find((l) => l.itemId === a)!;
    const lineB = lines.find((l) => l.itemId === b)!;
    await asOrg(f.orgId, (tx) =>
      receiveTradeOrder(tx, f.manager, {
        orderId: order.orderId, receivedOn: '2026-01-15',
        lines: [{ lineId: lineA.id, receivedQuantity: '18', shortageReason: 'damaged_in_transit' }, { lineId: lineB.id, receivedQuantity: '22' }] as never,
      }),
    );
    const rows = await rowsOf(order.orderId);
    expect(rows.map((r) => r.direction).sort()).toEqual(['over', 'short']);
    const byDir = await sql<{ direction: string; s: string }[]>`
      select to_jsonb(d)->>'direction' as direction, sum(value)::text as s from trade_discrepancies d where order_id = ${order.orderId} group by 1`;
    for (const r of rows) expect(byDir.find((x) => x.direction === r.direction)?.s).toBe(r.value);
    const costA = (await lineRow(lineA.id)).dispatch_cost;
    const costB = (await lineRow(lineB.id)).dispatch_cost;
    expect(rows.find((r) => r.direction === 'short')!.value).toBe(String((Number(costA) - (Number(costA) * 18) / 20).toFixed(2)));
    expect(rows.find((r) => r.direction === 'over')!.value).toBe(await costShare(costB, '2', '20'));
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'trade_orders' and column_name ~* 'discrepanc'`;
    expect(cols, 'an order-level total column exists').toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// Audit legs (a)-(c) — T-372 S6 audit: KPI / finding value, the third-store boundary, audit stays blocking, the other-room stock refusal
// -----------------------------------------------------------------------------------------------

const ageRows = (orderId: string, days = 20) =>
  sql`update trade_discrepancies set created_at = created_at - make_interval(days => ${days}) where order_id = ${orderId}`;

describe('A-a — an OVER row is counted but never valued: the KPI and the overdue finding carry the SHORT value only', () => {
  it('an over row worth ₱1,200 (24 of 20) plus a short row worth ₱600 (18 of 20), aged: openDisputes count 2, totalValue 600.00; the receivingDisputeOverdue finding says 2 disputes worth ₱600.00 and never ₱1,200.00 or ₱1,800.00', async () => {
    const f = await fixture('aa');
    const customerId = await internalCustomer(f);
    const a = await wholesaleItem(f, 'ShortLine');
    const b = await wholesaleItem(f, 'OverLine');
    for (const item of [a, b]) {
      await stock(f, f.storeId, f.locationId, item, '30', '300.0000');
      await mapSelf(f, item);
    }
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId: a, quantity: '20', rate: '500' }, { itemId: b, quantity: '20', rate: '500' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    const lineA = lines.find((l) => l.itemId === a)!;
    const lineB = lines.find((l) => l.itemId === b)!;
    await asOrg(f.orgId, (tx) =>
      receiveTradeOrder(tx, f.manager, {
        orderId: order.orderId, receivedOn: '2026-01-15',
        lines: [{ lineId: lineA.id, receivedQuantity: '18', shortageReason: 'damaged_in_transit' }, { lineId: lineB.id, receivedQuantity: '24' }] as never,
      }),
    );
    const rows = await rowsOf(order.orderId);
    expect(rows.map((r) => r.direction).sort(), 'fixture: one over row and one short row').toEqual(['over', 'short']);
    const over = rows.find((r) => r.direction === 'over')!;
    const short = rows.find((r) => r.direction === 'short')!;
    expect(Number(over.value), 'fixture: the over row has a value that differs from the short one').toBeGreaterThan(Number(short.value));
    await ageRows(order.orderId);

    const kpi = await asOrg(f.orgId, (tx) => commissaryKpisRepo.openDisputes(tx, { orgId: f.orgId }));
    expect(kpi.count, 'both rows are open disputes').toBe(2);
    expect(kpi.totalValue, "the over row's value is informational and must not enter the stranded-at-cost total").toBe(Number(short.value).toFixed(2));

    const findings = await asOrg(f.orgId, (tx) => findingsRepo.receivingDisputeOverdue(tx, f.orgId));
    expect(findings).toHaveLength(1);
    const detail = findings[0]!.detail;
    const pesos = (v: string) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(detail, 'two disputes').toMatch(/2 receiving disputes/);
    expect(detail, 'worth the SHORT value').toContain(`worth ${pesos(short.value)}`);
    expect(detail).not.toContain(pesos(over.value));
    expect(detail).not.toContain(pesos(String(Number(over.value) + Number(short.value))));
  });

  it("the finding's advice for an OVER-only row does not name loss / charge / late receipt (it cannot be written off) — control: a SHORT-only row still gets the audit/loss/charge/late-receipt advice", async () => {
    const { f, o } = await overCase('aa2');
    await ageRows(o.orderId);
    const overFinding = await asOrg(f.orgId, (tx) => findingsRepo.receivingDisputeOverdue(tx, f.orgId));
    expect(overFinding).toHaveLength(1);
    expect(overFinding[0]!.detail, 'the advice for an over row names dispositions that are refused for it').not.toMatch(/loss|charge|late receipt/i);

    const g = await fixture('aa3');
    const s = await dispatchedOrder(g);
    await receive(g, s, '18', 'damaged_in_transit');
    await ageRows(s.orderId);
    const shortFinding = await asOrg(g.orgId, (tx) => findingsRepo.receivingDisputeOverdue(tx, g.orgId));
    expect(shortFinding).toHaveLength(1);
    expect(shortFinding[0]!.detail, 'control: the short advice is unchanged').toMatch(/audit, loss, charge or late receipt/);
  });
});

describe('A-b — who may resolve an over row, and what "audit" does', () => {
  it('a THIRD store (neither the commissary nor the order\'s branch) trying `return` is refused with a written sentence; nothing changes; the branch itself is let in (E6b) — control', async () => {
    const { f, row } = await overCase('ab');
    const [third] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('third')}, 'Third') returning id`;
    const before = await journalCount(f.orgId);
    const out = await asOrg(f.orgId, (tx) =>
      resolveDiscrepancy(tx, { orgId: f.orgId, discrepancyId: row.id, commissaryStoreId: third!.id, disposition: 'return', note: 'recount: not mine', resolvedOn: '2026-01-20', resolvedBy: f.manager.personId } as never),
    ) as { ok: boolean; reason?: string };
    expect(out.ok, 'a store with no part in the order resolved its over row').toBe(false);
    expect(out.reason, 'no written reason').toBeTruthy();
    expect(out.reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|violates|constraint|undefined/);
    expect(await journalCount(f.orgId)).toBe(before);
    expect((await sql<{ status: string; disposition: string | null }[]>`select status, disposition from trade_discrepancies where id = ${row.id}`)[0]).toMatchObject({ status: 'open', disposition: null });
    // control: the commissary itself resolves it as a return
    expect((await resolveRow(f, row.id, 'return', { note: 'recount: branch miscounted' })).ok).toBe(true);
  });

  it('`audit` on an over row: allowed, posts nothing, the row STAYS open and still blocks the commissary day-open', async () => {
    const { f, row } = await overCase('ab2');
    const c = await commissaryStaff(f);
    const before = await journalCount(f.orgId);
    const out = await resolveRow(f, row.id, 'audit');
    expect(out.ok, `audit was refused: ${out.reason}`).toBe(true);
    expect(await journalCount(f.orgId)).toBe(before);
    expect((await sql<{ status: string }[]>`select status from trade_discrepancies where id = ${row.id}`)[0]!.status, 'audit must leave an over row open').toBe('open');
    const err = await openDay(f, c, '2026-01-20').then(() => null, (e: unknown) => e);
    expect(err, 'an audited over row stopped blocking day-open').toBeInstanceOf(TransitShortfallBlockedError);
  });
});

describe('A-c — the stock sits in ANOTHER room of the commissary, not the line\'s source room', () => {
  it('extra_dispatch is refused with a WRITTEN sentence (userMessage / reason, no digest-shaped raw text); no entry, no movement, the row stays open', async () => {
    const { f, o, row } = await overCase('ac');
    // empty the line's source room (A): dispatch the remaining 10, then hold 5 in a second room B only
    await extraOrder(f, { itemId: o.itemId, qty: '10' });
    await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`; // a commissary is a multi-room store; the fixture's is single-room
    const [locType] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} limit 1`;
    const [roomB] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, 'B', 'Stockroom B', ${locType!.id}, 'operating', false, ${f.superAdmin.personId}) returning id`;
    await stock(f, f.storeId, roomB!.id, o.itemId, '5', '300.0000');
    expect(await onHand(f.orgId, f.storeId, o.itemId), 'fixture: 5 on hand at the commissary, all in room B').toBe(5);
    const journalBefore = await journalCount(f.orgId);
    const movesBefore = Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`)[0]!.n);

    let said = '';
    let ok: boolean | undefined;
    try {
      const out = await resolveRow(f, row.id, 'extra_dispatch');
      ok = out.ok;
      said = out.reason ?? '';
    } catch (err) {
      const e = err as { message?: string; userMessage?: string };
      ok = false;
      said = `THROWN: userMessage=${e.userMessage ?? '(none)'} | raw=${e.message ?? err}`;
    }
    expect(ok, `the extra dispatch went through although the line's room holds nothing: ${said}`).toBe(false);
    expect(said, `no written sentence — got: ${said}`).not.toMatch(/^THROWN/);
    expect(said).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|violates|constraint|digest|undefined|stock_layers|consume/i);
    expect(said.length).toBeGreaterThan(20);
    expect(await journalCount(f.orgId)).toBe(journalBefore);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`)[0]!.n)).toBe(movesBefore);
    expect((await rowsOf(o.orderId))[0]!.status).toBe('open');
    console.log(`[A-c] text returned: ${said}`);
  });
});
