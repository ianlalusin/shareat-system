/**
 * T-392 S2 (TESTER) - class catalogue, candidate matching, per-day states, verdict, fingerprints
 * (pure; docs/tasks/392-dual-run-comparator.md, invariants 11-20 plus the R10 disposition restriction).
 *
 * The spec names files and invariants but no signatures, so THIS FILE PINS THEM. Builder: match these exactly or
 * report the one you cannot (do not reshape the tests). v2 figures come from S3 (not built): they are plain objects
 * here. Everything lives under packages/etl/src/dual-run/. Money is INTEGER CENTAVOS. delta = v2 - v1 everywhere.
 *
 *  classes.ts   CLASS_CATALOGUE: Record<code, { family, meaning, authority }>   (closed, R11; meaning/authority non-empty)
 *               families: tie | policy | timing | encoder | defect | scope | open
 *               codes: every code of the spec table plus V1_REMITTED_FIELD_ZERO, V1_UNKNOWN_EXPENSE_GROUP,
 *               V1_EXPENSE_ENTRY_GROUP_CONFLICT (the S1 flags); see the first test
 *               DISPOSITION_CLASSES = ['V1_DEFECT', 'V2_DEFECT']
 *  compare.ts   compareStoreWeek(input) -> StoreWeekResult
 *    input = { orgId, storeId, weekStart, through,
 *      v1: { lines: V1Line[], tradingDays: string[], cashResidual: Record<date, number>, scope?: ScopeEntry[] }   (S1 shapes)
 *      v2: { lines: V2Line[], tradingDays: string[] }   V2Line = { kind, key, amount, days: Record<date, number> }
 *      keyMap: Record<`${kind}|${v1Key}`, v2Key>   v1 key -> v2 key (keys sheet / v1_master_links). Absent => UNMAPPED_KEY
 *      v1Docs, v2Docs: Doc[]  all documents in the window [weekStart-7, through+7], inside OR outside the week.
 *        Doc = { id, kind, key, date, amount, state: 'posted' | 'unposted', receiptId?, correctionOf? }   (a v1 doc's key
 *        is the v1 key, mapped through keyMap exactly as lines are). Only 'posted' docs are inside the line figures; an
 *        'unposted' doc contributes nothing to a figure and exists only to explain it (PENDING_*).
 *      dispositions: Disposition[]  Disposition = { orgId, storeId, weekStart, kind, lineKey, deltaAt, class, ref,
 *        createdAt }   (latest createdAt wins; stored dispositions are appended, never edited) }
 *    StoreWeekResult = { storeId, weekStart, through, verdict: 'no_data'|'ties'|'explained'|'open',
 *      comparedDays: string[] (dates), matchRuns: number (lines on which candidate matching ran),
 *      lines: ResultLine[], v1Fingerprint, v2Fingerprint (sha256 hex over that side's SORTED figures and docs) }
 *    ResultLine = { kind, key, v1, v2, delta, class, family, paired: boolean, reCheck: boolean,
 *      items: { class, paired, amount, v1Id?, v2Id? }[], days: { date, v1, v2, delta, state: 'tied'|'classed'|'open' }[] }
 *      key = the v2 key when mapped, else `v1:<v1Key>` (UNMAPPED_KEY; never merged into another key). Every v1 or v2 line
 *      appears; a side with no figure shows 0 (never dropped). class = TIES when delta 0; the single class of items when
 *      all items share one; UNEXPLAINED if any residual remains; items[].amount is the explained part of delta and
 *      the unexplained remainder is its own item { class: 'UNEXPLAINED' }. Lines are sorted (kind, key); days by date.
 *    Matching (R9) runs only on a line whose week delta is not 0, passes in this order, each document used at most once,
 *      deterministic order (date, amount, id): exact(date,amount,key) -> AP_AT_INVOICE (ap_supplier kind, same receiptId,
 *      same key, same centavos, different date) -> V2_CORRECTION_DATED_LATER (a doc with correctionOf whose source is
 *      in the week and which is dated outside it) -> DATE_SHIFT (same key and centavos, other date, |days| <= 7) ->
 *      KEYING_DIFFERENCE (same date and key, centavos differ) -> MISCLASSIFIED (same date and centavos, other key of the
 *      same kind; BOTH lines get the item) -> NOT_DOUBLE_ENTERED (v1 doc left, nothing in v2) -> PENDING_V2 / PENDING_V1
 *      (the other side has an 'unposted' doc with the same key, date and centavos) -> UNEXPLAINED.
 *      A pair is explained for the week by its IN-WEEK contribution: (v2 amount if v2 date in week) - (v1 amount if v1
 *      date in week), so a pair straddling the week boundary explains the delta of BOTH weeks.
 *  verdict.ts   signOffPack(results: StoreWeekResult[]) -> { countedWeeks, noData, open: StoreWeekResult[],
 *      comparedDaysTotal: number, comparedDaysByStore: Record<storeId, number> }
 *      (no_data weeks listed apart and never counted: not in countedWeeks, not in the day totals)
 *  Verdict (R12): no_data iff nothing on either side (no line with a non-zero figure, no trading day); ties iff every
 *    line delta is 0 AND comparedDays is non-empty; explained iff some delta != 0 and every one is policy / scope /
 *    defect / paired timing / unpaired PENDING_* whose document is at most 2 days before `through`; otherwise open.
 *    A week with figures but 0 compared days is therefore 'open', never 'ties' and never 'no_data' (SPEC DEFECT 1).
 *  Compared day: in v1.tradingDays AND v2.tradingDays, at least one line has a non-zero figure that date on a side,
 *    and no line's day state is 'open' on that date. Day state: tied (day delta 0 AND the line is not open for another
 *    reason is NOT required) | classed (delta not 0, line class non-open: policy/scope/defect/timing) | open. A
 *    line that nets to 0 over the week still has 'open' days where its per-day delta is not 0.
 *
 * Judged by: every test imports ../src/dual-run/*, so on HEAD the whole file is red with "Cannot find module" (the
 * module is missing - the right reason). Once it exists, each `it` names the assertion that judges it; the mutant each
 * invariant catches is in the comment above its test. Tagged [inv N] per the spec.
 *
 * SPEC DEFECTS found while pinning (also in the report): (1) the CHECK "compared_days = 0 iff verdict no_data" cannot
 * hold: an open week with figures but no compared day exists (and R12 makes 0 compared days no_data while inv 17 says
 * no_data means no data at all); pinned: no_data only when nothing exists, 'open' otherwise, so the CHECK must become
 * `no_data => compared_days = 0`. (2) V1_CASH_RESIDUAL: "Delta = -(negative residual)" contradicts inv 4's example under
 * delta = v2 - v1 (residual -500, v2 cash -500, delta -500 = the residual itself); pinned to the numeric example.
 * (3) which line the residual class lands on (sales_tender cash vs cash_bank cash) is not said; pinned to sales_tender
 * cash only. (4) which date the 2-day age rule reads for a PENDING pair is not said; fixtures keep both sides on one
 * date. (5) SUPPLIER_ADVANCE_1240: the whole advance sub-line delta is classed (a "cause" is not observable from
 * figures). (6) v1 docs for matching are not in S1's output (V1_Line carries aggregates only), so S1 or S4 must also
 * emit documents; pinned as v1Docs/v2Docs inputs.
 */
import { describe, expect, it } from 'vitest';
import { CLASS_CATALOGUE, DISPOSITION_CLASSES } from '../src/dual-run/classes';
import { compareStoreWeek } from '../src/dual-run/compare';
import { signOffPack } from '../src/dual-run/verdict';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const WEEK = '2026-10-19';
const NEXT = '2026-10-26';
const D = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;
const sum = (days: Record<string, number>): number => Object.values(days).reduce((a, b) => a + b, 0);
const line = (kind: string, key: string, days: Record<string, number>, extra: Any = {}): Any => ({ kind, key, amount: sum(days), days, ...extra });
const doc = (id: string, kind: string, key: string, date: string, amount: number, extra: Any = {}): Any => ({ id, kind, key, date, amount, state: 'posted', ...extra });
const km = (kind: string, v1: string, v2: string): Record<string, string> => ({ [`${kind}|${v1}`]: v2 });

function input(over: Any = {}): Any {
  return {
    orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, through: '2026-10-25',
    v1: { lines: [], tradingDays: [], cashResidual: {}, scope: [] },
    v2: { lines: [], tradingDays: [] },
    keyMap: {}, v1Docs: [], v2Docs: [], dispositions: [],
    ...over,
  };
}
const res = (over: Any = {}): Any => compareStoreWeek(input(over));
/** Adds one tied cash_bank figure on a trading day (weekStart + 2) on both sides so a COMPARED day exists: a store-week with zero compared days is never explained (coordinator ruling). */
const resD = (over: Any = {}): Any => {
  const ws: string = over.weekStart ?? WEEK;
  const day = new Date(Date.parse(ws) + 2 * 86_400_000).toISOString().slice(0, 10);
  const base = input(over);
  base.v1 = { ...base.v1, lines: [...base.v1.lines, line('cash_bank', 'wd-v1', { [day]: 1000 })], tradingDays: [...base.v1.tradingDays, day] };
  base.v2 = { ...base.v2, lines: [...base.v2.lines, line('cash_bank', 'wd-v2', { [day]: 1000 })], tradingDays: [...base.v2.tradingDays, day] };
  base.keyMap = { ...base.keyMap, ...km('cash_bank', 'wd-v1', 'wd-v2') };
  return compareStoreWeek(base);
};
const ln = (r: Any, kind: string, key: string): Any => {
  const l = r.lines.find((x: Any) => x.kind === kind && x.key === key);
  if (!l) throw new Error(`no result line ${kind}/${key}; have ${r.lines.map((x: Any) => `${x.kind}/${x.key}`).join(', ')}`);
  return l;
};
const TD = [D(19), D(20), D(21)];
/** A fully tied store-week: one cash tender line, three trading days, same on both sides. */
function tiedBase(extraV1: Any[] = [], extraV2: Any[] = [], keyMap: Any = {}): Any {
  const days = { [D(19)]: 10000, [D(20)]: 20000, [D(21)]: 30000 };
  return {
    v1: { lines: [line('sales_tender', 'cash__cashier', days), ...extraV1], tradingDays: TD, cashResidual: {} },
    v2: { lines: [line('sales_tender', 'cash-lipa', days), ...extraV2], tradingDays: TD },
    keyMap: { ...km('sales_tender', 'cash__cashier', 'cash-lipa'), ...keyMap },
  };
}

describe('T-392 S2 - class catalogue [R11]', () => {
  // Mutant: a code missing / free-text class.
  it('holds every spec code with a family, meaning and authority; disposition classes are only the two defects', () => {
    const want: Record<string, string> = {
      TIES: 'tie', INVENTORY_BASIS: 'policy', PAYROLL_ON_V1: 'scope', NOT_IN_DUAL_RUN_SCOPE: 'scope', V2_ONLY_EVENT: 'policy',
      V1_CASH_RESIDUAL: 'policy', AP_AT_INVOICE: 'timing', SUPPLIER_ADVANCE_1240: 'policy', V2_CORRECTION_DATED_LATER: 'timing',
      CHANNEL_AR_FLOW: 'timing', PENDING_V2: 'timing', PENDING_V1: 'timing', DATE_SHIFT: 'timing', NOT_DOUBLE_ENTERED: 'encoder',
      KEYING_DIFFERENCE: 'encoder', MISCLASSIFIED: 'encoder', UNMAPPED_KEY: 'encoder', V1_DEFECT: 'defect', V2_DEFECT: 'defect',
      UNEXPLAINED: 'open',
    };
    for (const [code, family] of Object.entries(want)) {
      const c = (CLASS_CATALOGUE as Any)[code];
      expect(c, `catalogue is missing ${code}`).toBeDefined();
      expect(c.family, `family of ${code}`).toBe(family);
      expect(String(c.meaning).length).toBeGreaterThan(5);
      expect(String(c.authority).length).toBeGreaterThan(2);
    }
    for (const code of ['V1_REMITTED_FIELD_ZERO', 'V1_UNKNOWN_EXPENSE_GROUP', 'V1_EXPENSE_ENTRY_GROUP_CONFLICT']) {
      expect((CLASS_CATALOGUE as Any)[code], `S1 emits ${code}; the closed catalogue must hold it`).toBeDefined();
    }
    expect([...DISPOSITION_CLASSES].sort()).toEqual(['V1_DEFECT', 'V2_DEFECT']);
  });
});

describe('T-392 S2 - ties, one-sided rows, vacuous weeks', () => {
  // [inv 11] Mutant: matching always runs.
  it('[inv 11] equal figures give TIES and no candidate run', () => {
    const r = res(tiedBase());
    expect(ln(r, 'sales_tender', 'cash-lipa').class).toBe('TIES');
    expect(r.matchRuns).toBe(0);
    expect(r.verdict).toBe('ties');
    expect(r.comparedDays).toEqual(TD);
  });

  // Mutant: an inner join that drops the one-sided row (a v1-only or v2-only line vanishes and the week reads as ties).
  it('a v1-only and a v2-only line are both named in the result, never dropped', () => {
    const b = tiedBase(
      [line('expense_category', 'e-rent', { [D(20)]: 150000 })],
      [line('expense_category', 'cat-fuel', { [D(21)]: 80000 })],
      km('expense_category', 'e-rent', 'cat-rent'),
    );
    const r = res(b);
    const a = ln(r, 'expense_category', 'cat-rent');
    expect([a.v1, a.v2, a.delta]).toEqual([150000, 0, -150000]);
    const z = ln(r, 'expense_category', 'cat-fuel');
    expect([z.v1, z.v2, z.delta]).toEqual([0, 80000, 80000]);
    expect(a.class).toBe('UNEXPLAINED');
    expect(z.class).toBe('UNEXPLAINED');
    expect(r.verdict).toBe('open');
  });

  // [inv 17] Mutant: all-zero lines read as ties.
  it('[inv 17] a store-week with nothing on either side is no_data with 0 compared days, and the pack does not count it', () => {
    const empties = [
      input(),
      input({
        v1: { lines: [line('cash_bank', 'cash__cashier', {})], tradingDays: [], cashResidual: {} },
        v2: { lines: [line('cash_bank', 'cash-lipa', {})], tradingDays: [] },
        keyMap: km('cash_bank', 'cash__cashier', 'cash-lipa'),
      }),
    ];
    for (const empty of empties) {
      const r = compareStoreWeek(empty);
      expect(r.verdict).toBe('no_data');
      expect(r.comparedDays).toEqual([]);
    }
    const nd = res();
    const good = res(tiedBase());
    const pack = signOffPack([nd, good]);
    expect(pack.noData).toHaveLength(1);
    expect(pack.countedWeeks).toHaveLength(1);
    expect(pack.comparedDaysTotal).toBe(3);
    expect(signOffPack([nd]).countedWeeks).toHaveLength(0);
    expect(signOffPack([nd]).comparedDaysTotal).toBe(0);
  });

  // SPEC DEFECT 1: figures exist but no day is compared. Mutant: 0 compared days forced to no_data (or to ties).
  it('figures with no compared day are open, not no_data and not ties', () => {
    const r = res({
      v1: { lines: [line('cash_bank', 'cash__cashier', { [D(19)]: 10000 })], tradingDays: [], cashResidual: {} },
      v2: { lines: [], tradingDays: [] },
      keyMap: km('cash_bank', 'cash__cashier', 'cash-lipa'),
    });
    expect(r.comparedDays).toEqual([]);
    expect(r.verdict).toBe('open');
  });

  // [inv 18] Mutant: compared days taken from the week delta only.
  it('[inv 18] a line that nets to 0 over +100/-100 days is TIES for the week but those days are not compared', () => {
    const v1 = line('cash_bank', 'cash__cashier', { [D(19)]: 5000, [D(20)]: 5000, [D(21)]: 7000 });
    const v2 = line('cash_bank', 'cash-lipa', { [D(19)]: 5100, [D(20)]: 4900, [D(21)]: 7000 });
    const r = res({
      v1: { lines: [v1], tradingDays: TD, cashResidual: {} },
      v2: { lines: [v2], tradingDays: TD },
      keyMap: km('cash_bank', 'cash__cashier', 'cash-lipa'),
    });
    const l = ln(r, 'cash_bank', 'cash-lipa');
    expect(l.class).toBe('TIES');
    expect(l.days.map((d: Any) => [d.date, d.delta, d.state])).toEqual([[D(19), 100, 'open'], [D(20), -100, 'open'], [D(21), 0, 'tied']]);
    expect(r.comparedDays).toEqual([D(21)]);
  });
});

describe('T-392 S2 - V1_CASH_RESIDUAL rule [inv 4]', () => {
  const cashWeek = (residual: number, v2Day19: number, v1Day19 = 0): Any => ({
    v1: { lines: [line('sales_tender', 'cash__cashier', { [D(19)]: v1Day19, [D(20)]: 300000 })], tradingDays: [D(19), D(20)], cashResidual: { [D(19)]: residual, [D(20)]: 0 } },
    v2: { lines: [line('sales_tender', 'cash-lipa', { [D(19)]: v2Day19, [D(20)]: 300000 })], tradingDays: [D(19), D(20)] },
    keyMap: km('sales_tender', 'cash__cashier', 'cash-lipa'),
  });
  // Mutant: class on any negative residual regardless of delta (the -499.99 case).
  it('negative unfloored residual -500 and v2 cash -500 that day is exactly V1_CASH_RESIDUAL, policy, explained', () => {
    const r = res(cashWeek(-50000, -50000));
    const l = ln(r, 'sales_tender', 'cash-lipa');
    expect(l.class).toBe('V1_CASH_RESIDUAL');
    expect(l.family).toBe('policy');
    expect(l.delta).toBe(-50000);
    expect(r.verdict).toBe('explained');
  });
  it('v2 cash -499.99 (one centavo off) is NOT the class: UNEXPLAINED, week open', () => {
    const r = res(cashWeek(-50000, -49999));
    expect(ln(r, 'sales_tender', 'cash-lipa').class).toBe('UNEXPLAINED');
    expect(r.verdict).toBe('open');
  });
  it('a residual of 0 or positive never fires the class, whatever the delta (both signs)', () => {
    const cases: [number, number, number][] = [[50000, -50000, 0], [50000, 50000, 0], [0, -50000, 0], [50000, 0, 50000]];
    for (const [residual, v2cash, v1cash] of cases) {
      const l = ln(compareStoreWeek(input(cashWeek(residual, v2cash, v1cash))), 'sales_tender', 'cash-lipa');
      expect(l.class, `residual ${residual}, v2 ${v2cash}, v1 ${v1cash}`).not.toBe('V1_CASH_RESIDUAL');
    }
  });
  // Mutant: sign flipped (delta +500 against residual -500 accepted). Pinned to inv 4's numbers (SPEC DEFECT 2).
  it('residual -500 with delta +500 (the opposite sign) is not the class', () => {
    expect(ln(res(cashWeek(-50000, 50000)), 'sales_tender', 'cash-lipa').class).not.toBe('V1_CASH_RESIDUAL');
  });
  // The class explains ONLY the day it matches: another day's unrelated difference stays unexplained.
  it('classes the residual day only; an extra 1.00 on another day of the same line leaves an UNEXPLAINED item', () => {
    const w = cashWeek(-50000, -50000);
    w.v2.lines[0] = line('sales_tender', 'cash-lipa', { [D(19)]: -50000, [D(20)]: 300100 });
    const r = res(w);
    const l = ln(r, 'sales_tender', 'cash-lipa');
    expect(l.items.map((i: Any) => [i.class, i.amount]).sort()).toEqual([['UNEXPLAINED', 100], ['V1_CASH_RESIDUAL', -50000]]);
    expect(l.class).toBe('UNEXPLAINED');
    expect(r.verdict).toBe('open');
  });
});

describe('T-392 S2 - relaxed matching passes [inv 12]', () => {
  const exp = (v1: Any[], v2: Any[], v1Docs: Any[], v2Docs: Any[]): Any => res({
    v1: { lines: v1, tradingDays: [D(21)], cashResidual: {} }, v2: { lines: v2, tradingDays: [D(21)] },
    keyMap: { ...km('expense_category', 'e1', 'cat-1'), ...km('expense_category', 'e2', 'cat-2') }, v1Docs, v2Docs,
  });

  it('KEYING_DIFFERENCE: same date and key, centavos differ -> encoder item of +50, week open', () => {
    const r = exp([line('expense_category', 'e1', { [D(21)]: 100000 })], [line('expense_category', 'cat-1', { [D(21)]: 105000 })],
      [doc('a', 'expense_category', 'e1', D(21), 100000)], [doc('b', 'expense_category', 'cat-1', D(21), 105000)]);
    const l = ln(r, 'expense_category', 'cat-1');
    expect(l.class).toBe('KEYING_DIFFERENCE');
    expect(l.items).toEqual([expect.objectContaining({ class: 'KEYING_DIFFERENCE', amount: 5000, v1Id: 'a', v2Id: 'b', paired: false })]);
    expect(r.verdict).toBe('open');
  });
  it('MISCLASSIFIED: same date and centavos under another category -> BOTH lines carry the item, week open', () => {
    const r = exp([line('expense_category', 'e1', { [D(21)]: 30000 })], [line('expense_category', 'cat-2', { [D(21)]: 30000 })],
      [doc('a', 'expense_category', 'e1', D(21), 30000)], [doc('b', 'expense_category', 'cat-2', D(21), 30000)]);
    expect(ln(r, 'expense_category', 'cat-1').class).toBe('MISCLASSIFIED');
    expect(ln(r, 'expense_category', 'cat-2').class).toBe('MISCLASSIFIED');
    expect(r.verdict).toBe('open');
  });
  it('NOT_DOUBLE_ENTERED: a v1 document with no v2 candidate -> encoder, week open', () => {
    const r = exp([line('expense_category', 'e1', { [D(21)]: 12345 })], [], [doc('a', 'expense_category', 'e1', D(21), 12345)], []);
    expect(ln(r, 'expense_category', 'cat-1').class).toBe('NOT_DOUBLE_ENTERED');
    expect(r.verdict).toBe('open');
  });
  it('a v2-only document with no v1 candidate stays UNEXPLAINED (R9 names no encoder class for it)', () => {
    const r = exp([], [line('expense_category', 'cat-1', { [D(21)]: 777 })], [], [doc('b', 'expense_category', 'cat-1', D(21), 777)]);
    expect(ln(r, 'expense_category', 'cat-1').class).toBe('UNEXPLAINED');
  });
  // Mutant: two-to-one match (one v2 doc certifies two v1 docs).
  it('a document is matched at most once: two v1 docs of 100.00 vs one v2 doc of 100.00 leaves one unmatched', () => {
    const r = exp([line('expense_category', 'e1', { [D(21)]: 20000 })], [line('expense_category', 'cat-1', { [D(21)]: 10000 })],
      [doc('a1', 'expense_category', 'e1', D(21), 10000), doc('a2', 'expense_category', 'e1', D(21), 10000)],
      [doc('b', 'expense_category', 'cat-1', D(21), 10000)]);
    const l = ln(r, 'expense_category', 'cat-1');
    expect(l.delta).toBe(-10000);
    expect(l.items.map((i: Any) => i.class)).toEqual(['NOT_DOUBLE_ENTERED']);
  });
  it('PENDING_V2: the v2 document exists unposted -> unpaired timing item; PENDING_V1 mirrors it', () => {
    const p2 = exp([line('expense_category', 'e1', { [D(25)]: 80000 })], [], [doc('a', 'expense_category', 'e1', D(25), 80000)],
      [doc('b', 'expense_category', 'cat-1', D(25), 80000, { state: 'unposted' })]);
    const l2 = ln(p2, 'expense_category', 'cat-1');
    expect([l2.class, l2.paired]).toEqual(['PENDING_V2', false]);
    const p1 = exp([], [line('expense_category', 'cat-1', { [D(25)]: 80000 })], [doc('a', 'expense_category', 'e1', D(25), 80000, { state: 'unposted' })],
      [doc('b', 'expense_category', 'cat-1', D(25), 80000)]);
    const l1 = ln(p1, 'expense_category', 'cat-1');
    expect([l1.class, l1.paired]).toEqual(['PENDING_V1', false]);
  });
});

describe('T-392 S2 - DATE_SHIFT, PENDING age, timing pairs [inv 12-14]', () => {
  const shifted = (weekStart: string, through: string, v1Date: string, v2Date: string, v2Amount = 50000): Any => {
    const inW = (d: string): boolean => d >= weekStart && d <= through;
    return {
      weekStart, through,
      v1: { lines: [line('expense_category', 'e1', inW(v1Date) ? { [v1Date]: 50000 } : {})], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('expense_category', 'cat-1', inW(v2Date) ? { [v2Date]: v2Amount } : {})], tradingDays: [] },
      keyMap: km('expense_category', 'e1', 'cat-1'),
      v1Docs: [doc('a', 'expense_category', 'e1', v1Date, 50000)],
      v2Docs: [doc('b', 'expense_category', 'cat-1', v2Date, v2Amount)],
    };
  };

  // [inv 13] Mutants: age rule applied to pairs (week B is 6 days old at through); pair dropped at the boundary (week A).
  it('[inv 13] a DATE_SHIFT pair across the week boundary (v1 Sunday, v2 Monday) makes BOTH weeks explained, at any age', () => {
    const a = resD(shifted(WEEK, '2026-10-25', D(25), '2026-10-26'));
    const la = ln(a, 'expense_category', 'cat-1');
    expect([la.class, la.paired, la.delta]).toEqual(['DATE_SHIFT', true, -50000]);
    expect(a.verdict).toBe('explained');
    const b = resD(shifted(NEXT, '2026-11-01', D(25), '2026-10-26'));
    const lb = ln(b, 'expense_category', 'cat-1');
    expect([lb.class, lb.paired, lb.delta]).toEqual(['DATE_SHIFT', true, 50000]);
    expect(b.verdict).toBe('explained');
  });
  // Mutant: DATE_SHIFT window unbounded.
  it('[inv 12] DATE_SHIFT reaches 7 days and no further: 8 days is not paired and the week is open', () => {
    expect(ln(resD(shifted(WEEK, '2026-10-25', D(25), '2026-11-01')), 'expense_category', 'cat-1').class).toBe('DATE_SHIFT');
    const far = resD(shifted(WEEK, '2026-10-25', D(25), '2026-11-02'));
    expect(ln(far, 'expense_category', 'cat-1').class).not.toBe('DATE_SHIFT');
    expect(far.verdict).toBe('open');
  });
  it('a date shift with different centavos is not a DATE_SHIFT', () => {
    const r = resD(shifted(WEEK, '2026-10-25', D(25), '2026-10-26', 50100));
    expect(ln(r, 'expense_category', 'cat-1').class).not.toBe('DATE_SHIFT');
    expect(r.verdict).toBe('open');
  });

  // [inv 13] Mutant: age rule dropped (3 days old read as explained) / applied wrongly (1 day read as open).
  it('[inv 13] an unpaired PENDING_V2 three days before through is open; one and exactly two days before are explained', () => {
    const pend = (age: number): Any => {
      const d = D(25 - age);
      return resD({
        v1: { lines: [line('expense_category', 'e1', { [d]: 80000 })], tradingDays: [], cashResidual: {} },
        v2: { lines: [], tradingDays: [] },
        keyMap: km('expense_category', 'e1', 'cat-1'),
        v1Docs: [doc('a', 'expense_category', 'e1', d, 80000)],
        v2Docs: [doc('b', 'expense_category', 'cat-1', d, 80000, { state: 'unposted' })],
      });
    };
    expect(pend(3).verdict).toBe('open');
    expect(pend(1).verdict).toBe('explained');
    expect(pend(2).verdict).toBe('explained');
    expect(ln(pend(3), 'expense_category', 'cat-1').class).toBe('PENDING_V2');
  });

  // [inv 14] Mutant: AP_AT_INVOICE paired without the receipt document, or on a different amount.
  const apWeek = (weekStart: string, through: string, v1Amt: number, v2Amt: number, receipt = ['R1', 'R1'], v1Date = D(25), v2Date = '2026-10-26'): Any => {
    const inW = (d: string): boolean => d >= weekStart && d <= through;
    return {
      weekStart, through,
      v1: { lines: [line('ap_supplier', 'ap__S1', inW(v1Date) ? { [v1Date]: v1Amt } : {}, { supplierId: 'S1' })], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('ap_supplier', 'sup-1', inW(v2Date) ? { [v2Date]: v2Amt } : {})], tradingDays: [] },
      keyMap: km('ap_supplier', 'ap__S1', 'sup-1'),
      v1Docs: [doc('a', 'ap_supplier', 'ap__S1', v1Date, v1Amt, { receiptId: receipt[0] })],
      v2Docs: [doc('b', 'ap_supplier', 'sup-1', v2Date, v2Amt, { receiptId: receipt[1] })],
    };
  };
  it('[inv 14] AP_AT_INVOICE pairs the v1 credit expense with the v2 invoice for the same receipt, supplier and centavos on another date', () => {
    const a = resD(apWeek(WEEK, '2026-10-25', 90000, 90000));
    const la = ln(a, 'ap_supplier', 'sup-1');
    expect([la.class, la.paired, la.family]).toEqual(['AP_AT_INVOICE', true, 'timing']);
    expect(a.verdict).toBe('explained');
    const b = resD(apWeek(NEXT, '2026-11-01', 90000, 90000));
    expect(ln(b, 'ap_supplier', 'sup-1').class).toBe('AP_AT_INVOICE');
    expect(b.verdict).toBe('explained');
  });
  it('[inv 14] with different centavos the receipt does not pair (no AP_AT_INVOICE, no DATE_SHIFT); a different receipt does not pair either', () => {
    const diff = resD(apWeek(WEEK, '2026-10-25', 90000, 90500));
    expect(['AP_AT_INVOICE', 'DATE_SHIFT']).not.toContain(ln(diff, 'ap_supplier', 'sup-1').class);
    expect(diff.verdict).toBe('open');
    const other = resD(apWeek(WEEK, '2026-10-25', 90000, 90000, ['R1', 'R2']));
    expect(ln(other, 'ap_supplier', 'sup-1').class).not.toBe('AP_AT_INVOICE');
  });
  it('[inv 14] SUPPLIER_ADVANCE_1240 is its own sub-line, explained as policy, and does not touch the supplier 2110 line', () => {
    const r = resD({
      v1: {
        lines: [
          line('ap_supplier', 'ap__S1', { [D(20)]: 90000 }, { supplierId: 'S1' }),
          line('ap_supplier', 'supplier_advance__S1', { [D(20)]: 500000 }, { supplierId: 'S1' }),
        ],
        tradingDays: [D(20)], cashResidual: {},
      },
      v2: { lines: [line('ap_supplier', 'sup-1', { [D(20)]: 90000 })], tradingDays: [D(20)] },
      keyMap: { ...km('ap_supplier', 'ap__S1', 'sup-1'), ...km('ap_supplier', 'supplier_advance__S1', '1240:sup-1') },
    });
    expect(ln(r, 'ap_supplier', 'sup-1').class).toBe('TIES');
    const adv = ln(r, 'ap_supplier', '1240:sup-1');
    expect([adv.class, adv.family, adv.delta]).toEqual(['SUPPLIER_ADVANCE_1240', 'policy', -500000]);
    expect(r.verdict).toBe('explained');
  });

  it('V2_CORRECTION_DATED_LATER: a v2 correction dated in the next week is paired with its source, both weeks explained', () => {
    const wk = (weekStart: string, through: string): Any => {
      const early = weekStart === WEEK;
      return {
        weekStart, through,
        v1: { lines: [line('sales_tender', 'cash__cashier', early ? { [D(24)]: 80000 } : {})], tradingDays: [], cashResidual: {} },
        v2: { lines: [line('sales_tender', 'cash-lipa', early ? { [D(24)]: 100000 } : { '2026-10-28': -20000 })], tradingDays: [] },
        keyMap: km('sales_tender', 'cash__cashier', 'cash-lipa'),
        v1Docs: [doc('a', 'sales_tender', 'cash__cashier', D(24), 80000)],
        v2Docs: [
          doc('s', 'sales_tender', 'cash-lipa', D(24), 100000),
          doc('c', 'sales_tender', 'cash-lipa', '2026-10-28', -20000, { correctionOf: 's' }),
        ],
      };
    };
    const a = resD(wk(WEEK, '2026-10-25'));
    const la = ln(a, 'sales_tender', 'cash-lipa');
    expect([la.class, la.paired, la.delta]).toEqual(['V2_CORRECTION_DATED_LATER', true, 20000]);
    expect(a.verdict).toBe('explained');
    const b = resD(wk(NEXT, '2026-11-01'));
    const lb = ln(b, 'sales_tender', 'cash-lipa');
    expect([lb.class, lb.delta]).toEqual(['V2_CORRECTION_DATED_LATER', -20000]);
    expect(b.verdict).toBe('explained');
  });
});

describe('T-392 S2 - verdict families, UNMAPPED_KEY, scope [inv 16, 20]', () => {
  // [inv 16] Mutant: policy counted open.
  it('[inv 16] INVENTORY_BASIS never counts toward open; UNEXPLAINED always does', () => {
    const base = tiedBase([line('inventory_basis', 'COGS', { [D(20)]: 9000000 })], [line('inventory_basis', 'inv-lipa', { [D(20)]: 6500000 })], km('inventory_basis', 'COGS', 'inv-lipa'));
    const r = res(base);
    const l = ln(r, 'inventory_basis', 'inv-lipa');
    expect([l.class, l.family]).toEqual(['INVENTORY_BASIS', 'policy']);
    expect(r.verdict).toBe('explained');
    const bad = tiedBase([line('expense_category', 'e1', { [D(20)]: 1000 })], [line('expense_category', 'cat-1', { [D(20)]: 1001 })], km('expense_category', 'e1', 'cat-1'));
    expect(res(bad).verdict).toBe('open');
  });
  it('v1 scope classes (NOT_IN_DUAL_RUN_SCOPE, PAYROLL_ON_V1) never make a week open and stay named in the result', () => {
    const b = tiedBase();
    b.v1.scope = [
      { class: 'NOT_IN_DUAL_RUN_SCOPE', sourceType: 'remittance', legs: 3, in: 0, out: 500000 },
      { class: 'PAYROLL_ON_V1', sourceType: 'payroll_payout', legs: 2, in: 0, out: 900000 },
    ];
    const r = res(b);
    expect(r.verdict).not.toBe('open');
    expect(JSON.stringify(r)).toContain('payroll_payout');
    expect(JSON.stringify(r)).toContain('remittance');
  });
  // The S1 class V1_UNKNOWN_EXPENSE_GROUP must not be silently explained away (pinned: it stays open).
  it('a v1 line carrying V1_UNKNOWN_EXPENSE_GROUP keeps the week open', () => {
    const b = tiedBase([line('expense_category', 'e9', { [D(20)]: 5000 }, { class: 'V1_UNKNOWN_EXPENSE_GROUP', group: 'ZZZ' })], [line('expense_category', 'cat-9', { [D(20)]: 5000 })], km('expense_category', 'e9', 'cat-9'));
    expect(res(b).verdict).toBe('open');
  });

  // [inv 20] Mutant: a v1 supplier with no link silently merged into another supplier's line.
  it('[inv 20] an unlinked v1 supplier is UNMAPPED_KEY on its own v1:<id> line and never merged into a v2 supplier', () => {
    const r = res({
      v1: { lines: [line('ap_supplier', 'ap__S9', { [D(20)]: 70000 }, { supplierId: 'S9' })], tradingDays: [D(20)], cashResidual: {} },
      v2: { lines: [line('ap_supplier', 'sup-2', { [D(20)]: 70000 })], tradingDays: [D(20)] },
      keyMap: {},
    });
    const u = ln(r, 'ap_supplier', 'v1:ap__S9');
    expect([u.class, u.family, u.v1, u.v2]).toEqual(['UNMAPPED_KEY', 'encoder', 70000, 0]);
    const other = ln(r, 'ap_supplier', 'sup-2');
    expect([other.v1, other.v2]).toEqual([0, 70000]);
    expect(r.verdict).toBe('open');
  });
});

describe('T-392 S2 - determinism and fingerprints [inv 15]', () => {
  const rich = (): Any => {
    const b = tiedBase(
      [line('expense_category', 'e1', { [D(20)]: 11111, [D(21)]: 22222 }), line('ap_supplier', 'ap__S1', { [D(19)]: 5000 }, { supplierId: 'S1' })],
      [line('expense_category', 'cat-1', { [D(20)]: 11111, [D(21)]: 22000 }), line('ap_supplier', 'sup-1', { [D(19)]: 5000 })],
      { ...km('expense_category', 'e1', 'cat-1'), ...km('ap_supplier', 'ap__S1', 'sup-1') },
    );
    b.v1Docs = [doc('a1', 'expense_category', 'e1', D(20), 11111), doc('a2', 'expense_category', 'e1', D(21), 22222)];
    b.v2Docs = [doc('b1', 'expense_category', 'cat-1', D(20), 11111), doc('b2', 'expense_category', 'cat-1', D(21), 22000)];
    return b;
  };
  const rev = (days: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(days).reverse());
  const shuffle = (b: Any): Any => ({
    ...b,
    v1: { ...b.v1, lines: [...b.v1.lines].reverse().map((l: Any) => ({ ...l, days: rev(l.days) })), tradingDays: [...b.v1.tradingDays].reverse() },
    v2: { ...b.v2, lines: [...b.v2.lines].reverse().map((l: Any) => ({ ...l, days: rev(l.days) })), tradingDays: [...b.v2.tradingDays].reverse() },
    v1Docs: [...b.v1Docs].reverse(),
    v2Docs: [...b.v2Docs].reverse(),
    keyMap: Object.fromEntries(Object.entries(b.keyMap).reverse()),
  });
  // Mutant: result depends on input (insertion) order.
  it('[inv 15] shuffled input gives the same result and the same fingerprints', () => {
    const a = res(rich());
    const b = res(shuffle(rich()));
    expect(b).toEqual(a);
    expect(a.v1Fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.v2Fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.v1Fingerprint).not.toBe(a.v2Fingerprint);
    const keys = b.lines.map((l: Any) => `${l.kind}/${l.key}`);
    expect(keys).toEqual([...keys].sort());
  });
  it('one centavo changed in v2 changes only the v2 fingerprint; one changed in v1 only the v1 fingerprint', () => {
    const a = res(rich());
    const w2 = rich();
    w2.v2.lines[1].days[D(20)] += 1; w2.v2.lines[1].amount += 1; w2.v2Docs[0].amount += 1;
    const b = res(w2);
    expect(b.v2Fingerprint).not.toBe(a.v2Fingerprint);
    expect(b.v1Fingerprint).toBe(a.v1Fingerprint);
    const w1 = rich();
    w1.v1.lines[1].days[D(20)] += 1; w1.v1.lines[1].amount += 1; w1.v1Docs[0].amount += 1;
    const c = res(w1);
    expect(c.v1Fingerprint).not.toBe(a.v1Fingerprint);
    expect(c.v2Fingerprint).toBe(a.v2Fingerprint);
  });
});

describe('T-392 S2 - dispositions [inv 19, R10]', () => {
  const week = (v2Amount = 1200): Any => ({
    v1: { lines: [line('expense_category', 'e1', { [D(20)]: 1000 })], tradingDays: [D(20)], cashResidual: {} },
    v2: { lines: [line('expense_category', 'cat-1', { [D(20)]: v2Amount })], tradingDays: [D(20)] },
    keyMap: km('expense_category', 'e1', 'cat-1'),
  });
  const disp = (over: Any = {}): Any => ({
    orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, kind: 'expense_category', lineKey: 'cat-1', deltaAt: 200,
    class: 'V2_DEFECT', ref: 'DEF-700', createdAt: '2026-10-27T01:00:00Z', ...over,
  });
  const first = (r: Any): Any => ln(r, 'expense_category', 'cat-1');

  it('a V2_DEFECT disposition with a DEF ref explains the line while the delta is unchanged', () => {
    const r = res({ ...week(), dispositions: [disp()] });
    expect([first(r).class, first(r).family, first(r).reCheck]).toEqual(['V2_DEFECT', 'defect', false]);
    expect(r.verdict).toBe('explained');
  });
  // Mutant: ignores delta.
  it('[inv 19] once the delta moves by a centavo the disposition no longer applies: re-check, UNEXPLAINED, open', () => {
    const r = res({ ...week(1201), dispositions: [disp()] });
    expect([first(r).class, first(r).reCheck]).toEqual(['UNEXPLAINED', true]);
    expect(r.verdict).toBe('open');
  });
  // Mutant: keyed on line_key alone (store / week / org / kind missing from the key).
  it('[inv 19] it applies only to the same (org, store, week, kind, line_key); a same line_key under another kind is untouched', () => {
    const w = week();
    w.v1.lines.push(line('sales_tender', 'x', { [D(20)]: 1000 }));
    w.v2.lines.push(line('sales_tender', 'cat-1', { [D(20)]: 1200 }));
    w.keyMap = { ...w.keyMap, ...km('sales_tender', 'x', 'cat-1') };
    const r = res({ ...w, dispositions: [disp()] });
    expect(first(r).class).toBe('V2_DEFECT');
    expect(ln(r, 'sales_tender', 'cat-1').class).toBe('UNEXPLAINED');
    for (const other of [{ orgId: 'org-2' }, { storeId: 'MALVAR' }, { weekStart: NEXT }, { lineKey: 'cat-2' }]) {
      expect(first(res({ ...week(), dispositions: [disp(other)] })).class, JSON.stringify(other)).toBe('UNEXPLAINED');
    }
  });
  it('the latest disposition by createdAt wins, wherever it sits in the array', () => {
    const older = disp({ class: 'V1_DEFECT', ref: 'DEF-1', createdAt: '2026-10-26T01:00:00Z' });
    const newer = disp({ class: 'V2_DEFECT', ref: 'DEF-2', createdAt: '2026-10-28T01:00:00Z' });
    expect(first(res({ ...week(), dispositions: [newer, older] })).class).toBe('V2_DEFECT');
    expect(first(res({ ...week(), dispositions: [older, newer] })).class).toBe('V2_DEFECT');
  });
  // R10 Mutant: any catalogue class may be assigned by a person (policy hidden behind a disposition).
  it('[R10] a disposition may assign only V1_DEFECT or V2_DEFECT, with a DEF-nnn ref; anything else is refused', () => {
    const classes = ['INVENTORY_BASIS', 'NOT_IN_DUAL_RUN_SCOPE', 'PAYROLL_ON_V1', 'V1_CASH_RESIDUAL', 'SUPPLIER_ADVANCE_1240', 'V2_ONLY_EVENT', 'DATE_SHIFT', 'TIES', 'UNEXPLAINED'];
    for (const cls of classes) {
      expect(() => res({ ...week(), dispositions: [disp({ class: cls })] }), cls).toThrow(/disposition/i);
    }
    for (const ref of ['', 'nope', 'DEF-', 'def-7', 'DEF-7x', ' DEF-7']) {
      expect(() => res({ ...week(), dispositions: [disp({ ref })] }), JSON.stringify(ref)).toThrow(/disposition|ref/i);
    }
  });
});

describe('T-392 S2 - CHANNEL_AR_FLOW proved on a fixture [spec: S2 proves it or removes it]', () => {
  // Pinned: Doc may carry `channel: true` (a channel sale / channel_sales flow document). Pass order: after
  // V2_CORRECTION_DATED_LATER, before DATE_SHIFT; pairs a channel doc with a channel doc on the other side, same centavos.
  // Mutant: class never assigned (falls to DATE_SHIFT or UNEXPLAINED).
  const wk = (weekStart: string, through: string): Any => {
    const early = weekStart === WEEK;
    return {
      weekStart, through,
      v1: { lines: [line('sales_tender', 'channel_sales', early ? {} : { [D(26)]: 250000 })], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('sales_tender', '1220', early ? { [D(25)]: 250000 } : {})], tradingDays: [] },
      keyMap: km('sales_tender', 'channel_sales', '1220'),
      v1Docs: [doc('c1', 'sales_tender', 'channel_sales', D(26), 250000, { channel: true })],
      v2Docs: [doc('r1', 'sales_tender', '1220', D(25), 250000, { channel: true })],
    };
  };
  it('a channel sale in v2 1220 on the sales date and in the v1 channel_sales flow a day later is paired CHANNEL_AR_FLOW in both weeks', () => {
    const a = resD(wk(WEEK, '2026-10-25'));
    const la = ln(a, 'sales_tender', '1220');
    expect([la.class, la.paired, la.family, la.delta]).toEqual(['CHANNEL_AR_FLOW', true, 'timing', 250000]);
    expect(a.verdict).toBe('explained');
    const b = resD(wk(NEXT, '2026-11-01'));
    const lb = ln(b, 'sales_tender', '1220');
    expect([lb.class, lb.delta]).toEqual(['CHANNEL_AR_FLOW', -250000]);
    expect(b.verdict).toBe('explained');
  });
  it('without the channel marker the same figures are DATE_SHIFT, and with different centavos neither class pairs', () => {
    const w = wk(WEEK, '2026-10-25');
    w.v1Docs[0].channel = false; w.v2Docs[0].channel = false;
    expect(ln(resD(w), 'sales_tender', '1220').class).toBe('DATE_SHIFT');
    const x = wk(WEEK, '2026-10-25');
    x.v1Docs[0].amount = 250100;
    expect(ln(resD(x), 'sales_tender', '1220').class).not.toBe('CHANNEL_AR_FLOW');
  });
});

describe('T-392 S2 - zero compared days is never explained or ties (coordinator ruling)', () => {
  // Mutant: explained/ties judged from the deltas alone, ignoring the compared-day count.
  it('a classed or timing-explained mismatch with no trading day on either side is open, not explained', () => {
    const shift = res({
      v1: { lines: [line('expense_category', 'e1', { [D(25)]: 50000 })], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('expense_category', 'cat-1', {})], tradingDays: [] },
      keyMap: km('expense_category', 'e1', 'cat-1'),
      v1Docs: [doc('a', 'expense_category', 'e1', D(25), 50000)],
      v2Docs: [doc('b', 'expense_category', 'cat-1', '2026-10-26', 50000)],
    });
    expect(ln(shift, 'expense_category', 'cat-1').class).toBe('DATE_SHIFT');
    expect(shift.comparedDays).toEqual([]);
    expect(shift.verdict).toBe('open');
    const inv = res({
      v1: { lines: [line('inventory_basis', 'COGS', { [D(20)]: 9000000 })], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('inventory_basis', 'inv-lipa', { [D(20)]: 6500000 })], tradingDays: [] },
      keyMap: km('inventory_basis', 'COGS', 'inv-lipa'),
    });
    expect(inv.verdict).toBe('open');
  });
  it('monotone: the same mismatch on a week WITH a compared day is explained, and removing the trading days only worsens it', () => {
    const mk = (days: string[]): Any => ({
      v1: { lines: [line('cash_bank', 'a', { [D(21)]: 10 }), line('inventory_basis', 'COGS', { [D(20)]: 900 })], tradingDays: days, cashResidual: {} },
      v2: { lines: [line('cash_bank', 'b', { [D(21)]: 10 }), line('inventory_basis', 'inv', { [D(20)]: 100 })], tradingDays: days },
      keyMap: { ...km('cash_bank', 'a', 'b'), ...km('inventory_basis', 'COGS', 'inv') },
    });
    const rank: Record<string, number> = { ties: 0, explained: 1, open: 2 };
    const withDays = res(mk([D(21)]));
    const without = res(mk([]));
    expect(withDays.verdict).toBe('explained');
    expect(rank[without.verdict]).toBeGreaterThanOrEqual(rank[withDays.verdict] as number);
    expect(without.verdict).toBe('open');
  });
});
