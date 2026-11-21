import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { advisoryLocksRepo, closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { confirmReceipt, dispatchOrder, postInternalFreight } from '../../src/commissary/transfer';
import { resolveDiscrepancy } from '../../src/commissary/discrepancy';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { testItemCode } from './_fixtures/item-code';
import { heldRace } from './_fixtures/held-race';

/**
 * T-618 / DEF-921 - the commissary writers of the 1250/2150 pair (a receipt, its freight, an extra dispatch resolving an over-receipt) take the store-pair lock a cross-store
 * transfer, its void and a settle-between-stores take. Each test holds the writer's transaction open and starts a plain pair-lock taker beside it: the taker must PARK on the
 * advisory lock (heldRace's park proof throws if it never waits). Fixture copied from commissary-discrepancy.test.ts (T-174).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 6 });

let orgA: string, commissary: string, branch: string, personA: string, personB: string, fileA: string;
let comKitchen: string, brKitchen: string, itemA: string, brItemA: string;
let orderId: string, orderLineId: string;

const comLocations = (): LocationLike[] => [
  { id: comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
];

function receiveInput(received: string) {
  return {
    orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
    commissaryStoreCode: 'COM', branchStoreCode: 'BR',
    orderId, receivedOn: '2026-08-21', receivedBy: personA,
    orderLineIdByLineId: { '1': orderLineId },
    lines: [{
      lineId: '1', itemId: itemA, branchItemId: brItemA, branchLocationId: brKitchen,
      dispatchedQuantity: quantity('100'), receivedQuantity: quantity(received),
      branchBaseUnit: 'kg', commissaryBaseUnit: 'kg', rate: '310.0000',
      dispatchCost: money('30000.00'), branchItemKind: 'raw_material' as const,
    }],
  };
}

/** 200 kg in at 300, 100 dispatched at 310 (100 stay on hand for an extra dispatch); the receipt is the test's own. */
async function ship(): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${commissary},'purchase','2026-08-01',${fileA},${personA}) returning id`;
  await withOrgPrincipal(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: commissary, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: comLocations(), receivedBy: personA,
      lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('200'), conversionFactor: '1', unitCost: '300.0000', locationId: comKitchen }],
    }),
  );
  await withOrgPrincipal(orgA, (tx) =>
    dispatchOrder(tx, {
      orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
      dispatchedBy: personA, onHandByItem: { [itemA]: quantity('200') },
      lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
    }),
  );
}

beforeEach(async () => {
  await sql`
    truncate table trade_discrepancies, commissary_item_map, commissary_item_offerings,
      commissary_links, trade_order_lines, trade_orders, customers, expense_categories,
      count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [c] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'COM','Commissary','multi_room') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'BR','Branch','multi_room') returning id`;
  commissary = c!.id; branch = b!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Driver Ben') returning id`;
  personA = p!.id; personB = p2!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r1] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${commissary},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${branch},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  comKitchen = r1!.id; brKitchen = r2!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork','raw_material','kg',${personA}) returning id`;
  const [i2] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork (branch)','raw_material','kg',${personA}) returning id`;
  itemA = i!.id; brItemA = i2!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${personA}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-08-01','2026-08-31','open')`;

  const [cst] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgA},'Branch as counterparty','internal',${branch},${personA}) returning id`;
  const [ord] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by)
    values (${orgA},${commissary},${cst!.id},'2026-08-20','draft',31000,${branch},${personA}) returning id`;
  orderId = ord!.id;
  const [line] = await sql<{ id: string }[]>`
    insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, requested_quantity)
    values (${orgA},${orderId},${itemA},100,'kg',310,31000,100) returning id`;
  orderLineId = line!.id;
});


afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const taker = () => (tx: Parameters<typeof advisoryLocksRepo.lockInterStorePair>[0]) => advisoryLocksRepo.lockInterStorePair(tx, branch, commissary);

describe('DEF-921 - commissary writers hold the store-pair lock', () => {
  it('confirmReceipt: a pair-lock taker parks behind it - Mutant: drop the lock in confirmReceipt -> the taker never waits, red', async () => {
    await ship();
    await heldRace(withOrgPrincipal, orgA, async (tx) => {
      const r = await confirmReceipt(tx, receiveInput('100'));
      if (!r.ok) throw new Error(r.reason);
    }, taker(), 700, { sql });
  });

  it('postInternalFreight: a pair-lock taker parks behind it - Mutant: drop the lock in postInternalFreight -> red', async () => {
    await heldRace(withOrgPrincipal, orgA, async (tx) => {
      const r = await postInternalFreight(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch, commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', freight: money('250.00'), postedBy: personA,
      });
      expect(r).not.toBeNull();
    }, taker(), 700, { sql });
  });

  it('resolving an over-receipt as an extra dispatch: a pair-lock taker parks behind it - Mutant: drop the lock in resolveAsExtraDispatch -> red', async () => {
    await ship();
    await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by) values (${orgA}, ${commissary}, ${branch}, ${itemA}, ${brItemA}, ${personA})`;
    const received = await withOrgPrincipal(orgA, (tx) => confirmReceipt(tx, receiveInput('110')));
    if (!received.ok) throw new Error(received.reason);
    const discrepancyId = received.discrepancies[0]!.id!;
    await heldRace(withOrgPrincipal, orgA, async (tx) => {
      const r = await resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId, commissaryStoreId: commissary,
        disposition: 'extra_dispatch', resolvedOn: '2026-08-22', resolvedBy: personA,
      });
      if (!r.ok) throw new Error(r.reason);
    }, taker(), 700, { sql });
  });
});
