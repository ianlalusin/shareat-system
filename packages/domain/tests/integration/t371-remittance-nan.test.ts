import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — remittance module: `unremittedCeiling` on `setStoreCashPolicy` (live via /settings -> `setCashPolicyAction`; register-named). §S0 per-module NaN
 * tests, audit M2. The typed ceiling goes straight to `storesRepo.setCashPolicy`, so `'abc'` / `'NaN'` surface as the database's own finite CHECK. The target:
 * a plain sentence quoting the typed value and naming the ceiling, the STORED ceiling and cadence unchanged, a valid call afterwards that reads back
 * byte-identical, and (✎R13, a nullable column) a BLANK with a daily cadence stores NULL — never 0.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { setStoreCashPolicy } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, expectPlainRefusal, refusalOf } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const policyOf = async (storeId: string) => (await sql<{ c: string | null; cadence: string }[]>`select unremitted_ceiling::text as c, remittance_cadence as cadence from stores where id = ${storeId}`)[0]!;

describe('remittance — unremittedCeiling (setStoreCashPolicy)', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the ceiling; the stored policy is unchanged; a later valid call succeeds and reads back`, async () => {
      const k = await bootstrap(sql, `rm-${typed}`);
      await asOrg(k.orgId, (tx) => setStoreCashPolicy(tx, k.admin, { storeId: k.storeId, remittanceCadence: 'daily', unremittedCeiling: '30000.00' }));
      const before = await policyOf(k.storeId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => setStoreCashPolicy(tx, k.admin, { storeId: k.storeId, remittanceCadence: 'daily', unremittedCeiling: typed })));
      expectPlainRefusal(got, typed, /ceiling|unremitted/i, 'setStoreCashPolicy.unremittedCeiling');
      expect(await policyOf(k.storeId), 'a refused policy changed the stored ceiling or cadence').toEqual(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => setStoreCashPolicy(tx, k.admin, { storeId: k.storeId, remittanceCadence: 'daily', unremittedCeiling: '50000.00' })));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      expect((await policyOf(k.storeId)).c, 'a valid ceiling reads back byte-identical').toBe('50000.00');
    });
  }

  it("a BLANK ceiling with a daily cadence stores NULL (a nullable column) — never a guessed 0", async () => {
    const k = await bootstrap(sql, 'rm-blank');
    await asOrg(k.orgId, (tx) => setStoreCashPolicy(tx, k.admin, { storeId: k.storeId, remittanceCadence: 'daily', unremittedCeiling: '30000.00' }));
    const out = await refusalOf(asOrg(k.orgId, (tx) => setStoreCashPolicy(tx, k.admin, { storeId: k.storeId, remittanceCadence: 'daily', unremittedCeiling: '' })));
    expect(out.text, `a blank ceiling was refused: ${out.text}`).toBeNull();
    expect((await policyOf(k.storeId)).c, 'a blank ceiling must store null, not zero').toBeNull();
  });
});
