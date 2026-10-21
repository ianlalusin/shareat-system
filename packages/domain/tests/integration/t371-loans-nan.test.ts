import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — loans module: `interestRate` and `principalAmount` on `createLoan`. §S0 per-module NaN tests. `createLoan` already parses the rate and
 * the principal and names them in a sentence, so these legs are GUARDS (green today) that must stay green once the writer (`loansRepo`) is branded.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createLoan } from '@shareat/domain';
import { LOAN_ADD_RULES } from '@shareat/domain/field-rules';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Kit = Awaited<ReturnType<typeof bootstrap>>;
const loan = (k: Kit, over: Record<string, unknown> = {}) => ({
  storeId: k.storeId, lenderName: 'Grab', name: uid('Advance'), principalAmount: '200000.00', interestRate: '2', ratePeriod: 'month' as const,
  interestMethod: 'straight' as const, paymentFrequency: 'daily' as const, termPeriods: 90, startDate: '2026-01-11', ...over,
});

describe.each([['interestRate', /interest|rate/i], ['principalAmount', /principal|amount/i]] as const)('loans — %s', (field, label) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the field; zero rows; a later valid call succeeds`, async () => {
      const k = await bootstrap(sql, `ln-${field}-${typed}`);
      const before = await count(sql, 'loans', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => createLoan(tx, k.admin, loan(k, { [field]: typed }) as never)));
      expectPlainRefusal(got, typed, label, `createLoan.${field}`, LOAN_ADD_RULES[field]);
      expect(await count(sql, 'loans', k.orgId), 'a refused loan wrote a row').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createLoan(tx, k.admin, loan(k) as never)));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ r: string; p: string }[]>`select interest_rate::text as r, principal_amount::text as p from loans where org_id = ${k.orgId}`;
      expect(row?.p, 'a valid principal reads back byte-identical').toBe('200000.00');
      expect(row?.r, 'a valid interest rate reads back byte-identical (numeric(8,4))').toBe('2.0000');
    });
  }
});
