import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S6 (DEF-574) — the branch's recount, end to end at the domain: the action's own two steps
 * (`authorize('resolve_trade_discrepancy', { storeId: <branch> })` then `resolveDiscrepancy`, as
 * `commissary/discrepancies/actions.ts` does) against the list the new screen is built on
 * (`lowStockRepo.branchRecountList`). `docs/tasks/374-money-push-follow-ups.md` §S6 T3-T5.
 * ⛔ TESTER, not BUILDER. `branchRecountList` does not exist on HEAD, so every leg that reads the list fails with
 * "branchRecountList is not a function"; the guards that do not need it are named "(guard, green on HEAD)".
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, lowStockRepo, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, resolveDiscrepancy } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
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
// Fixture — t372-receipt-discrepancy.test.ts's, with TWO branches (br, bq) and per-store people.
// `storeId` is the commissary (dispatching store); `branchId` the branch that RECEIVES and miscounts.
// -----------------------------------------------------------------------------------------------
async function fixture(hint: string) {
  const code = uid(`t374s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}${++seq}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('com');
  const branchId = await mkStore('br');
  const branch2Id = await mkStore('bq');

  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const all = [storeId, branchId, branch2Id];
  const superAdminId = await mkPerson('Super', 'super_admin', all);
  const adminId = await mkPerson('Admin', 'admin', all);
  const managerId = await mkPerson('Commissary Manager', 'manager', all);
  const branchManagerId = await mkPerson('Branch Manager', 'manager', [branchId]);
  const branchStaffId = await mkPerson('Branch Staff', 'staff', [branchId]);

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  await mkLocation(branchId);
  await mkLocation(branch2Id);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;
  const [names] = await sql<{ com: string; br: string }[]>`
    select (select name from stores where id = ${storeId}) as com, (select name from stores where id = ${branchId}) as br`;

  return {
    orgId, storeId, branchId, branch2Id, locationId, fileId: file!.id, comName: names!.com, brName: names!.br,
    superAdmin: actor(orgId, superAdminId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
    branchManager: actor(orgId, branchManagerId), branchStaff: actor(orgId, branchStaffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, itemId: string, qty: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '300.0000', locationId: f.locationId }],
    }),
  );
}

/** A dispatched 20-unit order from the commissary to `branch`, received as `received` of 20. Returns the order and its discrepancy row (if any). */
async function orderTo(f: Fixture, branch: string, received: string) {
  const itemId = (await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: testItemCode(), name: `Prepped ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }))).id;
  await stock(f, itemId, '30');
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${branch}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('c')}`, customerGroup: 'internal', counterpartyStoreId: branch }));
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '20', rate: '500' }] }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  await asOrg(f.orgId, (tx) =>
    receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15', lines: [{ lineId: line!.id, receivedQuantity: received, ...(Number(received) < 20 ? { shortageReason: 'damaged_in_transit' } : {}) } as never] }),
  );
  const rows = await sql<{ id: string; direction: string; status: string; disposition: string | null; store_id: string }[]>`
    select id, direction, status, disposition, store_id from trade_discrepancies where order_id = ${order.orderId}`;
  return { orderId: order.orderId, itemId, rows, row: rows[0] };
}
const overTo = async (f: Fixture, branch: string) => {
  const o = await orderTo(f, branch, '22');
  if (!o.row || o.row.direction !== 'over') throw new Error('fixture: the over-receipt raised no OVER row');
  return { ...o, row: o.row };
};
const rowState = async (id: string) =>
  (await sql<{ status: string; disposition: string | null }[]>`select status, disposition from trade_discrepancies where id = ${id}`)[0]!;
const journalCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n);

// -----------------------------------------------------------------------------------------------
// The action, minus Next: authorize on the POSTED store, then the domain call with commissaryStoreId = that store.
// -----------------------------------------------------------------------------------------------
type Out = { ok: boolean; reason?: string; entryId?: string | null };
const act = (f: Fixture, who: Actor, discrepancyId: string, disposition: string, note: string | null) =>
  asOrg(f.orgId, async (tx) => {
    await authorize(tx, who, 'resolve_trade_discrepancy', { storeId: f.branchId });
    return resolveDiscrepancy(tx, {
      orgId: f.orgId, discrepancyId, commissaryStoreId: f.branchId, disposition, chargePersonId: null, note,
      resolvedOn: '2026-01-20', resolvedBy: who.personId,
    } as never);
  }) as Promise<Out>;
const branchList = (f: Fixture, store: string) =>
  asOrg(f.orgId, (tx) => (lowStockRepo as unknown as { branchRecountList: (t: Tx, o: string, s: string) => Promise<{ id: string }[]> }).branchRecountList(tx, f.orgId, store));
const commissaryList = (f: Fixture) => asOrg(f.orgId, (tx) => lowStockRepo.discrepancyList(tx, f.orgId, f.storeId, false));

describe('T3 — the path: a branch manager posts the listed form', () => {
  it('listed -> resolved as `return` (note kept), nothing posted, the row leaves the branch list; the commissary row reads resolved/return', async () => {
    const f = await fixture('t3');
    const { row } = await overTo(f, f.branchId);
    expect((await branchList(f, f.branchId)).map((r) => r.id), 'the over row is on the branch list').toEqual([row.id]);

    const journalBefore = await journalCount(f.orgId);
    const out = await act(f, f.branchManager, row.id, 'return', 'Recounted: 20, miscounted at the door');
    expect(out.ok, `the branch manager was refused its own recount return: ${out.reason}`).toBe(true);
    expect(out.entryId ?? null).toBeNull();
    expect(await journalCount(f.orgId), 'a recount return posts nothing').toBe(journalBefore);
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });
    expect(await branchList(f, f.branchId), 'the row left the list').toEqual([]);
    const seen = (await asOrg(f.orgId, (tx) => lowStockRepo.discrepancyList(tx, f.orgId, f.storeId, true))).find((r) => r.id === row.id);
    expect(seen, "the commissary's view (include resolved) shows it").toMatchObject({ status: 'resolved', disposition: 'return', direction: 'over' });
  });
});

describe('T4 (✗) — branch STAFF cannot post the form', () => {
  it('authorize refuses (no resolve_trade_discrepancy); the row is unchanged and still listed — positive control: the branch manager then resolves the SAME row', async () => {
    const f = await fixture('t4');
    const { row } = await overTo(f, f.branchId);
    expect((await branchList(f, f.branchId)).map((r) => r.id), 'fixture: listed for the branch').toEqual([row.id]);

    const err = await act(f, f.branchStaff, row.id, 'return', 'recount').then(() => null, (e: unknown) => e);
    expect(err, 'branch staff resolved a discrepancy').not.toBeNull();
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect((await branchList(f, f.branchId)).map((r) => r.id), 'still listed after the refusal').toEqual([row.id]);

    const out = await act(f, f.branchManager, row.id, 'return', 'recount');
    expect(out.ok, `control: the manager was refused: ${out.reason}`).toBe(true);
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });
  });
});

describe('T5 — the gate holds: a forged extra_dispatch from the branch', () => {
  it('(guard on the domain, plus the list) refused with the commissary-only sentence; nothing posted; the row stays open and listed', async () => {
    const f = await fixture('t5');
    const { row } = await overTo(f, f.branchId);
    expect((await branchList(f, f.branchId)).map((r) => r.id)).toEqual([row.id]);

    const journalBefore = await journalCount(f.orgId);
    const out = await act(f, f.branchManager, row.id, 'extra_dispatch', 'forged');
    expect(out.ok, 'the branch booked an extra dispatch for the commissary').toBe(false);
    expect(out.reason).toMatch(/only the dispatching commissary may resolve this/);
    expect(await journalCount(f.orgId)).toBe(journalBefore);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect((await branchList(f, f.branchId)).map((r) => r.id)).toEqual([row.id]);
  });

  it('the OTHER branch (bq) cannot recount the first branch\'s row, and its own list does not carry it', async () => {
    const f = await fixture('t5b');
    const { row } = await overTo(f, f.branchId);
    const out = await asOrg(f.orgId, (tx) =>
      resolveDiscrepancy(tx, { orgId: f.orgId, discrepancyId: row.id, commissaryStoreId: f.branch2Id, disposition: 'return', note: 'not mine', resolvedOn: '2026-01-20', resolvedBy: f.admin.personId } as never),
    ) as Out;
    expect(out.ok).toBe(false);
    expect(await branchList(f, f.branch2Id), "bq's list holds none of br's rows").toEqual([]);
  });
});

describe('T6 (control) — the commissary\'s own list for the dispatching store is unchanged', () => {
  it('discrepancyList(commissary) still lists the over row, resolve as extra_dispatch by the commissary still works (guard, green on HEAD)', async () => {
    const f = await fixture('t6');
    const { row } = await overTo(f, f.branchId);
    expect((await commissaryList(f)).map((r) => r.id)).toContain(row.id);
    const out = (await asOrg(f.orgId, (tx) =>
      resolveDiscrepancy(tx, { orgId: f.orgId, discrepancyId: row.id, commissaryStoreId: f.storeId, disposition: 'return', note: 'went back', resolvedOn: '2026-01-20', resolvedBy: f.manager.personId } as never),
    )) as Out;
    expect(out.ok, out.reason).toBe(true);
  });
});
