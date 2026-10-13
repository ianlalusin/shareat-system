import type postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { transaction, APP_ROLE, posV1Repo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { posV1SalesBody, posV1SoldItemsBody, type PosV1SalesFigures, type PosV1SoldItemInput } from '../../../../db/src/pos-v1/fixtures';
import * as D from '@shareat/domain';
import { receiveDelivery } from '../../../src/deliveries/receive';
import { quantity } from '../../../src/stock/quantity';
import type { LocationLike } from '../../../src/stock-locations/rules';
import { D1_FIGURES, linkTestStore, seedTestTenders } from './pos-day';
import { testItemCode } from './item-code';

/**
 * T-375 S6 - shared fixture for the drift, correction and reconciliation tests (`docs/tasks/375-pos-v1-day-feed.md`
 * S6 TESTER list). Tests only.
 *
 * One org with: Lipa (LINKED to POS, Cash + GCash tenders, a Walk-in channel and a non-remitted Foodpanda channel with
 * receivable 1220), the periods Dec 2026 - Mar 2027, all open (a closed period may only precede open ones, so a test that needs a closed
 * month closes Dec and Jan itself), a manager (Lipa),
 * an admin (Lipa) and a plain staff (Lipa, role staff, NO grant: lacks verify_sales_day). With `stock: true` Lipa also
 * has a kitchen, Cheese and Buns on hand (100 each) and the S5 item maps (A -> Cheese x1, B -> Buns x0.5), for the
 * usage-pull legs.
 */

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/** The business date every S6 test imports unless it says otherwise. */
export const DAY = '2027-01-10';

/** R1's drifted day: a voided 50.00 cash receipt. P 1,000.00, K 550.00, Cash 650.00 + GCash 350.00. Gross 1,050.00. */
export const R1_FIGURES: PosV1SalesFigures = { ...D1_FIGURES, paidTotal: 1000, packageOnly: 550, methods: { Cash: 650, GCash: 350 } };

export async function asOrgOn<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

export async function s6Fixture(sql: postgres.Sql, hint: string, o: { stock?: boolean } = {}) {
  const code = uid(`t375s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2026-12-01'::date, '2027-03-01'::date, interval '1 month') m`;

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Lipa', ${o.stock ? 'multi_room' : 'single_room'}) returning id`;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const plainStaffId = await mkPerson('Plain Staff', 'staff');

  const mkChannel = async (name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkInId = await mkChannel('Walk-in', true, null);
  const foodpandaId = await mkChannel('Foodpanda', false, '1220');

  const mkWallet = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${name}, 'ewallet', '1140', 'cashier') returning id`)[0]!.id;
  const gcashAcct = await mkWallet('GCash - Lipa');
  const mayaAcct = await mkWallet('Maya - Lipa');

  const { posStoreId } = await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: adminId });
  const tenders = await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcashAcct });

  const base = {
    orgId, storeId, walkInId, foodpandaId, gcashAcct, mayaAcct, posStoreId, ...tenders,
    adminId, managerId, plainStaffId,
    admin: actorOf(orgId, adminId), manager: actorOf(orgId, managerId), plainStaff: actorOf(orgId, plainStaffId),
  };
  if (!o.stock) return { ...base, kitchen: '', cheese: '', buns: '' };

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const kitchen = (await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`)[0]!.id;
  const locations: LocationLike[] = [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
  const mkItem = async (c: string, name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, ${name}, 'meat_slab', 'kg', ${managerId}) returning id`)[0]!.id;
  const cheese = await mkItem('CHEESE', 'Cheese');
  const buns = await mkItem('BUNS', 'Buns');
  for (const itemId of [cheese, buns]) {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
    const [del] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgId}, ${storeId}, 'purchase', '2026-12-02', ${file!.id}, ${managerId}) returning id`;
    await asOrgOn(orgId, (tx) =>
      receiveDelivery(tx, {
        orgId, storeId, deliveryId: del!.id, deliveredOn: '2026-12-02', locations, receivedBy: managerId,
        lines: [{ lineId: '1', itemId, itemKind: 'meat_slab', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchen }],
      }),
    );
  }
  await asOrgOn(orgId, async (tx) => {
    await D.upsertPosItemMap(tx, base.admin, { orgId, storeId, posItemKey: 'A', posItemName: 'A', mode: 'direct', itemId: cheese, quantityPerSale: '1' });
    await D.upsertPosItemMap(tx, base.admin, { orgId, storeId, posItemKey: 'B', posItemName: 'B', mode: 'direct', itemId: buns, quantityPerSale: '0.5', confirmShared: true });
  });
  return { ...base, kitchen, cheese, buns };
}
export type S6F = Awaited<ReturnType<typeof s6Fixture>>;

/**
 * A recheck batch (purpose 'recheck', BOTH kinds, V11) written through `posV1Repo.insertBatch`, the door S6's recheck
 * uses. Unlike `_fixtures/pos-sold-items.ts` (which copies the stored `sales` body and varies the items), this one
 * varies the `sales` figures: that is what R1/C1 need. `soldItems` defaults to the day's newest stored `sold_items`
 * feed, unchanged. `fetchedAt` defaults to strictly later than every stored feed of the day ("latest" is
 * `(fetched_at desc, id desc)`, so a tie would fall to a random uuid). Returns the ids by kind.
 */
export async function insertSalesRecheck(
  tx: Tx,
  o: {
    orgId: string;
    storeId: string;
    businessDate: string;
    posStoreId: string;
    fetchedBy: string;
    figures: PosV1SalesFigures;
    soldItems?: readonly PosV1SoldItemInput[];
    fetchedAt?: Date;
  },
): Promise<{ batchId: string; ids: { sales?: string; sold_items?: string } }> {
  const newestSales = await posV1Repo.latestForDay(tx, o.orgId, o.storeId, o.businessDate, 'sales');
  const newestItems = await posV1Repo.latestForDay(tx, o.orgId, o.storeId, o.businessDate, 'sold_items');
  if (!newestSales || !newestItems) throw new Error(`insertSalesRecheck: ${o.businessDate} has no stored feed to follow`);
  let fetchedAt = o.fetchedAt;
  if (!fetchedAt) {
    const floor = Math.max(newestSales.fetchedAt.getTime(), newestItems.fetchedAt.getTime()) + 1;
    fetchedAt = new Date(Math.max(Date.now(), floor));
  }
  const salesBody = JSON.stringify(posV1SalesBody(o.figures), null, 2);
  const itemsBody = o.soldItems ? JSON.stringify(posV1SoldItemsBody(o.soldItems), null, 2) : newestItems.body;
  return posV1Repo.insertBatch(tx, {
    orgId: o.orgId,
    storeId: o.storeId,
    businessDate: o.businessDate,
    purpose: 'recheck',
    posStoreId: o.posStoreId,
    fetchedBy: o.fetchedBy,
    fetchedAt,
    rows: [
      { kind: 'sales', body: salesBody, payload: JSON.parse(salesBody) as unknown },
      { kind: 'sold_items', body: itemsBody, payload: JSON.parse(itemsBody) as unknown },
    ],
  });
}
