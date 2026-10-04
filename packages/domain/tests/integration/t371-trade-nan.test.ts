import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — trade module: `deliveryFee` and `otherFees` on `createTradeOrder` (register-named). §S0 per-module NaN tests. `createTradeOrder` already
 * parses both fees (`parseMoneyInput`, "The delivery fee" / "The other fees") and refuses a negative one, so these legs are GUARDS (green today) that must
 * stay green once `tradeRepo`'s writers (the bulk `insertLines` among them) are branded. Blank fees are zero — the column has a default of 0.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createCustomer, createTradeOrder } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const k = await bootstrap(sql, hint);
  await sql`update items set sellable_wholesale = true where id = ${k.itemId}`;
  const customer = await asOrg(k.orgId, (tx) => createCustomer(tx, k.admin, { name: `Resto ${hint}` }));
  const order = (over: Record<string, unknown> = {}) => ({
    storeId: k.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId: k.itemId, quantity: '10', rate: '100' }], ...over,
  });
  return { k, order };
}

describe.each([['deliveryFee', /delivery fee/i], ['otherFees', /other fees/i]] as const)('trade — %s', (field, label) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the fee; zero orders and lines; a later valid call succeeds and reads back`, async () => {
      const { k, order } = await fixture(`tr-${field}-${typed}`);
      const before = [await count(sql, 'trade_orders', k.orgId), await count(sql, 'trade_order_lines', k.orgId)];
      const got = await refusalOf(asOrg(k.orgId, (tx) => createTradeOrder(tx, k.admin, order({ [field]: typed }) as never)));
      expectPlainRefusal(got, typed, label, `createTradeOrder.${field}`);
      expect([await count(sql, 'trade_orders', k.orgId), await count(sql, 'trade_order_lines', k.orgId)], 'a refused order wrote rows').toEqual(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createTradeOrder(tx, k.admin, order({ [field]: '250.00' }) as never)));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      const column = field === 'deliveryFee' ? 'delivery_fee' : 'other_fees';
      const [row] = await sql.unsafe<{ f: string }[]>(`select ${column}::text as f from trade_orders where org_id = '${k.orgId}'`);
      expect(row?.f, 'a valid fee reads back byte-identical').toBe('250.00');
    });
  }

  // ⚠️ Limit: this leg can NOT tell a guessed '0' from the column default — both read back 0.00. It pins only "a blank is not an error" (✎R13: a column WITH a
  // default omits the value on insert so the database default applies). Which of the two the builder does is visible in the source, not in this assertion.
  it('a BLANK fee is zero (the column default), not an error', async () => {
    const { k, order } = await fixture(`tr-${field}-blank`);
    const ok = await refusalOf(asOrg(k.orgId, (tx) => createTradeOrder(tx, k.admin, order({ [field]: '' }) as never)));
    expect(ok.text, `a blank fee was refused: ${ok.text}`).toBeNull();
  });
});
