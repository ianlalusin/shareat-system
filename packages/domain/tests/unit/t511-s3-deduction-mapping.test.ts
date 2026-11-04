/**
 * T-511 S3 (E) - the Component I table as data: `deductionFor(platform, column)`.
 * `docs/designs/channel-settlement-upload.md` Component I and spec item 7.
 *
 * CONTRACT PINNED HERE (the spec names the function but not its inputs or return type):
 *   deductionFor(platform: 'grab' | 'foodpanda', column: string): { kind: 'commission' | 'marketing' | 'platformFee' | 'none'; sign: 'cost' | 'credit' }
 *   `column` is, for Grab, the header text ("Channel Commission", "Discount (Merchant-Funded)", "Amount"), the adjustment Subcategory text,
 *   the Category "Advertisement" or the loan Subcategory text; for Foodpanda it is the NORMALISED Appendix A header text (the letters
 *   differ between layouts, the words do not) or, for Appendix B, the charge kind: "cpc_ad", "platform_fee", "pandago".
 *   `sign` is asserted only when kind is not 'none'. An unknown column is refused: GRAB_UNKNOWN_COLUMN / FOODPANDA_UNKNOWN_COLUMN, naming it.
 */
import { describe, expect, it } from 'vitest';
import { deductionFor } from '../../src/settlement-intake/deduction-mapping';
import { normalizeFoodpandaHeader } from '../../src/settlement-intake/foodpanda-workbook';
import { FP34_HEADERS, refusalOf } from './t511-s3-helpers';

type Row = [column: string, kind: string, sign: 'cost' | 'credit' | null];

const GRAB: Row[] = [
  ['Channel Commission', 'commission', 'cost'],
  ['Withholding Tax Remittance (non-taxable)', 'platformFee', 'cost'],
  ['Deduction - Eater Compensation', 'platformFee', 'cost'],
  ['Compensation - Orders', 'platformFee', 'credit'],
  ['Advertisement', 'marketing', 'cost'],
  ['Discount (Merchant-Funded)', 'none', null],
  ['Amount', 'none', null],
  ['Loan Deduction', 'none', null],
  ['Loan Disbursal', 'none', null],
];

const FOODPANDA: Row[] = [
  ['foodpanda Commission', 'commission', 'cost'],
  ['Gross Food Value / Product Value By Customer', 'none', null], // K
  ['Voucher Paid By Vendor', 'none', null], // O
  ['Discount Paid By Vendor', 'none', null], // P
  ['Pandabox Voucher Paid By Vendor', 'none', null], // Q
  ['Surcharge Fee', 'platformFee', 'credit'], // S
  ['Expanded Withholding Tax', 'platformFee', 'credit'], // AE
  ['1/2% Withholding Tax', 'platformFee', 'cost'], // T
  ['Waiting Time Fee', 'platformFee', 'cost'], // U
  ['Cancellation Fee', 'platformFee', 'cost'], // V
  ['Pandabox Fee Paid By Vendor', 'platformFee', 'cost'], // Z
  ['Customer Targeting Fee Paid By Vendor', 'platformFee', 'cost'], // AB
  ['Delivery Fee Campaign Paid By Vendor', 'platformFee', 'cost'], // AC
  ['Tax On Partner Charges', 'platformFee', 'cost'], // AD
  ['cpc_ad', 'marketing', 'cost'], // Appendix B CPC ads
  ['platform_fee', 'platformFee', 'cost'], // Appendix B Platform Fee
  ['pandago', 'none', null], // Appendix B PandaGO rows: shown, never booked
];

describe('deductionFor: Grab', () => {
  it.each(GRAB)('%s -> %s %s', (column, kind, sign) => {
    const d = deductionFor('grab', column);
    expect(d.kind).toBe(kind);
    if (sign) expect(d.sign).toBe(sign);
  });

  it('the discount column and Amount are information only (staff record the sale net of it): kind none', () => {
    expect(deductionFor('grab', 'Discount (Merchant-Funded)').kind).toBe('none');
    expect(deductionFor('grab', 'Amount').kind).toBe('none');
  });

  it('an unknown Grab column is refused naming it', async () => {
    const r = await refusalOf(() => deductionFor('grab', 'Mystery Charge'));
    expect(r.code).toBe('GRAB_UNKNOWN_COLUMN');
    expect(r.userMessage).toContain('Mystery Charge');
  });
});

describe('deductionFor: Foodpanda', () => {
  it.each(FOODPANDA)('%s -> %s %s', (column, kind, sign) => {
    const d = deductionFor('foodpanda', column);
    expect(d.kind).toBe(kind);
    if (sign) expect(d.sign).toBe(sign);
  });

  it('O, P and Q are information only: R is already after them (kind none)', () => {
    for (const c of ['Voucher Paid By Vendor', 'Discount Paid By Vendor', 'Pandabox Voucher Paid By Vendor']) expect(deductionFor('foodpanda', c).kind).toBe('none');
  });

  it('S and AE are the only credits among the fee columns (the balance adds them)', () => {
    const credits = FOODPANDA.filter(([, kind, sign]) => kind !== 'none' && sign === 'credit').map(([c]) => c);
    expect(credits.sort()).toEqual(['Expanded Withholding Tax', 'Surcharge Fee']);
    for (const c of credits) expect(deductionFor('foodpanda', c).sign).toBe('credit');
  });

  it('the table is keyed by the normalised header: the real header strings, normalised, find their row', () => {
    const real = FP34_HEADERS.find((h) => h.startsWith('Tax On Partner Charges')) as string;
    expect(deductionFor('foodpanda', normalizeFoodpandaHeader(real)).kind).toBe('platformFee');
    const comm = FP34_HEADERS.find((h) => h.startsWith('foodpanda Commission (')) as string;
    expect(deductionFor('foodpanda', normalizeFoodpandaHeader(comm)).kind).toBe('commission');
  });

  it('an unknown Foodpanda column is refused naming it', async () => {
    const r = await refusalOf(() => deductionFor('foodpanda', 'Mystery Column'));
    expect(r.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    expect(r.userMessage).toContain('Mystery Column');
  });

  it('one platform never answers for the other: a Foodpanda column asked of Grab is unknown', async () => {
    expect((await refusalOf(() => deductionFor('grab', 'Surcharge Fee'))).code).toBe('GRAB_UNKNOWN_COLUMN');
    expect((await refusalOf(() => deductionFor('foodpanda', 'Channel Commission'))).code).toBe('FOODPANDA_UNKNOWN_COLUMN');
  });
});
