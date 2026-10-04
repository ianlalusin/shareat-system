import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — stores module: `unremittedCeiling` on `createStore` (a nullable column: a BLANK stores null, ✎R13). §S0 per-module NaN tests.
 * The typed ceiling reaches `storesRepo.insertStore` unparsed today, so `'abc'` / `'NaN'` surface as the database's own error. The target: a plain
 * sentence quoting the typed value and naming the ceiling, no store row written, and a later valid call succeeds and reads back.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createStore } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const newStore = (over: Record<string, unknown> = {}) => ({ code: uid('S'), name: 'Malvar', unremittedCeiling: '50000.00', ...over });

describe('stores — unremittedCeiling', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the ceiling; no store row; a later valid call succeeds and reads back`, async () => {
      const k = await bootstrap(sql, `st-${typed}`);
      const before = await count(sql, 'stores', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => createStore(tx, k.admin, newStore({ unremittedCeiling: typed }) as never)));
      expectPlainRefusal(got, typed, /ceiling|unremitted/i, 'createStore.unremittedCeiling');
      expect(await count(sql, 'stores', k.orgId), 'a refused createStore wrote a store row').toBe(before);
      const code = uid('S2');
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createStore(tx, k.admin, newStore({ code, unremittedCeiling: '50000.00' }) as never)));
      expect(ok.text, `the control (a valid ceiling) was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ c: string | null }[]>`select unremitted_ceiling::text as c from stores where org_id = ${k.orgId} and code = ${code}`;
      expect(row?.c, 'the valid ceiling reads back byte-identical').toBe('50000.00');
    });
  }

  it('positive control: a valid ceiling creates the store and reads back byte-identical', async () => {
    const k = await bootstrap(sql, 'st-ok');
    const code = uid('S4');
    const ok = await refusalOf(asOrg(k.orgId, (tx) => createStore(tx, k.admin, newStore({ code }) as never)));
    expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
    const [row] = await sql<{ c: string | null }[]>`select unremitted_ceiling::text as c from stores where org_id = ${k.orgId} and code = ${code}`;
    expect(row?.c).toBe('50000.00');
  });

  it('a BLANK ceiling (a nullable column) stores null — never 0', async () => {
    const k = await bootstrap(sql, 'st-blank');
    const code = uid('S3');
    const ok = await refusalOf(asOrg(k.orgId, (tx) => createStore(tx, k.admin, newStore({ code, unremittedCeiling: '' }) as never)));
    expect(ok.text, `a blank ceiling was refused: ${ok.text}`).toBeNull();
    const [row] = await sql<{ c: string | null }[]>`select unremitted_ceiling::text as c from stores where org_id = ${k.orgId} and code = ${code}`;
    expect(row?.c, 'a blank ceiling must store null, not a guessed zero').toBeNull();
  });
});
