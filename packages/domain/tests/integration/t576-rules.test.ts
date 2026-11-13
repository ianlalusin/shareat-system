import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-576 (TESTER) - the rule `pos.require_pin_line_actions` (unit `flag`, org-wide, default 0 = off): the server's reader and the writer's bounds.
 *   - `readPosRules(...).requirePinLineActions` -> boolean, false by default, dated like every rule (it travels in the POS snapshot like saleVarianceTolerance);
 *   - the writer accepts 0 and 1 and refuses 2 and 0.5 with a plain sentence, writing nothing.
 *
 * RED NOW: the registry has no such key and PosRules has no such field.
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

const KEY = 'pos.require_pin_line_actions';
const set = (w: RuleWorld, input: { key: string; value: string; effectiveFrom: string; reason: string }) => asOrg(w.orgId, (tx) => setBusinessRule(tx, w.admin, input as never));
const read = (orgId: string, onDate: string) => asOrg(orgId, (tx) => readPosRules(tx, orgId, onDate)) as Promise<Awaited<ReturnType<typeof readPosRules>> & { requirePinLineActions: boolean }>;

describe('T-576 readPosRules - requirePinLineActions', () => {
  it('a fresh org (no rows) reads false, a plain boolean [kills: an absent row read as on; a number or text answer]', async () => {
    const w = await ruleWorld(sql, 'pin-fresh');
    const r = await read(w.orgId, '2026-11-06');
    expect(r.requirePinLineActions).toBe(false);
  });

  it('a dated change is read on its date: on from 2026-12-01 - 2026-11-30 reads false, 2026-12-01 reads true [kills: < for <= at the start day]', async () => {
    const w = await ruleWorld(sql, 'pin-dated');
    await putRule(sql, w.orgId, KEY, '1.000000', '2026-12-01');
    expect((await read(w.orgId, '2026-11-30')).requirePinLineActions).toBe(false);
    expect((await read(w.orgId, '2026-12-01')).requirePinLineActions).toBe(true);
  });

  it("one org never reads another org's switch [kills: a read keyed on something other than the org]", async () => {
    const a = await ruleWorld(sql, 'pin-iso-a');
    const b = await ruleWorld(sql, 'pin-iso-b');
    await putRule(sql, b.orgId, KEY, '1.000000', '2000-01-01');
    expect((await read(a.orgId, '2026-11-06')).requirePinLineActions).toBe(false);
    expect((await read(b.orgId, '2026-11-06')).requirePinLineActions).toBe(true);
  });
});

describe('T-576 writer - the flag unit accepts 0 and 1 only', () => {
  it('0 and 1 are accepted and stored [kills: a ceiling of 0; a floor of 1]', async () => {
    const w = await ruleWorld(sql, 'pin-ok');
    for (const v of ['1', '0']) await set(w, { key: KEY, value: v, effectiveFrom: daysFromToday(1), reason: `Set ${v}` });
    expect((await ruleRows(sql, w.orgId, KEY)).map((r) => Number(r.value)).sort()).toEqual([0, 1]);
  });

  it.each([['2'], ['0.5']])('%s is refused with a plain On/Off sentence and writes nothing [kills: a flag that takes any number between its bounds]', async (value) => {
    const w = await ruleWorld(sql, `pin-bad-${value}`);
    const r = await attempt(() => set(w, { key: KEY, value, effectiveFrom: daysFromToday(1), reason: 'Bad value' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).toMatch(/On or Off|between 0 and 1/);
    }
    expect(await ruleRows(sql, w.orgId, KEY)).toHaveLength(0);
  });
});
