import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import * as print from './index';

/**
 * T-558 R3 (TESTER) - the X and Z slips print the "Short payments" line. docs/tasks/558-pos-sale-variance-tolerance.md R3.
 *
 * FIXED BY THE SPEC: the slips print "Short payments" with the amount, plus the count of findings when there are any. Exact arrays at 32 columns (58 mm) and 48 (80 mm).
 * ASSUMED BY THIS TESTER (the spec gives no paper layout; edit the arrays here with the planner's word):
 *   - the label is upper case like every other row: `SHORT PAYMENTS`; the findings row is `SHORT PAY FINDINGS`, printed only when the count is above zero;
 *   - both rows sit right after the tender rows and before `TO CHECK (wallet)` / `LATE RECEIPTS` (they are part of the money, the to-check and late counts are for looking at);
 *   - the amount prints as a plain positive figure (no minus sign: it is money NOT collected, shown like a tender figure, not like a discount);
 *   - when the short-payment amount is zero NEITHER row prints (like a zero discount row), and a slip with the two fields at zero is byte-for-byte the slip of before.
 * ASSUMED API (apps/erp/src/lib/pos-print/types.ts): ReadingSlipView gains `varianceTotal: Money` and `shortfallCount: number` (both come from `readingFor`: `varianceTotal`
 * and `shortfallCount`). A view WITHOUT them (every T-531 caller) must still print as before: the builder makes them optional or updates the callers.
 *
 * RED NOW FOR THE RIGHT REASON: the formatters do not print the rows, so the exact arrays differ by the missing lines.
 */
type Fmt = (view: unknown, layout: { width: 58 | 80; font: 'small' | 'normal' }) => string[];
const formatter = (name: 'formatXSlip' | 'formatZSlip'): Fmt => (print as unknown as Record<string, Fmt>)[name]!;

const header = { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true };
const base = () => ({
  header, printedBy: 'Cara Counter', windowFromLocal: '02/11/26 04:00', windowToLocal: '02/11/26 22:30', spansTwoDates: false,
  receiptCount: 3, subtotal: money('3075.00'), discounts: { senior: money('128.29'), pwd: money('0.00'), other: money('50.00') }, discountTotal: money('178.29'),
  grossTotal: money('2896.71'), unliSales: money('2245.00'), alaCarteSales: money('830.00'), heads: 5, packageSessions: 2, seniorPwdDiners: 1,
  tenders: [{ name: 'Cash', amount: money('2396.71') }, { name: 'GCash', amount: money('500.00') }], toCheckCount: 1, lateCount: 1,
});
const zOf = (o: Record<string, unknown>) => ({ ...base(), spansTwoDates: true, zNo: 1, businessDateLocal: '02/11/26', approvedBy: 'Manny Manager', reprint: false, ...o });
const L32 = { width: 58 as const, font: 'normal' as const };
const L48 = { width: 80 as const, font: 'normal' as const };

const X_32_A: string[] = [
  '          SHAREAT LIPA',
  '      Lipa City, Batangas',
  '    TIN: 123-456-789-000 VAT',
  '',
  '           X-READING',
  'Reading so far - the day is NOT',
  '             closed',
  'FROM:             02/11/26 04:00',
  'TO:               02/11/26 22:30',
  'PRINTED BY:         Cara Counter',
  '--------------------------------',
  'RECEIPTS                       3',
  'SUBTOTAL                3,075.00',
  'SENIOR DISCOUNT          -128.29',
  'OTHER DISCOUNT            -50.00',
  'TOTAL DISCOUNTS          -178.29',
  'GROSS TOTAL             2,896.71',
  '--------------------------------',
  'UNLI SALES              2,245.00',
  'A LA CARTE SALES          830.00',
  'HEADS                          5',
  'PACKAGE SESSIONS               2',
  'SENIOR/PWD DINERS              1',
  '--------------------------------',
  'Cash                    2,396.71',
  'GCash                     500.00',
  'SHORT PAYMENTS              0.51',
  'SHORT PAY FINDINGS             1',
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const X_32_B: string[] = [
  '          SHAREAT LIPA',
  '      Lipa City, Batangas',
  '    TIN: 123-456-789-000 VAT',
  '',
  '           X-READING',
  'Reading so far - the day is NOT',
  '             closed',
  'FROM:             02/11/26 04:00',
  'TO:               02/11/26 22:30',
  'PRINTED BY:         Cara Counter',
  '--------------------------------',
  'RECEIPTS                       3',
  'SUBTOTAL                3,075.00',
  'SENIOR DISCOUNT          -128.29',
  'OTHER DISCOUNT            -50.00',
  'TOTAL DISCOUNTS          -178.29',
  'GROSS TOTAL             2,896.71',
  '--------------------------------',
  'UNLI SALES              2,245.00',
  'A LA CARTE SALES          830.00',
  'HEADS                          5',
  'PACKAGE SESSIONS               2',
  'SENIOR/PWD DINERS              1',
  '--------------------------------',
  'Cash                    2,396.71',
  'GCash                     500.00',
  'SHORT PAYMENTS              0.01',
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const Z_32_A: string[] = [
  '          SHAREAT LIPA',
  '      Lipa City, Batangas',
  '    TIN: 123-456-789-000 VAT',
  '',
  '           Z-READING',
  'Z NO:                     Z-0001',
  'BUSINESS DATE:          02/11/26',
  'FROM:             02/11/26 04:00',
  'TO:               02/11/26 22:30',
  '        Spans two dates',
  'PRINTED BY:         Cara Counter',
  'APPROVED BY:       Manny Manager',
  '--------------------------------',
  'RECEIPTS                       3',
  'SUBTOTAL                3,075.00',
  'SENIOR DISCOUNT          -128.29',
  'OTHER DISCOUNT            -50.00',
  'TOTAL DISCOUNTS          -178.29',
  'GROSS TOTAL             2,896.71',
  '--------------------------------',
  'UNLI SALES              2,245.00',
  'A LA CARTE SALES          830.00',
  'HEADS                          5',
  'PACKAGE SESSIONS               2',
  'SENIOR/PWD DINERS              1',
  '--------------------------------',
  'Cash                    2,396.71',
  'GCash                     500.00',
  'SHORT PAYMENTS              0.51',
  'SHORT PAY FINDINGS             1',
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const Z_32_B: string[] = [
  '          SHAREAT LIPA',
  '      Lipa City, Batangas',
  '    TIN: 123-456-789-000 VAT',
  '',
  '           Z-READING',
  'Z NO:                     Z-0001',
  'BUSINESS DATE:          02/11/26',
  'FROM:             02/11/26 04:00',
  'TO:               02/11/26 22:30',
  '        Spans two dates',
  'PRINTED BY:         Cara Counter',
  'APPROVED BY:       Manny Manager',
  '--------------------------------',
  'RECEIPTS                       3',
  'SUBTOTAL                3,075.00',
  'SENIOR DISCOUNT          -128.29',
  'OTHER DISCOUNT            -50.00',
  'TOTAL DISCOUNTS          -178.29',
  'GROSS TOTAL             2,896.71',
  '--------------------------------',
  'UNLI SALES              2,245.00',
  'A LA CARTE SALES          830.00',
  'HEADS                          5',
  'PACKAGE SESSIONS               2',
  'SENIOR/PWD DINERS              1',
  '--------------------------------',
  'Cash                    2,396.71',
  'GCash                     500.00',
  'SHORT PAYMENTS              0.01',
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const X_48_A: string[] = [
  '                  SHAREAT LIPA',
  '              Lipa City, Batangas',
  '            TIN: 123-456-789-000 VAT',
  '',
  '                   X-READING',
  '     Reading so far - the day is NOT closed',
  'FROM:                             02/11/26 04:00',
  'TO:                               02/11/26 22:30',
  'PRINTED BY:                         Cara Counter',
  '------------------------------------------------',
  'RECEIPTS                                       3',
  'SUBTOTAL                                3,075.00',
  'SENIOR DISCOUNT                          -128.29',
  'OTHER DISCOUNT                            -50.00',
  'TOTAL DISCOUNTS                          -178.29',
  'GROSS TOTAL                             2,896.71',
  '------------------------------------------------',
  'UNLI SALES                              2,245.00',
  'A LA CARTE SALES                          830.00',
  'HEADS                                          5',
  'PACKAGE SESSIONS                               2',
  'SENIOR/PWD DINERS                              1',
  '------------------------------------------------',
  'Cash                                    2,396.71',
  'GCash                                     500.00',
  'SHORT PAYMENTS                              0.51',
  'SHORT PAY FINDINGS                             1',
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];
const X_48_B: string[] = [
  '                  SHAREAT LIPA',
  '              Lipa City, Batangas',
  '            TIN: 123-456-789-000 VAT',
  '',
  '                   X-READING',
  '     Reading so far - the day is NOT closed',
  'FROM:                             02/11/26 04:00',
  'TO:                               02/11/26 22:30',
  'PRINTED BY:                         Cara Counter',
  '------------------------------------------------',
  'RECEIPTS                                       3',
  'SUBTOTAL                                3,075.00',
  'SENIOR DISCOUNT                          -128.29',
  'OTHER DISCOUNT                            -50.00',
  'TOTAL DISCOUNTS                          -178.29',
  'GROSS TOTAL                             2,896.71',
  '------------------------------------------------',
  'UNLI SALES                              2,245.00',
  'A LA CARTE SALES                          830.00',
  'HEADS                                          5',
  'PACKAGE SESSIONS                               2',
  'SENIOR/PWD DINERS                              1',
  '------------------------------------------------',
  'Cash                                    2,396.71',
  'GCash                                     500.00',
  'SHORT PAYMENTS                              0.01',
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];
const Z_48_A: string[] = [
  '                  SHAREAT LIPA',
  '              Lipa City, Batangas',
  '            TIN: 123-456-789-000 VAT',
  '',
  '                   Z-READING',
  'Z NO:                                     Z-0001',
  'BUSINESS DATE:                          02/11/26',
  'FROM:                             02/11/26 04:00',
  'TO:                               02/11/26 22:30',
  '                Spans two dates',
  'PRINTED BY:                         Cara Counter',
  'APPROVED BY:                       Manny Manager',
  '------------------------------------------------',
  'RECEIPTS                                       3',
  'SUBTOTAL                                3,075.00',
  'SENIOR DISCOUNT                          -128.29',
  'OTHER DISCOUNT                            -50.00',
  'TOTAL DISCOUNTS                          -178.29',
  'GROSS TOTAL                             2,896.71',
  '------------------------------------------------',
  'UNLI SALES                              2,245.00',
  'A LA CARTE SALES                          830.00',
  'HEADS                                          5',
  'PACKAGE SESSIONS                               2',
  'SENIOR/PWD DINERS                              1',
  '------------------------------------------------',
  'Cash                                    2,396.71',
  'GCash                                     500.00',
  'SHORT PAYMENTS                              0.51',
  'SHORT PAY FINDINGS                             1',
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];
const Z_48_B: string[] = [
  '                  SHAREAT LIPA',
  '              Lipa City, Batangas',
  '            TIN: 123-456-789-000 VAT',
  '',
  '                   Z-READING',
  'Z NO:                                     Z-0001',
  'BUSINESS DATE:                          02/11/26',
  'FROM:                             02/11/26 04:00',
  'TO:                               02/11/26 22:30',
  '                Spans two dates',
  'PRINTED BY:                         Cara Counter',
  'APPROVED BY:                       Manny Manager',
  '------------------------------------------------',
  'RECEIPTS                                       3',
  'SUBTOTAL                                3,075.00',
  'SENIOR DISCOUNT                          -128.29',
  'OTHER DISCOUNT                            -50.00',
  'TOTAL DISCOUNTS                          -178.29',
  'GROSS TOTAL                             2,896.71',
  '------------------------------------------------',
  'UNLI SALES                              2,245.00',
  'A LA CARTE SALES                          830.00',
  'HEADS                                          5',
  'PACKAGE SESSIONS                               2',
  'SENIOR/PWD DINERS                              1',
  '------------------------------------------------',
  'Cash                                    2,396.71',
  'GCash                                     500.00',
  'SHORT PAYMENTS                              0.01',
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];

const withShort = (amount: string, count: number) => ({ varianceTotal: money(amount), shortfallCount: count });

describe('X-reading: Short payments', () => {
  it('32 columns: 0.51 short with 1 finding prints both rows, exact lines', () => {
    expect(formatter('formatXSlip')({ ...base(), ...withShort('0.51', 1) }, L32)).toEqual(X_32_A);
  });
  it('48 columns: 0.51 short with 1 finding prints both rows, exact lines', () => {
    expect(formatter('formatXSlip')({ ...base(), ...withShort('0.51', 1) }, L48)).toEqual(X_48_A);
  });
  it('32 columns: 0.01 short with no finding prints the amount only, exact lines', () => {
    expect(formatter('formatXSlip')({ ...base(), ...withShort('0.01', 0) }, L32)).toEqual(X_32_B);
  });
  it('48 columns: 0.01 short with no finding prints the amount only, exact lines', () => {
    expect(formatter('formatXSlip')({ ...base(), ...withShort('0.01', 0) }, L48)).toEqual(X_48_B);
  });
});

describe('Z-reading: Short payments', () => {
  it('32 columns: 0.51 short with 1 finding, exact lines', () => {
    expect(formatter('formatZSlip')(zOf(withShort('0.51', 1)), L32)).toEqual(Z_32_A);
  });
  it('48 columns: 0.51 short with 1 finding, exact lines', () => {
    expect(formatter('formatZSlip')(zOf(withShort('0.51', 1)), L48)).toEqual(Z_48_A);
  });
  it('32 columns: 0.01 short with no finding, exact lines', () => {
    expect(formatter('formatZSlip')(zOf(withShort('0.01', 0)), L32)).toEqual(Z_32_B);
  });
  it('48 columns: 0.01 short with no finding, exact lines', () => {
    expect(formatter('formatZSlip')(zOf(withShort('0.01', 0)), L48)).toEqual(Z_48_B);
  });
});

describe('Short payments at zero: the slip is the slip of before', () => {
  it('a view with varianceTotal 0.00 and no findings prints exactly as a view that never had the fields (X and Z, both widths)', () => {
    for (const layout of [L32, L48]) {
      expect(formatter('formatXSlip')({ ...base(), ...withShort('0.00', 0) }, layout)).toEqual(formatter('formatXSlip')(base(), layout));
      expect(formatter('formatZSlip')(zOf(withShort('0.00', 0)), layout)).toEqual(formatter('formatZSlip')(zOf({}), layout));
    }
    const text = formatter('formatXSlip')({ ...base(), ...withShort('0.00', 0) }, L48).join('|');
    expect(text).not.toContain('SHORT PAY');
  });
});
