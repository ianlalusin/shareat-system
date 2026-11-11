import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import * as print from './index';

/**
 * T-531 R6 (TESTER) - the X-reading and Z-reading paper, exact line arrays at 32 columns (58 mm, Font A) and 48 columns (80 mm, Font A).
 * docs/tasks/531-pos-day-close.md R6 "X-reading", "Close day (Z)", R8 "Print".
 *
 * FIXED BY THE SPEC (R6): the X header "X-READING", the line "Reading so far - the day is NOT closed", the Z header "Z-READING", the number `Z-0001`,
 * from/to in Manila time, "Spans two dates" when it applies, printed by and approved by, the same figures, and the footer "Cash control, not a BIR document".
 * ASSUMED BY THIS TESTER (the spec gives no paper layout; the builder may change a label here with Ian's/the planner's word, the test is the one place to edit):
 * the order of the rows, the labels (FROM:, TO:, PRINTED BY:, APPROVED BY:, RECEIPTS, SUBTOTAL, SENIOR/PWD/OTHER DISCOUNT, TOTAL DISCOUNTS, GROSS TOTAL, UNLI SALES,
 * A LA CARTE SALES, HEADS, PACKAGE SESSIONS, SENIOR/PWD DINERS, one row per tender, TO CHECK (wallet), LATE RECEIPTS), `Z NO:` and `BUSINESS DATE:` rows on the Z,
 * a zero discount row is NOT printed (here only senior and other are non-zero), and the layout primitives of receipt-text.ts (center / justify / rule / wrap; a 38-character
 * sub-header wraps and each piece is centred, as `pushCentered` does). Like the receipt, nothing is computed: figures print exactly as given.
 *
 * ASSUMED API (apps/erp/src/lib/pos-print/reading-text.ts, exported from index.ts): formatXSlip(view, layout): string[] and formatZSlip(view, layout): string[].
 * ReadingSlipView = { header: ReceiptHeader, printedBy, windowFromLocal, windowToLocal, spansTwoDates, receiptCount, subtotal, discounts: { senior, pwd, other },
 *   discountTotal, grossTotal, unliSales, alaCarteSales, heads, packageSessions, seniorPwdDiners, tenders: { name, amount }[], toCheckCount, lateCount }
 * ZSlipView = ReadingSlipView & { zNo: number, businessDateLocal, approvedBy, reprint: boolean }.
 *
 * RED NOW FOR THE RIGHT REASON: reading-text.ts does not exist, so formatXSlip / formatZSlip are not exported from the print index.
 */
type Fmt = (view: unknown, layout: { width: 58 | 80; font: 'small' | 'normal' }) => string[];
function formatter(name: 'formatXSlip' | 'formatZSlip'): Fmt {
  const fn = (print as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: apps/erp/src/lib/pos-print does not export ${name} (T-531 not built).`);
  return fn as Fmt;
}

const header = { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true };
const base = () => ({
  header, printedBy: 'Cara Counter', windowFromLocal: '02/11/26 04:00', windowToLocal: '02/11/26 22:30', spansTwoDates: false,
  receiptCount: 3, subtotal: money('3075.00'), discounts: { senior: money('128.29'), pwd: money('0.00'), other: money('50.00') }, discountTotal: money('178.29'),
  grossTotal: money('2896.71'), unliSales: money('2245.00'), alaCarteSales: money('830.00'), heads: 5, packageSessions: 2, seniorPwdDiners: 1,
  tenders: [{ name: 'Cash', amount: money('2396.71') }, { name: 'GCash', amount: money('500.00') }], toCheckCount: 1, lateCount: 1,
});
const zView = (o: Record<string, unknown> = {}) => ({ ...base(), spansTwoDates: true, zNo: 1, businessDateLocal: '02/11/26', approvedBy: 'Manny Manager', reprint: false, ...o });
const chr = (code: number): string => String.fromCharCode(code); // (the tester's cases call chr(10); it was never defined)
const L32 = { width: 58 as const, font: 'normal' as const };
const L48 = { width: 80 as const, font: 'normal' as const };

const X_32: string[] = [
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
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const Z_32: string[] = [
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
  'TO CHECK (wallet)              1',
  'LATE RECEIPTS                  1',
  '--------------------------------',
  'Cash control, not a BIR document',
];
const X_48: string[] = [
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
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];
const Z_48: string[] = [
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
  'TO CHECK (wallet)                              1',
  'LATE RECEIPTS                                  1',
  '------------------------------------------------',
  '        Cash control, not a BIR document',
];

describe('X-reading (R6): the open window, the day is NOT closed', () => {
  it('32 columns: the exact lines', () => {
    expect(formatter('formatXSlip')(base(), L32)).toEqual(X_32);
  });
  it('48 columns: the exact lines', () => {
    expect(formatter('formatXSlip')(base(), L48)).toEqual(X_48);
  });
  it('says the day is not closed and that it is cash control; never says Z-READING or a Z number', () => {
    const text = formatter('formatXSlip')(base(), L48).join(chr(10));
    expect(text).toContain('Reading so far - the day is NOT closed');
    expect(text).toContain('Cash control, not a BIR document');
    expect(text).not.toMatch(/Z-READING|Z-0001|APPROVED BY/);
  });
  it('"Spans two dates" prints on an X when the window spans two, and not otherwise', () => {
    expect(formatter('formatXSlip')({ ...base(), spansTwoDates: true }, L48)).toContain('                Spans two dates');
    expect(formatter('formatXSlip')(base(), L48)).not.toContain('                Spans two dates');
  });
});

describe('Z-reading (R6): the closed window', () => {
  it('32 columns: the exact lines (Z-0001, spans two dates, printed by and approved by)', () => {
    expect(formatter('formatZSlip')(zView(), L32)).toEqual(Z_32);
  });
  it('48 columns: the exact lines', () => {
    expect(formatter('formatZSlip')(zView(), L48)).toEqual(Z_48);
  });
  it('the Z number is zero-padded to four digits: Z-0012 and Z-1234', () => {
    expect(formatter('formatZSlip')(zView({ zNo: 12 }), L48).join(chr(10))).toContain('Z-0012');
    expect(formatter('formatZSlip')(zView({ zNo: 1234 }), L48).join(chr(10))).toContain('Z-1234');
  });
  it('a reprint says REPRINT, centred under the header; an original does not', () => {
    const lines = formatter('formatZSlip')(zView({ reprint: true }), L48);
    expect(lines).toContain('                    REPRINT');
    expect(formatter('formatZSlip')(zView(), L48).join(chr(10))).not.toContain('REPRINT');
  });
  it('figures print exactly as given, even ones that do not add up (nothing is recomputed)', () => {
    const lines = formatter('formatZSlip')(zView({ grossTotal: money('1.00') }), L48);
    expect(lines).toContain('GROSS TOTAL                                 1.00');
  });
});
