import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S4a (DEF-302, Ian (a)) — a stock-moving flow dated in a closed (or locked) month is refused IN
 * PLAIN WORDS, before any write. `docs/tasks/369-unwired-money-screens.md` §S4a, T1–T3, T6–T8.
 *
 *   "{Month YYYY} is closed. Stock can't be {doing} on {date} — a closed month's stock stays as it was,
 *    and the closed-month override doesn't change that. Use a date in an open month."   (locked: "is locked.")
 *
 * ⛔ TESTER, not BUILDER. Every flow is driven through its REAL domain function against a REAL Postgres
 * (the DB trigger 0145 is the enforcement and stays, I3). What each leg asserts is the TARGET: the
 * sentence the person reads, and that NOTHING was written — zero new `stock_movements`, zero new
 * `journal_entries`, the record unchanged. Every refusal has a positive control that runs the SAME
 * flow in an open month.
 *
 * On HEAD every red leg fails because the refusal text is the trigger's raw P0001 ("cannot move stock
 * into a closed period …") or a thrown error, never the sentence. `refusalOf` returns whatever the call
 * said — `{ok:false, reason}`, a `RefusalError.userMessage`, or a raw message — so the diff reads as
 * "expected the sentence, got the trigger text".
 *
 * Ruled by the orchestrator (2026-10-01): `voidReturn`'s `doing` is "voided"; `recordReturn` says "returned"
 * whether it is `returnedOn` or today's date that is closed.
 *
 * Fixture is `supplier-returns.test.ts`'s (stores, staff/manager/admin, locations, supplier, raw item,
 * `receiveOne`) plus `production.test.ts`'s slab/slice items and `customer-returns.test.ts`'s trade
 * orders; periods run Jan 2025 – Dec 2027 so a flow dated in Feb 2026 AND one moving stock "now" both
 * have an open month to start from.
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
  voidProduction,
  voidReturn,
  voidUsageRecord,
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

// -----------------------------------------------------------------------------------------------
// The sentence, and how to read what a flow said
// -----------------------------------------------------------------------------------------------

const TAIL = " — a closed month's stock stays as it was, and the closed-month override doesn't change that. Use a date in an open month.";
/** The "today" variant (AUDIT E): the stock moves at NOW, so there is no date to pick - and no "Use a date in an open month". */
const todaySentence = (month: string, word: 'closed' | 'locked', doing: string) =>
  `${month} is ${word}. Stock can't be ${doing} today — a closed month's stock stays as it was.`;
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
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLoc = async (sid: string, c: string) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sid}, ${c}, ${`Room ${c}`}, ${type!.id}, 'operating', true, ${adminId}) returning id`)[0]!.id;
  const locationId = await mkLoc(storeId, 'A');
  const otherLocationId = await mkLoc(otherStoreId, 'B');

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${adminId}) returning id`;
  const [slab] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Beef Forequarter', 'meat_slab', 'kg', ${adminId}) returning id`;
  const mkSlice = async (c: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
      values (${orgId}, ${testItemCode()}, ${`Beef Slice ${c}`}, 'meat_sliced', 'kg', ${slab!.id}, ${adminId}) returning id`)[0]!.id;
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

// -----------------------------------------------------------------------------------------------
// T1 / T2 / T6 / T7 — production
// -----------------------------------------------------------------------------------------------

async function draft(f: Fixture, producedOn: string): Promise<string> {
  const d = await asOrg(f.orgId, (tx) =>
    createProductionDraft(tx, f.staff, {
      orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', producedOn, labourCost: '1000.00',
      inputs: [{ itemId: f.slabId, quantity: '50', unit: 'kg' }],
      outputs: [{ itemId: f.sliceA, quantity: '20', unit: 'kg' }, { itemId: f.sliceB, quantity: '17', unit: 'kg' }, { itemId: f.sliceC, quantity: '11', unit: 'kg' }],
    }),
  );
  if (!d.ok) throw new Error(`draft failed: ${d.reason}`);
  return d.recordId;
}
const post = (f: Fixture, who: Actor, recordId: string) => asOrg(f.orgId, (tx) => postProduction(tx, who, { recordId }));
const prodStatus = async (id: string) => (await sql<{ status: string; revision: number }[]>`select status, revision from production_records where id = ${id}`)[0]!;

describe('T1 — a production post dated in a closed month', () => {
  it('refused with "September 2026 is closed. Stock can\'t be produced on …" — never the trigger text; zero movements, zero entries, the record stays a draft', async () => {
    const f = await fixture('t1');
    await receiveStock(f, f.slabId, 'meat_slab', '100', '300.0000', '2026-08-01');
    const recordId = await draft(f, '2026-09-15');
    await setPeriod(f.orgId, '2026-09', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(post(f, f.manager, recordId), 'a production post in September 2026');
    expect(said).toBe(sentence('September 2026', 'closed', 'produced', '2026-09-15'));
    expect(said).not.toMatch(/cannot move stock/);

    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect((await prodStatus(recordId)).status).toBe('draft');
  });

  it('positive control: the SAME flow dated in an open month posts', async () => {
    const f = await fixture('t1pc');
    await receiveStock(f, f.slabId, 'meat_slab', '100', '300.0000', '2026-08-01');
    const recordId = await draft(f, '2026-10-05');
    await setPeriod(f.orgId, '2026-09', 'closed'); // a closed month elsewhere changes nothing
    expect(await isOk(post(f, f.manager, recordId))).toBe(true);
    expect((await prodStatus(recordId)).status).toBe('posted');
  });
});

describe('T2 — production void and edit of a record whose month has since closed', () => {
  it('void -> "… Stock can\'t be voided on …"; edit -> "… Stock can\'t be changed on …"; the record stays posted at its revision; no reversal', async () => {
    const f = await fixture('t2');
    await receiveStock(f, f.slabId, 'meat_slab', '100', '300.0000', '2026-08-01');
    const recordId = await draft(f, '2026-09-15');
    expect(await isOk(post(f, f.manager, recordId)), 'fixture: posted while September was open').toBe(true);
    const posted = await prodStatus(recordId);
    await setPeriod(f.orgId, '2026-09', 'closed');
    const before = await counts(f.orgId);

    const voided = await refusalOf(asOrg(f.orgId, (tx) => voidProduction(tx, f.manager, { recordId, reason: 'Mistake' })), 'a production void in a closed month');
    expect(voided).toBe(sentence('September 2026', 'closed', 'voided', '2026-09-15'));

    const edited = await refusalOf(
      asOrg(f.orgId, (tx) =>
        editPostedProduction(tx, f.manager, {
          recordId, labourCost: '1200.00',
          inputs: [{ itemId: f.slabId, quantity: '50', unit: 'kg' }],
          outputs: [{ itemId: f.sliceA, quantity: '25', unit: 'kg' }, { itemId: f.sliceB, quantity: '20', unit: 'kg' }],
        }),
      ),
      'a production edit in a closed month',
    );
    expect(edited).toBe(sentence('September 2026', 'closed', 'changed', '2026-09-15'));

    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    expect(await prodStatus(recordId)).toEqual(posted);
    const [rev] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and reversal_of_entry_id is not null`;
    expect(Number(rev!.n), 'no reversal was written').toBe(0);
  });
});

describe('T6 (I5) — an admin holding override_period_lock gets the SAME sentence; the override never reaches stock', () => {
  it('production post by the admin -> the identical sentence; zero period_overrides rows', async () => {
    const f = await fixture('t6');
    await receiveStock(f, f.slabId, 'meat_slab', '100', '300.0000', '2026-08-01');
    const recordId = await draft(f, '2026-09-15');
    await setPeriod(f.orgId, '2026-09', 'closed');

    const said = await refusalOf(post(f, f.admin, recordId), 'an admin production post in a closed month');
    expect(said).toBe(sentence('September 2026', 'closed', 'produced', '2026-09-15'));
    expect((await counts(f.orgId)).overrides).toBe(0);
    expect((await prodStatus(recordId)).status).toBe('draft');
  });
});

describe('T7 — a LOCKED month says "locked"', () => {
  it('production post in a locked month -> "September 2026 is locked. Stock can\'t be produced on …"', async () => {
    const f = await fixture('t7');
    await receiveStock(f, f.slabId, 'meat_slab', '100', '300.0000', '2026-08-01');
    const recordId = await draft(f, '2026-09-15');
    await setPeriod(f.orgId, '2026-09', 'locked');

    const said = await refusalOf(post(f, f.manager, recordId), 'a production post in a locked month');
    expect(said).toBe(sentence('September 2026', 'locked', 'produced', '2026-09-15'));
    expect(said).not.toMatch(/closed\./);
  });
});

// -----------------------------------------------------------------------------------------------
// T3 — customer returns, internal and external
// -----------------------------------------------------------------------------------------------

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

describe('T3 — recordCustomerReturn with returnedOn in a closed month (both branches)', () => {
  for (const [name, make] of [['external', externalSale], ['internal', internalTransfer]] as const) {
    it(`${name}: refused with "February 2026 is closed. Stock can't be returned on …"; no movement, no entry, no customer_returns row — positive control: the same order returns on an open date`, async () => {
      const f = await fixture(`t3-${name}`);
      const s = await make(f);
      await setPeriod(f.orgId, '2026-02', 'closed');
      const before = await counts(f.orgId);

      const said = await refusalOf(returnIt(f, s, '2026-02-10'), `a ${name} customer return in February 2026`);
      expect(said).toBe(sentence('February 2026', 'closed', 'returned', '2026-02-10'));
      expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
      expect(await customerReturnRows(f.orgId)).toBe(0);

      expect(await isOk(returnIt(f, s, '2026-03-05')), 'the same order, an open (later) date, returns').toBe(true);
      expect(await customerReturnRows(f.orgId)).toBe(1);
    });
  }
});

// -----------------------------------------------------------------------------------------------
// T8 (DEF-528) — the other stock-plus-ledger flows, one leg each
// -----------------------------------------------------------------------------------------------

describe('T8 — receiveDelivery with deliveredOn in a closed month', () => {
  async function pendingDelivery(f: Fixture, on: string) {
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, ${on}, ${f.fileId}, ${f.staffId}) returning id`;
    return () =>
      asOrg(f.orgId, (tx) =>
        receiveDelivery(tx, {
          orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: on, locations: loc(f), receivedBy: f.staffId,
          lines: [{ lineId: '1', itemId: f.itemId, itemKind: 'raw_material', receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '100.0000', locationId: f.locationId }],
        }),
      );
  }

  it('refused with the "received" sentence; zero movements, zero entries — positive control: an open date receives', async () => {
    const f = await fixture('t8-recv');
    const closedReceive = await pendingDelivery(f, '2026-02-06');
    const openReceive = await pendingDelivery(f, '2026-03-20');
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(closedReceive(), 'a delivery receipt in February 2026');
    expect(said).toBe(sentence('February 2026', 'closed', 'received', '2026-02-06'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });

    expect(await isOk(openReceive())).toBe(true);
  });
});

describe('T8 — usage records (consumption AND wastage) and their void', () => {
  const usage = (f: Fixture, kind: 'usage' | 'wastage', usedOn: string, recordId = crypto.randomUUID()) =>
    asOrg(f.orgId, (tx) =>
      postUsageRecord(tx, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, recordId, kind, usedOn, postedBy: f.staffId,
        ...(kind === 'wastage' ? { reason: 'spoilage' as const } : {}),
        lines: [{ lineId: '1', itemId: f.itemId, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('5') }],
      }),
    );

  for (const [kind, doing] of [['usage', 'used'], ['wastage', 'wasted']] as const) {
    it(`${kind}: usedOn in a closed month -> the "${doing}" sentence; zero movements/entries — positive control: an open date posts`, async () => {
      const f = await fixture(`t8-${kind}`);
      await receiveStock(f, f.itemId, 'raw_material', '50', '100.0000', '2026-01-01');
      await setPeriod(f.orgId, '2026-02', 'closed');
      const before = await counts(f.orgId);

      const said = await refusalOf(usage(f, kind, '2026-02-10'), `${kind} dated in February 2026`);
      expect(said).toBe(sentence('February 2026', 'closed', doing, '2026-02-10'));
      expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });

      expect(await isOk(usage(f, kind, '2026-03-20'))).toBe(true);
    });
  }

  it('voidUsageRecord with voidedOn in a closed month -> the "voided" sentence; the usage stays posted (no reversal) — positive control: an open voidedOn voids it', async () => {
    const f = await fixture('t8-void');
    await receiveStock(f, f.itemId, 'raw_material', '50', '100.0000', '2026-01-01');
    const recordId = crypto.randomUUID();
    const posted = await usage(f, 'usage', '2026-02-10', recordId);
    if (!posted.ok) throw new Error(`fixture: ${posted.reason}`);
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);
    const voidOn = (voidedOn: string) =>
      asOrg(f.orgId, (tx) =>
        voidUsageRecord(tx, {
          orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, recordId, kind: 'usage', voidedOn, voidedBy: f.staffId,
          lines: [{ itemId: f.itemId, movementId: posted.movementIds[0]!, quantity: quantity('5') }],
        }),
      );

    const said = await refusalOf(voidOn('2026-02-12'), 'a usage void dated in a closed February');
    expect(said).toBe(sentence('February 2026', 'closed', 'voided', '2026-02-12'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });

    expect(await isOk(voidOn('2026-03-02')), 'an open voidedOn voids it').toBe(true);
  });
});

describe('T8 — supplier returns (recordReturn moves stock at NOW but posts at returnedOn; voidReturn moves at NOW)', () => {
  const today = toBusinessDate();
  const todayMonth = today.slice(0, 7);
  // The first of next month + 5 days: returnedOn must be OPEN while today's month is closed, and an open month
  // can only come AFTER a closed one.
  const nextMonth = (() => { const [y, m] = todayMonth.split('-').map(Number); return new Date(Date.UTC(y!, m!, 6)).toISOString().slice(0, 10); })();
  const todayMonthLabel = new Date(`${todayMonth}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const doReturn = (f: Fixture, returnedOn: string, deliveryLineId: string, deliveryId: string) =>
    asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId, returnedOn, reason: 'damaged',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );

  it('returnedOn in a closed month while today is open -> the "returned" sentence for returnedOn; nothing written — positive control: an open returnedOn records', async () => {
    const f = await fixture('t8-ret-a');
    const rec = await receiveStock(f, f.itemId, 'raw_material', '30', '100.0000', '2026-01-05');
    await setPeriod(f.orgId, '2026-02', 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(doReturn(f, '2026-02-06', rec.deliveryLineId, rec.deliveryId), 'a supplier return with returnedOn in February 2026');
    expect(said).toBe(sentence('February 2026', 'closed', 'returned', '2026-02-06'));
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });

    expect(await isOk(doReturn(f, '2026-03-06', rec.deliveryLineId, rec.deliveryId))).toBe(true);
  });

  it("TODAY's month closed while returnedOn is open -> refused too (the stock moves at NOW); nothing written", async () => {
    const f = await fixture('t8-ret-b');
    const rec = await receiveStock(f, f.itemId, 'raw_material', '30', '100.0000', '2026-01-05');
    await setPeriod(f.orgId, todayMonth, 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(doReturn(f, nextMonth, rec.deliveryLineId, rec.deliveryId), "a supplier return while today's month is closed");
    expect(said).toBe(todaySentence(todayMonthLabel, 'closed', 'returned'));
    expect(said).not.toMatch(/cannot move stock/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
  });

  it("voidReturn with TODAY's month closed -> refused with the closed-month sentence; the return stays recorded", async () => {
    const f = await fixture('t8-ret-c');
    const rec = await receiveStock(f, f.itemId, 'raw_material', '30', '100.0000', '2026-01-05');
    const recorded = await doReturn(f, '2026-01-06', rec.deliveryLineId, rec.deliveryId);
    if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
    await setPeriod(f.orgId, todayMonth, 'closed');
    const before = await counts(f.orgId);

    const said = await refusalOf(asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, recorded.returnId, 'Sent back by mistake')), "a supplier-return void while today's month is closed");
    expect(said).toBe(todaySentence(todayMonthLabel, 'closed', 'voided'));
    expect(said).not.toMatch(/cannot move stock/);
    expect(await counts(f.orgId)).toMatchObject({ movements: before.movements, entries: before.entries });
    const [row] = await sql<{ status: string }[]>`select status from supplier_returns where id = ${recorded.returnId}`;
    expect(row!.status).not.toBe('void');
  });
});
