/**
 * T-392 S2 AUDIT ROUND (TESTER) - coordinator legs 1-8. Signatures are those pinned in t392-s2-compare.test.ts.
 * Each test is red against the first builder cut for the reason in its comment (mutant named).
 * New pins: Doc.receiptId is the document LINK for DATE_SHIFT / CHANNEL_AR_FLOW too (a link wins over any candidate);
 * keyMap, dispositions, flags and weekStart/through all count in the fingerprints; amounts are validated at entry
 * (a throw matching /integer|centavo|amount/i).
 */
import { describe, expect, it } from 'vitest';
import { compareStoreWeek } from '../src/dual-run/compare';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const WEEK = '2026-10-19';
const NEXT = '2026-10-26';
const D = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;
const sum = (days: Record<string, number>): number => Object.values(days).reduce((a, b) => a + b, 0);
const line = (kind: string, key: string, days: Record<string, number>, extra: Any = {}): Any => ({ kind, key, amount: sum(days), days, ...extra });
const doc = (id: string, kind: string, key: string, date: string, amount: number, extra: Any = {}): Any => ({ id, kind, key, date, amount, state: 'posted', ...extra });
const km = (kind: string, v1: string, v2: string): Record<string, string> => ({ [`${kind}|${v1}`]: v2 });
const input = (over: Any = {}): Any => ({
  orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, through: '2026-10-25',
  v1: { lines: [], tradingDays: [], cashResidual: {}, scope: [] }, v2: { lines: [], tradingDays: [] },
  keyMap: {}, v1Docs: [], v2Docs: [], dispositions: [], ...over,
});
const res = (over: Any = {}): Any => compareStoreWeek(input(over));
const ln = (r: Any, kind: string, key: string): Any => {
  const l = r.lines.find((x: Any) => x.kind === kind && x.key === key);
  if (!l) throw new Error(`no result line ${kind}/${key}; have ${r.lines.map((x: Any) => `${x.kind}/${x.key}`).join(', ')}`);
  return l;
};
const TD = [D(19), D(20), D(21)];
function tiedBase(extraV1: Any[] = [], extraV2: Any[] = [], keyMap: Any = {}): Any {
  const days = { [D(19)]: 10000, [D(20)]: 20000, [D(21)]: 30000 };
  return {
    v1: { lines: [line('sales_tender', 'cash__cashier', days), ...extraV1], tradingDays: TD, cashResidual: {} },
    v2: { lines: [line('sales_tender', 'cash-lipa', days), ...extraV2], tradingDays: TD },
    keyMap: { ...km('sales_tender', 'cash__cashier', 'cash-lipa'), ...keyMap },
  };
}
const rank = (v: string): number => ({ no_data: -1, ties: 0, explained: 1, open: 2 } as Any)[v];

describe('T-392 S2 audit - offsetting days, zero compared days, no_data [legs 1-3]', () => {
  // Leg 1. Mutant: verdict from week deltas only (a compared day elsewhere hides a line whose days offset).
  it('[leg 1] a line with delta 0 over the week but Mon +5.00 / Tue -5.00 makes the verdict open', () => {
    const b = tiedBase(
      [line('cash_bank', 'cash__cashier', { [D(19)]: 5000, [D(20)]: 5000 })],
      [line('cash_bank', 'cash-lipa', { [D(19)]: 5500, [D(20)]: 4500 })],
      km('cash_bank', 'cash__cashier', 'cash-lipa'),
    );
    const r = res(b);
    expect(ln(r, 'cash_bank', 'cash-lipa').delta).toBe(0);
    expect(r.verdict).toBe('open');
  });

  // Leg 2. Mutant: explained without a compared day.
  it('[leg 2] an all-INVENTORY_BASIS week with no v2 trading day is open, never explained', () => {
    const r = res({
      v1: { lines: [line('inventory_basis', 'COGS', { [D(20)]: 9000000 })], tradingDays: [D(20)], cashResidual: {} },
      v2: { lines: [line('inventory_basis', 'inv-lipa', { [D(20)]: 6500000 })], tradingDays: [] },
      keyMap: km('inventory_basis', 'COGS', 'inv-lipa'),
    });
    expect(r.comparedDays).toEqual([]);
    expect(r.verdict).toBe('open');
  });
  it('[leg 2] explained mismatches with 0 compared days are open (cash residual week, v2 never traded)', () => {
    const r = res({
      v1: { lines: [line('sales_tender', 'cash__cashier', { [D(19)]: 0 })], tradingDays: [D(19)], cashResidual: { [D(19)]: -50000 } },
      v2: { lines: [line('sales_tender', 'cash-lipa', { [D(19)]: -50000 })], tradingDays: [] },
      keyMap: km('sales_tender', 'cash__cashier', 'cash-lipa'),
    });
    expect(r.verdict).toBe('open');
  });
  it('[leg 2] monotone: adding a mismatch never improves a verdict', () => {
    const baseOpen = (): Any => {
      const b = tiedBase();
      b.v2.tradingDays = [];
      return b;
    };
    const adds: [string, (b: Any) => void][] = [
      ['policy line', (b) => { b.v1.lines.push(line('inventory_basis', 'COGS', { [D(20)]: 900 })); b.v2.lines.push(line('inventory_basis', 'inv', { [D(20)]: 100 })); b.keyMap = { ...b.keyMap, ...km('inventory_basis', 'COGS', 'inv') }; }],
      ['unexplained line', (b) => { b.v1.lines.push(line('expense_category', 'e1', { [D(20)]: 1 })); b.v2.lines.push(line('expense_category', 'cat-1', { [D(20)]: 2 })); b.keyMap = { ...b.keyMap, ...km('expense_category', 'e1', 'cat-1') }; }],
    ];
    for (const mk of [() => tiedBase(), baseOpen]) {
      const before = rank(res(mk()).verdict);
      for (const [name, add] of adds) {
        const w = mk();
        add(w);
        expect(rank(res(w).verdict), name).toBeGreaterThanOrEqual(before);
      }
    }
  });

  // Leg 3. Mutant: no_data judged from figures alone (a week holding only a v1 flag disappears).
  it('[leg 3] no_data only when lines, flags, dispositions and scope are ALL empty (docs no longer count, S4b inv 43)', () => {
    expect(res().verdict).toBe('no_data');
    const flagOnly = res({ v1: { lines: [], tradingDays: [], cashResidual: {}, flags: [{ code: 'V1_REMITTED_FIELD_ZERO', date: D(20) }] } });
    expect(flagOnly.verdict).toBe('open');
    const cases: Record<string, Any> = {
      scope: { v1: { lines: [], tradingDays: [], cashResidual: {}, scope: [{ class: 'PAYROLL_ON_V1', sourceType: 'payroll_payout', legs: 1, in: 0, out: 100 }] } },
      disposition: { dispositions: [{ orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, kind: 'expense_category', lineKey: 'c', deltaAt: 1, class: 'V2_DEFECT', ref: 'DEF-1', createdAt: '2026-10-27T00:00:00Z' }] },
    };
    for (const [name, over] of Object.entries(cases)) {
      expect(res(over).verdict, name).not.toBe('no_data');
    }
  });
});

describe('T-392 S2 audit - classes explain only their own amounts [leg 4]', () => {
  // Mutant: rawV1.some(supplier_advance__) blanket classes the whole merged-key delta.
  it('[leg 4] a real 2110 error merged into the advance key stays UNEXPLAINED; only the advance amount is classed', () => {
    const r = res({
      v1: {
        lines: [
          line('ap_supplier', 'ap__S1', { [D(20)]: 90000 }, { supplierId: 'S1' }),
          line('ap_supplier', 'supplier_advance__S1', { [D(20)]: 500000 }, { supplierId: 'S1' }),
        ],
        tradingDays: [D(20)], cashResidual: {},
      },
      v2: { lines: [line('ap_supplier', 'sup-1', { [D(20)]: 90500 })], tradingDays: [D(20)] },
      keyMap: { ...km('ap_supplier', 'ap__S1', 'sup-1'), ...km('ap_supplier', 'supplier_advance__S1', 'sup-1') },
    });
    const l = ln(r, 'ap_supplier', 'sup-1');
    expect(l.items.map((i: Any) => [i.class, i.amount]).sort()).toEqual([['SUPPLIER_ADVANCE_1240', -500000], ['UNEXPLAINED', 500]]);
    expect(l.class).toBe('UNEXPLAINED');
    expect(r.verdict).toBe('open');
  });
  // Mutant: rawV1.some(startsWith cash__) - the residual class lands on a key that also holds a credit line.
  it('[leg 4] the cash residual class never lands on a key that also holds non-cash v1 lines', () => {
    const r = res({
      v1: {
        lines: [line('sales_tender', 'cash__cashier', { [D(19)]: 0, [D(20)]: 300000 }), line('sales_tender', 'credit', { [D(19)]: 100000 })],
        tradingDays: [D(19), D(20)], cashResidual: { [D(19)]: -50000, [D(20)]: 0 },
      },
      v2: { lines: [line('sales_tender', 'tender-x', { [D(19)]: 50000, [D(20)]: 300000 })], tradingDays: [D(19), D(20)] },
      keyMap: { ...km('sales_tender', 'cash__cashier', 'tender-x'), ...km('sales_tender', 'credit', 'tender-x') },
    });
    const l = ln(r, 'sales_tender', 'tender-x');
    expect(l.delta).toBe(-50000);
    expect(l.items.map((i: Any) => i.class)).not.toContain('V1_CASH_RESIDUAL');
    expect(r.verdict).toBe('open');
  });
});

describe('T-392 S2 audit - pairing needs a link or a unique candidate [leg 5]', () => {
  const sunWeek = (v1Docs: Any[], v2Docs: Any[], channel = false): Any => ({
    v1: { lines: [line('expense_category', 'e1', Object.fromEntries(v1Docs.map((d: Any) => [d.date, 5000])))], tradingDays: [], cashResidual: {} },
    v2: { lines: [line('expense_category', 'cat-1', {})], tradingDays: [] },
    keyMap: km('expense_category', 'e1', 'cat-1'),
    v1Docs: v1Docs.map((d: Any) => ({ ...d, channel })),
    v2Docs: v2Docs.map((d: Any) => ({ ...d, channel })),
  });
  // Mutant: first equal-centavo candidate wins (greedy).
  it('[leg 5] two equal daily v1 charges and one equal v2 charge next week do not pair; week open', () => {
    const r = res(sunWeek(
      [doc('a1', 'expense_category', 'e1', D(24), 5000), doc('a2', 'expense_category', 'e1', D(25), 5000)],
      [doc('b', 'expense_category', 'cat-1', NEXT, 5000)],
    ));
    expect(ln(r, 'expense_category', 'cat-1').items.map((i: Any) => i.class)).not.toContain('DATE_SHIFT');
    expect(r.verdict).toBe('open');
  });
  it('[leg 5] the same ambiguity for CHANNEL_AR_FLOW: two equal channel docs do not pair', () => {
    const r = res(sunWeek(
      [doc('a1', 'expense_category', 'e1', D(24), 5000), doc('a2', 'expense_category', 'e1', D(25), 5000)],
      [doc('b', 'expense_category', 'cat-1', NEXT, 5000)],
      true,
    ));
    expect(ln(r, 'expense_category', 'cat-1').items.map((i: Any) => i.class)).not.toContain('CHANNEL_AR_FLOW');
    expect(r.verdict).toBe('open');
  });
  // Mutant: link ignored (earliest doc a1 paired though the receipt says a2).
  it('[leg 5] a document link (receiptId) wins over any candidate: the linked v1 doc is the one paired', () => {
    const r = res(sunWeek(
      [doc('a1', 'expense_category', 'e1', D(24), 5000, { receiptId: 'R1' }), doc('a2', 'expense_category', 'e1', D(25), 5000, { receiptId: 'R2' })],
      [doc('b', 'expense_category', 'cat-1', NEXT, 5000, { receiptId: 'R2' })],
    ));
    const pairItem = ln(r, 'expense_category', 'cat-1').items.find((i: Any) => i.class === 'DATE_SHIFT');
    expect(pairItem).toEqual(expect.objectContaining({ v1Id: 'a2', v2Id: 'b', paired: true }));
  });
  it('[leg 5] a unique equal-centavo candidate on each side still pairs without a link', () => {
    const r = res(sunWeek([doc('a2', 'expense_category', 'e1', D(25), 5000)], [doc('b', 'expense_category', 'cat-1', NEXT, 5000)]));
    expect(ln(r, 'expense_category', 'cat-1').class).toBe('DATE_SHIFT');
    expect(r.verdict).toBe('open'); // no trading day in the fixture: zero compared days is never explained (ruling)
  });
});

describe('T-392 S2 audit - fingerprints and total order [leg 6]', () => {
  const rich = (): Any => tiedBase(
    [line('expense_category', 'e1', { [D(20)]: 100 })],
    [line('expense_category', 'cat-1', { [D(20)]: 100 }), line('expense_category', 'cat-2', { [D(20)]: 100 })],
    km('expense_category', 'e1', 'cat-1'),
  );
  const pair = (r: Any): string => `${r.v1Fingerprint}|${r.v2Fingerprint}`;
  // Mutant: figures only (keyMap absent from the identity).
  it('[leg 6] keyMap is in the v1 fingerprint (same figures, different mapping, different identity)', () => {
    const a = res(rich());
    const w = rich();
    w.keyMap = { ...w.keyMap, ...km('expense_category', 'e1', 'cat-2') };
    expect(res(w).v1Fingerprint).not.toBe(a.v1Fingerprint);
  });
  it('[leg 6] v1.flags are in the v1 fingerprint', () => {
    const a = res(rich());
    const w = rich();
    w.v1.flags = [{ code: 'V1_REMITTED_FIELD_ZERO', date: D(20) }];
    expect(res(w).v1Fingerprint).not.toBe(a.v1Fingerprint);
  });
  it('[leg 6] through and dispositions change the identity pair', () => {
    const a = res(rich());
    const t = rich();
    t.through = '2026-10-24';
    expect(pair(res(t))).not.toBe(pair(a));
    const dsp = rich();
    dsp.v1.lines.push(line('expense_category', 'e2', { [D(21)]: 5 }));
    const withD = { ...dsp, dispositions: [{ orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, kind: 'expense_category', lineKey: 'v1:e2', deltaAt: -5, class: 'V1_DEFECT', ref: 'DEF-9', createdAt: '2026-10-27T00:00:00Z' }] };
    expect(pair(res(withD))).not.toBe(pair(res({ ...dsp, dispositions: [] })));
  });
  // Mutant: partial sort key (docs by id only, lines by kind/key/amount only) leaves duplicates in input order.
  it('[leg 6] total order: duplicate ids and equal amounts in any input order give the same result and fingerprints', () => {
    const mk = (docs: Any[], lines: Any[]): Any => ({
      v1: { lines, tradingDays: [D(20)], cashResidual: {} }, v2: { lines: [], tradingDays: [D(20)] },
      keyMap: km('expense_category', 'e1', 'cat-1'), v1Docs: docs, v2Docs: [],
    });
    const docs = [doc('x', 'expense_category', 'e1', D(20), 100), doc('x', 'expense_category', 'e1', D(21), 200), doc('x', 'expense_category', 'e1', D(21), 200, { receiptId: 'R' })];
    const lines = [line('expense_category', 'e1', { [D(20)]: 100 }), line('expense_category', 'e1', { [D(21)]: 100 })];
    const a = res(mk(docs, lines));
    const b = res(mk([...docs].reverse(), [...lines].reverse()));
    expect(b.v1Fingerprint).toBe(a.v1Fingerprint);
    expect(b).toEqual(a);
  });
});

describe('T-392 S2 audit - corrections [leg 7]', () => {
  const corr = (v1Amount: number, weekStart: string, through: string): Any => {
    const early = weekStart === WEEK;
    return {
      weekStart, through,
      v1: { lines: [line('sales_tender', 'cash__cashier', early ? { [D(24)]: v1Amount } : {})], tradingDays: [], cashResidual: {} },
      v2: { lines: [line('sales_tender', 'cash-lipa', early ? { [D(24)]: 100000 } : { '2026-10-28': -20000 })], tradingDays: [] },
      keyMap: km('sales_tender', 'cash__cashier', 'cash-lipa'),
      v1Docs: [doc('a', 'sales_tender', 'cash__cashier', D(24), v1Amount)],
      v2Docs: [doc('s', 'sales_tender', 'cash-lipa', D(24), 100000), doc('c', 'sales_tender', 'cash-lipa', '2026-10-28', -20000, { correctionOf: 's' })],
    };
  };
  // Mutant: pairing on the correction document alone, without checking v1 holds the corrected amount.
  it('[leg 7] dated-later applies only when v1 holds the corrected amount; v1 still on the original 1000.00 is UNEXPLAINED', () => {
    const ok = res(corr(80000, NEXT, '2026-11-01'));
    expect(ln(ok, 'sales_tender', 'cash-lipa').class).toBe('V2_CORRECTION_DATED_LATER');
    const bad = res(corr(100000, NEXT, '2026-11-01'));
    const l = ln(bad, 'sales_tender', 'cash-lipa');
    expect(l.items.map((i: Any) => i.class)).not.toContain('V2_CORRECTION_DATED_LATER');
    expect(l.class).toBe('UNEXPLAINED');
    expect(bad.verdict).toBe('open');
  });
  it('[leg 7] document order does not change the result (correction listed before or after its source)', () => {
    const w = corr(80000, WEEK, '2026-10-25');
    expect(res({ ...w, v2Docs: [...w.v2Docs].reverse() })).toEqual(res(w));
  });
});

describe('T-392 S2 audit - amounts are integers [leg 8]', () => {
  const bad: [string, number][] = [['fractional', 10.5], ['NaN', NaN], ['Infinity', Infinity], ['unsafe', Number.MAX_SAFE_INTEGER + 2]];
  // Mutant: no entry validation (a float silently becomes a centavo).
  it('[leg 8] a non-integer / NaN / unsafe amount is refused at entry, wherever it appears', () => {
    for (const [name, v] of bad) {
      const lineAmt = tiedBase(); lineAmt.v1.lines[0].amount = v;
      expect(() => res(lineAmt), `line amount ${name}`).toThrow(/integer|centavo|amount/i);
      const dayAmt = tiedBase(); dayAmt.v2.lines[0].days[D(19)] = v;
      expect(() => res(dayAmt), `day amount ${name}`).toThrow(/integer|centavo|amount/i);
      const docAmt = tiedBase(); docAmt.v1Docs = [doc('a', 'sales_tender', 'cash__cashier', D(19), v)];
      expect(() => res(docAmt), `doc amount ${name}`).toThrow(/integer|centavo|amount/i);
      const resid = tiedBase(); resid.v1.cashResidual = { [D(19)]: v };
      expect(() => res(resid), `residual ${name}`).toThrow(/integer|centavo|amount/i);
    }
  });
});
