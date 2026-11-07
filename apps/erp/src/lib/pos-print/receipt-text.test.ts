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
    vat: null,
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

// ---------------------------------------------------------------------------------------------------------------------
// T-528b section 5 (absorbed into T-528): the VAT block. ASSUMED API: ReceiptView.vat =
//   null | { vatRegistered: boolean; vatableSales; vatExemptSales; vatAmount; vatRateLabel: string; vatRemovedForScPwd }  (work order T-528b section 3).
// The four lines follow TOTAL and come BEFORE the tender rule; `Less: VAT exemption (SC/PWD)` only when the removed amount is not "0.00".
// RED NOW FOR THE RIGHT REASON: formatReceipt ignores `view.vat`.
// ---------------------------------------------------------------------------------------------------------------------
const VAT_SENIOR = {
  vatRegistered: true,
  vatableSales: money('1518.75'),
  vatExemptSales: money('489.28'),
  vatAmount: money('182.25'),
  vatRateLabel: '12%',
  vatRemovedForScPwd: money('58.72'),
  /** The statutory 20% only (80.18 + 17.68); the VAT removed is separate. 1,518.75 + 182.25 + 489.28 - 97.86 = 2,092.42, the TOTAL. */
  scPwdDiscount: money('97.86'),
};
const withVat = (vat: unknown): ReceiptView => ({ ...baseView(), vat }) as unknown as ReceiptView;
/** The T-528a arrays with the VAT lines spliced in right after TOTAL (the tender rule that followed TOTAL stays after them). */
const spliceAfterTotal = (base: string[], block: string[]): string[] => {
  const at = base.findIndex((l) => l.startsWith('TOTAL '));
  return [...base.slice(0, at + 1), ...block, ...base.slice(at + 1)];
};

describe('T-528b - the VAT block', () => {
  it('VAT block with a senior: the exact 32- and 48-column arrays, five lines in order (the SC/PWD discount straight after VAT-EXEMPT SALES), after TOTAL and before the tenders', () => {
    expect(formatReceipt(withVat(VAT_SENIOR), { width: 58, font: 'normal' })).toEqual(
      spliceAfterTotal(RECEIPT_32, [
        'Less: VAT exemption',
        '(SC/PWD)                  -58.72',
        'VATABLE SALES           1,518.75',
        'VAT-EXEMPT SALES          489.28',
        'Less: SC/PWD discount     -97.86',
        'VAT (12%)                 182.25',
      ]),
    );
    expect(formatReceipt(withVat(VAT_SENIOR), { width: 80, font: 'normal' })).toEqual(
      spliceAfterTotal(RECEIPT_48, [
        'Less: VAT exemption (SC/PWD)              -58.72',
        'VATABLE SALES                           1,518.75',
        'VAT-EXEMPT SALES                          489.28',
        'Less: SC/PWD discount                     -97.86',
        'VAT (12%)                                 182.25',
      ]),
    );
  });

  it('VAT block without senior/PWD: no "Less: VAT exemption" line when the removed amount is "0.00"', () => {
    const view = withVat({ ...VAT_SENIOR, vatExemptSales: money('0.00'), vatRemovedForScPwd: money('0.00'), vatableSales: money('1914.52'), vatAmount: money('177.90'), scPwdDiscount: money('0.00') });
    const lines = formatReceipt(view, { width: 58, font: 'normal' });
    expect(lines.some((l) => l.includes('Less: VAT exemption'))).toBe(false);
    expect(lines.some((l) => l.includes('Less: SC/PWD discount')), 'no senior, no discount line').toBe(false);
    const at = lines.findIndex((l) => l.startsWith('TOTAL '));
    expect(lines.slice(at + 1, at + 4)).toEqual(['VATABLE SALES           1,914.52', 'VAT-EXEMPT SALES            0.00', 'VAT (12%)                 177.90']);
    expect(lines[at + 4]).toBe('-'.repeat(32)); // the tender rule follows straight after
  });

  it('non-VAT store: vatRegistered:false prints SC/PWD SALES instead of VAT-EXEMPT SALES', () => {
    const view = withVat({ vatRegistered: false, vatableSales: money('0.00'), vatExemptSales: money('449.00'), vatAmount: money('0.00'), vatRateLabel: '12%', vatRemovedForScPwd: money('0.00'), scPwdDiscount: money('89.80') });
    const lines = formatReceipt(view, { width: 58, font: 'normal' });
    expect(lines).toContain('SC/PWD SALES              449.00');
    expect(lines.some((l) => l.includes('VAT-EXEMPT SALES'))).toBe(false);
    expect(lines.some((l) => l.includes('Less: VAT exemption'))).toBe(false);
    expect(lines.some((l) => l.includes('Less: SC/PWD discount')), 'a non-VAT bill has no VAT identity to complete').toBe(false);
  });

  it('vat null prints nothing new: the T-528a arrays are unchanged', () => {
    expect(formatReceipt(withVat(null), { width: 58, font: 'normal' })).toEqual(RECEIPT_32);
    expect(formatReceipt(withVat(null), { width: 80, font: 'normal' })).toEqual(RECEIPT_48);
  });

  it('the rate comes only from the label the caller passes (never typed in the formatter)', () => {
    const lines = formatReceipt(withVat({ ...VAT_SENIOR, vatRateLabel: '7.5%' }), { width: 58, font: 'normal' });
    expect(lines).toContain('VAT (7.5%)                182.25');
    expect(lines.some((l) => l.includes('VAT (12%)'))).toBe(false);
  });

  it('every VAT-block line fits every paper and font', () => {
    for (const layout of [{ width: 58, font: 'normal' }, { width: 58, font: 'small' }, { width: 80, font: 'normal' }, { width: 80, font: 'small' }] as PrintLayout[]) {
      const cols = columnsFor(layout);
      for (const line of formatReceipt(withVat(VAT_SENIOR), layout)) expect(line.length, `"${line}" ${layout.width}/${layout.font}`).toBeLessThanOrEqual(cols);
    }
  });

  it('a PWD diner and two diners: the diner block prints PWD #2 and both diners in order', () => {
    const view = baseView();
    view.diners = [
      { dinerNo: 1, kind: 'senior', holderName: 'Lolita R.', idNumber: 'OSCA 04-1187' },
      { dinerNo: 2, kind: 'pwd', holderName: 'Ramon C.', idNumber: 'PWD 77-3021' },
    ];
    const lines = formatReceipt(view, { width: 58, font: 'normal' });
    const at = lines.indexOf('SENIOR #1');
    expect(lines.slice(at, at + 6)).toEqual(['SENIOR #1', '  Name: Lolita R.', '  ID: OSCA 04-1187', 'PWD #2', '  Name: Ramon C.', '  ID: PWD 77-3021']);
    expect(lines[at - 1]).toBe('-'.repeat(32));
    expect(lines[at + 6]).toBe('This is not an official receipt');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// T-528c: the printed VAT block must ADD UP to the TOTAL, read off the paper: VATABLE + VAT + VAT-EXEMPT - SC/PWD discount = TOTAL.
// The figures below are parsed back out of the printed lines, so the test proves what a customer can add up, not what the code holds.
// ---------------------------------------------------------------------------------------------------------------------
describe('T-528c - the printed VAT figures add up to the total', () => {
  const printed = (lines: string[], label: string): bigint => {
    const row = lines.find((l) => l.startsWith(label));
    expect(row, label).toBeTruthy();
    const amount = row!.slice(label.length).trim();
    const negative = amount.startsWith('-');
    const cents = BigInt(amount.replace(/[-,.]/g, ''));
    return negative ? -cents : cents;
  };

  for (const layout of [{ width: 58, font: 'normal' }, { width: 80, font: 'normal' }, { width: 58, font: 'small' }] as PrintLayout[]) {
    it(`payment.png bill, ${columnsFor(layout)} columns: 1,518.75 + 182.25 + 489.28 - 97.86 = 2,092.42`, () => {
      const lines = formatReceipt(withVat(VAT_SENIOR), layout);
      const sum = printed(lines, 'VATABLE SALES') + printed(lines, 'VAT (12%)') + printed(lines, 'VAT-EXEMPT SALES') + printed(lines, 'Less: SC/PWD discount');
      expect(sum).toBe(printed(lines, 'TOTAL'));
      expect(sum).toBe(209242n);
    });
  }

  it('the VAT removed line is kept as it was and is NOT part of the sum (it is already inside the exempt figure)', () => {
    const lines = formatReceipt(withVat(VAT_SENIOR), { width: 80, font: 'normal' });
    expect(printed(lines, 'Less: VAT exemption (SC/PWD)')).toBe(-5872n);
    expect(printed(lines, 'Less: SC/PWD discount')).toBe(-9786n);
  });

  it('a PWD-only bill adds up the same way (no senior wording is needed on the discount line)', () => {
    // One PWD, one 449.00 package head: VAT off 48.11 + 20% 80.18; exempt 400.89; rest 1,347.00 -> VAT 144.32, VATable 1,202.68; total 1,347.00 + 400.89 - 80.18 = 1,667.71.
    const view = { ...baseView(), total: money('1667.71'), subtotal: money('1796.00'), discountTotal: money('128.29') };
    const lines = formatReceipt({ ...view, vat: { vatRegistered: true, vatableSales: money('1202.68'), vatExemptSales: money('400.89'), vatAmount: money('144.32'), vatRateLabel: '12%', vatRemovedForScPwd: money('48.11'), scPwdDiscount: money('80.18') } } as unknown as ReceiptView, { width: 58, font: 'normal' });
    expect(printed(lines, 'VATABLE SALES') + printed(lines, 'VAT (12%)') + printed(lines, 'VAT-EXEMPT SALES') + printed(lines, 'Less: SC/PWD discount')).toBe(printed(lines, 'TOTAL'));
  });

  it('a VAT bill with no discount prints no discount line, and the three figures are the whole total', () => {
    const view = withVat({ ...VAT_SENIOR, vatExemptSales: money('0.00'), vatRemovedForScPwd: money('0.00'), scPwdDiscount: money('0.00'), vatableSales: money('1868.20'), vatAmount: money('224.18') });
    const lines = formatReceipt({ ...view, total: money('2092.38') }, { width: 58, font: 'normal' });
    expect(lines.some((l) => l.startsWith('Less: SC/PWD discount'))).toBe(false);
    expect(printed(lines, 'VATABLE SALES') + printed(lines, 'VAT (12%)') + printed(lines, 'VAT-EXEMPT SALES')).toBe(printed(lines, 'TOTAL'));
  });
});
