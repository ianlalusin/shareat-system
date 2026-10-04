import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — trade/returns: `applyCredit` (`trade/returns.ts`, live via /trade/returns -> `applyCreditAction`). §S0 per-module NaN tests, audit M1.
 *
 * `applyCredit` does `const amount = Number(input.amount)` and then forwards `amount.toFixed(2)` to `recordCollection` — so a typed `'abc'` is REPLACED by the
 * string "NaN" before anything parses it: the sentence that comes back (if any) quotes "NaN", never what the person typed, and `NaN <= 0` / `NaN > outstanding` are
 * both false so the amount sails past both guards. The target: a plain sentence QUOTING the typed value and naming the amount, ZERO new `ar_collections` rows, the
 * credit balance and the charge's outstanding unchanged, and a valid call afterwards that reads back byte-identical.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { arRepo, closeDb, tradeRepo } from '@shareat/db';
import { applyCredit, createCustomer, createTradeOrder, dispatchTradeOrder, recordCollection } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** An org with ₱500 of store credit and a dispatched ₱500 order to apply it against. */
async function fixture(hint: string) {
  const k = await bootstrap(sql, hint);
  await sql`update items set sellable_wholesale = true where id = ${k.itemId}`;
  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${k.orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${k.orgId}, ${k.storeId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${k.adminId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${k.orgId}, ${k.storeId}, 'receipt_photo', ${`orgs/${k.orgId}/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${k.adminId}) returning id`;
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${k.orgId}, ${k.storeId}, 'purchase', '2026-01-01', ${file!.id}, ${k.adminId}) returning id`;
  await asOrg(k.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: k.orgId, storeId: k.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: loc!.id, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }], receivedBy: k.adminId,
      lines: [{ lineId: '1', itemId: k.itemId, itemKind: 'raw_material', receivedQuantity: quantity('20'), conversionFactor: '1', unitCost: '100.0000', locationId: loc!.id }],
    }),
  );
  const customer = await asOrg(k.orgId, (tx) => createCustomer(tx, k.admin, { name: `Resto ${hint}` }));
  const [cashier] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${k.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const order = async (qty: string) => {
    const o = await asOrg(k.orgId, (tx) => createTradeOrder(tx, k.admin, { storeId: k.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId: k.itemId, quantity: qty, rate: '500' }] }));
    await asOrg(k.orgId, (tx) => dispatchTradeOrder(tx, k.admin, { orderId: o.orderId }));
    return o.orderId;
  };
  const a = await order('2'); // ₱1,000
  const orderA = await asOrg(k.orgId, (tx) => tradeRepo.getOrderById(tx, k.orgId, a));
  // an overpayment of ₱500 -> ₱500 of store credit
  await asOrg(k.orgId, (tx) =>
    recordCollection(tx, k.admin, {
      storeId: k.storeId, customerId: customer.id, collectionDate: '2026-01-11', amount: '1500.00', moneyAccountId: cashier!.id,
      allocations: [{ chargeId: orderA!.arChargeId!, amountApplied: '1000.00' }],
    } as never),
  );
  const b = await order('1'); // ₱500 outstanding
  return { k, customerId: customer.id, cashierId: cashier!.id, orderB: b };
}

describe('trade/returns — applyCredit amount', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence QUOTING the typed value and naming the amount; zero ar_collections rows; the credit and the charge are untouched; a valid application succeeds and reads back`, async () => {
      const f = await fixture(`tr-credit-${typed}`);
      const before = await count(sql, 'ar_collections', f.k.orgId);
      const creditBefore = await asOrg(f.k.orgId, (tx) => arRepo.creditBalanceOf(tx, f.k.orgId, f.customerId));
      const got = await refusalOf(asOrg(f.k.orgId, (tx) => applyCredit(tx, f.k.admin, { tradeOrderId: f.orderB, amount: typed, collectionDate: '2026-01-12', moneyAccountId: f.cashierId })));
      expectPlainRefusal(got, typed, /amount/i, 'applyCredit.amount');
      expect(await count(sql, 'ar_collections', f.k.orgId), 'a refused credit application wrote an ar_collections row').toBe(before);
      expect(await asOrg(f.k.orgId, (tx) => arRepo.creditBalanceOf(tx, f.k.orgId, f.customerId)), 'the store credit moved').toBe(creditBefore);

      const ok = await refusalOf(asOrg(f.k.orgId, (tx) => applyCredit(tx, f.k.admin, { tradeOrderId: f.orderB, amount: '500.00', collectionDate: '2026-01-12', moneyAccountId: f.cashierId })));
      expect(ok.text, `the control (a valid ₱500 application) was refused: ${ok.text}`).toBeNull();
      expect(await count(sql, 'ar_collections', f.k.orgId)).toBe(before + 1);
      const [row] = await sql<{ a: string }[]>`select amount::text as a from ar_collections where org_id = ${f.k.orgId} order by created_at desc limit 1`;
      expect(row?.a, 'a valid amount reads back byte-identical').toBe('500.00');
    });
  }
});
