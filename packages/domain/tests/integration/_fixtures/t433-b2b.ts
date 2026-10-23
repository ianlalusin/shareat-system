import type postgres from 'postgres';
import { vi } from 'vitest';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { receiveDelivery } from '../../../src/deliveries/receive';
import { quantity } from '../../../src/stock/quantity';
import { asOrgOn } from './pos-s6';
import { grantEverydayPositionAccess } from './staff-everyday-access';
import { testItemCode } from './item-code';

/**
 * T-433 tester fixtures (docs/tasks/433-b2b-trade-order-gaps.md). Test-support only.
 *
 * One org, two stores (A = f.storeId, B = f.otherStoreId), people at every rank, stock at A,
 * A's cash drawer + e-wallet, B's cash drawer + office safe. The clock is frozen at 2026-10-16
 * (Manila noon) by `freezeClock()` so "the day of dispatch" is a fixed, assertable date.
 *
 * New APIs the builder adds are reached through `api` (a namespace cast), so a missing export is a
 * clear runtime failure ("not a function"), never a compile error that hides the test.
 */
export const NOW_ISO = '2026-10-16T04:00:00Z';
export const TODAY = '2026-10-16';

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
}
export function thawClock(): void {
  vi.useRealTimers();
}

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;
export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });
export const asOrg = asOrgOn;

/** The T-433 surface, typed loosely on purpose. */
export const api = domain as unknown as {
  dispatchTradeOrder: (tx: unknown, actor: Actor, input: Record<string, unknown>) => Promise<{ chargeId: string | null; entryId: string; creditOverridden: boolean; treatment: string }>;
  recordChargeWithCollection: (tx: unknown, actor: Actor, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  previewCreditExposure: (tx: unknown, actor: Actor, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  setBirInvoiceNo: (tx: unknown, actor: Actor, input: Record<string, unknown>) => Promise<unknown>;
};

export async function fixture(sql: postgres.Sql, hint: string) {
  const code = uid(`t433-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('lipa');
  const otherStoreId = await mkStore('other');

  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const both = [storeId, otherStoreId];
  const superAdminId = await mkPerson('Super', 'super_admin', both);
  const adminId = await mkPerson('Admin', 'admin', both);
  const managerId = await mkPerson('Manager', 'manager', both);
  const managerBId = await mkPerson('Manager B only', 'manager', [otherStoreId]);
  const staffId = await mkPerson('Staff', 'staff', [storeId]);
  const collectorId = await mkPerson('Collector', 'staff', [storeId]);

  const mkEmployment = async (personId: string, caps?: readonly string[]) => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, {
      orgId, storeId, employmentId: e!.id, personId, setBy: managerId,
      ...(caps ? { capabilities: caps as never } : {}),
    });
  };
  await mkEmployment(staffId);
  // The collector holds record_ar_collection and NOTHING else of the money path (not approve_buyer).
  await mkEmployment(collectorId, ['record_ar_collection']);

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  const otherLocationId = await mkLocation(otherStoreId);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId})
    returning id`;

  const acct = async (sId: string, instrument: string, custodian: string) => {
    const [a] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${sId} and instrument = ${instrument} and custodian = ${custodian} limit 1`;
    if (!a) throw new Error(`fixture: no ${instrument}/${custodian} money account at store ${sId}`);
    return a.id;
  };
  return {
    orgId, storeId, otherStoreId, locationId, otherLocationId, fileId: file!.id,
    drawerA: await acct(storeId, 'cash', 'cashier'),
    walletA: await acct(storeId, 'ewallet', 'cashier'),
    safeB: await acct(otherStoreId, 'cash', 'office'),
    superAdmin: actorOf(orgId, superAdminId),
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
    managerB: actorOf(orgId, managerBId),
    staff: actorOf(orgId, staffId),
    collector: actorOf(orgId, collectorId),
  };
}
export type Fx = Awaited<ReturnType<typeof fixture>>;

export async function stock(sql: postgres.Sql, f: Fx, itemId: string, qty: string, storeId = f.storeId, locationId = f.locationId) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '50.0000', locationId }],
    }),
  );
}

export async function wholesaleItem(f: Fx, name = 'Beef'): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    domain.createItem(tx, f.superAdmin, { code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  return item.id;
}

export async function buyer(
  sql: postgres.Sql, f: Fx, opts: { creditLimit?: string; group?: 'wholesale' | 'internal' } = {},
): Promise<string> {
  const c = await asOrg(f.orgId, (tx) =>
    domain.createCustomer(tx, f.admin, {
      name: `Buyer ${uid('b')}`,
      customerGroup: opts.group ?? 'wholesale',
      priceListId: null,
      ...(opts.group === 'internal' ? { counterpartyStoreId: f.otherStoreId } : {}),
    }),
  );
  if (opts.creditLimit !== undefined) await sql`update customers set credit_limit = ${opts.creditLimit} where id = ${c.id}`;
  return c.id;
}

/** A DRAFT external order for one item at one rate, qty 1 (so total = `amount`). Own item + own stock. */
export async function orderWorth(
  sql: postgres.Sql, f: Fx, customerId: string, amount: string,
  opts: { orderDate?: string; storeId?: string; referenceNo?: string } = {},
): Promise<{ orderId: string; totalAmount: string; itemId: string }> {
  const storeId = opts.storeId ?? f.storeId;
  const itemId = await wholesaleItem(f);
  await stock(sql, f, itemId, '5', storeId, storeId === f.storeId ? f.locationId : f.otherLocationId);
  const o = await asOrg(f.orgId, (tx) =>
    domain.createTradeOrder(tx, f.manager, {
      storeId, customerId, orderDate: opts.orderDate ?? '2026-10-10',
      lines: [{ itemId, quantity: '1', rate: amount }],
      ...(opts.referenceNo ? { referenceNo: opts.referenceNo } : {}),
    }),
  );
  return { orderId: o.orderId, totalAmount: o.totalAmount, itemId };
}

/** An INTERNAL (branch) order: needs the commissary item map, as trade.test.ts does. */
export async function internalOrder(sql: postgres.Sql, f: Fx, amount = '1000') {
  const customerId = await buyer(sql, f, { group: 'internal' });
  const itemId = await asOrg(f.orgId, (tx) =>
    domain.createItem(tx, f.superAdmin, { code: testItemCode(), name: `Prepped ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: false }),
  ).then((i) => i.id);
  await stock(sql, f, itemId, '10');
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
  const o = await asOrg(f.orgId, (tx) =>
    domain.createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-10-10', lines: [{ itemId, quantity: '1', rate: amount }] }),
  );
  return { orderId: o.orderId, customerId };
}

export const dispatch = (f: Fx, who: Actor, orderId: string, extra: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) => api.dispatchTradeOrder(tx, who, { orderId, ...extra }));

export const payNow = (amount: string, moneyAccountId: string, more: Record<string, unknown> = {}) => ({
  payNow: { amount, moneyAccountId, ...more },
});

/** The customer's org-wide receivable (1210 party balance), read straight from the journal. */
export async function owed(sql: postgres.Sql, f: Fx, customerId: string): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and jl.party_type = 'customer' and jl.party_id = ${customerId} and a.code = '1210'`;
  return r!.b;
}

export async function counts(sql: postgres.Sql, f: Fx, customerId: string) {
  const [r] = await sql<{ charges: number; collections: number; allocations: number; movements: number }[]>`
    select
      (select count(*)::int from ar_charges where org_id = ${f.orgId} and customer_id = ${customerId}) as charges,
      (select count(*)::int from ar_collections where org_id = ${f.orgId} and customer_id = ${customerId}) as collections,
      (select count(*)::int from ar_collection_allocations a join ar_collections c on c.id = a.ar_collection_id
         where c.org_id = ${f.orgId} and c.customer_id = ${customerId}) as allocations,
      (select count(*)::int from stock_movements where org_id = ${f.orgId} and source_type = 'trade_order_dispatch') as movements`;
  return r!;
}

/** The sentence a RefusalError shows a person (`userMessage`), or null when the rejection is some other error. */
export async function sayOf(p: Promise<unknown>): Promise<{ said: string | null; message: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    return { said: e.userMessage ?? null, message: e.message ?? String(err), err };
  }
  throw new Error('NOT REFUSED - the call succeeded');
}

export const audit = (sql: postgres.Sql, orgId: string, action: string) =>
  sql<{ id: string; entity: string; entity_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor_person_id: string | null }[]>`
    select id, entity, entity_id, before, after, actor_person_id from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at, id`;
