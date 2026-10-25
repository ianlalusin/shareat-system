/**
 * T-471 slice T - the pure Z/X reading maths. docs/tasks/471-pos-day-close-z-reading.md Rulings 1, 5, 6.
 *
 * CONTRACT THE BUILDER MATCHES - module `@/lib/cash/z-reading` (pure: no firebase, no React, no server-only), exports:
 *   formatZNo(n: number): string          1 -> 'Z-0001', 12345 -> 'Z-12345'
 *   zWindow({ lastZToMs: number | null, nowMs: number }): { fromMs; toMs; spansTwoDates: boolean; fromDate: string; toDate: string }
 *       HALF-OPEN [fromMs, toMs). No previous Z: fromMs = 04:00 Manila of the shift day that contains nowMs (handover.ts getShiftDayStartMs rule).
 *       Otherwise fromMs = lastZToMs ("Z to Z"). toMs = nowMs. spansTwoDates = (toMs - fromMs) > 24 h. fromDate/toDate = Manila 'YYYY-MM-DD' of
 *       fromMs and of toMs.
 *   computeZReading({ window, lastZPrintedAtMs, receipts, conversions, handovers, cashNames }): ZReading
 *       receipts      raw Firestore receipt data (+ id): createdAtClientMs, createdAt (Timestamp-like with toMillis(), or ms), isRefund, status,
 *                     total, analytics { subtotal, discountsTotal, chargesTotal, grandTotal, statutoryDiscountTotal, mop }, statutoryDiners[],
 *                     refundTender { methodName }, refundTotalCentavos, voidCashRetained, voidCashRetainedReversed.  PESOS in, CENTAVOS out.
 *       conversions   raw paymentConversions: status, fromMethod, toMethod, amount (pesos), createdAtClientMs
 *       handovers     raw cashHandovers: periodEndMs, startingCash, deductionsTotal, manualCashAdjustment?, countedCash, variance (pesos)
 *       cashNames     ReadonlySet<string> of configured cash method names (isCashMethod from cash-method.ts decides what is cash)
 *     A receipt is COUNTED when its sale moment createdAtClientMs is in [fromMs, toMs); or it is LATE: sale moment < fromMs, lastZPrintedAtMs is
 *     not null and its arrival (createdAt) >= lastZPrintedAtMs. Late receipts are counted here and their numbers listed. Nothing else is counted.
 *     Result (all integer centavos):
 *       receiptCount (final sales, not refunds, not voided), grossCentavos (sum analytics.subtotal), chargesCentavos,
 *       discounts { ordinaryCentavos (sum discountsTotal), seniorPwd { dinerCount (sum statutoryDiners.length), centavos (sum statutoryDiscountTotal) }, totalCentavos },
 *       refunds { count, centavos (refundTotalCentavos, else |total|) }, voids { count, centavos (analytics.grandTotal, else total) },
 *       byMethod [{ method, saleCentavos (sum mop), refundCentavos (refundTender.methodName), convertCentavos (to +, from -, active only), netCentavos = sale - refund + convert }] sorted by method,
 *       totals { saleCentavos, refundCentavos, netCentavos } = the sums of the byMethod lines,
 *       convertNetCashCentavos, cash { startingCentavos, salesCentavos, convertNetCentavos, deductionsCentavos, expectedCentavos, refundsPaidCentavos },
 *       lastHandover { countedCentavos, varianceCentavos } | null, negativeMethods (names whose netCentavos < 0, sorted), lateReceiptNumbers (sorted).
 *     cash.salesCentavos = cash-method mop + voidCashRetained of voided receipts (unless voidCashRetainedReversed) - the same rule as computeCashSalesAndRefunds.
 *     Handovers: only those with periodEndMs in [fromMs, toMs). startingCentavos = the earliest one's startingCash (0 if none); deductionsCentavos = sum of
 *     their deductionsTotal; expected = computeExpectedCash (convert-net.ts) incl. their manualCashAdjustment. refundsPaidCentavos = cash-method refunds
 *     (SUBTRACTED from expected cash, bible row 391 - 23 Oct; the handover subtracts them too).
 *
 * RED FOR THE RIGHT REASON: @/lib/cash/z-reading does not exist yet - every case fails on the missing module.
 * MUTANTS: M1 window closed at the end (to counted twice); M2 first Z from midnight; M3 voided receipt counted as a sale; M4 refund added to sales;
 *   M5 senior/PWD folded into ordinary discounts; M6 late receipt dropped or double counted; M7 converts change the sale totals; M8 voided convert counted;
 *   M9 float sums (0.1 + 0.2); M10 negative flag from sale only; M11 expected cash ignores convert or deductions; M12 a handover outside the window used.
 */
import { describe, expect, it } from 'vitest';
import { computeExpectedCash } from '@/lib/cash/convert-net';
import * as z from '@/lib/cash/z-reading';

const at = (s: string) => Date.parse(`${s}+08:00`);
const CASH = new Set(['Cash']);
const FROM = at('2026-10-14T04:00:00');
const TO = at('2026-10-15T01:00:00');
const WINDOW = { fromMs: FROM, toMs: TO, spansTwoDates: false, fromDate: '2026-10-14', toDate: '2026-10-15' };

let n = 0;
const sale = (o: { ms?: number; mop?: Record<string, number>; extra?: Record<string, any>; analytics?: Record<string, any>; arrived?: number; number?: string } = {}) => {
  const ms = o.ms ?? FROM + 3_600_000;
  const mop = o.mop ?? { Cash: 100 };
  const total = Object.values(mop).reduce((a, b) => a + b, 0);
  const id = `r${++n}`;
  return {
    id, receiptNumber: o.number ?? `SHT-01-${String(n).padStart(6, '0')}`, status: 'final', createdAtClientMs: ms,
    createdAt: { toMillis: () => o.arrived ?? ms }, total,
    analytics: { subtotal: total, discountsTotal: 0, chargesTotal: 0, grandTotal: total, statutoryDiscountTotal: 0, mop, ...(o.analytics ?? {}) },
    ...(o.extra ?? {}),
  } as Record<string, any>;
};
const refund = (cents: number, method = 'Cash', ms = FROM + 7_200_000) => ({
  id: `rf${++n}`, receiptNumber: `SHT-01-9${n}`, isRefund: true, status: 'final', createdAtClientMs: ms, createdAt: { toMillis: () => ms },
  total: -cents / 100, refundTotalCentavos: cents, refundTender: { methodId: 'm', methodName: method },
}) as Record<string, any>;
const conv = (from: string, to: string, pesos: number, o: Record<string, any> = {}) => ({ status: 'active', fromMethod: from, toMethod: to, amount: pesos, createdAtClientMs: FROM + 10_000, ...o });
const handover = (o: Record<string, any> = {}) => ({ periodEndMs: FROM + 5_000_000, startingCash: 0, deductionsTotal: 0, countedCash: 0, variance: 0, ...o });
const run = (i: { receipts?: any[]; conversions?: any[]; handovers?: any[]; window?: typeof WINDOW; lastZPrintedAtMs?: number | null; countedReceiptIds?: string[] } = {}) =>
  z.computeZReading({ window: i.window ?? WINDOW, lastZPrintedAtMs: i.lastZPrintedAtMs ?? null, countedReceiptIds: new Set(i.countedReceiptIds ?? []), receipts: i.receipts ?? [], conversions: i.conversions ?? [], handovers: i.handovers ?? [], cashNames: CASH });
const line = (r: ReturnType<typeof run>, m: string) => r.byMethod.find((l) => l.method === m)!;

describe('zNo', () => {
  it('formats', () => {
    expect(z.formatZNo(1)).toBe('Z-0001');
    expect(z.formatZNo(42)).toBe('Z-0042');
    expect(z.formatZNo(12345)).toBe('Z-12345');
  });
});

describe('zWindow (Ruling 1: Z to Z, half-open)', () => {
  it('the first Z starts at 04:00 Manila of the shift day that contains now', () => {
    expect(z.zWindow({ lastZToMs: null, nowMs: at('2026-10-15T01:00:00') }).fromMs).toBe(at('2026-10-14T04:00:00')); // after midnight = previous day's shift
    expect(z.zWindow({ lastZToMs: null, nowMs: at('2026-10-15T05:30:00') }).fromMs).toBe(at('2026-10-15T04:00:00'));
    expect(z.zWindow({ lastZToMs: null, nowMs: at('2026-10-15T03:59:59') }).fromMs).toBe(at('2026-10-14T04:00:00'));
    expect(z.zWindow({ lastZToMs: null, nowMs: at('2026-10-15T04:00:00') }).fromMs).toBe(at('2026-10-15T04:00:00'));
  });
  it('after a Z the window runs from that Z to now', () => {
    const last = at('2026-10-15T01:05:00');
    const w = z.zWindow({ lastZToMs: last, nowMs: at('2026-10-16T00:40:00') });
    expect(w.fromMs).toBe(last);
    expect(w.toMs).toBe(at('2026-10-16T00:40:00'));
    expect(w.spansTwoDates).toBe(false);
    expect([w.fromDate, w.toDate]).toEqual(['2026-10-15', '2026-10-16']);
  });
  it('a forgotten Z: the next one covers both days and says so (longer than 24 hours)', () => {
    const w = z.zWindow({ lastZToMs: at('2026-10-12T01:00:00'), nowMs: at('2026-10-14T01:00:00') });
    expect(w.spansTwoDates).toBe(true);
    expect([w.fromDate, w.toDate]).toEqual(['2026-10-12', '2026-10-14']);
    expect(z.zWindow({ lastZToMs: 1_000_000, nowMs: 1_000_000 + 86_400_000 }).spansTwoDates).toBe(false);
    expect(z.zWindow({ lastZToMs: 1_000_000, nowMs: 1_000_000 + 86_400_001 }).spansTwoDates).toBe(true);
  });
  it('is the same start the handover uses (shared 04:00 Manila rule)', () => {
    // 2026-10-14T20:00Z is 2026-10-15 04:00 Manila exactly
    expect(z.zWindow({ lastZToMs: null, nowMs: Date.parse('2026-10-14T20:00:00Z') }).fromMs).toBe(Date.parse('2026-10-14T20:00:00Z'));
  });
});

describe('computeZReading - counting', () => {
  it('counts [from, to): the opening instant is in, the closing instant is out, earlier and later are out', () => {
    const r = run({ receipts: [sale({ ms: FROM }), sale({ ms: TO - 1 }), sale({ ms: TO }), sale({ ms: FROM - 1 }), sale({ ms: FROM + 1000 })] });
    expect(r.receiptCount).toBe(3);
    expect(r.totals.saleCentavos).toBe(30_000);
  });
  it('an empty day is all zeros, not an error', () => {
    const r = run();
    expect(r.receiptCount).toBe(0);
    expect(r.byMethod).toEqual([]);
    expect(r.totals).toEqual({ saleCentavos: 0, refundCentavos: 0, netCentavos: 0 });
    expect(r.cash.expectedCentavos).toBe(0);
    expect(r.lastHandover).toBeNull();
    expect(r.negativeMethods).toEqual([]);
    expect(r.lateReceiptNumbers).toEqual([]);
  });
  it('sales by payment method; sum of lines is the total', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 250.5 } }), sale({ mop: { Cash: 100, GCash: 49.25 } })] });
    expect(line(r, 'Cash').saleCentavos).toBe(35_050);
    expect(line(r, 'GCash').saleCentavos).toBe(4_925);
    expect(r.totals.saleCentavos).toBe(39_975);
    expect(r.byMethod.map((l) => l.method)).toEqual(['Cash', 'GCash']);
  });
  it('gross, charges and ordinary discounts come from the receipts', () => {
    const r = run({ receipts: [sale({ analytics: { subtotal: 1000, discountsTotal: 100, chargesTotal: 50 } }), sale({ analytics: { subtotal: 500.5, discountsTotal: 0.5, chargesTotal: 0 } })] });
    expect(r.grossCentavos).toBe(150_050);
    expect(r.discounts.ordinaryCentavos).toBe(10_050);
    expect(r.chargesCentavos).toBe(5_000);
  });
});

describe('computeZReading - senior / PWD discount stays apart (Ruling 6)', () => {
  it('counts qualifying diners and totals their discount separately; the discount total is the sum of both', () => {
    const r = run({ receipts: [
      // analytics.discountsTotal already INCLUDES the statutory discount (statutory/totals.ts totalDiscounts), so ordinary = discountsTotal - statutory.
      sale({ analytics: { discountsTotal: 180, statutoryDiscountTotal: 80 }, extra: { statutoryDiners: [{ kind: 'senior' }, { kind: 'pwd' }] } }),
      sale({ analytics: { discountsTotal: 60.25, statutoryDiscountTotal: 40.25 }, extra: { statutoryDiners: [{ kind: 'senior' }] } }),
      sale({}),
    ] });
    expect(r.discounts.ordinaryCentavos).toBe(12_000);
    expect(r.discounts.seniorPwd).toEqual({ dinerCount: 3, centavos: 12_025 });
    expect(r.discounts.totalCentavos).toBe(24_025);
  });
  it('a senior/PWD discount is counted once: the total equals the sum of discountsTotal, not discountsTotal plus statutory (row 390 double count)', () => {
    const r = run({ receipts: [sale({ analytics: { discountsTotal: 100, statutoryDiscountTotal: 100 }, extra: { statutoryDiners: [{ kind: 'senior' }] } })] });
    expect(r.discounts.ordinaryCentavos).toBe(0);
    expect(r.discounts.seniorPwd.centavos).toBe(10_000);
    expect(r.discounts.totalCentavos).toBe(10_000);
  });
});

describe('computeZReading - refunds and voids', () => {
  it('a refund is counted as a refund against its tender, never as a sale', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 500 } }), refund(12_500)] });
    expect(r.receiptCount).toBe(1);
    expect(r.refunds).toEqual({ count: 1, centavos: 12_500 });
    expect(line(r, 'Cash')).toMatchObject({ saleCentavos: 50_000, refundCentavos: 12_500, netCentavos: 37_500 });
    expect(r.totals).toEqual({ saleCentavos: 50_000, refundCentavos: 12_500, netCentavos: 37_500 });
    expect(r.cash.refundsPaidCentavos).toBe(12_500);
  });
  it('a refund without refundTotalCentavos falls back to |total|', () => {
    const rf = refund(0); delete rf.refundTotalCentavos; rf.total = -33.33;
    expect(run({ receipts: [rf] }).refunds.centavos).toBe(3_333);
  });
  it('a voided sale is not a sale: counted and totalled as a void only', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 100 } }), sale({ mop: { Cash: 300 }, extra: { status: 'voided' }, analytics: { grandTotal: 300 } })] });
    expect(r.receiptCount).toBe(1);
    expect(r.voids).toEqual({ count: 1, centavos: 30_000 });
    expect(r.totals.saleCentavos).toBe(10_000);
  });
  it('cash kept on a void is in expected cash (like computeCashSalesAndRefunds); once reversed it is not', () => {
    const voided = (retained: number, reversed?: boolean) => sale({ mop: { Cash: 300 }, extra: { status: 'voided', voidCashRetained: retained, ...(reversed ? { voidCashRetainedReversed: true } : {}) } });
    expect(run({ receipts: [sale({ mop: { Cash: 100 } }), voided(150)] }).cash.salesCentavos).toBe(25_000);
    expect(run({ receipts: [sale({ mop: { Cash: 100 } }), voided(150, true)] }).cash.salesCentavos).toBe(10_000);
    expect(run({ receipts: [sale({ mop: { Cash: 100 } }), voided(150)] }).cash.voidCashKeptCentavos).toBe(15_000);
    expect(run({ receipts: [sale({ mop: { Cash: 100 } }), voided(150, true)] }).cash.voidCashKeptCentavos).toBe(0);
    expect(run({ receipts: [voided(150)] }).totals.saleCentavos).toBe(0);
  });
});

describe('computeZReading - Convert (moves the mix, never sales)', () => {
  it('cash-in: GCash down, Cash up; sales untouched; cash convert net shown', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 1000, GCash: 800 } })], conversions: [conv('GCash', 'Cash', 200.5)] });
    expect(line(r, 'Cash')).toMatchObject({ saleCentavos: 100_000, convertCentavos: 20_050, netCentavos: 120_050 });
    expect(line(r, 'GCash')).toMatchObject({ saleCentavos: 80_000, convertCentavos: -20_050, netCentavos: 59_950 });
    expect(r.convertNetCashCentavos).toBe(20_050);
    expect(r.totals.saleCentavos).toBe(180_000);
    expect(r.totals.netCentavos).toBe(180_000);
  });
  it('cash-out is the reverse', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 1000 } })], conversions: [conv('Cash', 'GCash', 300)] });
    expect(r.convertNetCashCentavos).toBe(-30_000);
    expect(line(r, 'GCash').convertCentavos).toBe(30_000);
  });
  it('voided conversions and conversions outside the window are ignored', () => {
    const r = run({ conversions: [conv('GCash', 'Cash', 100, { status: 'voided' }), conv('GCash', 'Cash', 100, { createdAtClientMs: FROM - 1 }), conv('GCash', 'Cash', 100, { createdAtClientMs: TO })] });
    expect(r.convertNetCashCentavos).toBe(0);
    expect(r.byMethod).toEqual([]);
  });
  it('a method below zero after converts is flagged by name', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 100, GCash: 100 } })], conversions: [conv('GCash', 'Cash', 500)] });
    expect(line(r, 'GCash').netCentavos).toBe(-40_000);
    expect(r.negativeMethods).toEqual(['GCash']);
    expect(run({ receipts: [sale({ mop: { Cash: 100 } })] }).negativeMethods).toEqual([]);
  });
});

describe('computeZReading - expected cash and the last handover', () => {
  it('equals computeExpectedCash over the window\'s handovers, cash sales and Convert', () => {
    const r = run({
      receipts: [sale({ mop: { Cash: 900, GCash: 300 } })],
      conversions: [conv('GCash', 'Cash', 200)],
      handovers: [handover({ periodEndMs: FROM + 1_000_000, startingCash: 5000, deductionsTotal: 400, countedCash: 6000, variance: 10 }),
        handover({ periodEndMs: FROM + 9_000_000, startingCash: 6000, deductionsTotal: 600, manualCashAdjustment: 50, countedCash: 6400.5, variance: -12.5 })],
    });
    expect(r.cash.startingCentavos).toBe(500_000);
    expect(r.cash.salesCentavos).toBe(90_000);
    expect(r.cash.convertNetCentavos).toBe(20_000);
    expect(r.cash.deductionsCentavos).toBe(100_000);
    expect(r.cash.expectedCentavos).toBe(Math.round(computeExpectedCash({ startingCash: 5000, cashSales: 900, convertNet: 200, deductions: 1000, manualCashAdjustment: 50 }) * 100));
    expect(r.lastHandover).toEqual({ countedCentavos: 640_050, varianceCentavos: -1_250 });
  });
  it('a handover outside the window is not used; with none, start is 0 and lastHandover is null', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 100 } })], handovers: [handover({ periodEndMs: FROM - 1, startingCash: 999 }), handover({ periodEndMs: TO, startingCash: 999 })] });
    expect(r.cash.startingCentavos).toBe(0);
    expect(r.cash.expectedCentavos).toBe(10_000);
    expect(r.lastHandover).toBeNull();
  });
});

describe('computeZReading - cash refunds come off expected cash (bible row 391)', () => {
  it('expected = start + cash sales + Convert net - deductions - cash refunds; a GCash refund does not touch the drawer', () => {
    const r = run({
      receipts: [sale({ mop: { Cash: 900 } }), refund(12_500, 'Cash'), refund(40_000, 'GCash')],
      handovers: [handover({ startingCash: 100, deductionsTotal: 50 })],
    });
    expect(r.cash.refundsPaidCentavos).toBe(12_500);
    expect(r.cash.expectedCentavos).toBe(10_000 + 90_000 - 5_000 - 12_500);
  });
  it('a refund outside the window, or voided, is not subtracted; one inside is (same createdAtClientMs rule as sales)', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 500 } }), refund(10_000, 'Cash', FROM - 1), refund(20_000, 'Cash', TO), { ...refund(30_000, 'Cash'), status: 'voided' }, refund(4_000, 'Cash', FROM)] });
    expect(r.cash.expectedCentavos).toBe(50_000 - 4_000);
  });
});

describe('computeZReading - late arrivals (Ruling 5)', () => {
  const LAST_Z_PRINTED = FROM + 1000;
  it('rung before the last Z but arrived after it: counted now, listed by number', () => {
    const late = sale({ ms: FROM - 60_000, arrived: LAST_Z_PRINTED + 5000, number: 'SHT-02-000777', mop: { Cash: 80 } });
    const r = run({ receipts: [late, sale({ mop: { Cash: 20 } })], lastZPrintedAtMs: LAST_Z_PRINTED });
    expect(r.receiptCount).toBe(2);
    expect(r.totals.saleCentavos).toBe(10_000);
    expect(r.lateReceiptNumbers).toEqual(['SHT-02-000777']);
  });
  it('rung before the last Z and arrived before it: already on that Z, not counted again', () => {
    const early = sale({ ms: FROM - 60_000, arrived: LAST_Z_PRINTED - 1, number: 'SHT-02-000778' });
    const r = run({ receipts: [early], lastZPrintedAtMs: LAST_Z_PRINTED });
    expect(r.receiptCount).toBe(0);
    expect(r.lateReceiptNumbers).toEqual([]);
  });
  it('the very first Z has no "late": old receipts are simply outside', () => {
    const r = run({ receipts: [sale({ ms: FROM - 60_000, arrived: TO })], lastZPrintedAtMs: null });
    expect(r.receiptCount).toBe(0);
  });
  it('a late refund is counted too, and a receipt in the window is never listed as late', () => {
    const lateRefund = refund(5_000, 'Cash', FROM - 1000); lateRefund.createdAt = { toMillis: () => LAST_Z_PRINTED + 1 };
    const r = run({ receipts: [lateRefund, sale({ number: 'SHT-01-IN' })], lastZPrintedAtMs: LAST_Z_PRINTED });
    expect(r.refunds.count).toBe(1);
    expect(r.lateReceiptNumbers).toEqual([lateRefund.receiptNumber]);
  });
});

describe('computeZReading - a receipt is on one Z only (receiptIds)', () => {
  const LAST_Z_PRINTED = FROM + 1000;
  it('a late receipt whose id an earlier Z already counted is NOT counted again', () => {
    const raced = sale({ ms: FROM - 1, arrived: LAST_Z_PRINTED + 1, number: 'SHT-02-000900', mop: { Cash: 80 } });
    const r = run({ receipts: [raced], lastZPrintedAtMs: LAST_Z_PRINTED, countedReceiptIds: [String(raced.id)] });
    expect(r.receiptCount).toBe(0);
    expect(r.lateReceiptNumbers).toEqual([]);
    expect(r.receiptIds).toEqual([]);
  });
  it('lists the id of every receipt it counted: sales, refunds, voids and late ones; not the ones it skipped', () => {
    const late = sale({ ms: FROM - 60_000, arrived: LAST_Z_PRINTED + 5000, mop: { Cash: 80 } });
    const inside = sale({ mop: { Cash: 20 } });
    const voided = sale({ mop: { Cash: 5 }, extra: { status: 'voided' } });
    const rf = refund(1_000);
    const outside = sale({ ms: FROM - 60_000, arrived: LAST_Z_PRINTED - 1 });
    const r = run({ receipts: [late, inside, voided, rf, outside], lastZPrintedAtMs: LAST_Z_PRINTED });
    expect([...r.receiptIds].sort()).toEqual([late.id, inside.id, voided.id, rf.id].map(String).sort());
  });
});

describe('computeZReading - integer centavos and totals = sum of lines (property)', () => {
  it('0.1 + 0.2 style pesos never leave a fraction of a centavo', () => {
    const r = run({ receipts: [sale({ mop: { Cash: 0.1 } }), sale({ mop: { Cash: 0.2 } })] });
    expect(r.totals.saleCentavos).toBe(30);
  });
  it('200 random days: every total equals the sum of its lines, everything is a safe integer', () => {
    let seed = 20261023;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const peso = () => Math.round(rnd() * 500000) / 100;
    const methods = ['Cash', 'GCash', 'Card', 'Maya'];
    for (let day = 0; day < 200; day++) {
      const receipts: any[] = [];
      for (let i = 0; i < Math.floor(rnd() * 25); i++) {
        const kind = rnd();
        const ms = FROM + Math.floor(rnd() * (TO - FROM));
        if (kind < 0.12) receipts.push(refund(Math.round(peso() * 100), methods[Math.floor(rnd() * 4)]!, ms));
        else {
          const mop: Record<string, number> = {};
          for (const m of methods) if (rnd() < 0.4) mop[m] = peso();
          if (!Object.keys(mop).length) mop.Cash = peso();
          receipts.push(sale({ ms, mop, extra: kind < 0.2 ? { status: 'voided', voidCashRetained: peso() } : kind < 0.35 ? { statutoryDiners: [{ kind: 'senior' }] } : {},
            analytics: (() => { const stat = kind < 0.35 ? peso() : 0; return { subtotal: peso(), discountsTotal: Math.round((peso() + stat) * 100) / 100, statutoryDiscountTotal: stat, chargesTotal: peso() }; })() }));
        }
      }
      const conversions = Array.from({ length: Math.floor(rnd() * 5) }, () => { const a = Math.floor(rnd() * 4); return conv(methods[a]!, methods[(a + 1 + Math.floor(rnd() * 3)) % 4]!, peso(), { createdAtClientMs: FROM + Math.floor(rnd() * (TO - FROM)) }); });
      const r = run({ receipts, conversions });
      const sum = (f: (l: (typeof r.byMethod)[number]) => number) => r.byMethod.reduce((a, l) => a + f(l), 0);
      expect(r.totals.saleCentavos).toBe(sum((l) => l.saleCentavos));
      expect(r.totals.refundCentavos).toBe(sum((l) => l.refundCentavos));
      expect(r.totals.netCentavos).toBe(sum((l) => l.netCentavos));
      expect(r.totals.netCentavos).toBe(r.totals.saleCentavos - r.totals.refundCentavos); // converts move money between lines, they add none
      expect(sum((l) => l.convertCentavos)).toBe(0);
      expect(r.discounts.totalCentavos).toBe(r.discounts.ordinaryCentavos + r.discounts.seniorPwd.centavos);
      expect(r.discounts.totalCentavos).toBe(receipts.filter((x) => !x.isRefund && x.status !== 'voided').reduce((n, x) => n + Math.round(x.analytics.discountsTotal * 100), 0)); // each peso of discount once
      expect(r.cash.expectedCentavos).toBe(r.cash.startingCentavos + r.cash.salesCentavos + r.cash.convertNetCentavos - r.cash.deductionsCentavos - r.cash.refundsPaidCentavos);
      for (const l of r.byMethod) expect(l.netCentavos).toBe(l.saleCentavos - l.refundCentavos + l.convertCentavos);
      expect(r.negativeMethods).toEqual(r.byMethod.filter((l) => l.netCentavos < 0).map((l) => l.method).sort());
      const walk = (v: unknown) => { if (typeof v === 'number') expect(Number.isSafeInteger(v)).toBe(true); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
      walk({ ...r, byMethod: r.byMethod.map(({ method: _m, ...nums }) => nums), negativeMethods: [], lateReceiptNumbers: [] });
    }
  });
});

describe('T-474 DEF-759: manual cash adjustments are reported on the reading', () => {
  it('cash.manualAdjustmentCentavos is the signed sum of the window handovers\' manualCashAdjustment, in integer centavos', () => {
    const r = run({ handovers: [handover({ startingCash: 100, manualCashAdjustment: 20 }), handover({ periodEndMs: FROM + 6_000_000, manualCashAdjustment: -5.25 })] });
    expect(r.cash.manualAdjustmentCentavos).toBe(1_475);
    expect(r.cash.startingCentavos).toBe(10_000);
    expect(r.cash.expectedCentavos).toBe(11_475);
  });
  it('is 0 with no handover', () => {
    expect(run().cash.manualAdjustmentCentavos).toBe(0);
  });
  it('property: start + (cash sales - kept) + kept + convert + manual - deductions - refunds = expected (200 random days)', () => {
    let seed = 7741;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const peso = () => Math.round(rnd() * 100000) / 100;
    for (let day = 0; day < 200; day++) {
      const receipts: any[] = [];
      for (let i = 0; i < Math.floor(rnd() * 15); i++) {
        const ms = FROM + Math.floor(rnd() * (TO - FROM));
        if (rnd() < 0.15) receipts.push(refund(Math.round(peso() * 100), 'Cash', ms));
        else receipts.push(sale({ ms, mop: { Cash: peso() }, extra: rnd() < 0.2 ? { status: 'voided', voidCashRetained: peso() } : {} }));
      }
      const handovers = Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => handover({ periodEndMs: FROM + 1_000_000 * (k + 1), startingCash: peso(), deductionsTotal: peso(), manualCashAdjustment: rnd() < 0.5 ? peso() : -peso() }));
      const r = run({ receipts, handovers, conversions: [conv('GCash', 'Cash', peso())] });
      const c = r.cash;
      expect(c.expectedCentavos).toBe(c.startingCentavos + (c.salesCentavos - c.voidCashKeptCentavos) + c.voidCashKeptCentavos + c.convertNetCentavos + c.manualAdjustmentCentavos! - c.deductionsCentavos - c.refundsPaidCentavos);
    }
  });
});
