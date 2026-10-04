import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — pos module: `quantityPerSale` on a direct POS item map (`upsertPosItemMap`). `docs/tasks/371-nan-sweep.md` §S0 per-module NaN tests.
 *
 * Today the guard is `!input.quantityPerSale || Number(input.quantityPerSale) <= 0`: `Number('abc') <= 0` is FALSE, so `'abc'` / `'NaN'` pass the
 * check and reach the INSERT, where the database's own finite CHECK / numeric syntax error surfaces. The target: a plain sentence quoting the typed
 * value and naming the quantity, nothing written, and a later valid call succeeds. Blank stays refused (a direct map needs a quantity).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error(`Refusing to run against a database whose name does not contain "_test".`);

import { closeDb } from '@shareat/db';
import { upsertPosItemMap } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const mapInput = (k: Awaited<ReturnType<typeof bootstrap>>, quantityPerSale: string | null) => ({
  orgId: k.orgId, storeId: k.storeId, posItemKey: uid('POS'), posItemName: 'Pork plate', mode: 'direct' as const, itemId: k.itemId, quantityPerSale,
});

describe('pos — quantityPerSale', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the quantity; zero rows; a later valid call succeeds and reads back`, async () => {
      const k = await bootstrap(sql, `pos-${typed}`);
      const before = await count(sql, 'pos_item_maps', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => upsertPosItemMap(tx, k.admin, mapInput(k, typed))));
      expectPlainRefusal(got, typed, /quantity/i, 'upsertPosItemMap');
      expect(await count(sql, 'pos_item_maps', k.orgId), 'a refused map wrote a row').toBe(before);

      const ok = await asOrg(k.orgId, (tx) => upsertPosItemMap(tx, k.admin, mapInput(k, '2.5')));
      expect(ok.ok, `the control (a valid quantity) was refused: ${JSON.stringify(ok)}`).toBe(true);
      const [row] = await sql<{ q: string }[]>`select quantity_per_sale::text as q from pos_item_maps where org_id = ${k.orgId}`;
      expect(row?.q, 'the valid quantity reads back exactly (numeric(14,6))').toBe('2.500000');
    });
  }

  it('a BLANK quantity on a direct map is refused (a direct map needs one) and writes nothing', async () => {
    const k = await bootstrap(sql, 'pos-blank');
    const got = await refusalOf(asOrg(k.orgId, (tx) => upsertPosItemMap(tx, k.admin, mapInput(k, ''))));
    expect(got.text, 'a blank quantity was accepted').not.toBeNull();
    expect(got.raw, `a raw error reached the person: ${got.text}`).toBe(false);
    expect(await count(sql, 'pos_item_maps', k.orgId)).toBe(0);
  });
});
