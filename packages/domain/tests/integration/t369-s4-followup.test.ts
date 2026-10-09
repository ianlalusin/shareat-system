import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S4 FOLLOW-UP legs (orchestrator, 2026-10-01): A the double-void loser sentence, B the NOW-stamped voids at 02:00 Manila. Fixture: t369-s4a.
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
import { reverseConsumption } from '../../src/stock/consume';
import { testItemCode } from './_fixtures/item-code';

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
  const item = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: testItemCode(), name: `Beef ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }));
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

/** 02:00 Manila on 1 April 2026 = 18:00 UTC on 31 March: the business date is OPEN (April) and, since T-373 S3 / DEF-555 (migration 0180), so is the date the movement trigger sees (its UTC date no longer decides). */
/** 23:30 Manila on 31 March = 15:30 UTC on 31 March: closed March by both calendars - the refusal control. */
const MANILA_2330_MARCH_31 = new Date('2026-03-31T15:30:00.000Z');
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


// -----------------------------------------------------------------------------------------------
// S4 FOLLOW-UP legs (orchestrator, 2026-10-01).
// -----------------------------------------------------------------------------------------------

const VOIDED_ONCE = 'This return has already been voided.';

describe('FOLLOW-UP A — the loser of a double voidReturn is told in a sentence with no id', () => {
  it('concurrent double void: the loser\'s reason is exactly "This return has already been voided." (no uuid); one reversal only', async () => {
    const { f, doReturn } = await supplierReturnFixture('fuA');
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
      (r) => r,
      (err: unknown) => ({ ok: false, reason: String((err as Error).message) }),
    );
    await new Promise((r) => setTimeout(r, 800));
    release();
    expect((await first).ok, 'the first void must succeed').toBe(true);
    const loser = await second;
    expect(loser.ok).toBe(false);
    expect(loser.reason, 'the loser\'s reason is not the person-facing sentence').toBe(VOIDED_ONCE);
    expect(String(loser.reason)).not.toMatch(UUID_RE);
  });

  it('a second void AFTER the first has committed gets the same sentence (the check above the lock says it too)', async () => {
    const { f, doReturn } = await supplierReturnFixture('fuA2');
    const recorded = await doReturn('2026-02-06');
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
    expect((await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'First'))).ok).toBe(true);
    const again = await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'Second'));
    expect(again.ok).toBe(false);
    expect(again.reason).toBe(VOIDED_ONCE);
  });
});
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('FOLLOW-UP B — voidTradeOrder / voidCustomerReturn stamp their reversal movements NOW: same Manila-day rule as the supplier voids (T-373 S3 / DEF-555)', () => {
  const NOON_APRIL_2 = new Date('2026-04-02T04:00:00.000Z'); // 12:00 Manila: UTC date also April

  it('voidTradeOrder at 02:00 Manila on 1 April with March closed: VOIDS — controls: at 23:30 Manila on 31 March the "today" sentence, nothing written, the order stays dispatched; at midday a second order voids', async () => {
    const f = await fixture('fuB-to');
    const itemId = await wholesaleItem(f);
    await receiveStock(f, itemId, 'raw_material', '50', '90.0000', '2026-01-01');
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
    const dispatched = async () => {
      const o = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-04-10', lines: [{ itemId, quantity: '5', rate: '500' }] }));
      await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
      return o.orderId;
    };
    const early = await dispatched();
    const mid = await dispatched();
    await setPeriod(f.orgId, '2026-03', 'closed');
    const before = await counts(f.orgId);

    const said = await withClock(MANILA_2330_MARCH_31, () => refusalOf(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: early, reason: 'Typed wrong' })), 'a trade-order void at 23:30 Manila on 31 March'));
    expect(said).toBe(todaySentence('March 2026', 'closed', 'voided'));
    expect(said).not.toMatch(/cannot move stock|P0001/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from trade_orders where id = ${early}`)[0]!.status).toBe('dispatched');

    expect(await withClock(MANILA_2AM_APRIL_1, () => isOk(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: early, reason: 'Typed wrong' })))), 'at 02:00 Manila on 1 April the void goes through').toBe(true);
    expect((await sql<{ status: string }[]>`select status from trade_orders where id = ${early}`)[0]!.status).not.toBe('dispatched');

    expect(await withClock(NOON_APRIL_2, () => isOk(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: mid, reason: 'Typed wrong' })))), 'control: at midday the void goes through').toBe(true);
  });

  it('voidCustomerReturn at 02:00 Manila on 1 April with March closed: VOIDS — controls: at 23:30 Manila on 31 March the "today" sentence, the return stays; at midday a second return voids', async () => {
    const f = await fixture('fuB-cr');
    const s = await externalSale(f);
    const early = await returnIt(f, s, '2026-04-12');
    const mid = await returnIt(f, s, '2026-04-13');
    for (const r of [early, mid]) if (!isOk2(r)) throw new Error('fixture: customer return did not record');
    await setPeriod(f.orgId, '2026-03', 'closed');
    const before = await counts(f.orgId);

    const said = await withClock(MANILA_2330_MARCH_31, () => refusalOf(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(early), 'Typed wrong')), 'a customer-return void at 23:30 Manila on 31 March'));
    expect(said).toBe(todaySentence('March 2026', 'closed', 'voided'));
    expect(said).not.toMatch(/cannot move stock|P0001/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await sql<{ status: string }[]>`select status from customer_returns where id = ${idOf(early)}`)[0]!.status).not.toBe('void');

    expect(await withClock(MANILA_2AM_APRIL_1, () => isOk(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(early), 'Typed wrong')))), 'at 02:00 Manila on 1 April the void goes through').toBe(true);
    expect((await sql<{ status: string }[]>`select status from customer_returns where id = ${idOf(early)}`)[0]!.status).toBe('void');

    expect(await withClock(NOON_APRIL_2, () => isOk(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(mid), 'Typed wrong')))), 'control: at midday the void goes through').toBe(true);
  });
});
const isOk2 = (r: unknown) => (r as { ok?: boolean }).ok !== false;
const idOf = (r: unknown) => String((r as { returnId?: string; id?: string }).returnId ?? (r as { id?: string }).id);

// -----------------------------------------------------------------------------------------------
// DEF-560 / audit #4 (orchestrator, 2026-10-02)
// -----------------------------------------------------------------------------------------------

describe('DEF-560 — a supplier-return void is all-or-nothing: line 2 refused leaves NO reversal movement for line 1', () => {
  /** One delivery of two different items (60 kg each), returned in one return as two lines (6 kg of each), recorded in February. */
  async function twoLineReturn(hint: string) {
    const f = await fixture(hint);
    const item2 = (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('ITEM2')}, 'Chicken Thigh', 'raw_material', 'kg', ${f.adminId}) returning id`)[0]!.id;
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, '2026-01-05', ${f.fileId}, ${f.staffId}) returning id`;
    const dls: string[] = [];
    for (const [i, item] of [f.itemId, item2].entries()) {
      const [dl] = await sql<{ id: string }[]>`
        insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
        values (${d!.id}, ${String(i + 1)}, ${item}, '60', '60', 'kg', '1', '100.0000', ${f.locationId}) returning id`;
      dls.push(dl!.id);
    }
    const received = await asOrg(f.orgId, (tx) =>
      receiveDelivery(tx, {
        orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-05', locations: loc(f), receivedBy: f.staffId,
        lines: [f.itemId, item2].map((itemId, i) => ({ lineId: String(i + 1), itemId, itemKind: 'raw_material' as never, receivedQuantity: quantity('60'), conversionFactor: '1', unitCost: '100.0000', locationId: f.locationId })),
      }),
    );
    if (!received.ok) throw new Error(`fixture: ${received.reason}`);
    const recorded = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: d!.id, returnedOn: '2026-02-06', reason: 'damaged',
        lines: [f.itemId, item2].map((itemId, i) => ({ itemId, itemKind: 'raw_material' as const, locationId: f.locationId, quantity: quantity('6.000'), deliveryLineId: dls[i]! })),
        actor: f.staff,
      }),
    );
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
    const lines = await sql<{ id: string; line_no: string; movement_id: string }[]>`
      select id, line_no, movement_id from supplier_return_lines where return_id = ${recorded.returnId} order by line_no`;
    if (lines.length !== 2) throw new Error(`fixture: expected 2 return lines, got ${lines.length}`);
    return { f, returnId: recorded.returnId, lines };
  }
  const voidMovements = async (orgId: string, returnId: string) =>
    Number((await sql<{ n: string }[]>`
      select count(*)::text as n from stock_movements where org_id = ${orgId} and source_type = 'supplier_return_void' and source_id = ${returnId}`)[0]!.n);
  const returnStatus = async (returnId: string) =>
    (await sql<{ status: string }[]>`select status from supplier_returns where id = ${returnId}`)[0]!.status;

  it('line 2\'s consumption was already given back (so its reversal is refused): the void is refused, no supplier_return_void movement exists for line 1, the return is still active', async () => {
    const { f, returnId, lines } = await twoLineReturn('def560');
    // Line 2's stock was already given back through the domain's own reverseConsumption (its layer rows are the real ones), so the
    // void finds nothing outstanding to reverse for line 2 and refuses there, AFTER line 1 has been reversed in the same transaction.
    const l2 = (await sql<{ item_id: string; location_id: string; quantity: string }[]>`
      select item_id, location_id, quantity::text as quantity from supplier_return_lines where id = ${lines[1]!.id}`)[0]!;
    const giveBack = await asOrg(f.orgId, (tx) =>
      reverseConsumption(tx, {
        orgId: f.orgId, storeId: f.storeId, locationId: l2.location_id, itemId: l2.item_id, originalMovementId: lines[1]!.movement_id,
        quantity: quantity(l2.quantity), movedAt: new Date(), kind: 'return_out', sourceType: 'test_give_back', sourceId: lines[1]!.id, createdBy: f.adminId,
      }),
    );
    if (!giveBack.ok) throw new Error(`fixture: give-back refused: ${giveBack.reason}`);
    const before = await counts(f.orgId);

    const outcome = await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, returnId, 'Typed wrong')).then(
      (r) => r as { ok: boolean; reason?: string },
      (err: unknown) => ({ ok: false, reason: `THROWN: ${String((err as Error).message)}` }),
    );
    expect(outcome.ok, 'the void was expected to be refused at line 2').toBe(false);
    expect(await voidMovements(f.orgId, returnId), 'line 1 was reversed before line 2 was refused and the reversal was left behind').toBe(0);
    expect(await returnStatus(returnId), 'the return is no longer active').not.toBe('void');
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
  });

  it('control: a clean void of the same two-line shape reverses every line and voids the return', async () => {
    const { f, returnId } = await twoLineReturn('def560c');
    const out = await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, returnId, 'Typed wrong'));
    expect(out.ok).toBe(true);
    expect(await voidMovements(f.orgId, returnId), 'one reversal movement per line').toBe(2);
    expect(await returnStatus(returnId)).toBe('void');
  });
});

describe('Audit #4 — under the REAL clock the void movements are stamped with exactly voided_at', () => {
  it('voidReturn (supplier): every supplier_return_void movement has moved_at = voided_at', async () => {
    const { f, doReturn } = await supplierReturnFixture('a4s');
    const recorded = await doReturn('2026-02-06');
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
    expect((await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'Typed wrong'))).ok).toBe(true);
    const rows = await sql<{ same: boolean }[]>`
      select (m.moved_at = r.voided_at) as same from stock_movements m join supplier_returns r on r.id = m.source_id
      where m.org_id = ${f.orgId} and m.source_type = 'supplier_return_void' and r.id = ${recorded.returnId}`;
    expect(rows.length, 'no void movement found').toBeGreaterThan(0);
    expect(rows.every((r) => r.same), 'moved_at differs from voided_at').toBe(true);
  });

  it('voidCustomerReturn: every customer-return void movement has moved_at = voided_at', async () => {
    const f = await fixture('a4c');
    const s = await externalSale(f);
    const ret = await returnIt(f, s, '2026-02-12');
    if (!isOk2(ret)) throw new Error('fixture: customer return did not record');
    expect(await isOk(asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, idOf(ret), 'Typed wrong')))).toBe(true);
    const rows = await sql<{ same: boolean; st: string }[]>`
      select (m.moved_at = r.voided_at) as same, m.source_type as st from stock_movements m join customer_returns r on r.id = m.source_id
      where m.org_id = ${f.orgId} and r.id = ${idOf(ret)} and m.source_type like '%void%'`;
    expect(rows.length, 'no void movement found for the customer return').toBeGreaterThan(0);
    expect(rows.every((r) => r.same), `moved_at differs from voided_at (${rows.map((r) => r.st).join(',')})`).toBe(true);
  });
});
