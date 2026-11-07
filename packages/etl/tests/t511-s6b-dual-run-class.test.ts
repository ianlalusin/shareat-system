/**
 * T-511 S6b (TESTER, 7 Nov 2026) - the dual-run class `PLATFORM_FILE_CORRECTION`: the rule-assigned class for a v2 correcting entry that moves a platform day's
 * sales and receivable to the platform file figure. Design decision 17, BOSS ruling 5: "Dual-run gets the rule-assigned class 'platform file correction', which
 * must exist before any correction posts". Pure; no database. The class CHECK in migration 0243 is `packages/db/tests/integration/t511-s6b-migration.test.ts`;
 * the v2 reader that re-dates and flags the documents is `packages/domain/tests/integration/t511-s6b-readers.test.ts`.
 *
 * RED TODAY: `CLASS_CATALOGUE` has no such code and `compareStoreWeek` cannot assign it.
 *
 * PINNED (the spec says only "catalogue entry ... assignment rule in compare.ts ~:286"; builder meets these or asks BOSS to change the tests):
 *  K1  `CLASS_CATALOGUE.PLATFORM_FILE_CORRECTION` = { family: 'policy', meaning, authority } (policy: explained, never a blocker, like V2_ONLY_EVENT). It is NOT a
 *      disposition class (a person still assigns only V1_DEFECT / V2_DEFECT).
 *  K2  `CompareDoc` gains `platformCorrection?: boolean`. A POSTED v2 document with it set, on a line whose delta is non-zero, is explained by an item
 *      { class: 'PLATFORM_FILE_CORRECTION', paired: false, amount: the document's in-week contribution, v2Id: the document }. Flag absent = no such item
 *      (a class is never derived from the shape or size of a document).
 *  K3  whatever the flagged documents do not explain stays its own UNEXPLAINED item, and the line then blocks (class UNEXPLAINED, verdict open).
 *  K4  it composes with the ordinary passes: the day's own document still pairs EXACT with its v1 twin first, the correction explains only the remainder.
 */
import { describe, expect, it } from 'vitest';
import { CLASS_CATALOGUE, DISPOSITION_CLASSES } from '../src/dual-run/classes';
import { compareStoreWeek } from '../src/dual-run/compare';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const WEEK = '2026-10-19';
const D = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;
const sum = (days: Record<string, number>): number => Object.values(days).reduce((a, b) => a + b, 0);
const line = (kind: string, key: string, days: Record<string, number>): Any => ({ kind, key, amount: sum(days), days });
const doc = (id: string, key: string, date: string, amount: number, extra: Any = {}): Any => ({ id, kind: 'sales_tender', key, date, amount, state: 'posted', ...extra });
const ln = (r: Any, key: string): Any => {
  const l = r.lines.find((x: Any) => x.kind === 'sales_tender' && x.key === key);
  if (!l) throw new Error(`no result line ${key}; have ${r.lines.map((x: Any) => `${x.kind}/${x.key}`).join(', ')}`);
  return l;
};

/** One channel line: v1 holds the staff figure on D(20); v2 holds `v2Cents` (the corrected figure); plus one tied cash day so a COMPARED day exists. */
function week(v1Cents: number, v2Cents: number, v2Docs: Any[]): Any {
  const wd = D(21);
  return compareStoreWeek({
    orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, through: '2026-10-25',
    v1: { lines: [line('sales_tender', 'chan__fp', { [D(20)]: v1Cents }), line('cash_bank', 'wd-v1', { [wd]: 1000 })], tradingDays: [D(20), wd], cashResidual: {}, scope: [] },
    v2: { lines: [line('sales_tender', 'chan-fp', { [D(20)]: v2Cents }), line('cash_bank', 'wd-v2', { [wd]: 1000 })], tradingDays: [D(20), wd] },
    keyMap: { 'sales_tender|chan__fp': 'chan-fp', 'cash_bank|wd-v1': 'wd-v2' },
    v1Docs: [doc('a', 'chan__fp', D(20), v1Cents)],
    v2Docs,
    dispositions: [],
  } as Any);
}

describe('T-511 S6b - the class is in the closed catalogue', () => {
  it('PLATFORM_FILE_CORRECTION is a policy class with a meaning and an authority, and not a class a person may assign [kills: a missing entry; a blocking family; a person-assignable class]', () => {
    const c = (CLASS_CATALOGUE as Any).PLATFORM_FILE_CORRECTION;
    expect(c, 'catalogue is missing PLATFORM_FILE_CORRECTION').toBeDefined();
    expect(c.family).toBe('policy');
    expect(String(c.meaning).length).toBeGreaterThan(5);
    expect(String(c.authority).length).toBeGreaterThan(2);
    expect([...DISPOSITION_CLASSES].sort()).toEqual(['V1_DEFECT', 'V2_DEFECT']);
  });
});

describe('T-511 S6b - the comparator assigns it by rule', () => {
  it('staff 11,000.00 in v1, v2 corrected to 10,000.00 by a flagged correction document: the line is PLATFORM_FILE_CORRECTION for the whole -1,000.00, unpaired, and the week is explained [kills: no rule (UNEXPLAINED, blocks sign-off); a paired item; a wrong amount]', () => {
    const r = week(1100000, 1000000, [doc('s', 'chan-fp', D(20), 1100000), doc('c', 'chan-fp', D(20), -100000, { platformCorrection: true })]);
    const l = ln(r, 'chan-fp');
    expect([l.class, l.family, l.delta]).toEqual(['PLATFORM_FILE_CORRECTION', 'policy', -100000]);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ class: 'PLATFORM_FILE_CORRECTION', paired: false, amount: -100000, v2Id: 'c' });
    expect(r.verdict).toBe('explained');
  });

  it('file higher (v1 9,000.00, v2 10,000.00): the item is +1,000.00 [kills: an absolute value; a negative-only rule]', () => {
    const r = week(900000, 1000000, [doc('s', 'chan-fp', D(20), 900000), doc('c', 'chan-fp', D(20), 100000, { platformCorrection: true })]);
    const l = ln(r, 'chan-fp');
    expect([l.class, l.delta]).toEqual(['PLATFORM_FILE_CORRECTION', 100000]);
    expect(l.items[0]).toMatchObject({ class: 'PLATFORM_FILE_CORRECTION', amount: 100000 });
    expect(r.verdict).toBe('explained');
  });

  it('the same -1,000.00 document WITHOUT the flag is UNEXPLAINED and the week is open: a class is never guessed from a document\'s shape [kills: a rule that fires on any v2-only negative document]', () => {
    const r = week(1100000, 1000000, [doc('s', 'chan-fp', D(20), 1100000), doc('c', 'chan-fp', D(20), -100000)]);
    const l = ln(r, 'chan-fp');
    expect(l.class).toBe('UNEXPLAINED');
    expect(l.items.map((i: Any) => i.class)).not.toContain('PLATFORM_FILE_CORRECTION');
    expect(r.verdict).toBe('open');
  });

  it('a delta bigger than the flagged documents (-1,500.00 against a flagged -1,000.00): the correction explains its own -1,000.00 and the rest is its own UNEXPLAINED item; the line blocks [kills: a rule that swallows the whole delta]', () => {
    const r = week(1100000, 950000, [doc('s', 'chan-fp', D(20), 1100000), doc('c', 'chan-fp', D(20), -100000, { platformCorrection: true })]);
    const l = ln(r, 'chan-fp');
    expect(l.class).toBe('UNEXPLAINED');
    const byClass = Object.fromEntries(l.items.map((i: Any) => [i.class, i.amount]));
    expect(byClass).toEqual({ PLATFORM_FILE_CORRECTION: -100000, UNEXPLAINED: -50000 });
    expect(r.verdict).toBe('open');
  });

  it('a tied line is untouched: v1 11,000.00 = v2 11,000.00 stays TIES [kills: matching running on a tied line]', () => {
    const r = week(1100000, 1100000, [doc('s', 'chan-fp', D(20), 1100000)]);
    expect(ln(r, 'chan-fp').class).toBe('TIES');
  });
});
