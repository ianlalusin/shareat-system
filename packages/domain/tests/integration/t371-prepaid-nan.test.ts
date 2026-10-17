import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — prepaid module: `totalCost` on `createPrepaidItem` (register-named). §S0 per-module NaN tests. The typed cost is handed to the schedule builder
 * and the INSERT; the leg asserts a plain sentence quoting the typed value and naming the cost, zero rows, and a valid control that reads back byte-identical.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createPrepaidItem } from '@shareat/domain';
import { PREPAID_ADD_RULES } from '@shareat/domain/field-rules';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Kit = Awaited<ReturnType<typeof bootstrap>>;
const item = (k: Kit, over: Record<string, unknown> = {}) => ({
  storeId: k.storeId, name: 'Fire insurance', category: 'insurance', coverageStartDate: '2026-01-01', coverageMonths: 12, totalCost: '12000.00', ...over,
});

describe('prepaid — totalCost', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the cost; zero rows; a later valid item succeeds and reads back`, async () => {
      const k = await bootstrap(sql, `pp-${typed}`);
      const before = await count(sql, 'prepaid_items', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => createPrepaidItem(tx, k.admin, item(k, { totalCost: typed }) as never)));
      expectPlainRefusal(got, typed, /cost/i, 'createPrepaidItem.totalCost', PREPAID_ADD_RULES.totalCost);
      expect(await count(sql, 'prepaid_items', k.orgId), 'a refused item wrote a row').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createPrepaidItem(tx, k.admin, item(k) as never)));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ c: string }[]>`select total_cost::text as c from prepaid_items where org_id = ${k.orgId}`;
      expect(row?.c, 'a valid cost reads back byte-identical').toBe('12000.00');
    });
  }
});
