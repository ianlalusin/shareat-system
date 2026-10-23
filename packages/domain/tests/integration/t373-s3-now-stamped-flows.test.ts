import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S3 / DEF-555 (TESTER) - the flows that stamp a movement at NOW judge `now` by its MANILA business day, like the
 * trigger (migration 0180). `docs/tasks/373-money-follow-ups.md` section S3, R5. The trigger alone is
 * `packages/db/tests/integration/t373-s3-stock-period-manila-day.test.ts`. Fixture helpers are `t369-s4-audit.test.ts`'s.
 *   T5  at 02:00 Manila on 1 April, March closed: supplier recordReturn, voidReturn, an in-store transferNow, voidTradeOrder,
 *       voidCustomerReturn each SUCCEED, their movements stamped with the fake `now`.          [red on HEAD: UTC date]
 *   T6  control: the same five at 23:30 Manila on 31 March (2026-03-31T15:30Z) are refused with the "today" sentence for March;
 *       nothing written.
 *   T7  guard agrees with trigger at 07:59 Manila on 1 April (2026-03-31T23:59Z): `closedStockPeriodSentenceToday` is null AND
 *       a flow's insert is accepted; at 08:00 Manila (2026-04-01T00:00Z) both agree before and after (pin).
 *   T8  transferNow: (i) no period covers today -> posts; (ii) today's month closed -> the "today" sentence with verb "moved",
 *       no uuid; (iii) movements' moved_at and the transfer's dispatched_at are the instant the clock was read.
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
import { parseBusinessDate } from '@shareat/core/datetime';
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
  transferNow,
} from '@shareat/domain';
import { closedStockPeriodSentenceToday } from '../../src/stock/period-guard';
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
const returnIt = (f: Fixture, s: { orderId: string; lineId: string }, returnedOn: string) =>
  asOrg(f.orgId, (tx) => recordCustomerReturn(tx, { tradeOrderId: s.orderId, returnedOn, reason: 'Wrong item shipped.', lines: [{ tradeOrderLineId: s.lineId, quantity: '4' }], actor: f.manager }));

// -----------------------------------------------------------------------------------------------
// Clock, sentences, flows
// -----------------------------------------------------------------------------------------------

const todaySentence = (month: string, word: 'closed' | 'locked', doing: string) =>
  `${month} is ${word}. Stock can't be ${doing} today — a closed month's stock stays as it was.`;

const AT_2AM_APRIL_1 = new Date('2026-03-31T18:00:00.000Z'); // 02:00 Manila 1 April; UTC date 31 March (closed)
const AT_2330_MARCH_31 = new Date('2026-03-31T15:30:00.000Z'); // 23:30 Manila 31 March; UTC date also 31 March
const AT_0759_APRIL_1 = new Date('2026-03-31T23:59:00.000Z'); // 07:59 Manila 1 April; UTC date 31 March
const AT_0800_APRIL_1 = new Date('2026-04-01T00:00:00.000Z'); // 08:00 Manila 1 April; both dates are April
async function withClock<T>(at: Date, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

const isOk2 = (r: unknown) => (r as { ok?: boolean }).ok !== false;
const idOf = (r: unknown) => String((r as { returnId?: string; id?: string }).returnId ?? (r as { id?: string }).id);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const mv = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${orgId}`)[0]!.n);

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

/** A second operating room in the fixture's store, and 100 kg of the fixture item in room A (received in Jan, before any close). */
async function roomsWithStock(f: Fixture) {
  const [type] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} limit 1`;
  const [b] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'B2', 'Room B2', ${type!.id}, 'operating', false, ${f.adminId}) returning id`;
  await receiveStock(f, f.itemId, 'raw_material', '100', '100.0000', '2026-01-05');
  return { roomA: f.locationId, roomB: b!.id };
}
const roomTransfer = (f: Fixture, r: { roomA: string; roomB: string }) =>
  asOrg(f.orgId, (tx) =>
    transferNow(tx, { storeId: f.storeId, fromLocationId: r.roomA, toLocationId: r.roomB, lines: [{ itemId: f.itemId, quantity: quantity('5.000') }], actor: f.staff }),
  );

/** One now-stamped flow, prepared (records created) before March closes; `run(at)` calls it under the fake clock. */
type Flow = { name: string; run: (at: Date) => Promise<unknown>; doing: string; f: Fixture };

async function flows(hint: string, only?: string): Promise<Flow[]> {
  const out: Flow[] = [];
  const want = (n: string) => !only || only === n;

  if (want('recordReturn') || want('voidReturn')) {
  const sr = await supplierReturnFixture(`${hint}-sr`);
  const recorded = await sr.doReturn('2026-04-06');
  if (!recorded.ok) throw new Error(`fixture: ${recorded.reason}`);
  out.push({ name: 'recordReturn', doing: 'returned', f: sr.f, run: (at) => withClock(at, () => sr.doReturn('2026-04-06', '1.000')) });
  out.push({
    name: 'voidReturn', doing: 'voided', f: sr.f,
    run: (at) => withClock(at, () => asOrg(sr.f.orgId, (tx) => voidReturn(tx, sr.f.manager, recorded.returnId, 'Typed wrong'))),
  });

  }

  if (want('transferNow')) {
  const tf = await fixture(`${hint}-tf`);
  const rooms = await roomsWithStock(tf);
  out.push({ name: 'transferNow', doing: 'moved', f: tf, run: (at) => withClock(at, () => roomTransfer(tf, rooms)) });

  }

  if (want('voidTradeOrder')) {
  const to = await fixture(`${hint}-to`);
  const itemId = await wholesaleItem(to);
  await receiveStock(to, itemId, 'raw_material', '50', '90.0000', '2026-01-01');
  const customer = await asOrg(to.orgId, (tx) => createCustomer(tx, to.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
  const o = await asOrg(to.orgId, (tx) => createTradeOrder(tx, to.manager, { storeId: to.storeId, customerId: customer.id, orderDate: '2026-04-10', lines: [{ itemId, quantity: '5', rate: '500' }] }));
  await asOrg(to.orgId, (tx) => dispatchTradeOrder(tx, to.manager, { orderId: o.orderId }));
  out.push({
    name: 'voidTradeOrder', doing: 'voided', f: to,
    run: (at) => withClock(at, () => asOrg(to.orgId, (tx) => voidTradeOrder(tx, to.manager, { orderId: o.orderId, reason: 'Typed wrong' }))),
  });

  }

  if (want('voidCustomerReturn')) {
  const cr = await fixture(`${hint}-cr`);
  const s = await externalSale(cr);
  const ret = await returnIt(cr, s, '2026-04-12');
  if (!isOk2(ret)) throw new Error('fixture: customer return did not record');
  out.push({
    name: 'voidCustomerReturn', doing: 'voided', f: cr,
    run: (at) => withClock(at, () => asOrg(cr.orgId, (tx) => voidCustomerReturn(tx, cr.manager, idOf(ret), 'Typed wrong'))),
  });

  }

  for (const x of new Set(out.map((o2) => o2.f))) await setPeriod(x.orgId, '2026-03', 'closed');
  return only ? out.filter((o2) => o2.name === only) : out;
}

/** Runs a flow, folding a thrown error into the same shape as an `{ok:false}` outcome. */
async function attempt(x: Flow, at: Date): Promise<string> {
  try {
    const out = (await x.run(at)) as { ok?: boolean; reason?: string } | undefined;
    return out && out.ok === false ? String(out.reason) : 'ok';
  } catch (err) {
    return String((err as { userMessage?: string; message?: string }).userMessage ?? (err as Error).message);
  }
}

const FLOW_NAMES = ['recordReturn', 'voidReturn', 'transferNow', 'voidTradeOrder', 'voidCustomerReturn'];
const STAMPED_BY_NOW = ['voidReturn', 'transferNow', 'voidTradeOrder', 'voidCustomerReturn'];

describe('T-373 S3 T6 - control: at 23:30 Manila on 31 March (March closed) every now-stamped flow is refused with the "today" sentence', () => {
  for (const name of FLOW_NAMES) {
    it(`${name}: refused with the March "today" sentence (no period id); nothing written`, async () => {
      const [x] = await flows(`t6-${name}`, name);
      const before = await mv(x!.f.orgId);
      const said = await attempt(x!, AT_2330_MARCH_31);
      expect(said).toBe(todaySentence('March 2026', 'closed', x!.doing));
      expect(said).not.toMatch(UUID_RE);
      expect(await mv(x!.f.orgId), 'a movement was written').toBe(before);
    });
  }
});

describe('T-373 S3 T5 - at 02:00 Manila on 1 April (UTC date is the closed 31 March) every now-stamped flow SUCCEEDS', () => {
  for (const name of FLOW_NAMES) {
    it(`${name}: succeeds and writes movements`, async () => {
      const [x] = await flows(`t5-${name}`, name);
      const before = await mv(x!.f.orgId);
      expect(await attempt(x!, AT_2AM_APRIL_1)).toBe('ok');
      expect(await mv(x!.f.orgId), 'no movement written').toBeGreaterThan(before);
    });
  }

  for (const name of STAMPED_BY_NOW) {
    it(`${name}: its new movements are stamped with the fake now`, async () => {
      const [x] = await flows(`t5b-${name}`, name);
      const stamped = async () =>
        Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${x!.f.orgId} and moved_at = ${AT_2AM_APRIL_1.toISOString()}::timestamptz`)[0]!.n);
      const before = await stamped();
      expect(await attempt(x!, AT_2AM_APRIL_1)).toBe('ok');
      expect(await stamped()).toBeGreaterThan(before);
    });
  }
});

describe('T-373 S3 T7 - the TS guard agrees with the trigger', () => {
  it('07:59 Manila on 1 April, March closed: the guard says null AND the insert is accepted - control: at 23:59:59 Manila on 31 March the guard says March and the insert is refused; 08:00 pinned', async () => {
    const f = await fixture('t7');
    await setPeriod(f.orgId, '2026-03', 'closed');
    const guard = (at: Date) => asOrg(f.orgId, (tx) => closedStockPeriodSentenceToday(tx, f.orgId, at, 'moved'));
    const insertAt = async (at: Date): Promise<string> => {
      try {
        await sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
                  values (${f.orgId}, ${f.storeId}, ${f.locationId}, ${f.itemId}, ${at.toISOString()}::timestamptz, 1, 'opening', 'test', ${crypto.randomUUID()}, ${f.staffId})`;
        return 'accepted';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const lastClosedSecond = new Date('2026-03-31T15:59:59.000Z');
    expect(await guard(lastClosedSecond), 'control: the guard at 23:59:59 Manila on 31 March').toBe(todaySentence('March 2026', 'closed', 'moved'));
    expect(await insertAt(lastClosedSecond), 'control: the trigger at 23:59:59 Manila on 31 March').toMatch(/^cannot move stock into a closed period/);

    expect(await guard(AT_0759_APRIL_1), 'the guard at 07:59 Manila on 1 April').toBeNull();
    expect(await insertAt(AT_0759_APRIL_1), 'the trigger at 07:59 Manila on 1 April').toBe('accepted');

    expect(await guard(AT_0800_APRIL_1), 'pin: the guard at 08:00 Manila').toBeNull();
    expect(await insertAt(AT_0800_APRIL_1), 'pin: the trigger at 08:00 Manila').toBe('accepted');
  });

  it('a flow (voidReturn) at 07:59 Manila on 1 April is accepted and its movement exists - control: the same flow at 23:59 Manila on 31 March is refused', async () => {
    const ok = await supplierReturnFixture('t7-ok');
    const bad = await supplierReturnFixture('t7-bad');
    const rOk = await ok.doReturn('2026-04-06');
    const rBad = await bad.doReturn('2026-04-06');
    if (!rOk.ok || !rBad.ok) throw new Error('fixture');
    await setPeriod(ok.f.orgId, '2026-03', 'closed');
    await setPeriod(bad.f.orgId, '2026-03', 'closed');
    const voidIt = (x: typeof ok, id: string, at: Date) => withClock(at, () => asOrg(x.f.orgId, (tx) => voidReturn(tx, x.f.manager, id, 'Typed wrong')));

    expect(await refusalOf(voidIt(bad, rBad.returnId, new Date('2026-03-31T15:59:00Z')), 'a void at 23:59 Manila on 31 March')).toBe(todaySentence('March 2026', 'closed', 'voided'));
    const before = await mv(ok.f.orgId);
    expect(await isOk(voidIt(ok, rOk.returnId, AT_0759_APRIL_1)), 'a void at 07:59 Manila on 1 April').toBe(true);
    expect(await mv(ok.f.orgId)).toBeGreaterThan(before);
  });
});

describe('T-373 S3 T8 - transferNow uses the one "today" guard', () => {
  it('(i) no fiscal period covers today -> the transfer posts (the trigger allows it) - control: with today\'s month closed it is refused', async () => {
    const f = await fixture('t8i');
    const rooms = await roomsWithStock(f);
    const NO_PERIOD = new Date('2028-06-15T04:00:00.000Z'); // fixture periods end 2027-12
    const posted = await withClock(NO_PERIOD, () => roomTransfer(f, rooms));
    expect(posted, 'no period covers 2028-06-15').toMatchObject({ ok: true });

    const g = await fixture('t8i-ctl');
    const rg = await roomsWithStock(g);
    await setPeriod(g.orgId, '2026-04', 'closed');
    const refused = await withClock(new Date('2026-04-02T04:00:00.000Z'), () => roomTransfer(g, rg));
    expect(refused.ok, 'control: a closed month refuses').toBe(false);
  });

  it('(ii) today\'s month closed -> "April 2026 is closed. Stock can\'t be moved today ..." with no period id; nothing written', async () => {
    const f = await fixture('t8ii');
    const rooms = await roomsWithStock(f);
    await setPeriod(f.orgId, '2026-04', 'closed');
    const before = await mv(f.orgId);
    const said = await refusalOf(withClock(new Date('2026-04-02T04:00:00.000Z'), () => roomTransfer(f, rooms)), 'transferNow in a closed month');
    expect(said).toBe(todaySentence('April 2026', 'closed', 'moved'));
    expect(said).not.toMatch(UUID_RE);
    expect(await mv(f.orgId)).toBe(before);
  });

  it('(iii) the movements\' moved_at and the transfer\'s dispatched_at/received_at are the one instant the clock was read', async () => {
    const f = await fixture('t8iii');
    const rooms = await roomsWithStock(f);
    const at = new Date('2026-06-10T03:21:09.000Z');
    const res = await withClock(at, () => roomTransfer(f, rooms));
    if (!res.ok) throw new Error(`transfer refused: ${res.reason}`);
    const t = (await sql<{ d: Date; r: Date }[]>`select dispatched_at as d, received_at as r from stock_transfers where id = ${res.transferId}`)[0]!;
    const m = await sql<{ at: Date }[]>`select moved_at as at from stock_movements where source_type = 'stock_transfer' and source_id = ${res.transferId}`;
    expect(m).toHaveLength(2);
    expect(t.d.toISOString()).toBe(at.toISOString());
    expect(t.r.toISOString()).toBe(at.toISOString());
    for (const row of m) expect(row.at.toISOString()).toBe(at.toISOString());
  });
});
