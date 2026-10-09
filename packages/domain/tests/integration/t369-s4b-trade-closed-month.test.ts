import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S4b (DEF-302, Ian (a)) — the TRADE flows: `receiveTradeOrder` and `dispatchTradeOrder` dated in a
 * closed (or locked) month are refused in plain words BEFORE any write. `docs/tasks/369-unwired-money-screens.md`
 * §S4b, T4, T5, T6 and T7 (the trade legs).
 *
 *   "{Month YYYY} is closed. Stock can't be {received|dispatched} on {date} — a closed month's stock stays
 *    as it was, and the closed-month override doesn't change that. Use a date in an open month."
 *
 * ⛔ TESTER, not BUILDER. Real domain functions over a real Postgres; the DB trigger 0145 stays the
 * enforcement (I3). Each leg asserts the sentence AND that nothing was written — no stock_movements, no
 * journal_entries, no `trade_order_lines.received_quantity` change, no `deliveries` row, the order's status
 * unchanged — and each refusal has a positive control (the same flow dated in an open, LATER month: the
 * database refuses an open period that precedes a closed one, so controls come after the closed month).
 *
 * S4b waits for T-372 S3 (it edits `trade/index.ts`); these tests do not depend on that.
 * Fixture is `customer-returns.test.ts`'s (`aSale` / `transferAndReceive`) on `supplier-returns.test.ts`'s base.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import {
  createCustomer,
  createItem,
  createTradeOrder,
  dispatchTradeOrder,
  humanDate,
  quantity,
  receiveDelivery,
  receiveTradeOrder,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
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

async function fixture(hint: string) {
  const code = uid(`t369s4b-${hint}`);
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
  await mkLoc(otherStoreId, 'B');
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by, credit_terms_days) values (${orgId}, 'Acme Meats', ${adminId}, 30) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/p.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${adminId}) returning id`;

  return {
    orgId, storeId, otherStoreId, locationId, supplierId: supplier!.id, fileId: file!.id,
    admin: actor(orgId, adminId), superAdmin: actor(orgId, superAdminId), manager: actor(orgId, managerId), staff: actor(orgId, staffId),
    adminId, managerId, staffId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Closes `ym` and every EARLIER month (the database refuses an open period that precedes a closed one). */
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

async function receiveStock(f: Fixture, itemId: string, qty: string, cost: string, on: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, ${on}, ${f.fileId}, ${f.staffId}) returning id`;
  await sql`
    insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
    values (${d!.id}, '1', ${itemId}, ${qty}, ${qty}, 'kg', '1', ${cost}, ${f.locationId})`;
  const r = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: on,
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }], receivedBy: f.staffId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: f.locationId }],
    }),
  );
  if (!r.ok) throw new Error(`receiveStock setup failed: ${r.reason}`);
}

// -----------------------------------------------------------------------------------------------
// Trade fixtures
// -----------------------------------------------------------------------------------------------

const orderStatus = async (id: string) => (await sql<{ status: string }[]>`select status from trade_orders where id = ${id}`)[0]!.status;
const receivedQty = async (orderId: string) =>
  (await sql<{ q: string | null }[]>`select received_quantity::text as q from trade_order_lines where order_id = ${orderId} order by id limit 1`)[0]!.q;
const deliveryRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from deliveries where org_id = ${orgId}`)[0]!.n);

async function wholesaleItem(f: Fixture): Promise<string> {
  const item = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: testItemCode(), name: `Beef ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }));
  return item.id;
}
/** An EXTERNAL order for 10 kg dated `orderDate`, created (not dispatched). Stock was received 1 Jan 2026. */
async function externalOrder(f: Fixture, orderDate: string) {
  const itemId = await wholesaleItem(f);
  await receiveStock(f, itemId, '50', '90.0000', '2026-01-01');
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
  const order = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate, lines: [{ itemId, quantity: '10', rate: '500' }] }));
  return order.orderId;
}
/** An INTERNAL order (commissary -> the other store) dispatched on 10 Jan 2026 and waiting to be received. */
async function dispatchedInternalOrder(f: Fixture) {
  const itemId = await wholesaleItem(f);
  await receiveStock(f, itemId, '20', '90.0000', '2026-01-01');
  await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
            values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.adminId})`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }));
  const order = await asOrg(f.orgId, (tx) => createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '10', rate: '100' }] }));
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  return order.orderId;
}
const dispatch = (f: Fixture, who: Actor, orderId: string) => asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, who, { orderId }));
const receive = (f: Fixture, who: Actor, orderId: string, receivedOn: string) => asOrg(f.orgId, (tx) => receiveTradeOrder(tx, who, { orderId, receivedOn }));

// -----------------------------------------------------------------------------------------------
// T4 — receiveTradeOrder
// -----------------------------------------------------------------------------------------------

describe('T4 — receiveTradeOrder with receivedOn in a closed month', () => {
  it("refused with \"February 2026 is closed. Stock can't be received on …\" (a refuse() sentence); received_quantity unchanged, no delivery row, no movement, no entry — positive control: an open (later) date receives", async () => {
    const f = await fixture('t4');
    const orderId = await dispatchedInternalOrder(f);
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);
    const qtyBefore = await receivedQty(orderId);
    const deliveriesBefore = await deliveryRows(f.orgId);

    const said = await refusalOf(receive(f, f.manager, orderId, '2026-02-05'), 'a trade-order receipt in February 2026');
    expect(said).toBe(sentence('February 2026', 'closed', 'received', '2026-02-05'));
    expect(said).not.toMatch(/cannot move stock/);

    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect(await receivedQty(orderId), 'setLineReceivedQuantity wrote before the check').toBe(qtyBefore);
    expect(await deliveryRows(f.orgId)).toBe(deliveriesBefore);

    expect(await isOk(receive(f, f.manager, orderId, '2026-03-05')), 'the same order, an open date, receives').toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T5 — dispatchTradeOrder (dated by order.orderDate)
// -----------------------------------------------------------------------------------------------

describe('T5 — dispatchTradeOrder of an order whose orderDate is in a closed month', () => {
  it("refused with \"… Stock can't be dispatched on <orderDate>\"; the order stays not dispatched; no movement, no entry — positive control: an order dated in an open (later) month dispatches", async () => {
    const f = await fixture('t5');
    const closedOrder = await externalOrder(f, '2026-02-05');
    const openOrder = await externalOrder(f, '2026-03-05');
    const statusBefore = await orderStatus(closedOrder);
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(dispatch(f, f.manager, closedOrder), 'a dispatch of an order dated in February 2026');
    expect(said).toBe(sentence('February 2026', 'closed', 'dispatched', '2026-02-05'));
    expect(said).not.toMatch(/cannot move stock/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect(await orderStatus(closedOrder), 'the order must stay as it was').toBe(statusBefore);

    expect(await isOk(dispatch(f, f.manager, openOrder))).toBe(true);
    expect(await orderStatus(openOrder)).not.toBe(statusBefore);
  });
});

// -----------------------------------------------------------------------------------------------
// T6 (I5) / T7 — the override never reaches stock; locked says locked
// -----------------------------------------------------------------------------------------------

describe('T6 (I5) — an admin holding override_period_lock gets the SAME sentence on receive and dispatch', () => {
  it('receive and dispatch by the admin -> the identical sentences; zero period_overrides rows; nothing written', async () => {
    const f = await fixture('t6');
    const receiving = await dispatchedInternalOrder(f);
    const dispatching = await externalOrder(f, '2026-02-05');
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    expect(await refusalOf(receive(f, f.admin, receiving, '2026-02-05'), 'an admin receipt in a closed month'))
      .toBe(sentence('February 2026', 'closed', 'received', '2026-02-05'));
    expect(await refusalOf(dispatch(f, f.admin, dispatching), 'an admin dispatch in a closed month'))
      .toBe(sentence('February 2026', 'closed', 'dispatched', '2026-02-05'));
    expect(await counts(f.orgId)).toEqual({ ...before, overrides: 0 });
  });
});

describe('T7 — a LOCKED month says "locked" (receive)', () => {
  it("receiveTradeOrder in a locked month -> \"February 2026 is locked. Stock can't be received on …\"", async () => {
    const f = await fixture('t7');
    const orderId = await dispatchedInternalOrder(f);
    await setPeriod(f.orgId, '2026-02', 'locked');

    const said = await refusalOf(receive(f, f.manager, orderId, '2026-02-05'), 'a trade-order receipt in a locked month');
    expect(said).toBe(sentence('February 2026', 'locked', 'received', '2026-02-05'));
    expect(said).not.toMatch(/closed\./);
  });
});
