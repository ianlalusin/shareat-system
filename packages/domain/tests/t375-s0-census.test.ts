import { describe, expect, it } from 'vitest';
import { posV1SalesBody } from '../../db/src/pos-v1/fixtures';
import { censusGate, classifyDay, emptyCensus, formatCensus, addDay } from '../src/pos/v1-census';

/** T-375 S0: the census counters (a)-(h) and the gate. P/D/C/K/X in pesos; N receipts. */
function run(...days: Record<string, unknown>[]) {
  const c = emptyCensus();
  for (const d of days) addDay(c, classifyDay(d));
  return c;
}
const clean = posV1SalesBody({ paidTotal: 1000, discounts: 0, charges: 0, packageOnly: 600, receiptCount: 10, methods: { Cash: 1000 } });

describe('T-375 S0 census', () => {
  it('(a) counts days found, and a not-found day nothing else', () => {
    const c = run(clean, posV1SalesBody({ found: false }));
    expect(c.found).toBe(1);
    expect(c.days).toBe(2);
    expect(censusGate(c).pass).toBe(true);
  });

  it('(e2) a refund day: X above 1 centavo per receipt, and refunds above cash is the gating count', () => {
    const refund = posV1SalesBody({ paidTotal: 1000, packageOnly: 600, receiptCount: 10, methods: { Cash: 900, GCash: 150 } }); // X 50
    const tooMuch = posV1SalesBody({ paidTotal: 1000, packageOnly: 600, receiptCount: 10, methods: { Cash: 30, GCash: 1000 } }); // X 30 > cash 30? equal: not exceed
    const exceed = posV1SalesBody({ paidTotal: 1000, packageOnly: 600, receiptCount: 10, methods: { Cash: 20, GCash: 1030 } }); // X 50 > cash 20
    const c = run(refund, tooMuch, exceed);
    expect(c.refundDays).toBe(3);
    expect(c.refundsOverCashDays).toBe(1);
    expect(censusGate(c)).toEqual({ pass: false, failed: ['(e2) days where refunds exceed cash: 1'] });
  });

  it('(r) a rounding-only day: 0 < X <= 0.01 x N is reported with the largest X, never gating', () => {
    const a = posV1SalesBody({ paidTotal: 1000, packageOnly: 600, receiptCount: 10, methods: { Cash: 1000.1 } }); // X 0.10 = N*0.01
    const b = posV1SalesBody({ paidTotal: 1000, packageOnly: 600, receiptCount: 300, methods: { Cash: 1001.5 } }); // X 1.50
    const c = run(a, b, clean);
    expect(c.roundingDays).toBe(2);
    expect(c.roundingMax).toBe(150n);
    expect(c.refundDays).toBe(0);
    expect(censusGate(c).pass).toBe(true);
  });

  it('(e1) methods short of the total', () => {
    const c = run(posV1SalesBody({ paidTotal: 1000, packageOnly: 0, receiptCount: 10, methods: { Cash: 999 } }));
    expect(c.shortDays).toBe(1);
    expect(censusGate(c).failed).toEqual(['(e1) days with methods short of the total: 1']);
  });

  it('(c) a cap day: K above P + D - C + refunds, largest excess; not gating', () => {
    const cap = posV1SalesBody({ paidTotal: 1000, discounts: 100, charges: 50, packageOnly: 1200, receiptCount: 10, methods: { Cash: 1000 } }); // total 1050, excess 150
    const refundCap = posV1SalesBody({ paidTotal: 1000, packageOnly: 1040, receiptCount: 10, methods: { Cash: 1000, GCash: 50 } }); // X 50 refund: total 1050; excess 0
    const c = run(cap, refundCap);
    expect(c.capDays).toBe(1);
    expect(c.capMax).toBe(15000n);
    expect(censusGate(c).pass).toBe(true);
  });

  it('(d) a non-centavo value, in a figure or a method', () => {
    const fig = posV1SalesBody({ paidTotal: 1000.005, receiptCount: 1, methods: { Cash: 1000 } });
    const meth = posV1SalesBody({ paidTotal: 1000, receiptCount: 1, methods: { Cash: 1000.004 } });
    const c = run(fig, meth);
    expect(c.nonCentavoDays).toBe(2);
    expect(censusGate(c).failed).toEqual(['(d) days with a non-centavo or negative figure: 2']);
  });

  it('(e) a negative method, and it also fails the gate', () => {
    const c = run(posV1SalesBody({ paidTotal: 1000, receiptCount: 5, methods: { Cash: 1100, GCash: -100 } }));
    expect(c.negativeMethodDays).toBe(1);
    expect(censusGate(c).failed).toEqual(['(e) days with a negative method total: 1']);
  });

  it('(f) distinct method names, zero methods included only if non-zero', () => {
    const c = run(clean, posV1SalesBody({ paidTotal: 10, receiptCount: 1, methods: { Cash: 10, 'G Cash': 0, Maya: 0 } }), posV1SalesBody({ paidTotal: 5, receiptCount: 1, methods: { GCash: 5 } }));
    expect([...c.methodNames].sort()).toEqual(['Cash', 'GCash']);
  });

  it('(g) days with charges above zero', () => {
    const c = run(posV1SalesBody({ paidTotal: 950, charges: 50, packageOnly: 0, receiptCount: 1, methods: { Cash: 950 } }), clean);
    expect(c.chargeDays).toBe(1);
  });

  it('a missing or non-numeric figure is counted unreadable and fails the gate', () => {
    const c = run({ found: true, totalSessions: 3 });
    expect(c.unreadableDays).toBe(1);
    expect(censusGate(c).pass).toBe(false);
  });

  it('a non-object payload is counted unreadable and fails the gate (R4 refuses it)', () => {
    const c = run('garbage' as unknown as Record<string, unknown>, [] as unknown as Record<string, unknown>);
    expect(c.unreadableDays).toBe(2);
    expect(c.found).toBe(0);
    expect(censusGate(c).pass).toBe(false);
  });

  it('(n) a negative total (charges exceed sales) is counted, gating, and not a (c) cap', () => {
    const neg = posV1SalesBody({ paidTotal: 100, discounts: 0, charges: 150, packageOnly: 500, receiptCount: 5, methods: { Cash: 100 } });
    const c = run(neg, clean);
    expect(c.negativeTotalDays).toBe(1);
    expect(c.capDays).toBe(0);
    expect(c.capMax).toBe(0n);
    expect(censusGate(c).failed).toEqual(['(n) days with a negative total (charges exceed sales): 1']);
    expect(formatCensus('S1', c, 90)).toContain('(n) days with a negative total (charges exceed sales; the import refuses these): 1');
  });

  it('gate pass and fail lines; the report states (h) and carries no bodies', () => {
    expect(formatCensus('S1', run(clean), 90)).toContain('GATE PASS');
    const bad = formatCensus('S1', run(posV1SalesBody({ paidTotal: 10, receiptCount: 1, methods: { Cash: 9 } })), 90);
    expect(bad).toContain('GATE FAIL: (e1)');
    expect(bad).toContain('(h)');
  });
});
