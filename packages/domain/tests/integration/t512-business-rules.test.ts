import { config } from 'dotenv';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-512 (T-511 S5c) TESTER - the business-rule reader and writer on a REAL Postgres (a `_test` database via TEST_DATABASE_URL).
 * docs/tasks/512-business-rules-s5c-spec.md "Reader and writer", "Capability, audit, screen".
 *
 * RED today: `ruleValue`, `loadRuleBook`, `setBusinessRule` and `listBusinessRules` are not exported by @shareat/domain, and the table does not exist.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - `setBusinessRule` returns anything (not asserted); it refuses with AuthorizationError (capability manage_business_rules) when the actor lacks the right, and with a RefusalError
 *     (plain `userMessage`, no key, no UUID, no SQL words) for every bad input; the capability gate comes FIRST (a staff member sending a bad value gets the permission refusal).
 *   - a money value must be a whole number of centavos (at most 2 decimals) and a percent a whole number of basis points (at most 2 decimals): 50.005 and 0.505 are refused.
 *   - the registry bounds are inclusive: min and max themselves are accepted, a cent/hundredth beyond them refused.
 *   - `effectiveFrom` equal to Manila's today is accepted (applies from today), earlier is "backdating" and refused, malformed is refused.
 *   - the audit row's payload (before and after together) carries the key, the old value, the new value, the effective date and the reason as scalar values.
 *   - `listBusinessRules(tx, actor)` is gated by the same capability, and returns either an array of items or an object keyed by rule key; each item has label, unit, current,
 *     scheduled[] (rows whose effective_from is after today) and history[] (every row, who/when/from-date/reason). `current` is a value or an object with `text` or `value`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { listBusinessRules, loadRuleBook, ruleValue, setBusinessRule } from '@shareat/domain';
import { RULE_REGISTRY, type BusinessRuleKey } from '../../src/business-rules/registry';
import { asOrg, attempt, auditCount, daysFromToday, foreignAdmin, hasNumber, putRule, ruleRows, ruleWorld, scalars, tieId, today, type RuleWorld } from './_fixtures/t512-rules';
import { auditRows } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 6 });
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const FLOOR: BusinessRuleKey = 'settlement.variance_floor_amount';
const PERCENT: BusinessRuleKey = 'settlement.variance_percent';
const LOAN: BusinessRuleKey = 'settlement.loan_final_tolerance';
const WITHHOLDING: BusinessRuleKey = 'tax.withholding_rate_percent';
const VAT: BusinessRuleKey = 'tax.vat_percent';
const KEYS = Object.keys(RULE_REGISTRY) as BusinessRuleKey[];

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

const set = (w: RuleWorld, who: { personId: string; orgId: string }, input: { key: string; value: string; effectiveFrom: string; reason: string }) =>
  asOrg(w.orgId, (tx) => setBusinessRule(tx, who, input as never));
const valueOn = (orgId: string, key: BusinessRuleKey, date: string) => asOrg(orgId, (tx) => ruleValue(tx, orgId, key, date));

/* ================================================================== the reader */

describe('T-512 reader - ruleValue and loadRuleBook on real rows', () => {
  it('an org with no rows reads the registry defaults, as exact bigints [kills: an absent row read as zero]', async () => {
    const w = await ruleWorld(sql, 'rd-empty');
    const v = (k: BusinessRuleKey) => valueOn(w.orgId, k, '2026-11-06');
    expect((await v(FLOOR)).centavos()).toBe(5000n);
    expect((await v(PERCENT)).basisPoints()).toBe(1000n);
    expect((await v(LOAN)).centavos()).toBe(1n);
    expect((await v(WITHHOLDING)).basisPoints()).toBe(50n);
    expect((await v(VAT)).basisPoints()).toBe(1200n);
  });

  it('the row with the latest effective_from on or before the date wins; the start day is already its day; a future row is unused [kills: oldest wins; < for <=; early read of a scheduled change]', async () => {
    const w = await ruleWorld(sql, 'rd-resolve');
    await putRule(sql, w.orgId, FLOOR, '50.000000', '2000-01-01');
    await putRule(sql, w.orgId, FLOOR, '80.000000', '2026-12-01');
    await putRule(sql, w.orgId, FLOOR, '120.000000', '2027-03-01');
    const at = async (d: string) => (await valueOn(w.orgId, FLOOR, d)).centavos();
    expect(await at('2026-11-30')).toBe(5000n);
    expect(await at('2026-12-01')).toBe(8000n);
    expect(await at('2027-02-28')).toBe(8000n);
    expect(await at('2027-03-01')).toBe(12000n);
    expect(await at('2001-01-01')).toBe(5000n);
    // a rule with ONLY a future row still answers the default before it starts
    await putRule(sql, w.orgId, PERCENT, '25.000000', '2026-12-01');
    expect((await valueOn(w.orgId, PERCENT, '2026-11-30')).basisPoints()).toBe(1000n);
    expect((await valueOn(w.orgId, PERCENT, '2026-12-01')).basisPoints()).toBe(2500n);
  });

  it('same effective_from: the later created_at wins; same instant: the greater id wins; a later date beats a later created_at [kills: unstable ties]', async () => {
    const w = await ruleWorld(sql, 'rd-ties');
    await putRule(sql, w.orgId, FLOOR, '80.000000', '2026-12-01', { at: '2026-11-06T01:00:00Z', id: tieId('ffffffff') });
    await putRule(sql, w.orgId, FLOOR, '95.000000', '2026-12-01', { at: '2026-11-06T02:00:00Z', id: tieId('00000000') });
    expect((await valueOn(w.orgId, FLOOR, '2026-12-01')).centavos()).toBe(9500n);
    await putRule(sql, w.orgId, VAT, '11.000000', '2026-12-01', { at: '2026-11-06T01:00:00Z', id: tieId('00000000aa') });
    await putRule(sql, w.orgId, VAT, '13.000000', '2026-12-01', { at: '2026-11-06T01:00:00Z', id: tieId('00000000bb') });
    expect((await valueOn(w.orgId, VAT, '2026-12-05')).basisPoints()).toBe(1300n);
    await putRule(sql, w.orgId, LOAN, '0.050000', '2026-12-01', { at: '2026-11-09T00:00:00Z' });
    await putRule(sql, w.orgId, LOAN, '0.020000', '2026-12-10', { at: '2026-11-01T00:00:00Z' });
    expect((await valueOn(w.orgId, LOAN, '2026-12-12')).centavos()).toBe(2n);
    expect((await valueOn(w.orgId, LOAN, '2026-12-05')).centavos()).toBe(5n);
  });

  it('loadRuleBook costs ONE query for all five keys, and asking the book for any date costs none [kills: a query per key or per date; keeps listReviewDays flat]', async () => {
    const w = await ruleWorld(sql, 'rd-count');
    await putRule(sql, w.orgId, FLOOR, '80.000000', '2026-12-01');
    const out = await asOrg(w.orgId, async (tx) => {
      const counter = queryCounter(tx);
      const book = await loadRuleBook(tx, w.orgId, KEYS);
      const afterLoad = counter.count();
      const answers = [];
      for (let d = 1; d <= 28; d++) for (const k of KEYS) answers.push(book.valueOn(k, `2026-12-${String(d).padStart(2, '0')}`).text);
      const total = counter.count();
      counter.stop();
      return { afterLoad, total, answers: answers.length };
    });
    expect(out.afterLoad).toBe(1);
    expect(out.total).toBe(1);
    expect(out.answers).toBe(28 * 5);
  });

  it('the book agrees with ruleValue for every key and a spread of dates', async () => {
    const w = await ruleWorld(sql, 'rd-agree');
    await putRule(sql, w.orgId, FLOOR, '80.000000', '2026-12-01');
    await putRule(sql, w.orgId, WITHHOLDING, '1.000000', '2026-12-15');
    const book = await asOrg(w.orgId, (tx) => loadRuleBook(tx, w.orgId, KEYS));
    for (const d of ['2026-11-30', '2026-12-01', '2026-12-14', '2026-12-15', '2027-06-01']) {
      for (const k of KEYS) expect(book.valueOn(k, d).text, `${k} ${d}`).toBe((await valueOn(w.orgId, k, d)).text);
    }
  });

  it('org isolation: another org\'s rows never answer, and RLS hides them even when the other org\'s id is passed in [kills: a reader that trusts its org argument alone]', async () => {
    const a = await ruleWorld(sql, 'rd-iso-a');
    const b = await ruleWorld(sql, 'rd-iso-b');
    await putRule(sql, b.orgId, FLOOR, '999.000000', '2000-01-01');
    expect((await valueOn(a.orgId, FLOOR, '2026-11-06')).centavos()).toBe(5000n);
    expect((await asOrg(a.orgId, (tx) => ruleValue(tx, b.orgId, FLOOR, '2026-11-06'))).centavos(), 'read B through A\'s principal').toBe(5000n);
    expect((await valueOn(b.orgId, FLOOR, '2026-11-06')).centavos()).toBe(99900n);
  });
});

/* ================================================================== the writer: who may */

describe('T-512 writer - setBusinessRule: the capability (manage_business_rules, admin only)', () => {
  it('an admin may: one row is written with the key, value, date, reason and who set it; it applies from its date, not before [kills: a write that is applied at once]', async () => {
    const w = await ruleWorld(sql, 'wr-admin');
    const tomorrow = daysFromToday(1);
    await set(w, w.admin, { key: FLOOR, value: '80.00', effectiveFrom: tomorrow, reason: 'Ian approved, 6 Nov' });
    const rows = await ruleRows(sql, w.orgId, FLOOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: FLOOR, effective_from: tomorrow, set_by: w.admin.personId, reason: 'Ian approved, 6 Nov' });
    expect(Number(rows[0]!.value)).toBe(80);
    expect((await valueOn(w.orgId, FLOOR, tomorrow)).centavos()).toBe(8000n);
    expect((await valueOn(w.orgId, FLOOR, today())).centavos(), 'today is still the old figure').toBe(5000n);
  });

  it('a manager, a staff member, and a person who is not in the org are each refused with AuthorizationError naming manage_business_rules, and NOTHING is written (no rule row, no audit row) [kills: manager allowed; staff allowed; a write before the gate]', async () => {
    const w = await ruleWorld(sql, 'wr-gate');
    const outsider = await foreignAdmin(sql, 'wr-gate');
    const cases: [string, { personId: string; orgId: string }][] = [
      ['manager', w.manager],
      ['staff', w.staff],
      ['a person of another org acting in this org', { personId: outsider.personId, orgId: w.orgId }],
    ];
    for (const [who, actor] of cases) {
      const before = { rules: (await ruleRows(sql, w.orgId)).length, audit: await auditCount(sql, w.orgId) };
      const r = await attempt(() => set(w, actor, { key: FLOOR, value: '80.00', effectiveFrom: daysFromToday(1), reason: 'try' }));
      expect(r.ok, `${who}: the call was NOT refused`).toBe(false);
      if (r.ok) continue;
      expect(r.error, `${who}: refused, but not by authorize() (${r.error.message})`).toBeInstanceOf(AuthorizationError);
      expect((r.error as AuthorizationError).capability).toBe('manage_business_rules');
      expect((await ruleRows(sql, w.orgId)).length, `${who}: a refused call wrote a rule row`).toBe(before.rules);
      expect(await auditCount(sql, w.orgId), `${who}: a refused call wrote an audit row`).toBe(before.audit);
    }
  });

  it('the gate comes before the data: a staff member sending an out-of-bounds value and no reason still gets the permission refusal [kills: field rules before authorize]', async () => {
    const w = await ruleWorld(sql, 'wr-gate-first');
    const r = await attempt(() => set(w, w.staff, { key: FLOOR, value: '-5', effectiveFrom: '2000-01-01', reason: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AuthorizationError);
  });

  it('an admin of ANOTHER org cannot reach this org: acting in its own org it writes only there, and this org stays untouched [kills: a write keyed on something other than the actor\'s org]', async () => {
    const a = await ruleWorld(sql, 'wr-iso-a');
    const b = await ruleWorld(sql, 'wr-iso-b');
    await set(b, b.admin, { key: VAT, value: '10', effectiveFrom: daysFromToday(1), reason: 'franchise rate' });
    expect(await ruleRows(sql, a.orgId)).toHaveLength(0);
    expect(await ruleRows(sql, b.orgId)).toHaveLength(1);
    expect((await valueOn(a.orgId, VAT, daysFromToday(2))).basisPoints()).toBe(1200n);
    // and B's admin, put under A's principal, writes nothing anywhere
    const r = await attempt(() => asOrg(a.orgId, (tx) => setBusinessRule(tx, b.admin, { key: VAT, value: '9', effectiveFrom: daysFromToday(1), reason: 'cross' } as never)));
    expect(r.ok).toBe(false);
    expect(await ruleRows(sql, a.orgId)).toHaveLength(0);
    expect(await ruleRows(sql, b.orgId)).toHaveLength(1);
  });
});

/* ================================================================== the writer: what */

describe('T-512 writer - bounds, formats and the reason', () => {
  it('each key: a hundredth below its minimum and above its maximum is refused with a plain sentence; the minimum and the maximum themselves are accepted [kills: unbounded; off-by-one on a bound]', async () => {
    const w = await ruleWorld(sql, 'wr-bounds');
    for (const key of KEYS) {
      const { min, max } = RULE_REGISTRY[key] as { min: unknown; max: unknown };
      const below = '-0.01';
      const above = (Number(max) + 0.01).toFixed(2);
      for (const bad of [below, above]) {
        const before = (await ruleRows(sql, w.orgId)).length;
        const r = await attempt(() => set(w, w.admin, { key, value: bad, effectiveFrom: daysFromToday(1), reason: 'bounds' }));
        expect(r.ok, `${key} ${bad} was accepted`).toBe(false);
        if (r.ok) continue;
        expect(r.error, `${key} ${bad}`).toBeInstanceOf(RefusalError);
        const say = (r.error as RefusalError).userMessage;
        expect(say, `${key}: a plain sentence`).toMatch(/^[A-Z][^]*[.!?]$/);
        expect(say, `${key}: no raw key`).not.toContain(key);
        expect(say, `${key}: no UUID or SQL`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|violates|constraint|numeric|relation "/i);
        expect((await ruleRows(sql, w.orgId)).length, `${key}: a refused value was written`).toBe(before);
      }
      await set(w, w.admin, { key, value: String(min), effectiveFrom: daysFromToday(1), reason: 'at the minimum' });
      await set(w, w.admin, { key, value: String(max), effectiveFrom: daysFromToday(2), reason: 'at the maximum' });
      expect(Number((await ruleRows(sql, w.orgId, key)).at(-1)!.value)).toBe(Number(max));
    }
  });

  it('the spec figures: loan tolerance above 1.00, a percent above 100 and a floor above 100000.00 are refused', async () => {
    const w = await ruleWorld(sql, 'wr-spec-bounds');
    for (const [key, value] of [[LOAN, '1.01'], [PERCENT, '100.01'], [WITHHOLDING, '101'], [VAT, '150'], [FLOOR, '100000.01']] as const) {
      const r = await attempt(() => set(w, w.admin, { key, value, effectiveFrom: daysFromToday(1), reason: 'too big' }));
      expect(r.ok, `${key} ${value}`).toBe(false);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    await set(w, w.admin, { key: LOAN, value: '1.00', effectiveFrom: daysFromToday(1), reason: 'the most allowed' });
  });

  it('values that are not a plain decimal, or finer than a centavo or a hundredth of a percent, are refused; plain decimals are accepted [kills: parseFloat leniency; silent rounding]', async () => {
    const w = await ruleWorld(sql, 'wr-format');
    for (const value of ['', ' ', 'abc', '1e3', '5%', '1,000', 'NaN', 'Infinity', '0x10', '.', '1.2.3', '--5']) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value, effectiveFrom: daysFromToday(1), reason: 'format' }));
      expect(r.ok, `${JSON.stringify(value)} was accepted`).toBe(false);
    }
    for (const [key, value] of [[FLOOR, '50.005'], [LOAN, '0.005'], [PERCENT, '10.005'], [WITHHOLDING, '0.505']] as const) {
      const r = await attempt(() => set(w, w.admin, { key, value, effectiveFrom: daysFromToday(1), reason: 'too fine' }));
      expect(r.ok, `${key} ${value} was accepted`).toBe(false);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    await set(w, w.admin, { key: FLOOR, value: '80.5', effectiveFrom: daysFromToday(1), reason: 'one decimal' });
    await set(w, w.admin, { key: PERCENT, value: '12.25', effectiveFrom: daysFromToday(1), reason: 'two decimals' });
    expect((await valueOn(w.orgId, FLOOR, daysFromToday(1))).centavos()).toBe(8050n);
    expect((await valueOn(w.orgId, PERCENT, daysFromToday(1))).basisPoints()).toBe(1225n);
  });

  it('an unknown key is refused (a typo, and the prototype keys), and nothing is written [kills: a free-text key]', async () => {
    const w = await ruleWorld(sql, 'wr-key');
    for (const key of ['settlement.nothing', 'settlement.variance_floor', '', '__proto__', 'toString', 'payroll.deduction_cap_percent']) {
      const r = await attempt(() => set(w, w.admin, { key, value: '10', effectiveFrom: daysFromToday(1), reason: 'typo' }));
      expect(r.ok, `${JSON.stringify(key)} was accepted`).toBe(false);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
  });

  it('the reason is required and bounded: empty, blank and an enormous text are refused; nothing is written [kills: a change nobody explained; an unbounded audit text]', async () => {
    const w = await ruleWorld(sql, 'wr-reason');
    for (const reason of ['', '   ', '\n\t', 'x'.repeat(5000)]) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason }));
      expect(r.ok, `reason of ${reason.length} chars was accepted`).toBe(false);
      if (!r.ok) expect(r.error).not.toBeInstanceOf(AuthorizationError);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'Because the platform changed its fee' });
    expect(await ruleRows(sql, w.orgId)).toHaveLength(1);
  });
});

describe('T-512 writer - the reason refuses control characters and zero-width text (fixes)', () => {
  it('a reason with NUL or another control character is refused with a plain RefusalError, not a raw database error; nothing is written; a tab and a line break are fine [kills: PostgresError 22021 reaching the screen]', async () => {
    const w = await ruleWorld(sql, 'wr-ctrl');
    for (const reason of ['bad\u0000reason', 'bell\u0007here', 'esc\u001b[0m', 'del\u007f', 'c1\u0085x']) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason }));
      expect(r.ok, JSON.stringify(reason)).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(RefusalError);
        expect((r.error as RefusalError).userMessage).not.toMatch(/postgres|22021|byte sequence|sql/i);
      }
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'Line one\n\ttwo' });
    expect(await ruleRows(sql, w.orgId)).toHaveLength(1);
  });

  it('a reason made only of zero-width characters (U+200B..U+200D, U+FEFF) counts as blank and is refused; mixed with real words they are dropped from what is stored [kills: an invisible reason]', async () => {
    const w = await ruleWorld(sql, 'wr-zw');
    for (const reason of ['\u200b', '\u200b\u200c\u200d\ufeff', ' \u200b \ufeff\n']) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason }));
      expect(r.ok, JSON.stringify(reason)).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'Fee\u200b changed\ufeff' });
    const rows = await sql<{ reason: string }[]>`select reason from business_rule_values where org_id = ${w.orgId}`;
    expect(rows.map((r) => r.reason)).toEqual(['Fee changed']);
  });
});

describe('T-512 writer - dates: no backdating, Manila business date', () => {
  it('yesterday and long ago are refused as backdating, in a plain sentence; today and tomorrow are accepted [kills: a rule rewritten into the past]', async () => {
    const w = await ruleWorld(sql, 'wr-date');
    for (const d of [daysFromToday(-1), daysFromToday(-30), '2000-01-01']) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: d, reason: 'backdated' }));
      expect(r.ok, `${d} was accepted`).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(RefusalError);
        expect((r.error as RefusalError).userMessage).toMatch(/^[A-Z][^]*[.!?]$/);
      }
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: today(), reason: 'from today' });
    await set(w, w.admin, { key: PERCENT, value: '11', effectiveFrom: daysFromToday(1), reason: 'from tomorrow' });
    expect((await valueOn(w.orgId, FLOOR, today())).centavos()).toBe(8000n);
  });

  it('a malformed or impossible date is refused: 2026-13-40, 2026-02-30, "tomorrow", empty [kills: a date string passed to the database unchecked]', async () => {
    const w = await ruleWorld(sql, 'wr-date-bad');
    for (const d of ['2026-13-40', '2026-02-30', 'tomorrow', '', '06/11/2026', '2026-11-6']) {
      const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: d, reason: 'bad date' }));
      expect(r.ok, `${JSON.stringify(d)} was accepted`).toBe(false);
    }
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
  });

  it('"today" is the MANILA date, not the UTC date: at 01:00 on 7 Nov in Manila (17:00 UTC on 6 Nov) the 6th is the past and the 7th is today [kills: toISOString().slice(0, 10); t374 census]', async () => {
    const w = await ruleWorld(sql, 'wr-manila');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T17:00:00Z') });
    const r = await attempt(() => set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: '2026-11-06', reason: 'UTC today is the 6th' }));
    expect(r.ok, 'the 6th is already yesterday in Manila').toBe(false);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: '2026-11-07', reason: 'Manila today' });
    vi.useRealTimers();
    const rows = await ruleRows(sql, w.orgId);
    expect(rows.map((x) => x.effective_from)).toEqual(['2026-11-07']);
  });
});

/* ================================================================== the writer: the trail */

describe('T-512 writer - append-only history and the audit trail', () => {
  it('a same-day second change is a NEWER row and wins; the first row is kept [kills: update in place; first-write-wins]', async () => {
    const w = await ruleWorld(sql, 'wr-sameday');
    const d = daysFromToday(3);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: d, reason: 'first' });
    await set(w, w.admin, { key: FLOOR, value: '95', effectiveFrom: d, reason: 'correction' });
    const rows = await ruleRows(sql, w.orgId, FLOOR);
    expect(rows.map((r) => r.reason)).toEqual(['first', 'correction']);
    expect((await valueOn(w.orgId, FLOOR, d)).centavos()).toBe(9500n);
  });

  it('one audit row business_rule.changed per change, in the same transaction, with the key, old value, new value, effective date and reason; org scope (no store); the actor is the admin [kills: no audit; a missing field]', async () => {
    const w = await ruleWorld(sql, 'wr-audit');
    const d = daysFromToday(2);
    await set(w, w.admin, { key: FLOOR, value: '80.00', effectiveFrom: d, reason: 'Platform raised its minimum' });
    const rows = await auditRows(sql, w.orgId, 'business_rule.changed');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actor_person_id).toBe(w.admin.personId);
    expect(a.store_id).toBeNull();
    const all = [...scalars(a.before), ...scalars(a.after)];
    expect(all, 'the key').toContain(FLOOR);
    expect(all, 'the effective date').toContain(d);
    expect(all, 'the reason').toContain('Platform raised its minimum');
    expect(hasNumber(all, 80), 'the new value').toBe(true);
    expect(hasNumber(all, 50), 'the value in force before (the default 50)').toBe(true);
  });

  it('the audit write is in the SAME transaction: when the transaction fails after the call, neither the rule row nor the audit row remains [kills: an audit written on its own connection; a row written outside the tx]', async () => {
    const w = await ruleWorld(sql, 'wr-rollback');
    const boom = new Error('boom');
    const r = await attempt(() =>
      asOrg(w.orgId, async (tx) => {
        await setBusinessRule(tx, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'will roll back' } as never);
        throw boom;
      }),
    );
    expect(r.ok).toBe(false);
    expect(await ruleRows(sql, w.orgId)).toHaveLength(0);
    expect(await auditCount(sql, w.orgId)).toBe(0);
    await set(w, w.admin, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'goes through' });
    expect(await ruleRows(sql, w.orgId)).toHaveLength(1);
    expect(await auditCount(sql, w.orgId)).toBe(1);
  });

  it('a refused call leaves no audit row either (bounds, reason, date)', async () => {
    const w = await ruleWorld(sql, 'wr-no-audit');
    await attempt(() => set(w, w.admin, { key: FLOOR, value: '-1', effectiveFrom: daysFromToday(1), reason: 'x' }));
    await attempt(() => set(w, w.admin, { key: FLOOR, value: '1', effectiveFrom: daysFromToday(1), reason: '' }));
    await attempt(() => set(w, w.admin, { key: FLOOR, value: '1', effectiveFrom: daysFromToday(-1), reason: 'x' }));
    expect(await auditCount(sql, w.orgId)).toBe(0);
  });
});

/* ================================================================== the screen's read */

describe('T-512 listBusinessRules - what the screen shows', () => {
  type Item = { key: string; label: string; unit: string; current: unknown; scheduled: unknown[]; history: unknown[] };
  const itemsOf = (r: unknown): Item[] =>
    Array.isArray(r) ? (r as Item[]) : Object.entries(r as Record<string, Omit<Item, 'key'>>).map(([key, v]) => ({ key, ...v }));
  const textOf = (c: unknown): string => (typeof c === 'object' && c !== null ? String((c as { text?: unknown; value?: unknown }).text ?? (c as { value?: unknown }).value) : String(c));

  it('an admin gets all five rules with the registry label and unit, the value in force today, the scheduled changes and the history [kills: a screen that shows raw keys; a current value that ignores dates]', async () => {
    const w = await ruleWorld(sql, 'ls-admin');
    await putRule(sql, w.orgId, FLOOR, '50.000000', '2000-01-01', { reason: 'Starting value' });
    await putRule(sql, w.orgId, FLOOR, '70.000000', daysFromToday(-5), { setBy: w.admin.personId, reason: 'raised last week' });
    await putRule(sql, w.orgId, FLOOR, '90.000000', daysFromToday(10), { setBy: w.admin.personId, reason: 'scheduled raise' });
    const items = itemsOf(await asOrg(w.orgId, (tx) => listBusinessRules(tx, w.admin)));
    expect(items.map((i) => i.key).sort()).toEqual([...KEYS].sort());
    for (const i of items) {
      const reg = RULE_REGISTRY[i.key as BusinessRuleKey] as { label: string; unit: string };
      expect(i.label, i.key).toBe(reg.label);
      expect(i.unit, i.key).toBe(reg.unit);
      expect(Array.isArray(i.scheduled), `${i.key} scheduled`).toBe(true);
      expect(Array.isArray(i.history), `${i.key} history`).toBe(true);
    }
    const floor = items.find((i) => i.key === FLOOR)!;
    expect(Number(textOf(floor.current)), 'the value in force TODAY, not the latest row and not the scheduled one').toBe(70);
    expect(floor.scheduled).toHaveLength(1);
    expect(scalars(floor.scheduled)).toContain('scheduled raise');
    expect(floor.history.length).toBeGreaterThanOrEqual(2);
    expect(scalars(floor.history)).toContain('raised last week');
    const vat = items.find((i) => i.key === VAT)!;
    expect(Number(textOf(vat.current)), 'a rule with no row shows its default').toBe(12);
    expect(vat.scheduled).toHaveLength(0);
  });

  it('a manager and staff are refused with AuthorizationError naming manage_business_rules [kills: a read surface open to everyone]', async () => {
    const w = await ruleWorld(sql, 'ls-gate');
    for (const actor of [w.manager, w.staff]) {
      const r = await attempt(() => asOrg(w.orgId, (tx) => listBusinessRules(tx, actor)));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBeInstanceOf(AuthorizationError);
      expect((r.error as AuthorizationError).capability).toBe('manage_business_rules');
    }
  });

  it('another org\'s rows never appear in an org\'s list [kills: a list that reads every org]', async () => {
    const a = await ruleWorld(sql, 'ls-iso-a');
    const b = await ruleWorld(sql, 'ls-iso-b');
    await putRule(sql, b.orgId, FLOOR, '777.000000', daysFromToday(-1), { reason: 'only in B' });
    const items = itemsOf(await asOrg(a.orgId, (tx) => listBusinessRules(tx, a.admin)));
    expect(JSON.stringify(items)).not.toContain('only in B');
    expect(Number(textOf(items.find((i) => i.key === FLOOR)!.current))).toBe(50);
  });

  it('the sentence a refused write shows names no UUID or SQL (plain words only)', async () => {
    const w = await ruleWorld(sql, 'ls-plain');
    const r = await attempt(() => set(w, w.manager, { key: FLOOR, value: '80', effectiveFrom: daysFromToday(1), reason: 'x' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(((r.error as { userMessage?: string }).userMessage ?? '')).not.toMatch(/violates|constraint|relation "|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
