import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-372 S5 — guards on the open-order block (docs/tasks/372-def-511-prepared-order-stays-prepared.md S5, O1-O5). They must be
 * GREEN today and stay green after DEF-511: a dispatched or ready order blocks a new draft, received/rejected free the pair,
 * the auto-order never makes a second order. TESTER only; a red leg is a new defect, not a fix.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, lowStockRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { decimal } from '@shareat/core/money';
import type { Actor } from '@shareat/auth';
import {
  saveBranchOrderDraft,
  submitOrder,
  acceptOrder,
  rejectOrder,
  markReady,
  dispatchBranchOrder,
  receiveTradeOrder,
} from '@shareat/domain';
import { ensureAutoOrderLines } from '../../src/commissary/auto-order';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/**
 * One org, a commissary (COM) and a branch (BR), a third store nobody on the order holds, and one
 * person per (role, side) — because invariant 10 is about WHICH STORE a capability resolves at,
 * the fixture needs people who hold exactly one side.
 */
async function fixture() {
  const code = uid('bo');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-07-01', '2026-07-31', 'closed'),
      (${orgId}, '2026-08-01', '2026-08-31', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`
      insert into stores (org_id, code, name, stock_model)
      values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id, code`;
    return s!;
  };
  const com = await mkStore('com');
  const br = await mkStore('br');
  const other = await mkStore('other');

  const mkPerson = async (name: string, role: string, scopes: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const storeId of scopes) {
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    }
    return actor(orgId, p!.id);
  };
  const superAdmin = await mkPerson('Super', 'super_admin', [com.id, br.id, other.id]);
  const admin = await mkPerson('Admin', 'admin', [com.id, br.id]);
  const branchStaff = await mkPerson('Branch cook', 'staff', [br.id]);
  const branchMgr = await mkPerson('Branch manager', 'manager', [br.id]);
  const comStaff = await mkPerson('Commissary packer', 'staff', [com.id]);
  const comMgr = await mkPerson('Commissary manager', 'manager', [com.id]);
  const outsider = await mkPerson('Someone else', 'manager', [other.id]);

  const [locType] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${locType!.id}, 'operating', ${isDefault}, ${superAdmin.personId})
      returning id`;
    return r!.id;
  };
  const comKitchen = await mkRoom(com.id, 'KIT', true);
  const comDry = await mkRoom(com.id, 'DRY', false);
  const brKitchen = await mkRoom(br.id, 'KIT', true);

  const mkItem = async (name: string, unit = 'kg') => {
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${testItemCode()}, ${name}, 'raw_material', ${unit}, ${superAdmin.personId}) returning id`;
    return i!.id;
  };
  const pork = await mkItem('Pork belly');
  const porkBr = await mkItem('Pork belly (branch)');
  const sauce = await mkItem('Bulgogi sauce');
  const sauceBr = await mkItem('Bulgogi sauce (branch)');
  const unmapped = await mkItem('Unmapped thing');
  const unpriced = await mkItem('Unpriced thing');

  await sql`
    insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
    values (${orgId}, ${com.id}, ${br.id}, ${superAdmin.personId})`;
  for (const [item, cost] of [[pork, '310.0000'], [sauce, '95.0000'], [unmapped, '10.0000']] as const) {
    await sql`
      insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by)
      values (${orgId}, ${com.id}, ${item}, ${cost}, ${superAdmin.personId})`;
  }
  // Offered, but with no cost of any kind — T-171 §5's "priced: false".
  await sql`
    insert into commissary_item_offerings (org_id, commissary_store_id, item_id, created_by)
    values (${orgId}, ${com.id}, ${unpriced}, ${superAdmin.personId})`;

  const [cst] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgId}, ${`Store br (internal) ${code}`}, 'internal', ${br.id}, ${superAdmin.personId}) returning id`;
  const [cogs] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and "group" = 'COGS' order by category limit 1`;
  const [cogs2] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and "group" = 'COGS' order by category offset 1 limit 1`;

  const mapRow = async (from: string, to: string, category: string | null, ledgerOnly = false) => {
    await sql`
      insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, is_ledger_only, expense_category_id, created_by)
      values (${orgId}, ${com.id}, ${br.id}, ${from}, ${to}, ${ledgerOnly}, ${category}, ${superAdmin.personId})`;
  };
  await mapRow(pork, porkBr, cogs!.id);
  await mapRow(sauce, sauceBr, cogs!.id);

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/p.jpg'}, 'image/jpeg', 10, ${uid('x')}, 'receipt_photo', ${superAdmin.personId}) returning id`;

  const mkEmploymentAndGrant = async (storeId: string, personId: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${personId}, ${uid('SE')}, 'regular', '2025-01-01')
      returning id
    `;
    await grantEverydayPositionAccess(sql, {
      orgId, storeId, employmentId: employment!.id, personId, setBy: superAdmin.personId,
    });
  };
  await mkEmploymentAndGrant(br.id, branchStaff.personId);
  await mkEmploymentAndGrant(com.id, comStaff.personId);

  return {
    orgId, com, br, other, comKitchen, comDry, brKitchen,
    pork, porkBr, sauce, sauceBr, unmapped, unpriced,
    customerId: cst!.id, cogs: cogs!.id, cogs2: cogs2!.id, fileId: file!.id,
    superAdmin, admin, branchStaff, branchMgr, comStaff, comMgr, outsider, mapRow,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Real stock at the commissary — through `receiveDelivery`, the same path a real receipt takes. */
async function stock(f: Fixture, itemId: string, qty: string, cost = '300.0000', locationId = f.comKitchen): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.com.id}, 'purchase', '2026-08-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  const res = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.com.id, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: [
        { id: f.comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
        { id: f.comDry, role: 'operating', purpose: 'normal', isDefault: false, status: 'active' },
      ],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId }],
    }),
  );
  if (!res.ok) throw new Error(res.reason);
}

async function onHand(itemId: string, storeId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and store_id = ${storeId}`;
  return r!.t;
}

async function balances(orgId: string, storeId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} and l.store_id = ${storeId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}


const draftInput = (f: Fixture, lines: { itemId: string; quantity: string; rate?: string }[] = [{ itemId: f.pork, quantity: '20' }]) => ({
  branchStoreId: f.br.id, commissaryStoreId: f.com.id, orderDate: '2026-08-20', lines,
});

/** Draft → submit → accept, as the two staff members — the state most tests start from. */
async function accepted(f: Fixture, lineInput?: { itemId: string; quantity: string; rate?: string }[]): Promise<string> {
  const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, lineInput)));
  await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
  await asOrg(f.orgId, (tx) => acceptOrder(tx, f.comStaff, { orderId }));
  return orderId;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});


const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from trade_orders where id = ${id}`)[0]!.status;
const rawDraft = (f: Fixture) => sql`
  insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by)
  values (${f.orgId}, ${f.com.id}, ${f.customerId}, '2026-08-21', 'draft', 1, ${f.br.id}, ${f.branchStaff.personId})`;
const openCount = async (f: Fixture) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from trade_orders where org_id = ${f.orgId} and requested_by_store_id = ${f.br.id} and status in ('draft','confirmed','dispatched')`)[0]!.n);
const newDraft = (f: Fixture) => asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
const ready = async (f: Fixture) => {
  await stock(f, f.pork, '100');
  const orderId = await accepted(f);
  await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
  return orderId;
};
const dispatched = async (f: Fixture) => {
  const orderId = await ready(f);
  await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
  return orderId;
};

describe('T-372 S5 — the one-open-order-per-branch block (guards: green today, and they must stay green)', () => {
  it('O1: a DISPATCHED order blocks a new draft for the same pair — in the domain and in the index; control: the order really is dispatched', async () => {
    const f = await fixture();
    const orderId = await dispatched(f);
    expect(await statusOf(orderId), 'fixture: the order is dispatched').toBe('dispatched');
    await expect(newDraft(f)).rejects.toThrow(/already has an open order.*dispatched/);
    await expect(rawDraft(f)).rejects.toThrow(/trade_orders_one_open_per_branch_key/);
    expect(await openCount(f), 'a refused draft left a second open order behind').toBe(1);
  });

  it('O2: a READY order (status confirmed) blocks a new draft — the sentence names confirmed, and the index agrees', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    expect(await statusOf(orderId), 'fixture: ready is still status confirmed').toBe('confirmed');
    await expect(newDraft(f)).rejects.toThrow(/already has an open order.*confirmed/);
    await expect(rawDraft(f)).rejects.toThrow(/trade_orders_one_open_per_branch_key/);
    expect(await openCount(f)).toBe(1);
  });

  it('O3 (positive): after the branch receives the dispatched order, a new draft succeeds', async () => {
    const f = await fixture();
    const orderId = await dispatched(f);
    await expect(newDraft(f), 'control: still blocked while dispatched').rejects.toThrow(/already has an open order/);
    await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.branchStaff, { orderId, receivedOn: '2026-08-21' }));
    expect(await statusOf(orderId)).toBe('received');
    const next = await newDraft(f);
    expect(next.orderId).not.toBe(orderId);
    expect(await openCount(f)).toBe(1);
  });

  it('O4 (positive): a READY order rejected (rejectOrder takes submitted, accepted and ready) frees the pair — a new draft succeeds', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    await expect(newDraft(f), 'control: ready still blocks').rejects.toThrow(/already has an open order/);
    await asOrg(f.orgId, (tx) => rejectOrder(tx, f.comStaff, { orderId, reason: 'no pork this week' }));
    expect(await openCount(f), 'a rejected order still counts as open').toBe(0);
    await newDraft(f);
    expect(await openCount(f)).toBe(1);
  });

  it('O5: the auto-order with a DISPATCHED open order creates nothing — created:false, a "dispatched, not a draft" note, still exactly one open order', async () => {
    const f = await fixture();
    const orderId = await dispatched(f);
    // The branch's own pork is below its threshold, so the auto-order has something to order.
    await asOrg(f.orgId, (tx) =>
      lowStockRepo.setThreshold(tx, { orgId: f.orgId, storeId: f.br.id, itemId: f.porkBr, threshold: decimal('10', '14,3'), setBy: f.superAdmin.personId }),
    );
    const res = await asOrg(f.orgId, (tx) =>
      ensureAutoOrderLines(tx, { orgId: f.orgId, branchStoreId: f.br.id, orderedOn: '2026-08-25', createdBy: f.superAdmin.personId }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(false);
    expect(res.notes.join(' ')).toMatch(/dispatched, not a draft/);
    expect(await openCount(f)).toBe(1);
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_orders where org_id = ${f.orgId}`;
    expect(n!.c, 'a second order row was created').toBe('1');
    expect(await statusOf(orderId)).toBe('dispatched');
  });
});
