import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { columnsFor } from './layout';
import { formatReceipt } from './receipt-text';
import type { PrintLayout, ReceiptView } from './types';

/**
 * T-528a — the sales receipt.
 *
 * The fixture is the bill in `docs/plans/pos-v2-design/payment.png` and its receipt in
 * `receipts.png`: Stand 7, 4 heads, a package for 4 with a senior discount on 1 unit, a shared
 * pitcher with no discount, 2 cheese corn with a senior discount on 1, a kimchi fried rice with a
 * 10 % preset, GCash ₱500 with a reference, cash ₱1,600, and ₱7.58 change off a ₱2,092.42 bill.
 */
function baseView(): ReceiptView {
  return {
    header: {
      businessName: 'Shareat Lipa',
      addressLines: ['Lipa City, Batangas'],
      tin: '123-456-789-000',
      vatRegistered: true,
    },
    receiptNo: 'LIP-001-004231',
    issuedAtLocal: '06/11/26 19:52',
    tableLabel: 'Stand 7',
    heads: 4,
    cashierName: 'Joy',
    lines: [
      {
        name: 'Unli Samgyup + Cheese',
        qty: 4,
        unitPrice: money('449.00'),
        gross: money('1796.00'),
        discounts: [{ label: 'Senior', qty: 1, amount: money('128.29') }],
        net: money('1667.71'),
      },
      {
        name: 'Iced tea pitcher',
        qty: 1,
        unitPrice: money('120.00'),
        gross: money('120.00'),
        discounts: [],
        net: money('120.00'),
      },
      {
        name: 'Cheese corn',
        qty: 2,
        unitPrice: money('99.00'),
        gross: money('198.00'),
        discounts: [{ label: 'Senior', qty: 1, amount: money('28.29') }],
        net: money('169.71'),
      },
      {
        name: 'Kimchi fried rice',
        qty: 1,
        unitPrice: money('150.00'),
        gross: money('150.00'),
        discounts: [{ label: 'Birthday promo 10%', qty: 1, amount: money('15.00') }],
        net: money('135.00'),
      },
    ],
    subtotal: money('2264.00'),
    discountTotal: money('171.58'),
    total: money('2092.42'),
    tenders: [
      { name: 'GCash', amount: money('500.00'), reference: '4012 889 213', toCheck: false },
      { name: 'Cash', amount: money('1600.00'), reference: null, toCheck: false },
    ],
    change: money('7.58'),
    diners: [{ dinerNo: 1, kind: 'senior', holderName: 'Lolita R.', idNumber: 'OSCA 04-1187' }],
    footerLines: ['This is not an official receipt'],
    offline: false,
    reprint: false,
  };
}

const RECEIPT_32: string[] = [
  '          SHAREAT LIPA',
  '      Lipa City, Batangas',
  '    TIN: 123-456-789-000 VAT',
  '',
  'RECEIPT:          LIP-001-004231',
  'DATE:             06/11/26 19:52',
  'TABLE:                   Stand 7',
  'HEADS:                         4',
  'CASHIER:                     Joy',
  '--------------------------------',
  '4 x Unli Samgyup +',
  'Cheese                  1,796.00',
  '  @ 449.00',
  '  Senior (1)             -128.29',
  '  Net                   1,667.71',
  '1 x Iced tea pitcher      120.00',
  '2 x Cheese corn           198.00',
  '  @ 99.00',
  '  Senior (1)              -28.29',
  '  Net                     169.71',
  '1 x Kimchi fried rice     150.00',
  '  Birthday promo 10% (1)  -15.00',
  '  Net                     135.00',
  '--------------------------------',
  'SUBTOTAL                2,264.00',
  'DISCOUNTS                -171.58',
  'TOTAL                   2,092.42',
  '--------------------------------',
  'GCash                     500.00',
  '  Ref: 4012 889 213',
  'Cash                    1,600.00',
  'CHANGE                      7.58',
  '--------------------------------',
  'SENIOR #1',
  '  Name: Lolita R.',
  '  ID: OSCA 04-1187',
  'This is not an official receipt',
];

const RECEIPT_48: string[] = [
  '                  SHAREAT LIPA',
  '              Lipa City, Batangas',
  '            TIN: 123-456-789-000 VAT',
  '',
  'RECEIPT:                          LIP-001-004231',
  'DATE:                             06/11/26 19:52',
  'TABLE:                                   Stand 7',
  'HEADS:                                         4',
  'CASHIER:                                     Joy',
  '------------------------------------------------',
  '4 x Unli Samgyup + Cheese               1,796.00',
  '  @ 449.00',
  '  Senior (1)                             -128.29',
  '  Net                                   1,667.71',
  '1 x Iced tea pitcher                      120.00',
  '2 x Cheese corn                           198.00',
  '  @ 99.00',
  '  Senior (1)                              -28.29',
  '  Net                                     169.71',
  '1 x Kimchi fried rice                     150.00',
  '  Birthday promo 10% (1)                  -15.00',
  '  Net                                     135.00',
  '------------------------------------------------',
  'SUBTOTAL                                2,264.00',
  'DISCOUNTS                                -171.58',
  'TOTAL                                   2,092.42',
  '------------------------------------------------',
  'GCash                                     500.00',
  '  Ref: 4012 889 213',
  'Cash                                    1,600.00',
  'CHANGE                                      7.58',
  '------------------------------------------------',
  'SENIOR #1',
  '  Name: Lolita R.',
  '  ID: OSCA 04-1187',
  '        This is not an official receipt',
];

describe('T-528a — the sales receipt', () => {
  it('the approved split-payment receipt', () => {
    expect(formatReceipt(baseView(), { width: 58, font: 'normal' })).toEqual(RECEIPT_32);
    expect(formatReceipt(baseView(), { width: 80, font: 'normal' })).toEqual(RECEIPT_48);
  });

  it('every line fits', () => {
    const layouts: PrintLayout[] = [
      { width: 58, font: 'normal' },
      { width: 58, font: 'small' },
      { width: 80, font: 'normal' },
      { width: 80, font: 'small' },
    ];
    for (const layout of layouts) {
      const cols = columnsFor(layout);
      for (const line of formatReceipt(baseView(), layout)) {
        // A line wider than the paper wraps into rubbish on a thermal printer, so this bound is the
        // difference between a readable receipt and an unreadable one.
        expect(line.length, `"${line}" in ${layout.width}mm/${layout.font}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('optional sections', () => {
    const bare = baseView();
    bare.header = { ...bare.header, tin: null };
    bare.tableLabel = null;
    bare.heads = null;
    bare.lines = bare.lines.map((line) => ({ ...line, discounts: [] }));
    bare.discountTotal = money('0.00');
    bare.diners = [];
    bare.footerLines = [];

    const lines = formatReceipt(bare, { width: 58, font: 'normal' });
    expect(lines.some((line) => line.includes('TIN:'))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith('TABLE:'))).toBe(false);
    expect(lines.some((line) => line.includes('HEADS:'))).toBe(false);
    // No discounts on any line → no bill DISCOUNTS row and no per-line net.
    expect(lines.some((line) => line.includes('DISCOUNTS'))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith('Net'))).toBe(false);
    // No qualifying diner → no diner block, and no rule left dangling for it.
    expect(lines.some((line) => line.includes('SENIOR') || line.includes('PWD'))).toBe(false);

    // The two flags appear only when they are true.
    expect(lines.some((line) => line.includes('REPRINT'))).toBe(false);
    expect(lines.some((line) => line.includes('OFFLINE'))).toBe(false);

    const flagged = baseView();
    flagged.reprint = true;
    flagged.offline = true;
    const flaggedLines = formatReceipt(flagged, { width: 58, font: 'normal' });
    // Centred, so compare the visible text: a flag is worth nothing if it is off the edge of the paper.
    expect(flaggedLines.map((line) => line.trim())).toContain('REPRINT');
    expect(flaggedLines.map((line) => line.trim())).toContain('OFFLINE SALE - TO SYNC');
  });

  it('tender reference and to-check', () => {
    const view = baseView();
    view.tenders = [
      { name: 'GCash', amount: money('500.00'), reference: '4012 889 213', toCheck: true },
      { name: 'Cash', amount: money('1600.00'), reference: null, toCheck: false },
    ];
    const lines = formatReceipt(view, { width: 58, font: 'normal' });

    // The name carries the flag, and the reference prints under the tender it belongs to.
    const flaggedRow = lines.findIndex((line) => line.includes('GCash (to check)'));
    expect(flaggedRow).toBeGreaterThan(-1);
    expect(lines[flaggedRow + 1]).toBe('  Ref: 4012 889 213');

    // A tender with no reference prints no Ref line — and the next tender follows immediately.
    const cashRow = lines.findIndex((line) => line.trimStart().startsWith('Cash'));
    expect(lines[cashRow]).toBe('Cash                    1,600.00');
    expect(lines[cashRow + 1]?.trim().replace(/\s+/g, ' ')).toBe('CHANGE 7.58');
    // ...and it is right-aligned to the paper, not merely present.
    expect(lines[cashRow + 1]).toHaveLength(32);
  });

  it('prints figures as given', () => {
    // A deliberately inconsistent bill: the total does not equal subtotal − discounts. The formatter
    // must print what it was handed — a receipt that "fixed" a figure would hide the caller's bug
    // behind paper that looks authoritative.
    const view = baseView();
    view.subtotal = money('2264.00');
    view.discountTotal = money('171.58');
    view.total = money('999.99');
    view.change = money('0.00');

    const lines = formatReceipt(view, { width: 58, font: 'normal' });
    const row = (label: string) => {
      const line = lines.find((candidate) => candidate.startsWith(`${label} `));
      return { text: line?.trim().replace(/\s+/g, ' '), width: line?.length };
    };
    expect(row('TOTAL')).toEqual({ text: 'TOTAL 999.99', width: 32 });
    expect(row('SUBTOTAL')).toEqual({ text: 'SUBTOTAL 2,264.00', width: 32 });
    expect(row('CHANGE')).toEqual({ text: 'CHANGE 0.00', width: 32 });
    // The real total is nowhere on the paper: the 2,092.42 came from the view, not from a sum.
    expect(lines.some((line) => line.includes('2,092.42'))).toBe(false);
  });
});
