import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-575 (TESTER) - the rule `pos.senior_id_repeat_days`: the server's reader and the writer's bounds. Mirrors t558-rules.test.ts.
 *   - `readSeniorIdRepeatDays(tx, orgId, onDate)` (business-rules/pos-rules.ts) -> a whole number of days, default 1, dated like every rule;
 *   - the writer accepts 1..30 whole days and refuses 0, 31 and 2.5 with a plain sentence, writing nothing.
 *
 * RED NOW: the registry has no such key and pos-rules.ts has no such reader.
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
import * as posRules from '../../src/business-rules/pos-rules';
import { asOrg, attempt, daysFromToday, putRule, ruleRows, ruleWorld, type RuleWorld } from './_fixtures/t512-rules';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const KEY = 'pos.senior_id_repeat_days';
const set = (w: RuleWorld, input: { key: string; value: string; effectiveFrom: string; reason: string }) =>
  asOrg(w.orgId, (tx) => setBusinessRule(tx, w.admin, input as never));
const read = (orgId: string, onDate: string): Promise<number> => {
  const fn = (posRules as Record<string, unknown>).readSeniorIdRepeatDays;
  if (typeof fn !== 'function') throw new Error('MISSING EXPORT: readSeniorIdRepeatDays is not exported from business-rules/pos-rules.ts (T-575 not built).');
  return asOrg(orgId, (tx) => (fn as (t: unknown, o: string, d: string) => Promise<number>)(tx, orgId, onDate));
};

describe('T-575 readSeniorIdRepeatDays', () => {
  it('a fresh org (no rows) reads 1, a plain number [kills: an absent row read as zero; a bigint or text answer]', async () => {
    const w = await ruleWorld(sql, 'rep-fresh');
    const n = await read(w.orgId, '2026-11-06');
    expect(n).toBe(1);
    expect(typeof n).toBe('number');
  });

  it('a dated change is read on its date: 7 from 2026-12-01 - 2026-11-30 reads 1, 2026-12-01 reads 7 [kills: < for <= at the start day]', async () => {
    const w = await ruleWorld(sql, 'rep-dated');
    await putRule(sql, w.orgId, KEY, '7.000000', '2026-12-01');
    expect(await read(w.orgId, '2026-11-30')).toBe(1);
    expect(await read(w.orgId, '2026-12-01')).toBe(7);
  });

  it("one org never reads another org's window [kills: a read keyed on something other than the org]", async () => {
    const a = await ruleWorld(sql, 'rep-iso-a');
    const b = await ruleWorld(sql, 'rep-iso-b');
    await putRule(sql, b.orgId, KEY, '14.000000', '2000-01-01');
    expect(await read(a.orgId, '2026-11-06')).toBe(1);
    expect(await read(b.orgId, '2026-11-06')).toBe(14);
  });
});

describe('T-575 writer - whole days from 1 to 30', () => {
  it('7 and 30 and 1 are accepted and stored [kills: a ceiling below 30]', async () => {
    const w = await ruleWorld(sql, 'rep-ok');
    for (const v of ['7', '30', '1']) await set(w, { key: KEY, value: v, effectiveFrom: daysFromToday(1), reason: `Set ${v}` });
    expect((await ruleRows(sql, w.orgId, KEY)).map((r) => Number(r.value)).sort((a, b) => a - b)).toEqual([1, 7, 30]);
  });

  it.each([['0'], ['31'], ['2.5'], ['100']])('%s is refused with a plain sentence and writes nothing [kills: a window of 0 days (never warns); a fraction of a day; a window above 30]', async (value) => {
    const w = await ruleWorld(sql, `rep-bad-${value}`);
    const r = await attempt(() => set(w, { key: KEY, value, effectiveFrom: daysFromToday(1), reason: 'Bad value' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).toMatch(/days/i);
    }
    expect(await ruleRows(sql, w.orgId, KEY)).toHaveLength(0);
  });
});
