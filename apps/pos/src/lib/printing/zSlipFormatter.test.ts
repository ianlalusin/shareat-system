/**
 * T-471 slice T - the Z / X reading slip text. docs/tasks/471-pos-day-close-z-reading.md Ruling 7.
 *
 * CONTRACT THE BUILDER MATCHES - `@/lib/printing/zSlipFormatter` (pure; no firebase, no React), exports:
 *   ZSLIP_HEADER = 'Z-READING — cash control, not a BIR document'
 *   ZSLIP_FOOTER = "The ERP's sales day still follows midnight until the shared database (P2)."
 *   formatZSlip(i: { kind: 'X' | 'Z'; storeName: string; zNo: string | null; window: ZWindow; reading: ZReading; printedBy: string; approvedBy: string | null; widthMm?: 58 | 80 }): string
 *     Same widths and helpers as the X-slip: 48 characters at 80 mm (default), 32 at 58 mm, no line longer. Header is ZSLIP_HEADER for 'Z', XSLIP_HEADER for 'X'.
 *     Times are MANILA time ('YYYY-MM-DD HH:mm'), whatever the tablet's clock zone. Amounts are formatCentavos text.
 *     Layout (the golden below): header (wrapped), rule, store, 'Z number: Z-0007' (Z) or 'Reading so far - the day is NOT closed' (X), From, To,
 *     'Spans two dates: <from> to <to>' only when it does, rule, Receipts, Gross sales, Charges, Discounts, 'Senior/PWD (<n> diners)', 'Refunds (<n>)',
 *     'Voided sales (<n>)', rule, 'BY PAYMENT METHOD' with Sale / Refund / Convert / Net per method, Total sales / Total refunds / Net, rule, 'CASH IN THE DRAWER'
 *     (Starting cash, Cash sales, Convert net, Less deductions, Less cash refunds, Expected cash, and - only when a handover exists - Counted at handover, Variance),
 *     then 'LATE FROM AN EARLIER DAY' + numbers and 'BELOW ZERO: <methods>' when present, rule, Printed by, Approved by (Z only), rule, ZSLIP_FOOTER.
 *
 * RED FOR THE RIGHT REASON: @/lib/printing/zSlipFormatter does not exist yet - every case fails on the missing module.
 * MUTANTS: M1 wrong header for X or Z; M2 local time instead of Manila; M3 a line over the width; M4 senior/PWD merged into discounts; M5 footer or header text missing;
 *   M6 spans line missing; M7 X shows 'Approved by'; M8 negative method not shown.
 */
import { describe, expect, it } from 'vitest';
import type { ZReading } from '@/lib/cash/z-reading';
import { XSLIP_HEADER } from '@/lib/printing/xSlipFormatter';
import * as zs from '@/lib/printing/zSlipFormatter';

const WINDOW = { fromMs: Date.parse('2026-10-14T04:00:00+08:00'), toMs: Date.parse('2026-10-15T01:00:00+08:00'), spansTwoDates: false, fromDate: '2026-10-14', toDate: '2026-10-15' };
const READING: ZReading = {
  receiptCount: 12, grossCentavos: 1_380_000, chargesCentavos: 0,
  discounts: { ordinaryCentavos: 50_000, seniorPwd: { dinerCount: 2, centavos: 80_000 }, totalCentavos: 130_000 },
  refunds: { count: 1, centavos: 25_000 }, voids: { count: 1, centavos: 60_000 },
  byMethod: [
    { method: 'Cash', saleCentavos: 900_000, refundCentavos: 25_000, convertCentavos: 20_000, netCentavos: 895_000 },
    { method: 'GCash', saleCentavos: 350_000, refundCentavos: 0, convertCentavos: -20_000, netCentavos: 330_000 },
  ],
  totals: { saleCentavos: 1_250_000, refundCentavos: 25_000, netCentavos: 1_225_000 },
  convertNetCashCentavos: 20_000,
  cash: { startingCentavos: 500_000, salesCentavos: 900_000, convertNetCentavos: 20_000, deductionsCentavos: 100_000, expectedCentavos: 1_295_000, refundsPaidCentavos: 25_000, voidCashKeptCentavos: 30_000 },
  lastHandover: { countedCentavos: 1_285_000, varianceCentavos: -10_000 },
  negativeMethods: [], lateReceiptNumbers: [],
};
const base = { kind: 'Z' as const, storeName: 'Shareat Test', zNo: 'Z-0007', window: WINDOW, reading: READING, printedBy: 'Cora Cashier', approvedBy: 'person-mgr-1' };

/** The X-slip's own two-column rule: left padded (or cut) so the line is exactly `width` wide. */
const two = (w: number, left: string, right: string) => { const room = Math.max(1, w - right.length - 1); return `${left.length > room ? left.slice(0, room) : left.padEnd(room)} ${right}`; };
const FOOT80 = ["The ERP's sales day still follows midnight until", 'the shared database (P2).'];
const BODY = (w: number) => [
  'Receipts: 12',
  two(w, 'Gross sales', '13,800.00'), two(w, 'Charges', '0.00'), two(w, 'Discounts', '500.00'), two(w, 'Senior/PWD (2 diners)', '800.00'),
  two(w, 'Refunds (1)', '250.00'), two(w, 'Voided sales (1)', '600.00'),
  '-'.repeat(w), 'BY PAYMENT METHOD',
  'Cash', two(w, '  Sale', '9,000.00'), two(w, '  Refund', '250.00'), two(w, '  Convert', '200.00'), two(w, '  Net', '8,950.00'),
  'GCash', two(w, '  Sale', '3,500.00'), two(w, '  Refund', '0.00'), two(w, '  Convert', '-200.00'), two(w, '  Net', '3,300.00'),
  two(w, 'Total sales', '12,500.00'), two(w, 'Total refunds', '250.00'), two(w, 'Net', '12,250.00'),
  '-'.repeat(w), 'CASH IN THE DRAWER',
  two(w, 'Starting cash', '5,000.00'), two(w, 'Cash sales', '8,700.00'), two(w, 'Cash kept on voided sales', '300.00'), two(w, 'Convert net', '200.00'), two(w, 'Less deductions', '1,000.00'),
  two(w, 'Less cash refunds', '250.00'), two(w, 'Expected cash', '12,950.00'), two(w, 'Counted at handover', '12,850.00'), two(w, 'Variance', '-100.00'),
  '-'.repeat(w), 'Printed by: Cora Cashier', 'Approved by: person-mgr-1', '-'.repeat(w),
];

describe('golden text (Z)', () => {
  it('80 mm', () => {
    const w = 48;
    const expected = [
      'Z-READING — cash control, not a BIR document', '-'.repeat(w), 'Shareat Test', 'Z number: Z-0007', 'From: 2026-10-14 04:00', 'To:   2026-10-15 01:00', '-'.repeat(w),
      ...BODY(w), ...FOOT80,
    ].join('\n');
    expect(zs.formatZSlip(base)).toBe(expected);
  });
  it('58 mm', () => {
    const w = 32;
    const expected = [
      'Z-READING — cash control, not a', 'BIR document', '-'.repeat(w), 'Shareat Test', 'Z number: Z-0007', 'From: 2026-10-14 04:00', 'To:   2026-10-15 01:00', '-'.repeat(w),
      ...BODY(w), "The ERP's sales day still", 'follows midnight until the', 'shared database (P2).',
    ].join('\n');
    expect(zs.formatZSlip({ ...base, widthMm: 58 })).toBe(expected);
  });
  it('exports the header and footer texts', () => {
    expect(zs.ZSLIP_HEADER).toBe('Z-READING — cash control, not a BIR document');
    expect(zs.ZSLIP_FOOTER).toBe("The ERP's sales day still follows midnight until the shared database (P2).");
  });
});

describe('the cash lines add up to expected cash', () => {
  const cents = (line: string) => Number(/(-?[\d,]+\.\d{2})$/.exec(line)![1]!.replace(/[,.]/g, ''));
  const sumOf = (reading: ZReading, widthMm: 58 | 80) => {
    const lines = zs.formatZSlip({ ...base, reading, widthMm }).split(String.fromCharCode(10));
    const from = lines.indexOf('CASH IN THE DRAWER') + 1;
    const to = lines.findIndex((l) => l.startsWith('Expected cash'));
    let total = 0;
    for (const l of lines.slice(from, to)) total += (l.startsWith('Less ') ? -1 : 1) * cents(l);
    return { total, expected: cents(lines[to]!) };
  };
  it('start + cash sales + cash kept on voided sales + convert - deductions - cash refunds = expected, to the centavo', () => {
    for (const w of [80, 58] as const) { const r = sumOf(READING, w); expect(r.total).toBe(r.expected); expect(r.expected).toBe(1_295_000); }
  });
  it('cash kept on voided sales is its own line, above expected cash, and Cash sales no longer hides it', () => {
    const text = zs.formatZSlip(base);
    expect(text).toContain('Cash kept on voided sales');
    expect(text.indexOf('Cash kept on voided sales')).toBeLessThan(text.indexOf('Expected cash'));
    expect(text).toMatch(/Cash sales +8,700\.00/);
  });
  it('still reconciles when there is no void cash and when the figures are odd centavos', () => {
    const odd: ZReading = { ...READING, cash: { startingCentavos: 12_345, salesCentavos: 67_891, convertNetCentavos: -1_001, deductionsCentavos: 5_005, expectedCentavos: 12_345 + 67_891 - 1_001 - 5_005 - 333, refundsPaidCentavos: 333, voidCashKeptCentavos: 0 } };
    const r = sumOf(odd, 80);
    expect(r.total).toBe(r.expected);
  });
});

describe('content rules', () => {
  it('times are Manila time even on a machine in another zone (the formatter never uses the local clock)', () => {
    const text = zs.formatZSlip({ ...base, window: { ...WINDOW, fromMs: Date.parse('2026-10-14T20:00:00Z'), toMs: Date.parse('2026-10-15T17:05:00Z') } });
    expect(text).toContain('From: 2026-10-15 04:00');
    expect(text).toContain('To:   2026-10-16 01:05');
  });
  it('the X-reading uses the X header, says the day is not closed, and has no approver or Z number', () => {
    const text = zs.formatZSlip({ ...base, kind: 'X', zNo: null, approvedBy: null });
    expect(text.split('\n')[0]).toBe(XSLIP_HEADER);
    expect(text).toContain('Reading so far - the day is NOT closed');
    expect(text).not.toContain('Z number');
    expect(text).not.toContain('Approved by');
    expect(text).toContain("The ERP's sales day still follows midnight");
  });
  it('a window that spans two dates says so with both dates', () => {
    const text = zs.formatZSlip({ ...base, window: { ...WINDOW, spansTwoDates: true, fromDate: '2026-10-12', toDate: '2026-10-14' } });
    expect(text).toContain('Spans two dates: 2026-10-12 to 2026-10-14');
    expect(zs.formatZSlip(base)).not.toContain('Spans two dates');
  });
  it('lists late receipts by number and the methods below zero', () => {
    const text = zs.formatZSlip({ ...base, reading: { ...READING, lateReceiptNumbers: ['SHT-02-000777', 'SHT-02-000780'], negativeMethods: ['GCash', 'Maya'] } });
    expect(text).toContain('LATE FROM AN EARLIER DAY');
    expect(text).toContain('SHT-02-000777');
    expect(text).toContain('SHT-02-000780');
    expect(text).toContain('BELOW ZERO: GCash, Maya');
    expect(zs.formatZSlip(base)).not.toContain('LATE FROM');
    expect(zs.formatZSlip(base)).not.toContain('BELOW ZERO');
  });
  it('with no handover the counted and variance lines are left out', () => {
    const text = zs.formatZSlip({ ...base, reading: { ...READING, lastHandover: null } });
    expect(text).not.toContain('Counted at handover');
    expect(text).not.toContain('Variance');
    expect(text).toContain('Expected cash');
  });
  it('no line is ever longer than the paper, even with a long store name, long names and many late numbers', () => {
    for (const widthMm of [58, 80] as const) {
      const w = widthMm === 58 ? 32 : 48;
      const text = zs.formatZSlip({ ...base, widthMm, storeName: 'Shareat Restaurant and Catering Services Incorporated - Main Branch', printedBy: 'Maria Cristina Dela Cruz-Santos', approvedBy: 'person-with-a-very-long-identifier-0123456789',
        window: { ...WINDOW, spansTwoDates: true, fromDate: '2026-10-12', toDate: '2026-10-14' },
        reading: { ...READING, lateReceiptNumbers: Array.from({ length: 5 }, (_, i) => `SHT-02-00077${i}`), negativeMethods: ['GCash', 'Maya', 'Online Bank Transfer Method'] } });
      for (const l of text.split('\n')) expect(l.length, `${widthMm}mm: "${l}"`).toBeLessThanOrEqual(w);
    }
  });
  it('negative money shows with a minus sign, whole centavos only', () => {
    expect(zs.formatZSlip({ ...base, reading: { ...READING, lastHandover: { countedCentavos: 99, varianceCentavos: -5 } } })).toContain(two(48, 'Variance', '-0.05'));
  });
});
