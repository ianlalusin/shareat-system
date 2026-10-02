import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S4 AUDIT legs A-F (orchestrator, 2026-10-01) — what the first S4 pass left open. Fixture and sentence helpers are
 * `t369-s4a-stock-closed-month.test.ts`'s. ⛔ TESTER. Every red leg asserts the TARGET sentence and that nothing was written.
 *   A. the supplier "today" guard must use the date the movement trigger sees (UTC date of now) — fake clock, 02:00 Manila on the 1st.
 *   B. receiveTradeOrder with no receivedOn defaults to today's BUSINESS date.
 *   C. voidReturn of a return whose returnedOn month has closed.   D. voidCustomerReturn / voidTradeOrder of a closed-month record.
 *   E. the "today" sentence variant has no "Use a date".          F. voidReturn double submit with no advance credit.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, tradeRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import {
  createCustomer,
  createItem,
  createProductionDraft,
  createTradeOrder,
  dispatchTradeOrder,
  editPostedProduction,
  humanDate,
  postProduction,
  postUsageRecord,
  quantity,
  receiveDelivery,
  receiveTradeOrder,
  recordCustomerReturn,
  recordReturn,
  voidCustomerReturn,
  voidProduction,
  voidReturn,
  voidTradeOrder,
  voidUsageRecord,
} from '@shareat/domain';
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
// The sentence, and how to read what a flow said
// -----------------------------------------------------------------------------------------------

const TAIL = " — a closed month's stock stays as it was, and the closed-month override doesn't change that. Use a date in an open month.";
const sentence = (month: string, word: 'closed' | 'locked', doing: string, isoDate: string) =>
  `${month} is ${word}. Stock can't be ${doing} on ${humanDate(parseBusinessDate(isoDate))}${TAIL}`;

/** What the call said when it refused: `{ok:false}`'s reason, a RefusalError's sentence, or a raw error message. */
async function refusalOf(p: Promise<unknown>, what: string): Promise<string> {
  try {
    const out = (await p) as { ok?: boolean; reason?: string } | undefined;
    if (out && out.ok === false) return String(out.reason);
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return String(e.userMessage ?? e.message ?? err);
  }
  throw new Error(`NOT REFUSED — ${what} succeeded in a closed month (the defect this leg targets)`);
}
const isOk = async (p: Promise<unknown>): Promise<boolean> => {
  const out = (await p) as { ok?: boolean } | undefined;
  return out?.ok !== false;
};

// -----------------------------------------------------------------------------------------------
// Fixture
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string) {
  const code = uid(`t369s4a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  const mkStore = async (label: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id`)[0]!.id;
  const storeId = await mkStore('lipa');
  const otherStoreId = await mkStore('other');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId}), (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const superAdminId = await mkPerson('Super', 'super_admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLoc = async (sid: string, c: string) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sid}, ${c}, ${`Room ${c}`}, ${type!.id}, 'operating', true, ${adminId}) returning id`)[0]!.id;
  const locationId = await mkLoc(storeId, 'A');
  const otherLocationId = await mkLoc(otherStoreId, 'B');

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${adminId}) returning id`;
  const [slab] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${uid('SLAB')}, 'Beef Forequarter', 'meat_slab', 'kg', ${adminId}) returning id`;
  const mkSlice = async (c: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
      values (${orgId}, ${uid(c)}, ${`Beef Slice ${c}`}, 'meat_sliced', 'kg', ${slab!.id}, ${adminId}) returning id`)[0]!.id;
  const sliceA = await mkSlice('A');
  const sliceB = await mkSlice('B');
  const sliceC = await mkSlice('C');

  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by, credit_terms_days) values (${orgId}, 'Acme Meats', ${adminId}, 30) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/p.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${adminId}) returning id`;

  return {
    orgId, storeId, otherStoreId, locationId, otherLocationId, itemId: item!.id, slabId: slab!.id, sliceA, sliceB, sliceC,
    supplierId: supplier!.id, fileId: file!.id,
    admin: actor(orgId, adminId), superAdmin: actor(orgId, superAdminId), manager: actor(orgId, managerId), staff: actor(orgId, staffId), adminId, managerId, staffId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const loc = (f: Fixture, id = f.locationId) => [{ id, role: 'operating' as const, purpose: 'normal' as const, isDefault: true, status: 'active' as const }];

/** Closes (or locks) `ym` — and every EARLIER month, because the database refuses an open period that precedes a closed one.
 *  So every "open date" control in this file is dated AFTER the closed month. */
async function setPeriod(orgId: string, ym: string, status: 'closed' | 'locked') {
  await sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on <= ${`${ym}-01`}`;
  if (status === 'locked') {
    // A locked year may hold no open period (fiscal_periods trigger): close the whole year, then lock the whole year.
    const year = ym.slice(0, 4);
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on between ${`${year}-01-01`} and ${`${year}-12-01`}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${orgId} and starts_on between ${`${year}-01-01`} and ${`${year}-12-01`}`;
  }
}

async function counts(orgId: string) {
  const [m] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${orgId}`;
  const [e] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`;
  const [o] = await sql<{ n: string }[]>`select count(*)::text as n from period_overrides where org_id = ${orgId}`;
  return { movements: Number(m!.n), entries: Number(e!.n), overrides: Number(o!.n) };
}

/** Stock `qty` of `itemId` at `locationId` through a real delivery receipt dated `on` (an OPEN month). */
async function receiveStock(f: Fixture, itemId: string, itemKind: string, qty: string, cost: string, on: string, storeId = f.storeId, locationId = f.locationId) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'supplier', ${f.supplierId}, ${on}, ${f.fileId}, ${f.staffId}) returning id`;
  const [dl] = await sql<{ id: string }[]>`
    insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
    values (${d!.id}, '1', ${itemId}, ${qty}, ${qty}, 'kg', '1', ${cost}, ${locationId}) returning id`;
  const r = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: on, locations: loc(f, locationId), receivedBy: f.staffId,
      lines: [{ lineId: '1', itemId, itemKind: itemKind as never, receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId }],
    }),
  );
  if (!r.ok) throw new Error(`receiveStock setup failed: ${r.reason}`);
  return { deliveryId: d!.id, deliveryLineId: dl!.id };
}

async function wholesaleItem(f: Fixture): Promise<string> {
  const item = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: uid('WS'), name: `Beef ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }));
  return item.id;
}
/** A dispatched external sale (dated 10 Jan 2026) ready to return. */
async function externalSale(f: Fixture) {
  const itemId = await wholesaleItem(f);
  await receiveStock(f, itemId, 'raw_material', '50', '90.0000', '2026-01-01');
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
  const order = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '10', rate: '500' }] }));
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, lineId: lines[0]!.id };
}
/** A dispatched AND received internal transfer (commissary -> other store) ready to return. */
async function internalTransfer(f: Fixture) {
  const itemId = await wholesaleItem(f);
  await receiveStock(f, itemId, 'raw_material', '20', '90.0000', '2026-01-01');
  await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
            values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.adminId})`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }));
  const order = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '10', rate: '100' }] }));
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-11' }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, lineId: lines[0]!.id };
}
const returnIt = (f: Fixture, s: { orderId: string; lineId: string }, returnedOn: string) =>
  asOrg(f.orgId, (tx) => recordCustomerReturn(tx, { tradeOrderId: s.orderId, returnedOn, reason: 'Wrong item shipped.', lines: [{ tradeOrderLineId: s.lineId, quantity: '4' }], actor: f.manager }));
const customerReturnRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from customer_returns where org_id = ${orgId}`)[0]!.n);


// -----------------------------------------------------------------------------------------------
// AUDIT legs A-F (orchestrator, 2026-10-01). Same fixture as `t369-s4a-stock-closed-month.test.ts`.
// -----------------------------------------------------------------------------------------------

/** The "today" variant (E): no date to pick, so no "Use a date in an open month". */
const todaySentence = (month: string, word: 'closed' | 'locked', doing: string) =>
  `${month} is ${word}. Stock can't be ${doing} today — a closed month's stock stays as it was.`;

/** 02:00 Manila on 1 April 2026 = 18:00 UTC on 31 March: the business date is OPEN (April) while the UTC date the movement trigger sees is CLOSED (March). */
const MANILA_2AM_APRIL_1 = new Date('2026-03-31T18:00:00.000Z');
async function withClock<T>(at: Date, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

async function supplierReturnFixture(hint: string) {
  const f = await fixture(hint);
  const rec = await receiveStock(f, f.itemId, 'raw_material', '60', '100.0000', '2026-01-05');
  const doReturn = (returnedOn: string, qty = '10.000') =>
    asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: rec.deliveryId, returnedOn, reason: 'damaged',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity(qty), deliveryLineId: rec.deliveryLineId }],
        actor: f.staff,
      }),
    );
  return { f, rec, doReturn };
}

describe('AUDIT A — the "today" guard uses the date the movement trigger sees (UTC), not the Manila business date', () => {
  it('recordReturn at 02:00 Manila on 1 April, with March closed: the closed-month "today" sentence for March, never a raw P0001; nothing written — control: the same flow at midday Manila (UTC date also April) records', async () => {
    const { f, doReturn } = await supplierReturnFixture('auditA-rec');
    await setPeriod(f.orgId, '2026-03', 'closed');
    const before = await counts(f.orgId);

    const said = await withClock(MANILA_2AM_APRIL_1, () => refusalOf(doReturn('2026-04-06'), 'a supplier return at 02:00 Manila with the UTC date in a closed month'));
    expect(said).toBe(todaySentence('March 2026', 'closed', 'returned'));
    expect(said).not.toMatch(/cannot move stock|P0001/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });

    const noon = new Date('2026-04-02T04:00:00.000Z'); // 12:00 Manila on 2 April: UTC date is also April
    expect(await withClock(noon, async () => isOk(doReturn('2026-04-06'))), 'control: with both dates in April the return records').toBe(true);
  });

  it('voidReturn at 02:00 Manila on 1 April, with March closed: the same sentence ("voided"); the return stays recorded', async () => {
    const { f, doReturn } = await supplierReturnFixture('auditA-void');
    const recorded = await doReturn('2026-04-06');
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
    await setPeriod(f.orgId, '2026-03', 'closed');
    const before = await counts(f.orgId);

    const said = await withClock(MANILA_2AM_APRIL_1, () =>
      refusalOf(asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'Sent back by mistake')), 'a supplier-return void at 02:00 Manila with the UTC date in a closed month'),
    );
    expect(said).toBe(todaySentence('March 2026', 'closed', 'voided'));
    expect(said).not.toMatch(/cannot move stock|P0001/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from supplier_returns where id = ${recorded.returnId}`)[0]!.status).not.toBe('void');
  });
});

describe('AUDIT B — receiveTradeOrder with NO receivedOn defaults to today\'s BUSINESS date (Manila), not the UTC date', () => {
  it('at 02:00 Manila on 1 April with March closed: the receipt posts (April is open) instead of being refused as a March receipt', async () => {
    const f = await fixture('auditB');
    const itemId = await wholesaleItem(f);
    await receiveStock(f, itemId, 'raw_material', '20', '90.0000', '2026-01-01');
    await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
              values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.adminId})`;
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }));
    const order = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '10', rate: '100' }] }));
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    await setPeriod(f.orgId, '2026-03', 'closed');

    const outcome = await withClock(MANILA_2AM_APRIL_1, () =>
      asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId })).then(
        (r) => ({ ok: true as const, r }),
        (err: unknown) => ({ ok: false as const, said: String((err as { userMessage?: string; message?: string }).userMessage ?? (err as Error).message) }),
      ),
    );
    expect(outcome.ok ? 'received' : outcome.said, 'a receipt on the Manila 1 April was refused as a closed-month receipt').toBe('received');
    const [row] = await sql<{ status: string }[]>`select status from trade_orders where id = ${order.orderId}`;
    expect(row!.status).toBe('received');
  });
});

describe('AUDIT C — voidReturn of a return whose returnedOn month has since closed (today is open)', () => {
  it('refused with the "voided" sentence for returnedOn; nothing written; the return stays recorded — control: a return in an open month voids', async () => {
    const { f, doReturn } = await supplierReturnFixture('auditC');
    const inFeb = await doReturn('2026-02-06');
    const inMar = await doReturn('2026-03-06');
    if (!inFeb.ok || !inMar.ok) throw new Error('fixture: returns did not record');
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, inFeb.returnId, 'Typed wrong')), 'a void of a return recorded in a month that is now closed');
    expect(said).toBe(sentence('February 2026', 'closed', 'voided', '2026-02-06'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from supplier_returns where id = ${inFeb.returnId}`)[0]!.status).not.toBe('void');

    expect(await isOk(asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, inMar.returnId, 'Typed wrong'))), 'control: the March return voids').toBe(true);
  });
});

describe('AUDIT D — voidCustomerReturn and voidTradeOrder of a record in a closed month', () => {
  it('voidCustomerReturn: returned 10 Feb, February closed -> the "voided" sentence for returnedOn; nothing written; the return stays — control: a March return voids', async () => {
    const f = await fixture('auditD-cr');
    const s = await externalSale(f);
    const feb = await returnIt(f, s, '2026-02-10');
    const mar = await returnIt(f, s, '2026-03-05');
    for (const r of [feb, mar]) if (!isOk2(r)) throw new Error('fixture: customer return did not record');
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(feb), 'Typed wrong')), 'a customer-return void in a closed month');
    expect(said).toBe(sentence('February 2026', 'closed', 'voided', '2026-02-10'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from customer_returns where id = ${idOf(feb)}`)[0]!.status).not.toBe('void');

    expect(await isOk(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(mar), 'Typed wrong'))), 'control: the March return voids').toBe(true);
  });

  it('voidTradeOrder: a dispatched external order dated 10 Jan, January closed -> the "voided" sentence for the order date; the order stays dispatched — control: a March order voids', async () => {
    const f = await fixture('auditD-to');
    const itemId = await wholesaleItem(f);
    await receiveStock(f, itemId, 'raw_material', '50', '90.0000', '2026-01-01');
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
    const dispatched = async (orderDate: string) => {
      const o = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate, lines: [{ itemId, quantity: '5', rate: '500' }] }));
      await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
      return o.orderId;
    };
    const jan = await dispatched('2026-01-10');
    const mar = await dispatched('2026-03-10');
    await setPeriod(f.orgId, '2026-01', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: jan, reason: 'Typed wrong' })), 'a trade-order void in a closed month');
    expect(said).toBe(sentence('January 2026', 'closed', 'voided', '2026-01-10'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from trade_orders where id = ${jan}`)[0]!.status).toBe('dispatched');

    expect(await isOk(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: mar, reason: 'Typed wrong' }))), 'control: the March order voids').toBe(true);
  });
});
const isOk2 = (r: unknown) => (r as { ok?: boolean }).ok !== false;
const idOf = (r: unknown) => String((r as { returnId?: string; id?: string }).returnId ?? (r as { id?: string }).id);

describe('AUDIT E — the "today" refusals do not tell the person to pick a date', () => {
  it('closed AND locked variants: "{Month YYYY} is {closed|locked}. Stock can\'t be returned today — a closed month\'s stock stays as it was." (no "Use a date")', async () => {
    const today = toBusinessDate();
    const todayMonth = today.slice(0, 7);
    const label = new Date(`${todayMonth}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    for (const status of ['closed', 'locked'] as const) {
      const { f, doReturn } = await supplierReturnFixture(`auditE-${status}`);
      await setPeriod(f.orgId, todayMonth, status);
      const said = await refusalOf(doReturn('2027-03-06'), `a supplier return while today's month is ${status}`);
      expect(said).toBe(todaySentence(label, status, 'returned'));
      expect(said).not.toMatch(/Use a date|override/);
    }
  });
});

describe('AUDIT F — voidReturn with NO advance credit: a double submit says "already void"', () => {
  it('two concurrent voids of one return (no 1240 credit): the loser gets "already void" and exactly one set of reversals exists', async () => {
    const { f, doReturn } = await supplierReturnFixture('auditF');
    const recorded = await doReturn('2026-02-06');
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstDone!: () => void;
    const voided = new Promise<void>((r) => (firstDone = r));
    const first = asOrg(f.orgId, async (tx) => {
      const out = await voidReturn(tx, f.manager, recorded.returnId, 'First click');
      firstDone();
      await gate;
      return out;
    });
    await Promise.race([voided, first]);
    const second = asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'Second click')).then(
      (r) => ({ settled: true as const, r }),
      (err: unknown) => ({ settled: true as const, r: { ok: false, reason: String((err as Error).message) } }),
    );
    await new Promise((r) => setTimeout(r, 800));
    release();
    const a = await first;
    const b = await second;
    expect(a.ok, 'the first void must succeed').toBe(true);
    expect(b.r.ok, 'the second void succeeded too').toBe(false);
    expect(String(b.r.reason), 'the loser did not get the "already void" answer').toMatch(/already been voided/i);
    const [m] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId} and source_type = 'supplier_return_void' and source_id = ${recorded.returnId}`;
    expect(Number(m!.n), 'the return was reversed twice').toBe(1);
  });
});
