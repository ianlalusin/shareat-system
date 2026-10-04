import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — owners module: `ownershipPercentage` and `drawingLimit` on `createOwner`, `acknowledgedAmount` on `closeDrawingMonth` (register-named). §S0
 * per-module NaN tests. All three already parse with a written sentence quoting the typed value (T-343 S5.5s, `parseMoneyInput`), so these legs are
 * GUARDS (green today) that must stay green once `ownersRepo`'s writers are branded (S1) and the comparisons rewritten (S2).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { closeDrawingMonth, createOwner } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Kit = Awaited<ReturnType<typeof bootstrap>>;
const owner = (k: Kit, over: Record<string, unknown> = {}) => ({ storeId: k.storeId, personId: k.managerId, role: 'Managing Partner', ...over });

describe.each([
  ['ownershipPercentage', /ownership percentage/i, { ownershipPercentage: '50' }],
  ['drawingLimit', /drawing limit/i, { drawingLimit: '10000.00', drawingLimitPeriod: 'monthly' }],
] as const)('owners — createOwner %s', (field, label, valid) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the field; zero rows; a later valid call succeeds`, async () => {
      const k = await bootstrap(sql, `ow-${field}-${typed}`);
      const before = await count(sql, 'owners', k.orgId);
      const over = field === 'drawingLimit' ? { drawingLimit: typed, drawingLimitPeriod: 'monthly' } : { [field]: typed };
      const got = await refusalOf(asOrg(k.orgId, (tx) => createOwner(tx, k.admin, owner(k, over) as never)));
      expectPlainRefusal(got, typed, label, `createOwner.${field}`);
      expect(await count(sql, 'owners', k.orgId), 'a refused owner wrote a row').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createOwner(tx, k.admin, owner(k, valid) as never)));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      expect(await count(sql, 'owners', k.orgId)).toBe(before + 1);
      const [row] = await sql<{ p: string | null; d: string | null }[]>`select ownership_percentage::text as p, drawing_limit::text as d from owners where org_id = ${k.orgId}`;
      expect(field === 'ownershipPercentage' ? row?.p : row?.d, 'a valid value reads back byte-identical').toBe(field === 'ownershipPercentage' ? '50.000' : '10000.00');
    });
  }
});

describe('owners — closeDrawingMonth acknowledgedAmount', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the agreed amount; no close row; a later valid close succeeds`, async () => {
      const k = await bootstrap(sql, `ow-close-${typed}`);
      const o = await asOrg(k.orgId, (tx) => createOwner(tx, k.admin, owner(k, { ownershipPercentage: '50' }) as never));
      const input = (acknowledgedAmount?: string) => ({ ownerId: o.id, month: '2025-12-01', on: '2026-01-15', ...(acknowledgedAmount !== undefined ? { acknowledgedAmount } : {}) });
      const before = await count(sql, 'owner_drawing_closes', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => closeDrawingMonth(tx, k.admin, input(typed))));
      expectPlainRefusal(got, typed, /agreed amount/i, 'closeDrawingMonth.acknowledgedAmount');
      expect(await count(sql, 'owner_drawing_closes', k.orgId), 'a refused close wrote a row').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => closeDrawingMonth(tx, k.admin, input('0.00'))));
      expect(ok.text, `the control (agree with the ledger at zero) was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ a: string }[]>`select acknowledged_amount::text as a from owner_drawing_closes where org_id = ${k.orgId}`;
      expect(row?.a, 'a valid agreed amount reads back byte-identical').toBe('0.00');
    });
  }
});
