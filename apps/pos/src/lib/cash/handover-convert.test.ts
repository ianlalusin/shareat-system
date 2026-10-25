/**
 * T-427 slice T - drawer reconciliation (Ruling 5, Acceptance 7).
 *
 * CONTRACT: new PURE module @/lib/cash/convert-net (no firebase import):
 *   convertNetPesos(docs: ConversionLike[], fromMs: number, toMs: number, isCashKey: (name: string) => boolean): number
 *       ConversionLike = { status?: string; fromMethod: string; toMethod: string; amount: number (pesos); createdAtClientMs: number; source?: string }
 *       Sums EVERY active doc (v1, pos2-convert, pos2-correction alike) whose createdAtClientMs is in [fromMs, toMs] (inclusive):
 *       to-method cash => +amount, from-method cash => -amount (both cash or neither => 0). Voided docs ignored. Result in pesos, exact to the centavo.
 *   computeExpectedCash(i: { startingCash: number; cashSales: number; convertNet: number; deductions: number }): number   // start + sales + convertNet - deductions
 *   convertLineText(convertNet: number): string | null     // 'Convert and tender fixes: +₱1,150.00' / '...: −₱300.00' (U+2212) ; null when 0
 *   buildHandoverRecord(i: { startingCash; cashSales; convertNet; deductions; countedCash: number }): { expectedCash: number; convertNet: number; variance: number; ... }
 *       the saved cashHandovers doc: convertNet saved so Expected = Starting + Cash sales + convertNet - Deductions in history/export.
 *   negativeMethods(byMethod: Record<string, number>): string[]    // names strictly below zero, sorted
 *   NEGATIVE_METHOD_NOTICE = 'A payment method is below zero today; the office must check this day.'
 * RED: the module does not exist yet (fails on the missing module).   MUTANTS: M1 conversions ignored (v1's gap); M2 only pos2-convert counted (v1/correction skipped);
 *   M3 voided counted; M4 window ignored; M5 sign flipped; M6 non-cash conversion counted; M7 convertNet not saved; M8 float drift.
 */
import { describe, expect, it } from 'vitest';
import { NEGATIVE_METHOD_NOTICE, buildHandoverRecord, computeExpectedCash, convertLineText, convertNetPesos, negativeMethods, handoverReadFrom, parseCashAdjustment } from '@/lib/cash/convert-net';

const FROM = Date.parse('2026-10-14T08:00:00+08:00');
const TO = Date.parse('2026-10-14T20:00:00+08:00');
const at = (h: number) => Date.parse(`2026-10-14T${String(h).padStart(2, '0')}:00:00+08:00`);
// Cash and GCash are different tenders. A substring callback would make every cash/wallet move net to zero.
const isCash = (k: string) => k === 'Cash' || /\bcash\b/i.test(k);
const doc = (over: Record<string, unknown>) => ({ status: 'active', fromMethod: 'GCash', toMethod: 'Cash', amount: 100, createdAtClientMs: at(12), ...over }) as any;

const acceptance7 = () => [
  doc({ source: 'pos2-convert', amount: 1200 }), // cash-in  +1200
  doc({ source: 'pos2-convert', fromMethod: 'Cash', toMethod: 'GCash', amount: 300 }), // cash-out -300
  doc({ source: 'pos2-correction', amount: 150 }), // GCash -> Cash tender correction +150
  doc({ amount: 100 }), // v1 conversion cash-in +100 (no source)
];

describe('Acceptance 7 - shift-close reconciliation', () => {
  it('manual adjustments use exact signed centavos and refuse malformed typed amounts', () => {
    expect(parseCashAdjustment('')).toBe(0); expect(parseCashAdjustment(' +0.10 ')).toBe(10); expect(parseCashAdjustment('-100.25')).toBe(-10025);
    for (const invalid of ['1e2', '1.234', '--5', '0x10']) expect(() => parseCashAdjustment(invalid)).toThrow();
  });
  it('an explicit signed adjustment is retained with its reason and included exactly once', () => {
    const record = buildHandoverRecord({ startingCash: 2000, cashSales: 5000, convertNet: 1150, deductions: 0,
      countedCash: 8300.25, manualCashAdjustment: 150.25, manualCashAdjustmentReason: '  Offline cash not yet synced  ' });
    expect(record).toMatchObject({ expectedCash: 8300.25, variance: 0, manualCashAdjustment: 150.25, manualCashAdjustmentReason: 'Offline cash not yet synced' });
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: 1150, deductions: 0, manualCashAdjustment: -0.1 })).toBe(8149.9);
    expect(() => buildHandoverRecord({ startingCash: 0, cashSales: 0, convertNet: 0, deductions: 0, countedCash: 0, manualCashAdjustment: 1 }))
      .toThrow('Say why cash sales are being adjusted.');
  });
  it('consecutive windows include a boundary movement exactly once; the first window includes its opening instant', () => {
    const docs = [doc({ createdAtClientMs: 1500, amount: 100 })];
    const first = convertNetPesos(docs, handoverReadFrom(1000, false), 1500, isCash);
    const next = convertNetPesos(docs, handoverReadFrom(1500, true), 2000, isCash);
    expect(first).toBe(100); expect(next).toBe(0);
    expect(handoverReadFrom(1500, false)).toBe(1500);
  });
  it('start 2,000 + cash sales 5,000 + convert net 1,150 - deductions 0 = expected 8,150; the line shows +1,150; the saved doc has convertNet 1150', () => {
    const net = convertNetPesos(acceptance7(), FROM, TO, isCash);
    expect(net).toBe(1150);
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: net, deductions: 0 })).toBe(8150);
    expect(convertLineText(net)).toBe('Convert and tender fixes: +₱1,150.00');
    const rec = buildHandoverRecord({ startingCash: 2000, cashSales: 5000, convertNet: net, deductions: 0, countedCash: 8100 });
    expect(rec.convertNet).toBe(1150);
    expect(rec.expectedCash).toBe(8150);
    expect(rec.variance).toBe(-50);
    expect(rec.expectedCash).toBe(2000 + 5000 + rec.convertNet - 0);
  });

  it('row 391: cash refunds come off expected cash and are stored on the handover record', () => {
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: 0, deductions: 250, cashRefunds: 125.5 })).toBe(6624.5);
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: 0, deductions: 0 })).toBe(7000); // omitted = none
    const rec = buildHandoverRecord({ startingCash: 2000, cashSales: 5000, convertNet: 0, deductions: 0, cashRefunds: 100, countedCash: 6900 });
    expect(rec).toMatchObject({ expectedCash: 6900, cashRefunds: 100, variance: 0 });
  });
  it('deductions still subtract, and a negative net shows a minus sign', () => {
    const net = convertNetPesos([doc({ fromMethod: 'Cash', toMethod: 'GCash', amount: 300 })], FROM, TO, isCash);
    expect(net).toBe(-300);
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: net, deductions: 250 })).toBe(6450);
    expect(convertLineText(net)).toBe('Convert and tender fixes: −₱300.00');
  });

  it('no conversions: net 0, no line, expected is the old formula (M1)', () => {
    expect(convertNetPesos([], FROM, TO, isCash)).toBe(0);
    expect(convertLineText(0)).toBeNull();
    expect(computeExpectedCash({ startingCash: 2000, cashSales: 5000, convertNet: 0, deductions: 0 })).toBe(7000);
  });

  it('voided, out-of-window and non-cash conversions are ignored; the window ends are inclusive (M3, M4, M6)', () => {
    const docs = [
      doc({ status: 'voided', amount: 999 }),
      doc({ createdAtClientMs: FROM - 1, amount: 998 }),
      doc({ createdAtClientMs: TO + 1, amount: 997 }),
      doc({ fromMethod: 'GCash', toMethod: 'Maya', amount: 996 }),
      doc({ createdAtClientMs: FROM, amount: 10 }),
      doc({ createdAtClientMs: TO, amount: 5 }),
    ];
    expect(convertNetPesos(docs, FROM, TO, isCash)).toBe(15);
  });

  it('v1 docs and pos2-correction docs count as much as pos2-convert (M2); sign: to-cash adds, from-cash subtracts (M5)', () => {
    expect(convertNetPesos([doc({ source: undefined, amount: 40 })], FROM, TO, isCash)).toBe(40);
    expect(convertNetPesos([doc({ source: 'pos2-correction', amount: 40 })], FROM, TO, isCash)).toBe(40);
    expect(convertNetPesos([doc({ source: 'pos2-correction', fromMethod: 'Cash', toMethod: 'Card', amount: 40 })], FROM, TO, isCash)).toBe(-40);
  });

  it('centavo amounts add up exactly (M8)', () => {
    const docs = [doc({ amount: 0.1 }), doc({ amount: 0.2 }), doc({ amount: 100.05 })];
    expect(convertNetPesos(docs, FROM, TO, isCash)).toBe(100.35);
    expect(computeExpectedCash({ startingCash: 0.1, cashSales: 0.2, convertNet: 0, deductions: 0 })).toBe(0.3);
  });
});

describe('the negative-day notice on the handover screen', () => {
  it('lists the methods strictly below zero, sorted; nothing when none', () => {
    expect(negativeMethods({ Cash: 1500, GCash: -200, Maya: -0.01, Card: 0 })).toEqual(['GCash', 'Maya']);
    expect(negativeMethods({ Cash: 0, GCash: 10 })).toEqual([]);
    expect(negativeMethods({})).toEqual([]);
  });
  it('has the exact sentence', () => {
    expect(NEGATIVE_METHOD_NOTICE).toBe('A payment method is below zero today; the office must check this day.');
  });
});
