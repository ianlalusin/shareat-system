import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { formatRefundSlip, formatXSlip } from './index';

/**
 * T-534 S4 - the refund slip, exact lines at 32 columns (58 mm, Font A). Nothing is computed: figures print as given. The slip says REFUND, the refund number, the ORIGINAL receipt number,
 * the items, the money back by method (with a wallet's reference), the reason and the approver. The X/Z slip gains a "REFUNDS" row only when there was a refund.
 */
const header = { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true };
const view = (o: Record<string, unknown> = {}) => ({
  header, refundNo: 'SL-R-000001', receiptNo: 'SL-01-000007', refundedAtLocal: '20/11/26 12:30',
  lines: [{ name: 'Pork belly', qty: 2, amount: money('500.00') }], total: money('500.00'),
  payments: [{ name: 'Cash', amount: money('300.00'), reference: null }, { name: 'GCash', amount: money('200.00'), reference: 'GC-0001234' }],
  reason: 'Customer returned it', approvedBy: 'Manny Manager', recordedBy: 'Cara Counter', ...o,
});
const L32 = { width: 58 as const, font: 'normal' as const };
const row = (l: string, r: string): string => l + ' '.repeat(32 - l.length - r.length) + r;

describe('T-534 S4 - formatRefundSlip', () => {
  it('prints REFUND, both numbers, the items, the money back by method with the wallet reference, the reason and who approved it', () => {
    expect(formatRefundSlip(view(), L32)).toEqual([
      '          SHAREAT LIPA',
      '      Lipa City, Batangas',
      '    TIN: 123-456-789-000 VAT',
      '',
      '             REFUND',
      'REFUND NO:           SL-R-000001',
      'RECEIPT:            SL-01-000007',
      'DATE:             20/11/26 12:30',
      '--------------------------------',
      '2 x Pork belly            500.00',
      '--------------------------------',
      'TOTAL REFUNDED            500.00',
      '--------------------------------',
      'MONEY BACK',
      'Cash                      300.00',
      'GCash                     200.00',
      '  Ref: GC-0001234',
      '--------------------------------',
      'Reason: Customer returned it',
      'APPROVED BY:       Manny Manager',
      'RECORDED BY:        Cara Counter',
    ]);
  });
  it('a reprint says REPRINT under the header; a figure that does not add up still prints as given', () => {
    const lines = formatRefundSlip(view({ reprint: true, total: money('499.00') }), L32);
    expect(lines[4]).toBe('            REPRINT');
    expect(lines).toContain('TOTAL REFUNDED            499.00');
  });
});

describe('T-534 S4 - the X/Z slip refunds row', () => {
  const base = {
    header, printedBy: 'Cara Counter', windowFromLocal: '02/11/26 04:00', windowToLocal: '02/11/26 22:30', spansTwoDates: false, receiptCount: 1,
    subtotal: money('1000.00'), discounts: { senior: money('0.00'), pwd: money('0.00'), other: money('0.00') }, discountTotal: money('0.00'), grossTotal: money('1000.00'),
    unliSales: money('0.00'), alaCarteSales: money('1000.00'), heads: 2, packageSessions: 0, seniorPwdDiners: 0, tenders: [{ name: 'Cash', amount: money('750.00') }], toCheckCount: 0, lateCount: 0,
  };
  it('shows "REFUNDS -250.00" under the (net) tenders when there was a refund, and nothing when there was none [kills: no refunds row]', () => {
    const withRefund = formatXSlip({ ...base, refunds: { total: money('250.00'), count: 1 } } as never, L32);
    expect(withRefund).toContain(row('Cash', '750.00'));
    expect(withRefund).toContain(row('REFUNDS', '-250.00'));
    expect(formatXSlip({ ...base, refunds: { total: money('0.00'), count: 0 } } as never, L32).join('\n')).not.toContain('REFUNDS');
    expect(formatXSlip(base as never, L32).join('\n')).not.toContain('REFUNDS');
  });
});
