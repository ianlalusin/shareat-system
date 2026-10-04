import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — attendance module: every NUMERIC field of the store attendance config (the register's "11 attendance fields"), fed through
 * `supersedeConfig`. The field list is DERIVED from the schema (`constrainedColumns()` for `store_attendance_config`), never listed, so a new numeric field
 * is covered by itself. §S0 per-module NaN tests.
 *
 * `supersedeConfig` already parses `changes` with `parseConfigChanges` (T-352), so the typed-garbage legs are GUARDS (green today) that must stay green
 * once `attendanceConfigRepo.insertConfig` (which spreads the whole live row: `...stripLifecycle(live), ...changes`) is branded. Each leg asserts a plain
 * sentence quoting the typed value, ZERO new config rows and the live row still live, then a valid change succeeds.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { seedAttendanceConfig, supersedeConfig } from '@shareat/domain';
import { constrainedColumns } from '../../../../tests/unit/lib/numeric-write-census';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** The key's own words ("holidaySpecialNonWorkingMultiplier" -> holiday, special, non, working, multiplier): a generic sentence cannot pass 11 x 2 legs. */
const wordsOf = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ').filter((w) => w.length >= 3);
const namesField = (key: string) => {
  const words = wordsOf(key);
  const need = Math.min(2, words.length);
  return new RegExp(`^(?=(?:.*\\b(?:${words.join('|')})\\b){${need}})`, 'i');
};

const keys = constrainedColumns().filter((c) => c.table === 'store_attendance_config').map((c) => c.key).sort();
const liveRows = async (storeId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from store_attendance_config where store_id = ${storeId} and superseded_at is null`)[0]!.n);

async function fixture(hint: string) {
  const k = await bootstrap(sql, hint);
  await asOrg(k.orgId, (tx) => seedAttendanceConfig(tx, { orgId: k.orgId, storeId: k.storeId, effectiveFrom: '2026-01-01' }));
  return k;
}

describe('attendance — the numeric fields are derived from the schema', () => {
  it('floor: the schema has numeric attendance-config columns', () => {
    expect(keys.length, 'no numeric attendance column was derived').toBeGreaterThan(0);
  });
});

describe.each(keys)('attendance — %s', (key) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it; no new config row; the live row is still live; a later valid change succeeds`, async () => {
      const k = await fixture(`at-${key}-${typed}`);
      const before = await count(sql, 'store_attendance_config', k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => supersedeConfig(tx, k.admin, { storeId: k.storeId, effectiveFrom: '2026-06-01', changes: { [key]: typed } as never })));
      expectPlainRefusal(got, typed, namesField(key), `supersedeConfig.${key}`);
      expect(await count(sql, 'store_attendance_config', k.orgId), 'a refused change wrote a config row').toBe(before);
      expect(await liveRows(k.storeId), 'the live config is no longer the single live row').toBe(1);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => supersedeConfig(tx, k.admin, { storeId: k.storeId, effectiveFrom: '2026-06-01', changes: { requiredHoursPerShift: '8' } as never })));
      expect(ok.text, `the control (a valid change) was refused: ${ok.text}`).toBeNull();
      expect(await count(sql, 'store_attendance_config', k.orgId)).toBe(before + 1);
      const [live] = await sql<{ v: string }[]>`select required_hours_per_shift::text as v from store_attendance_config where store_id = ${k.storeId} and superseded_at is null`;
      expect(live?.v, 'a valid hours value reads back byte-identical on the live row (numeric(4,2))').toBe('8.00');
    });
  }
});
