import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-493 S2 (F23, DEF-797) — a customer cash refund is paid from the refunding store's OWN
 * money account, and never from a staff cash float (GL 1120). A refusal writes nothing.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, recordCustomerReturn } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
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

async function fixture(hint: string) {
  const code = uid(`rf-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('lipa');
  const otherStoreId = await mkStore('other');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const actor = (id: string): Actor => ({ personId: id, orgId });
  const [locType] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;
  const mkAccount = async (sId: string, name: string, instrument: string, gl: string) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, custodian, instrument, gl_account_code, is_active)
      values (${orgId}, ${sId}, ${name}, 'cashier', ${instrument}, ${gl}, true) returning id`;
    return a!.id;
  };
  return {
    orgId, storeId, otherStoreId, locationId: loc!.id, fileId: file!.id,
    ownCashId: await mkAccount(storeId, 'Cash drawer', 'cash', '1110'),
    otherCashId: await mkAccount(otherStoreId, 'Other store safe', 'cash', '1110'),
    floatId: await mkAccount(storeId, 'Staff cash float', 'cash', '1120'),
    superAdmin: actor(superAdminId), admin: actor(adminId), manager: actor(managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function aSale(f: Fixture) {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name: `Beef ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId: item.id, itemKind: 'raw_material', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '90.0000', locationId: f.locationId }],
    }),
  );
  const c = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId: c.id, orderDate: '2026-01-10',
      lines: [{ itemId: item.id, quantity: '2', rate: '500' }],
    }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, lineId: lines[0]!.id };
}

async function counts(orgId: string) {
  const [r] = await sql<{ returns: string; entries: string; moves: string }[]>`
    select (select count(*) from customer_returns where org_id = ${orgId})::text as returns,
           (select count(*) from journal_entries where org_id = ${orgId})::text as entries,
           (select count(*) from stock_movements where org_id = ${orgId})::text as moves`;
  return r!;
}

async function refund(f: Fixture, s: { orderId: string; lineId: string }, moneyAccountId: string) {
  // The refusal is returned, not thrown, so commit semantics matter: counts are read AFTER the transaction ends.
  return asOrg(f.orgId, (tx) =>
    recordCustomerReturn(tx, {
      tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Refund requested.',
      lines: [{ tradeOrderLineId: s.lineId, quantity: '1' }], refund: true, moneyAccountId, actor: f.manager,
    }),
  );
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe("T-493 S2 — a refund is paid from the refunding store's own cash", () => {
  it("1. a refund from another store's money account is refused and writes nothing", async () => {
    const f = await fixture('xstore');
    const s = await aSale(f);
    const before = await counts(f.orgId);
    const res = await refund(f, s, f.otherCashId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("That money account belongs to another store. A refund is paid from this store's own cash.");
    expect(await counts(f.orgId)).toEqual(before);
  });

  it('2. a refund from the staff cash float (GL 1120) is refused by name and writes nothing', async () => {
    const f = await fixture('float');
    const s = await aSale(f);
    const before = await counts(f.orgId);
    const res = await refund(f, s, f.floatId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/staff cash float/);
    expect(res.reason).toMatch(/refund/i);
    expect(await counts(f.orgId)).toEqual(before);
  });

  it("3. a refund from the store's own office cash still posts", async () => {
    const f = await fixture('own');
    const s = await aSale(f);
    const res = await refund(f, s, f.ownCashId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('cash_refund');
  });
});
