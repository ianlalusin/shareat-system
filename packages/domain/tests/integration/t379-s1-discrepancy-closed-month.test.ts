import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S1 (DEF-575) - resolving a discrepancy into a closed or locked month is refused BEFORE the first write, in plain words.
 * `docs/tasks/379-erp-small-follow-ups.md` S1 D1-D6. Fixture: `t374-s6-branch-recount-action.test.ts` (commissary + branch,
 * an order dispatched and received short / over). The month of `resolvedOn` (January 2026) is closed (or locked) by an
 * UPDATE on `fiscal_periods`, as `t376-s1-verify-override.test.ts` does.
 * TESTER, not BUILDER. On HEAD `postEntry` / the movement trigger throws a raw error, so D1-D4 reject instead of returning.
 *
 *   D1-D4 red on HEAD. Mutants: delete the check -> D1-D4 red; check only `closed` -> D4 red;
 *         check `loss`/`charge` only -> D3 red; check every disposition -> D5 red.
 *   D5 (control, green on HEAD): `return`/`audit` in a closed month are fine; `loss` in an open month posts.
 *   D6 (guard, green on HEAD): the direction gate stays ABOVE the month check - mutant: month check placed above the gate -> red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, resolveDiscrepancy } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
const shortTo = async (f: Fixture, branch: string) => {
  const o = await orderTo(f, branch, '15');
  if (!o.row || o.row.direction !== 'short') throw new Error('fixture: the short receipt raised no SHORT row');
  return { ...o, row: o.row };
};
const rowState = async (id: string) =>
  (await sql<{ status: string; disposition: string | null }[]>`select status, disposition from trade_discrepancies where id = ${id}`)[0]!;
const entriesFor = async (id: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where idempotency_key like ${`trade_discrepancy:${id}:%`}`)[0]!.n);
const movementsFor = async (id: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where source_id = ${id}`)[0]!.n);
/** `locked` needs the whole year out of `open` (a trigger refuses an open period inside a locked year), so lock both fixture months. */
const setJanuary = (f: Fixture, status: 'open' | 'closed' | 'locked') =>
  status === 'locked'
    ? sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`
    : sql`update fiscal_periods set status = ${status} where org_id = ${f.orgId} and starts_on = '2026-01-01'`;

type Out = { ok: boolean; reason?: string; userReason?: string; entryId?: string | null };
const resolve = (f: Fixture, id: string, disposition: string, extra: { note?: string | null; chargePersonId?: string | null } = {}, resolvedOn = '2026-01-20') =>
  asOrg(f.orgId, (tx) =>
    resolveDiscrepancy(tx, {
      orgId: f.orgId, discrepancyId: id, commissaryStoreId: f.storeId, disposition, chargePersonId: extra.chargePersonId ?? null,
      note: extra.note ?? null, resolvedOn, resolvedBy: f.manager.personId,
    } as never),
  ) as Promise<Out>;

/** The one refusal sentence (R1). `{humanDate}` is whatever the builder prints for 2026-01-20 - asserted loosely, the rest exactly. */
const sentence = (state: 'closed' | 'locked') => new RegExp(`^January 2026 is ${state}, so this can't be booked on .+\\. Nothing was saved\\.$`);

describe('D1-D4 - a posting disposition into a closed or locked month is a returned sentence, and nothing is written', () => {
  it('D1 short row, loss, closed January: {ok:false} with the closed sentence in userReason, no uuid; row still open; no entry - red on HEAD (it throws)', async () => {
    const f = await fixture('d1');
    const { row } = await shortTo(f, f.branchId);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'loss');
    expect(out.ok).toBe(false);
    expect(out.userReason).toMatch(sentence('closed'));
    expect(out.userReason).not.toMatch(UUID);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });

  it('D2 short row, charge a named person, closed January: the same sentence, nothing written - red on HEAD', async () => {
    const f = await fixture('d2');
    const { row } = await shortTo(f, f.branchId);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'charge', { chargePersonId: f.manager.personId });
    expect(out.ok).toBe(false);
    expect(out.userReason).toMatch(sentence('closed'));
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });

  it('D3 over row, extra_dispatch, stock on hand at the source room, closed January: the same sentence; zero stock_movements with source_id = the row; row open - red on HEAD', async () => {
    const f = await fixture('d3');
    const { row } = await overTo(f, f.branchId);
    expect(await movementsFor(row.id), 'fixture: nothing moved for the row yet').toBe(0);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'extra_dispatch', { note: 'sent more' });
    expect(out.ok).toBe(false);
    expect(out.userReason).toMatch(sentence('closed'));
    expect(await movementsFor(row.id)).toBe(0);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });

  it('D4 locked January: "... is locked, so ..." - red on HEAD; mutant "check only closed" is red here', async () => {
    const f = await fixture('d4');
    const { row } = await shortTo(f, f.branchId);
    await setJanuary(f, 'locked');
    const out = await resolve(f, row.id, 'loss');
    expect(out.ok).toBe(false);
    expect(out.userReason).toMatch(sentence('locked'));
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });
});

describe('D5 (control, green on HEAD) - dispositions that write nothing are not concerned with a closed month', () => {
  it('over row, return with a note, closed January -> ok', async () => {
    const f = await fixture('d5a');
    const { row } = await overTo(f, f.branchId);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'return', { note: 'went back on the truck' });
    expect(out.ok, out.reason).toBe(true);
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });
  });

  it('short row, audit, closed January -> ok, nothing posted', async () => {
    const f = await fixture('d5b');
    const { row } = await shortTo(f, f.branchId);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'audit', { note: 'looking into it' });
    expect(out.ok, out.reason).toBe(true);
    expect(await entriesFor(row.id)).toBe(0);
  });

  it('short row, loss, OPEN January -> ok, and the entry is posted', async () => {
    const f = await fixture('d5c');
    const { row } = await shortTo(f, f.branchId);
    const out = await resolve(f, row.id, 'loss');
    expect(out.ok, out.reason).toBe(true);
    expect(await entriesFor(row.id)).toBe(1);
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'loss' });
  });
});

describe('D6 (guard, green on HEAD) - the direction gate stays above the month check', () => {
  it('over row, loss, closed January: still the over-receipt refusal, not the month sentence', async () => {
    const f = await fixture('d6');
    const { row } = await overTo(f, f.branchId);
    await setJanuary(f, 'closed');
    const out = await resolve(f, row.id, 'loss');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/This is an over-receipt/);
    expect(`${out.userReason ?? ''}${out.reason}`).not.toMatch(/January 2026 is/);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
  });
});
