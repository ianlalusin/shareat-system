import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { formatDepositSlip } from './deposit-text';
import { formatReceipt } from './receipt-text';
import { formatXSlip, formatZSlip } from './reading-text';
import type { ReadingSlipView, ReceiptView, ZSlipView } from './types';

/**
 * T-628 (X / Z and receipt) - reservation deposits on the paper: the X and the Z print DEPOSITS TAKEN / REFUNDED / KEPT / APPLIED rows (each only above zero); the final receipt prints
 * LESS DEPOSIT above the tenders; the deposit slip names the customer, the table time and the amount. Nothing is computed here: the figures arrive worked out.
 */
const L32 = { width: 58 as const, font: 'normal' as const };
const header = { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true };

const receipt = (o: Partial<ReceiptView> = {}): ReceiptView => ({
  header, receiptNo: 'LIP-01-000042', issuedAtLocal: '22/11/26 19:52', tableLabel: 'Stand 3', heads: 2, cashierName: 'Joy',
  lines: [{ name: 'Pork belly', qty: 4, unitPrice: money('250.00'), gross: money('1000.00'), discounts: [], net: money('1000.00') }],
  subtotal: money('1000.00'), discountTotal: money('0.00'), total: money('1000.00'),
  tenders: [{ name: 'Cash', amount: money('500.00'), reference: null, toCheck: false }], change: money('0.00'), diners: [], footerLines: [], offline: false, reprint: false,
  vat: { vatRegistered: true, vatableSales: money('892.86'), vatExemptSales: money('0.00'), vatAmount: money('107.14'), vatRateLabel: '12%', vatRemovedForScPwd: money('0.00'), scPwdDiscount: money('0.00') },
  ...o,
});

describe('T-628 receipt paper', () => {
  it('prints LESS DEPOSIT above the tenders when a deposit paid part of the bill [kills: the receipt ignores the deposit]', () => {
    const lines = formatReceipt(receipt({ deposit: money('500.00') }), L32);
    const less = lines.findIndex((l) => l.startsWith('LESS DEPOSIT'));
    expect(lines[less]).toMatch(/LESS DEPOSIT\s+-500\.00$/);
    expect(less).toBeGreaterThan(lines.findIndex((l) => l.startsWith('TOTAL')));
    expect(less).toBeLessThan(lines.findIndex((l) => l.startsWith('Cash')));
  });
  it('no deposit, no line (zero and absent are the same)', () => {
    for (const view of [receipt(), receipt({ deposit: money('0.00') })]) expect(formatReceipt(view, L32).some((l) => l.includes('LESS DEPOSIT'))).toBe(false);
  });
});

const slip = (o: Partial<ReadingSlipView> = {}): ReadingSlipView => ({
  header, printedBy: 'Cara', windowFromLocal: '22/11/26 04:00', windowToLocal: '22/11/26 22:30', spansTwoDates: false, receiptCount: 1, subtotal: money('1000.00'),
  discounts: { senior: money('0.00'), pwd: money('0.00'), other: money('0.00') }, discountTotal: money('0.00'), grossTotal: money('1000.00'),
  unliSales: money('0.00'), alaCarteSales: money('1000.00'), heads: 2, packageSessions: 0, seniorPwdDiners: 0,
  tenders: [{ name: 'Cash', amount: money('500.00') }], toCheckCount: 0, lateCount: 0, ...o,
});

describe('T-628 X and Z paper', () => {
  it('print DEPOSITS rows for what was taken, refunded, kept and applied, each only above zero [kills: the reading text drops the deposits block]', () => {
    const view = slip({ deposits: { taken: money('1000.00'), refunded: money('200.00'), kept: money('300.00'), applied: money('500.00') } });
    const z: ZSlipView = { ...view, zNo: 1, businessDateLocal: '22/11/26', approvedBy: 'Manny', reprint: false };
    for (const lines of [formatXSlip(view, L32), formatZSlip(z, L32)]) {
      const row = (label: string) => lines.find((l) => l.startsWith(label));
      expect(row('DEPOSITS TAKEN')).toMatch(/1,?000\.00$/);
      expect(row('DEPOSITS REFUNDED')).toMatch(/-200\.00$/);
      expect(row('DEPOSITS KEPT')).toMatch(/300\.00$/);
      expect(row('DEPOSITS APPLIED')).toMatch(/500\.00$/);
    }
  });
  it('print the drawer\'s own cash lines apart from the method-blind rows, so a GCash deposit does not hide the cash figure [kills: the cash lines dropped]', () => {
    const view = slip({ deposits: { taken: money('1000.00'), refunded: money('200.00'), kept: money('0.00'), applied: money('0.00'), cashTaken: money('400.00'), cashReturned: money('150.00') } });
    const lines = formatXSlip(view, L32);
    expect(lines.find((l) => l.startsWith('DEPOSITS CASH IN'))).toMatch(/400\.00$/);
    expect(lines.find((l) => l.startsWith('DEPOSITS CASH OUT'))).toMatch(/-150\.00$/);
    const noCash = formatXSlip(slip({ deposits: { taken: money('300.00'), refunded: money('0.00'), kept: money('0.00'), applied: money('0.00'), cashTaken: money('0.00'), cashReturned: money('0.00') } }), L32);
    expect(noCash.some((l) => l.startsWith('DEPOSITS CASH'))).toBe(false);
    expect(noCash.some((l) => l.startsWith('DEPOSITS TAKEN'))).toBe(true);
  });
  it('a window with no deposits prints none', () => {
    const zero = { taken: money('0.00'), refunded: money('0.00'), kept: money('0.00'), applied: money('0.00') };
    for (const view of [slip(), slip({ deposits: zero })]) expect(formatXSlip(view, L32).some((l) => l.startsWith('DEPOSITS'))).toBe(false);
  });
});

describe('T-628 deposit slip', () => {
  const view = { header, customerName: 'Santos', partySize: 8, reservedForLocal: '23/11/26 19:00', takenAtLocal: '22/11/26 15:10', amount: '1000.00', tenderName: 'GCash', reference: 'GC-123456', takenBy: 'Joy', reprint: false };
  it('names the customer, the table time, the method with its reference and the amount', () => {
    const lines = formatDepositSlip(view, L32);
    expect(lines.some((l) => l.includes('RESERVATION DEPOSIT'))).toBe(true);
    expect(lines.find((l) => l.startsWith('NAME:'))).toMatch(/Santos$/);
    expect(lines.find((l) => l.startsWith('RESERVED FOR:'))).toMatch(/23\/11\/26 19:00$/);
    expect(lines.find((l) => l.startsWith('GCASH'))).toMatch(/1,?000\.00$/);
    expect(lines.some((l) => l.includes('Ref: GC-123456'))).toBe(true);
    expect(lines.find((l) => l.startsWith('DEPOSIT PAID'))).toMatch(/1,?000\.00$/);
  });
  it('cash has no reference line; a reprint says REPRINT', () => {
    const lines = formatDepositSlip({ ...view, tenderName: 'Cash', reference: null, reprint: true }, L32);
    expect(lines.some((l) => l.includes('Ref:'))).toBe(false);
    expect(lines.some((l) => l.trim() === 'REPRINT')).toBe(true);
  });
});
