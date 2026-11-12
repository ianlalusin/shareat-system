import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-539 S1 TESTER - `readPosRules` and the writer for the two POS keys, on a REAL Postgres (a `_test` database via TEST_DATABASE_URL).
 * docs/tasks/539-pos-business-rule-keys.md R2 (writer), R4 (reader), R5.
 *
 * RED today: packages/domain/src/business-rules/pos-rules.ts does not exist, and the registry has neither POS key.
 *
 * ASSUMED API: `readPosRules(tx, orgId, onDate)` is a named export of packages/domain/src/business-rules/pos-rules.ts (imported here by that path, not through
 *   '@shareat/domain', because the spec says "exported from the business-rules index", which is the DB-free leaf and must not import @shareat/db; the builder may also
 *   re-export it from the domain root, this test does not care). It returns exactly { vatPercentBasisPoints: bigint; scPwdPercentBasisPoints: bigint; businessDayStartHour: number }.
 * ASSUMED: the whole-hour refusal is a RefusalError whose userMessage is exactly "<label> must be a whole hour from 0 to 23." and an out-of-bounds hour is the existing
 *   bounds sentence "<label> must be between 0 and 23." (R2: "the min and max still apply").
 * No lane DB name is used: the file runs on whatever `_test` database TEST_DATABASE_URL names.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { setBusinessRule } from '@shareat/domain';
import { readPosRules } from '../../src/business-rules/pos-rules';
import { asOrg, attempt, auditCount, daysFromToday, putRule, ruleRows, ruleWorld, type RuleWorld } from './_fixtures/t512-rules';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const SC = 'pos.senior_pwd_discount_percent';
const HOUR = 'pos.business_day_start_hour';
const VAT = 'tax.vat_percent';
const TABLE = 'pos.table_warn_minutes';
const HOUR_LABEL = 'Hour a new POS business day starts (0–23)';
const TABLE_LABEL = 'Minutes before a table tile turns red';

const set = (w: RuleWorld, who: { personId: string; orgId: string }, input: { key: string; value: string; effectiveFrom: string; reason: string }) =>
  asOrg(w.orgId, (tx) => setBusinessRule(tx, who, input as never));
const read = (orgId: string, onDate: string) => asOrg(orgId, (tx) => readPosRules(tx, orgId, onDate));

/** Counts every statement a transaction sends to Postgres (postgres.js `unsafe` is what drizzle calls for each one). */
function queryCounter(tx: Tx): { count: () => number; stop: () => void } {
  const client = (tx as unknown as { session: { client: { unsafe: (...a: unknown[]) => unknown } } }).session.client;
  const original = client.unsafe;
  let n = 0;
  client.unsafe = function counted(this: unknown, ...a: unknown[]) {
    n += 1;
    return original.apply(client, a);
  };
  return { count: () => n, stop: () => void (client.unsafe = original) };
}

describe('T-539 readPosRules - the reader', () => {
  it('a fresh org (no rows) reads exactly { vat 1200n, senior/PWD 2000n, start hour 4, table warning 90 } [kills: an absent row read as zero; a wrong default; hour as bigint]', async () => {
    const w = await ruleWorld(sql, 'pos-fresh');
    const r = await read(w.orgId, '2026-11-06');
    expect(r).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(typeof r.businessDayStartHour).toBe('number');
    expect(typeof r.tableWarnMinutes).toBe('number');
    expect(Object.keys(r).sort()).toEqual(['businessDayStartHour', 'saleVarianceToleranceCentavos', 'scPwdPercentBasisPoints', 'tableWarnMinutes', 'vatPercentBasisPoints']);
  });

  it('after setBusinessRule(senior/PWD, 25, from 2026-12-01 equivalent) the day before reads 2000n and the start day reads 2500n; the other two stay [kills: a change applied early; a change applied late]', async () => {
    const w = await ruleWorld(sql, 'pos-dated');
    // The writer refuses a start day before today (Manila), so the 2026-12-01 of the spec is a day after today relative to the run; if the run is already past it, use today+1.
    const from = daysFromToday(1);
    const before = daysFromToday(0);
    await set(w, w.admin, { key: SC, value: '25', effectiveFrom: from, reason: 'Law changed' });
    expect(await read(w.orgId, before)).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(await read(w.orgId, from)).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2500n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(await read(w.orgId, daysFromToday(30))).toMatchObject({ scPwdPercentBasisPoints: 2500n });
  });

  it('the same dated read with the spec dates on raw rows: 2026-11-30 reads 2000n, 2026-12-01 reads 2500n [kills: < for <= at the start day]', async () => {
    const w = await ruleWorld(sql, 'pos-spec-dates');
    await putRule(sql, w.orgId, SC, '25.000000', '2026-12-01');
    expect((await read(w.orgId, '2026-11-30')).scPwdPercentBasisPoints).toBe(2000n);
    expect((await read(w.orgId, '2026-12-01')).scPwdPercentBasisPoints).toBe(2500n);
  });

  it('each of the three is dated on its own: VAT 11 from one day, hour 6 from another, senior/PWD untouched [kills: one row moving all three; a key read from the wrong row]', async () => {
    const w = await ruleWorld(sql, 'pos-each');
    await putRule(sql, w.orgId, VAT, '11.000000', '2026-12-01');
    await putRule(sql, w.orgId, HOUR, '6.000000', '2026-12-10');
    expect(await read(w.orgId, '2026-11-30')).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(await read(w.orgId, '2026-12-01')).toEqual({ vatPercentBasisPoints: 1100n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(await read(w.orgId, '2026-12-10')).toEqual({ vatPercentBasisPoints: 1100n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 6, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
  });

  it('S3: a dated change of the table warning: 90 before its start day, 30 from it; the other three stay [kills: a change applied early or late; tableWarnMinutes read from the wrong row]', async () => {
    const w = await ruleWorld(sql, 'pos-table-dated');
    const from = daysFromToday(1);
    await set(w, w.admin, { key: TABLE, value: '30', effectiveFrom: from, reason: 'Check on tables sooner' });
    expect(await read(w.orgId, daysFromToday(0))).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
    expect(await read(w.orgId, from)).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 30, saleVarianceToleranceCentavos: 1n });
    expect(await auditCount(sql, w.orgId)).toBe(1);
  });

  it('S3: the same dated read on raw rows: 2026-11-30 reads 90, 2026-12-01 reads 30 [kills: < for <= at the start day]', async () => {
    const w = await ruleWorld(sql, 'pos-table-spec-dates');
    await putRule(sql, w.orgId, TABLE, '30.000000', '2026-12-01');
    expect((await read(w.orgId, '2026-11-30')).tableWarnMinutes).toBe(90);
    expect((await read(w.orgId, '2026-12-01')).tableWarnMinutes).toBe(30);
  });

  it('S3: a stored 30.5 minutes (a row no writer would make) is refused at read, never rounded [kills: minutes truncated to 30]', async () => {
    const w = await ruleWorld(sql, 'pos-bad-minutes');
    await putRule(sql, w.orgId, TABLE, '30.500000', '2000-01-01');
    expect((await attempt(() => read(w.orgId, '2026-11-06'))).ok).toBe(false);
  });

  it('one org never reads another org\'s POS rows [kills: a read keyed on something other than the org]', async () => {
    const a = await ruleWorld(sql, 'pos-iso-a');
    const b = await ruleWorld(sql, 'pos-iso-b');
    await putRule(sql, b.orgId, SC, '30.000000', '2000-01-01');
    expect((await read(a.orgId, '2026-11-06')).scPwdPercentBasisPoints).toBe(2000n);
    expect((await read(b.orgId, '2026-11-06')).scPwdPercentBasisPoints).toBe(3000n);
  });

  it('a stored hour of 4.5 (a row no writer would make) is refused at read, never rounded [kills: an hour truncated to 4]', async () => {
    const w = await ruleWorld(sql, 'pos-bad-hour');
    await putRule(sql, w.orgId, HOUR, '4.500000', '2000-01-01');
    const r = await attempt(() => read(w.orgId, '2026-11-06'));
    expect(r.ok).toBe(false);
  });

  it('it costs ONE statement for all four rules [kills: a query per key]', async () => {
    const w = await ruleWorld(sql, 'pos-count');
    await putRule(sql, w.orgId, SC, '25.000000', '2026-12-01');
    const n = await asOrg(w.orgId, async (tx) => {
      const counter = queryCounter(tx);
      await readPosRules(tx, w.orgId, '2026-12-05');
      counter.stop();
      return counter.count();
    });
    expect(n).toBe(1);
  });
});

describe('T-539 setBusinessRule - the POS keys through the existing writer', () => {
  it('an admin may set the senior/PWD percent and the hour; both rows are written, audited, and read back [kills: a POS key the writer does not know]', async () => {
    const w = await ruleWorld(sql, 'pos-admin');
    const from = daysFromToday(1);
    await set(w, w.admin, { key: SC, value: '25', effectiveFrom: from, reason: 'Law changed' });
    await set(w, w.admin, { key: HOUR, value: '6', effectiveFrom: from, reason: 'Stores open later' });
    const rows = await ruleRows(sql, w.orgId);
    expect(rows.map((r) => [r.key, Number(r.value), r.effective_from, r.set_by, r.reason]).sort()).toEqual(
      [
        [HOUR, 6, from, w.admin.personId, 'Stores open later'],
        [SC, 25, from, w.admin.personId, 'Law changed'],
      ].sort(),
    );
    expect(await auditCount(sql, w.orgId)).toBe(2);
    expect(await read(w.orgId, from)).toEqual({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2500n, businessDayStartHour: 6, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n });
  });

  it('a whole hour is accepted at both ends: 0 and 23 [kills: an off-by-one on the hour bounds]', async () => {
    const w = await ruleWorld(sql, 'pos-hour-edges');
    await set(w, w.admin, { key: HOUR, value: '0', effectiveFrom: daysFromToday(1), reason: 'Midnight' });
    await set(w, w.admin, { key: HOUR, value: '23', effectiveFrom: daysFromToday(2), reason: 'Late' });
    expect((await read(w.orgId, daysFromToday(1))).businessDayStartHour).toBe(0);
    expect((await read(w.orgId, daysFromToday(2))).businessDayStartHour).toBe(23);
  });

  it('an hour of 4.5 is refused with the whole-hour sentence, and nothing is written [kills: a fraction of an hour stored; a hour() that would throw on every later bill]', async () => {
    const w = await ruleWorld(sql, 'pos-hour-frac');
    for (const value of ['4.5', '4.25', '23.5']) {
      const r = await attempt(() => set(w, w.admin, { key: HOUR, value, effectiveFrom: daysFromToday(1), reason: 'half hour' }));
      expect(r.ok, `${value} was accepted`).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).toBe(`${HOUR_LABEL} must be a whole hour from 0 to 23.`);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
  });

  it('an hour of 24, 25 or 99 is refused by the bounds, with the bounds sentence, and nothing is written [kills: an hour past 23]', async () => {
    const w = await ruleWorld(sql, 'pos-hour-bounds');
    for (const value of ['24', '25', '99']) {
      const r = await attempt(() => set(w, w.admin, { key: HOUR, value, effectiveFrom: daysFromToday(1), reason: 'out of range' }));
      expect(r.ok, `${value} was accepted`).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBeInstanceOf(RefusalError);
      const say = (r.error as RefusalError).userMessage;
      expect(say).toBe(`${HOUR_LABEL} must be between 0 and 23.`);
      expect(say).not.toContain('whole hour');
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
  });

  it('the senior/PWD percent keeps the percent bounds: 100 and 0 are accepted, 100.01 and -0.01 are refused [kills: a percent bound of 99 or 101]', async () => {
    const w = await ruleWorld(sql, 'pos-sc-bounds');
    await set(w, w.admin, { key: SC, value: '100', effectiveFrom: daysFromToday(1), reason: 'Max' });
    await set(w, w.admin, { key: SC, value: '0', effectiveFrom: daysFromToday(2), reason: 'Min' });
    const r = await attempt(() => set(w, w.admin, { key: SC, value: '100.01', effectiveFrom: daysFromToday(1), reason: 'bad' }));
    expect(r.ok, '100.01 was accepted').toBe(false);
    if (!r.ok) expect((r.error as RefusalError).userMessage).toBe('Senior citizen and PWD discount (%) must be between 0 and 100.');
    const neg = await attempt(() => set(w, w.admin, { key: SC, value: '-0.01', effectiveFrom: daysFromToday(1), reason: 'bad' }));
    expect(neg.ok, '-0.01 was accepted').toBe(false);
    expect(await ruleRows(sql, w.orgId)).toHaveLength(2);
  });

  it('a manager and a staff member are each refused for a POS key with AuthorizationError naming manage_business_rules, and nothing is written [kills: a POS key with a weaker gate]', async () => {
    const w = await ruleWorld(sql, 'pos-gate');
    for (const [who, actor] of [['manager', w.manager], ['staff', w.staff]] as const) {
      for (const key of [SC, HOUR]) {
        const r = await attempt(() => set(w, actor, { key, value: key === HOUR ? '6' : '25', effectiveFrom: daysFromToday(1), reason: 'try' }));
        expect(r.ok, `${who} could set ${key}`).toBe(false);
        if (r.ok) continue;
        expect(r.error, `${who} ${key}: refused, but not by authorize()`).toBeInstanceOf(AuthorizationError);
        expect((r.error as AuthorizationError).capability).toBe('manage_business_rules');
      }
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
  });

  it('S3: a whole number of minutes is accepted at both ends (1 and 600); 30.5 gets the whole-number sentence; 0, 601 and 9999 get the bounds sentence; nothing extra is written [kills: a fraction of a minute stored; an off-by-one on the bounds]', async () => {
    const w = await ruleWorld(sql, 'pos-minutes-writer');
    await set(w, w.admin, { key: TABLE, value: '1', effectiveFrom: daysFromToday(1), reason: 'Min' });
    await set(w, w.admin, { key: TABLE, value: '600', effectiveFrom: daysFromToday(2), reason: 'Max' });
    expect((await read(w.orgId, daysFromToday(1))).tableWarnMinutes).toBe(1);
    expect((await read(w.orgId, daysFromToday(2))).tableWarnMinutes).toBe(600);
    for (const value of ['30.5', '30.25']) {
      const r = await attempt(() => set(w, w.admin, { key: TABLE, value, effectiveFrom: daysFromToday(1), reason: 'half minute' }));
      expect(r.ok, `${value} was accepted`).toBe(false);
      if (!r.ok) expect((r.error as RefusalError).userMessage).toBe(`${TABLE_LABEL} must be a whole number of minutes.`);
    }
    for (const value of ['0', '601', '9999']) {
      const r = await attempt(() => set(w, w.admin, { key: TABLE, value, effectiveFrom: daysFromToday(1), reason: 'out of range' }));
      expect(r.ok, `${value} was accepted`).toBe(false);
      if (!r.ok) expect((r.error as RefusalError).userMessage).toBe(`${TABLE_LABEL} must be between 1 and 600.`);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(2);
  });

  it('S3: a manager and a staff member are refused for the table warning with AuthorizationError naming manage_business_rules [kills: the new key with a weaker gate]', async () => {
    const w = await ruleWorld(sql, 'pos-table-gate');
    for (const actor of [w.manager, w.staff]) {
      const r = await attempt(() => set(w, actor, { key: TABLE, value: '30', effectiveFrom: daysFromToday(1), reason: 'try' }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AuthorizationError);
        expect((r.error as AuthorizationError).capability).toBe('manage_business_rules');
      }
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
  });

  it('the gate still comes first for the hour: a staff member sending 4.5 gets the permission refusal, not the whole-hour sentence [kills: the hour check before authorize]', async () => {
    const w = await ruleWorld(sql, 'pos-gate-first');
    const r = await attempt(() => set(w, w.staff, { key: HOUR, value: '4.5', effectiveFrom: daysFromToday(1), reason: 'try' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AuthorizationError);
  });
});
