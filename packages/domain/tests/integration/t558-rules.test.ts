import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-558 R1 (TESTER) - `readPosRules` carries the tolerance, and the writer enforces the ceiling. docs/tasks/558-pos-sale-variance-tolerance.md R1.
 *   - `readPosRules` returns `saleVarianceToleranceCentavos: bigint` (default 1n = PHP 0.01), dated like every other rule;
 *   - the writer refuses 0.11 with the bounds sentence "<label> must be between 0 and 0.10." and accepts 0.10 (the ceiling) and 0 (off);
 *   - a refused value writes nothing.
 * Real Postgres (a `_test` database via TEST_DATABASE_URL). Mirrors t539-pos-rules.test.ts.
 *
 * RED NOW: the registry has no such key (the writer says "not a business rule"), and readPosRules returns no tolerance.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, RefusalError } from '@shareat/db';
import { setBusinessRule } from '@shareat/domain';
import { readPosRules } from '../../src/business-rules/pos-rules';
import { asOrg, attempt, daysFromToday, putRule, ruleRows, ruleWorld, type RuleWorld } from './_fixtures/t512-rules';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const KEY = 'pos.sale_variance_tolerance';
const LABEL = 'Largest short payment on a POS sale that counts as normal (₱)';

const set = (w: RuleWorld, who: { personId: string; orgId: string }, input: { key: string; value: string; effectiveFrom: string; reason: string }) =>
  asOrg(w.orgId, (tx) => setBusinessRule(tx, who, input as never));
const read = (orgId: string, onDate: string) =>
  asOrg(orgId, (tx) => readPosRules(tx, orgId, onDate)) as Promise<Awaited<ReturnType<typeof readPosRules>> & { saleVarianceToleranceCentavos: bigint }>; // (the field is the builder's: ASSUMED)

describe('T-558 readPosRules - saleVarianceToleranceCentavos', () => {
  it('a fresh org (no rows) reads 1n: PHP 0.01, a bigint of centavos [kills: an absent row read as zero; a number instead of a bigint]', async () => {
    const w = await ruleWorld(sql, 'var-fresh');
    const r = await read(w.orgId, '2026-11-06');
    expect(r.saleVarianceToleranceCentavos).toBe(1n);
    expect(typeof r.saleVarianceToleranceCentavos).toBe('bigint');
  });

  it('the other four POS numbers are unchanged beside it (vat 1200n, senior/PWD 2000n, start hour 4, table warning 90)', async () => {
    const w = await ruleWorld(sql, 'var-others');
    expect(await read(w.orgId, '2026-11-06')).toMatchObject({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90 });
  });

  it('a dated change is read on its date: raw rows, 0.05 from 2026-12-01 - 2026-11-30 reads 1n, 2026-12-01 reads 5n [kills: < for <= at the start day]', async () => {
    const w = await ruleWorld(sql, 'var-dated-raw');
    await putRule(sql, w.orgId, KEY, '0.050000', '2026-12-01');
    expect((await read(w.orgId, '2026-11-30')).saleVarianceToleranceCentavos).toBe(1n);
    expect((await read(w.orgId, '2026-12-01')).saleVarianceToleranceCentavos).toBe(5n);
  });

  it('a change through the writer: 0.10 from tomorrow - today still reads 1n, tomorrow and a month on read 10n', async () => {
    const w = await ruleWorld(sql, 'var-dated-writer');
    const from = daysFromToday(1);
    await set(w, w.admin, { key: KEY, value: '0.10', effectiveFrom: from, reason: 'Wallet rounding at Lipa' });
    expect((await read(w.orgId, daysFromToday(0))).saleVarianceToleranceCentavos).toBe(1n);
    expect((await read(w.orgId, from)).saleVarianceToleranceCentavos).toBe(10n);
    expect((await read(w.orgId, daysFromToday(30))).saleVarianceToleranceCentavos).toBe(10n);
  });

  it('0 is allowed (an admin may turn the allowance off): reads 0n, not the default [kills: a zero treated as "no row"]', async () => {
    const w = await ruleWorld(sql, 'var-zero');
    await set(w, w.admin, { key: KEY, value: '0', effectiveFrom: daysFromToday(1), reason: 'No allowance' });
    expect((await read(w.orgId, daysFromToday(1))).saleVarianceToleranceCentavos).toBe(0n);
  });

  it('one org never reads another org\'s tolerance [kills: a read keyed on something other than the org]', async () => {
    const a = await ruleWorld(sql, 'var-iso-a');
    const b = await ruleWorld(sql, 'var-iso-b');
    await putRule(sql, b.orgId, KEY, '0.080000', '2000-01-01');
    expect((await read(a.orgId, '2026-11-06')).saleVarianceToleranceCentavos).toBe(1n);
    expect((await read(b.orgId, '2026-11-06')).saleVarianceToleranceCentavos).toBe(8n);
  });
});

describe('T-558 writer - the registry max is the hard ceiling', () => {
  it('0.11 is refused with the bounds sentence and writes nothing [kills: a ceiling above 0.10; a refusal that still writes]', async () => {
    const w = await ruleWorld(sql, 'var-too-high');
    const r = await attempt(() => set(w, w.admin, { key: KEY, value: '0.11', effectiveFrom: daysFromToday(1), reason: 'Too generous' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).toBe(`${LABEL} must be between 0 and 0.10.`);
    }
    expect(await ruleRows(sql, w.orgId, KEY)).toHaveLength(0);
  });

  it('0.10 (the ceiling) is accepted and stored; so is 0.01', async () => {
    const w = await ruleWorld(sql, 'var-ceiling');
    await set(w, w.admin, { key: KEY, value: '0.10', effectiveFrom: daysFromToday(1), reason: 'Ceiling' });
    await set(w, w.admin, { key: KEY, value: '0.01', effectiveFrom: daysFromToday(2), reason: 'Back to normal' });
    expect((await ruleRows(sql, w.orgId, KEY)).map((x) => Number(x.value))).toEqual([0.1, 0.01]);
  });

  it('1 peso is refused with the same bounds sentence, and a negative figure is refused too; nothing is written', async () => {
    const w = await ruleWorld(sql, 'var-bounds');
    const one = await attempt(() => set(w, w.admin, { key: KEY, value: '1', effectiveFrom: daysFromToday(1), reason: 'Out of bounds' }));
    expect(one.ok).toBe(false);
    if (!one.ok) expect((one.error as RefusalError).userMessage).toBe(`${LABEL} must be between 0 and 0.10.`);
    const neg = await attempt(() => set(w, w.admin, { key: KEY, value: '-0.01', effectiveFrom: daysFromToday(1), reason: 'Out of bounds' }));
    expect(neg.ok).toBe(false);
    expect(await ruleRows(sql, w.orgId, KEY)).toHaveLength(0);
  });

  it('an admin can move it but a manager cannot (control first, so the refusal is the capability and not an unknown key)', async () => {
    const w = await ruleWorld(sql, 'var-capability');
    await set(w, w.admin, { key: KEY, value: '0.05', effectiveFrom: daysFromToday(1), reason: 'Admin sets it' });
    const r = await attempt(() => set(w, w.manager, { key: KEY, value: '0.06', effectiveFrom: daysFromToday(2), reason: 'Not allowed' }));
    expect(r.ok).toBe(false);
    expect((await ruleRows(sql, w.orgId, KEY)).map((x) => Number(x.value))).toEqual([0.05]);
  });
});
