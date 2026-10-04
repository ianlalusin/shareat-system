import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — statutory-discounts module: `grossAmount` / `discountAmount` on `recordStatutoryDiscount`. §S0 per-module NaN tests and ✎R13
 * (blank cases follow the COLUMN): `grossAmount` is NOT NULL with no default, so a BLANK is refused with a sentence, never stored as '0'.
 * Today the typed strings go straight to the INSERT (`grossAmount: input.grossAmount`), so `'abc'` / `'NaN'` surface as the database's own error
 * and a blank reaches it as '' (an invalid numeric). The target: a plain sentence quoting the typed value and naming the field, nothing written, a
 * later valid call succeeds and reads back byte-identical.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { recordStatutoryDiscount } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Kit = Awaited<ReturnType<typeof bootstrap>>;
const input = (k: Kit, over: Record<string, string> = {}) => ({
  storeId: k.storeId, businessDate: '2026-01-10', invoiceNumber: uid('INV'), kind: 'senior' as const, idNumber: 'SC-123', holderName: 'Lola Remedios',
  grossAmount: '1000.00', discountAmount: '200.00', ...over,
});
const TABLE = 'statutory_discount_records';

describe.each([
  ['grossAmount', /gross/i],
  ['discountAmount', /discount/i],
] as const)('statutory-discounts — %s', (field, label) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the field; zero rows; a later valid call succeeds`, async () => {
      const k = await bootstrap(sql, `sd-${field}-${typed}`);
      const before = await count(sql, TABLE, k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => recordStatutoryDiscount(tx, k.admin, input(k, { [field]: typed }))));
      expectPlainRefusal(got, typed, label, `recordStatutoryDiscount.${field}`);
      expect(await count(sql, TABLE, k.orgId), 'a refused record wrote a row').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => recordStatutoryDiscount(tx, k.admin, input(k))));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ g: string; d: string }[]>`select gross_amount::text as g, discount_amount::text as d from statutory_discount_records where org_id = ${k.orgId}`;
      expect([row?.g, row?.d], 'a valid pair reads back byte-identical').toEqual(['1000.00', '200.00']);
    });
  }
});

describe('statutory-discounts — a BLANK discountAmount follows the column (✎R13: NOT NULL, no default -> refused with a sentence)', () => {
  it("'' is refused with a sentence naming the discount, never stored as 0; zero rows", async () => {
    const k = await bootstrap(sql, 'sd-blank-discount');
    const got = await refusalOf(asOrg(k.orgId, (tx) => recordStatutoryDiscount(tx, k.admin, input(k, { discountAmount: '' }))));
    expect(got.text, 'a blank discount amount was ACCEPTED').not.toBeNull();
    expect(got.raw, `a raw error (not a sentence) reached the person: ${got.text}`).toBe(false);
    expect(got.text!.toLowerCase()).toContain('discount');
    expect(await count(sql, TABLE, k.orgId)).toBe(0);
  });
});

describe('statutory-discounts — blank follows the column (✎R13)', () => {
  it('a BLANK grossAmount (NOT NULL, no default) is refused with a sentence, never stored as 0; zero rows', async () => {
    const k = await bootstrap(sql, 'sd-blank');
    const got = await refusalOf(asOrg(k.orgId, (tx) => recordStatutoryDiscount(tx, k.admin, input(k, { grossAmount: '' }))));
    expect(got.text, 'a blank gross amount was ACCEPTED').not.toBeNull();
    expect(got.raw, `a raw error (not a sentence) reached the person: ${got.text}`).toBe(false);
    expect(got.text!.toLowerCase()).toContain('gross');
    expect(await count(sql, TABLE, k.orgId)).toBe(0);
    const zero = await sql<{ n: string }[]>`select count(*)::text as n from statutory_discount_records where org_id = ${k.orgId} and gross_amount = 0`;
    expect(Number(zero[0]!.n), 'a blank was turned into a zero').toBe(0);
  });
});
