/**
 * T-511 S3 - Component I of `docs/designs/channel-settlement-upload.md` as DATA: what each Grab column or category and each Foodpanda
 * column means for the books. `kind` is the deduction it feeds (`commission`, `marketing`, `platformFee`) or `none` (information only, or a
 * loan leg); `sign` is whether it costs the store or pays it back. No staging logic here (slice 4, `stage.ts`).
 *
 * Grab keys are the header text, the adjustment Subcategory, the loan Subcategory or the Category `Advertisement`. Foodpanda keys are the
 * NORMALISED Appendix A header text (the letters differ between layouts, the words do not) or, for Appendix B, the charge kind
 * (`cpc_ad`, `platform_fee`, `pandago`). A key that is not in the table is refused, naming it, so a new column stops the file.
 */
import { intakeRefusal, shown } from './refusal';

export type DeductionKind = 'commission' | 'marketing' | 'platformFee' | 'none';
export type DeductionSign = 'cost' | 'credit';
export interface Deduction {
  kind: DeductionKind;
  sign: DeductionSign;
}

const cost = (kind: DeductionKind): Deduction => ({ kind, sign: 'cost' });
const credit = (kind: DeductionKind): Deduction => ({ kind, sign: 'credit' });
const NONE: Deduction = cost('none');

const GRAB: Readonly<Record<string, Deduction>> = {
  'Channel Commission': cost('commission'),
  // Adjustment rows: Total is negative for a withholding-tax remittance or an eater-compensation chargeback, positive for a compensation.
  'Withholding Tax Remittance (non-taxable)': cost('platformFee'),
  'Deduction - Eater Compensation': cost('platformFee'),
  'Compensation - Orders': credit('platformFee'),
  Advertisement: cost('marketing'),
  // Information only: staff record the sale net of the discount (decision 15), and Amount is the pre-discount figure.
  'Discount (Merchant-Funded)': NONE,
  Amount: NONE,
  // Loan legs are not a platform charge.
  'Loan Deduction': NONE,
  'Loan Disbursal': NONE,
};

const FOODPANDA: Readonly<Record<string, Deduction>> = {
  'foodpanda Commission': cost('commission'),
  // O, P, Q are information only: R is already after them.
  'Voucher Paid By Vendor': NONE,
  'Discount Paid By Vendor': NONE,
  'Pandabox Voucher Paid By Vendor': NONE,
  'Gross Food Value / Product Value By Customer': NONE,
  'Container Charges Paid By Customer': NONE,
  'MOV Paid By Customer': NONE,
  'Partner Delivery Fee Paid By Customer': NONE,
  'Sales Revenue Via foodpanda After Partner Funded Discounts': NONE,
  'Already Received Amount By Vendor': NONE,
  'Cancelled Orders (Wastage)': NONE,
  'Balance to be paid to Partner': NONE,
  // S and AE are credits: the balance adds them.
  'Surcharge Fee': credit('platformFee'),
  'Expanded Withholding Tax': credit('platformFee'),
  '1/2% Withholding Tax': cost('platformFee'),
  'Waiting Time Fee': cost('platformFee'),
  'Cancellation Fee': cost('platformFee'),
  'Pandabox Fee Paid By Vendor': cost('platformFee'),
  'Customer Targeting Fee Paid By Vendor': cost('platformFee'),
  'Delivery Fee Campaign Paid By Vendor': cost('platformFee'),
  'Tax On Partner Charges': cost('platformFee'),
  // Appendix B charge kinds.
  cpc_ad: cost('marketing'),
  platform_fee: cost('platformFee'),
  // PandaGO rows are shown, never booked.
  pandago: NONE,
};

const FOODPANDA_BY_LOWER: ReadonlyMap<string, Deduction> = new Map(Object.entries(FOODPANDA).map(([k, v]) => [k.toLowerCase(), v]));

export function deductionFor(platform: 'grab' | 'foodpanda', column: string): Deduction {
  if (platform === 'grab') {
    const found = Object.hasOwn(GRAB, column) ? GRAB[column] : undefined;
    if (found) return found;
    throw intakeRefusal('GRAB_UNKNOWN_COLUMN', `The Grab column "${shown(column)}" has no deduction rule.`);
  }
  const found = FOODPANDA_BY_LOWER.get(column.trim().toLowerCase());
  if (found) return found;
  throw intakeRefusal('FOODPANDA_UNKNOWN_COLUMN', `The Foodpanda column "${shown(column)}" has no deduction rule.`);
}
