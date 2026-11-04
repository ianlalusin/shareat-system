/**
 * T-511 S4 - from parsed settlement files to staged store-days (PURE: no database, no auth, nothing written anywhere).
 * docs/tasks/511-settlement-upload-s4-spec.md "stage.ts" and the Opus rulings under it.
 *
 * One `StagedDay` per channel sales day: the columns of a `settlement_day_lines` row plus the loan and other lines under it.
 * `order_value` is NET as staff record it (Grab Net Sales, Foodpanda column R); the gross and the vendor discount are information
 * only and are never booked. Every cost or credit goes to its bucket through `deductionFor` (the mapping table, never a second copy).
 * Signs: a cost is positive, a credit negative (a Grab row's Total is minus the cost; a Foodpanda charge is its printed Net Total).
 * `unexplained` is the payout less what the rows add up to; a day that does not add up is marked, never refused.
 */
import { ZERO, add, compare, money, negate, subtract, type Money } from '@shareat/core/money';
import { deductionFor, type DeductionKind } from './deduction-mapping';
import type { FoodpandaCharge, FoodpandaInvoice, FoodpandaOrder } from './foodpanda-workbook';
import type { GrabPayout, GrabPayoutTie } from './grab-payouts';
import type { GrabTransactionRow, GrabTransactionsFile } from './grab-transactions';
import { intakeRefusal, shown } from './refusal';
import type { MatchedChannel } from './store-match';

export type StagedBookedAs = 'platformFee' | 'marketing' | 'none';
export type StagedOtherKind =
  | 'adjustment'
  | 'compensation'
  | 'chargeback'
  | 'withholding_tax'
  | 'advertisement'
  | 'cancelled_order'
  | 'period_charge'
  | 'platform_fee_weekly'
  | 'pandago';

export interface StagedLoanLine {
  kind: 'deduction' | 'disbursal';
  /** a magnitude above zero; the sign comes from the kind */
  amount: Money;
  rowOrdinal: number;
}

export interface StagedOtherLine {
  kind: StagedOtherKind;
  bookedAs: StagedBookedAs;
  amount: Money;
  lineDate: string | null;
  description: string | null;
}

export interface StagedDay {
  salesDate: string;
  platform: 'grab' | 'foodpanda';
  orderValue: Money;
  grossInfo: Money;
  commission: Money;
  marketing: Money;
  platformFee: Money;
  vendorDiscount: Money;
  loanDeduction: Money;
  loanDisbursal: Money;
  netPayout: Money;
  unexplained: Money;
  payoutReference: string | null;
  payoutDate: string | null;
  paymentArrivalDate: string | null;
  paidState: 'paid' | 'not_paid';
  feeMonthNote: string | null;
  loanLines: StagedLoanLine[];
  otherLines: StagedOtherLine[];
  warnings: string[];
}

export interface StagedFile {
  days: StagedDay[];
  /** lines that belong to the file but to no single day (PandaGO items, an ad with no order day) */
  periodLines: StagedOtherLine[];
  /** Grab payouts present in the Transfers file whose rows are not in the Transactions file (the first payout of a month) */
  waitingForRows: { settlementId: string; salesDate: string }[];
  /** plain sentences about the file as a whole (a weekly fee no day can pay); shown with the upload result, never a refusal */
  warnings: string[];
}

const STAGED_MONEY_FIELDS = [
  'orderValue', 'grossInfo', 'commission', 'marketing', 'platformFee', 'vendorDiscount', 'loanDeduction', 'loanDisbursal', 'netPayout', 'unexplained',
] as const;

const DESCRIPTION_MAX = 200;

/** Exact arithmetic that overflows the column is a named refusal, not a raw RangeError. */
function figured<T>(salesDate: string, work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) {
      throw intakeRefusal('STAGED_BAD_VALUE', `The figures for ${shown(salesDate)} add up to more than the system can hold.`);
    }
    throw e;
  }
}

type Buckets = Record<DeductionKind, Money>;
const emptyBuckets = (): Buckets => ({ commission: ZERO, marketing: ZERO, platformFee: ZERO, none: ZERO });
const put = (b: Buckets, kind: DeductionKind, amount: Money): void => {
  b[kind] = add(b[kind], amount);
};

/** The booking of an other line comes from its bucket; an other line can only feed platform fee or marketing, or nothing. */
function bookedAsOf(kind: DeductionKind, what: string): StagedBookedAs {
  if (kind === 'commission') throw intakeRefusal('STAGED_BAD_VALUE', `The line "${shown(what)}" maps to commission, which an adjustment line cannot carry.`);
  return kind;
}

/** payout less what the rows explain: net payout - (order value - commission - marketing - platform fee - loan deduction). Zero when the day adds up. */
function unexplainedOf(netPayout: Money, d: { orderValue: Money; commission: Money; marketing: Money; platformFee: Money; loanDeduction: Money }): Money {
  return subtract(netPayout, subtract(subtract(subtract(subtract(d.orderValue, d.commission), d.marketing), d.platformFee), d.loanDeduction));
}

function finishDay(day: Omit<StagedDay, 'unexplained' | 'warnings'>): StagedDay {
  const unexplained = figured(day.salesDate, () => unexplainedOf(day.netPayout, day));
  const warnings = compare(unexplained, ZERO) === 0 ? [] : [`The payout for ${day.salesDate} differs from what the rows add up to by ${unexplained}.`];
  return { ...day, unexplained, warnings };
}

/* ------------------------------------------------------------------ Grab */

const GRAB_LINE_KIND: Readonly<Record<string, StagedOtherKind>> = {
  'Withholding Tax Remittance (non-taxable)': 'withholding_tax',
  'Deduction - Eater Compensation': 'chargeback',
  'Compensation - Orders': 'compensation',
};

function grabDay(p: GrabPayout): StagedDay {
  const buckets = emptyBuckets();
  let orderValue = ZERO;
  let grossInfo = ZERO;
  let vendorDiscount = ZERO;
  let loanDeduction = ZERO;
  let loanDisbursal = ZERO;
  const loanLines: StagedLoanLine[] = [];
  const otherLines: StagedOtherLine[] = [];
  const commission = deductionFor('grab', 'Channel Commission');
  const advertisement = deductionFor('grab', 'Advertisement');

  const loanLine = (row: GrabTransactionRow): void => {
    const name = row.subcategory ?? 'Loans';
    deductionFor('grab', name); // an unknown loan subcategory stops the file here, naming it
    const total = row.total ?? ZERO;
    const kind = name === 'Loan Disbursal' ? 'disbursal' : 'deduction';
    const amount = kind === 'disbursal' ? total : negate(total);
    if (compare(amount, ZERO) <= 0) {
      throw intakeRefusal('STAGED_BAD_VALUE', `Line ${row.line}: a loan ${kind === 'disbursal' ? 'disbursal must be an amount paid in' : 'deduction must be an amount taken out'}.`);
    }
    loanLines.push({ kind, amount, rowOrdinal: loanLines.length });
    if (kind === 'disbursal') loanDisbursal = add(loanDisbursal, amount);
    else loanDeduction = add(loanDeduction, amount);
  };

  figured(p.storeDay, () => {
    for (const row of p.rows) {
      switch (row.kind) {
        case 'payment':
          orderValue = add(orderValue, row.netSales ?? ZERO);
          grossInfo = add(grossInfo, row.amount ?? ZERO);
          vendorDiscount = add(vendorDiscount, row.discount ?? ZERO);
          put(buckets, commission.kind, negate(row.channelCommission ?? ZERO));
          break;
        case 'adjustment': {
          const name = row.subcategory ?? 'Adjustment (no subcategory)';
          const d = deductionFor('grab', name);
          const amount = negate(row.total ?? ZERO);
          put(buckets, d.kind, amount);
          otherLines.push({
            kind: GRAB_LINE_KIND[name] ?? 'adjustment',
            bookedAs: bookedAsOf(d.kind, name),
            amount,
            lineDate: row.createdOn.date,
            description: row.description ? row.description.slice(0, DESCRIPTION_MAX) : null,
          });
          break;
        }
        case 'advertisement': {
          const amount = negate(row.total ?? ZERO);
          put(buckets, advertisement.kind, amount);
          otherLines.push({ kind: 'advertisement', bookedAs: bookedAsOf(advertisement.kind, 'Advertisement'), amount, lineDate: row.createdOn.date, description: null });
          break;
        }
        case 'loan':
          loanLine(row);
          break;
        case 'cancelled':
          break; // a cancelled order carries no money
      }
    }
  });

  const netPayout = figured(p.storeDay, () => subtract(p.netTotal, loanDisbursal));
  return finishDay({
    salesDate: p.storeDay,
    platform: 'grab',
    orderValue,
    grossInfo,
    commission: buckets.commission,
    marketing: buckets.marketing,
    platformFee: buckets.platformFee,
    vendorDiscount,
    loanDeduction,
    loanDisbursal,
    netPayout,
    payoutReference: p.settlementId,
    payoutDate: p.payoutDate,
    paymentArrivalDate: p.transferDate,
    paidState: p.status === 'completed' ? 'paid' : 'not_paid',
    feeMonthNote: null,
    loanLines,
    otherLines,
  });
}

/** One day per Grab payout that has rows; a payout with none is listed as waiting. The Transactions file only supplies the rows the tie already holds. */
export function stageGrabDays(tied: GrabPayoutTie, _transactions: GrabTransactionsFile): StagedFile {
  const days: StagedDay[] = [];
  const waitingForRows: StagedFile['waitingForRows'] = [];
  for (const p of tied.payouts) {
    if (p.state === 'waiting_for_rows') waitingForRows.push({ settlementId: p.settlementId, salesDate: p.storeDay });
    else days.push(grabDay(p));
  }
  days.sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  return { days, periodLines: [], waitingForRows, warnings: [] };
}

/* ------------------------------------------------------------------ Foodpanda */

/** The order columns that feed a bucket (commission, fees and credits), by the header `deductionFor` knows them under. */
const FOODPANDA_ORDER_COLUMNS: readonly (readonly [
  'commission' | 'surcharge' | 'withholdingTax' | 'waitingTimeFee' | 'cancellationFee' | 'pandaboxFee' | 'targetingFee' | 'campaignFee' | 'taxOnCharges' | 'expandedWithholdingTax',
  string,
])[] = [
  ['commission', 'foodpanda Commission'],
  ['surcharge', 'Surcharge Fee'],
  ['withholdingTax', '1/2% Withholding Tax'],
  ['waitingTimeFee', 'Waiting Time Fee'],
  ['cancellationFee', 'Cancellation Fee'],
  ['pandaboxFee', 'Pandabox Fee Paid By Vendor'],
  ['targetingFee', 'Customer Targeting Fee Paid By Vendor'],
  ['campaignFee', 'Delivery Fee Campaign Paid By Vendor'],
  ['taxOnCharges', 'Tax On Partner Charges'],
  ['expandedWithholdingTax', 'Expanded Withholding Tax'],
];

interface FoodpandaAcc {
  salesDate: string;
  orderValue: Money;
  grossInfo: Money;
  vendorDiscount: Money;
  balance: Money;
  buckets: Buckets;
  otherLines: StagedOtherLine[];
  feeMonthNote: string | null;
}

function addOrder(day: FoodpandaAcc, o: FoodpandaOrder): void {
  day.orderValue = add(day.orderValue, o.revenueAfterDiscounts);
  day.grossInfo = add(day.grossInfo, o.gross);
  day.vendorDiscount = add(day.vendorDiscount, o.vendorVoucher, o.vendorDiscount, o.pandaboxVoucher);
  day.balance = add(day.balance, o.balance);
  for (const [field, header] of FOODPANDA_ORDER_COLUMNS) {
    const value = o[field];
    if (value === null) continue; // the 32-column layout has no Surcharge Fee or Cancellation Fee
    const d = deductionFor('foodpanda', header);
    put(day.buckets, d.kind, d.sign === 'credit' ? negate(value) : value);
  }
}

/** What a day can still pay: its order value less its commission, marketing and fees so far. */
const room = (d: FoodpandaAcc): Money => subtract(subtract(subtract(d.orderValue, d.buckets.commission), d.buckets.marketing), d.buckets.platformFee);

export function stageFoodpandaDays(invoice: FoodpandaInvoice, _matched: Omit<MatchedChannel, 'isActive'>): StagedFile {
  const byDate = new Map<string, FoodpandaAcc>();
  for (const o of invoice.orders) {
    let day = byDate.get(o.orderDate);
    if (!day) {
      day = { salesDate: o.orderDate, orderValue: ZERO, grossInfo: ZERO, vendorDiscount: ZERO, balance: ZERO, buckets: emptyBuckets(), otherLines: [], feeMonthNote: null };
      byDate.set(o.orderDate, day);
    }
    figured(o.orderDate, () => addOrder(day, o));
  }
  const periodLines: StagedOtherLine[] = [];
  const warnings: string[] = [];
  const weekly: FoodpandaCharge[] = [];
  const charge = (c: FoodpandaCharge, line: Omit<StagedOtherLine, 'amount' | 'lineDate'>, day: FoodpandaAcc | undefined): void => {
    const l: StagedOtherLine = { ...line, amount: c.netTotal, lineDate: c.date };
    if (day) day.otherLines.push(l);
    else periodLines.push(l);
  };
  for (const c of invoice.charges) {
    if (c.kind === 'platform_fee') {
      weekly.push(c);
    } else if (c.kind === 'cpc_ad') {
      const kind = deductionFor('foodpanda', 'cpc_ad').kind;
      const day = c.date ? byDate.get(c.date) : undefined;
      if (day) figured(day.salesDate, () => put(day.buckets, kind, c.netTotal));
      charge(c, { kind: 'advertisement', bookedAs: bookedAsOf(kind, 'CPC ad'), description: null }, day);
    } else if (c.kind === 'pandago') {
      charge(c, { kind: 'pandago', bookedAs: bookedAsOf(deductionFor('foodpanda', 'pandago').kind, 'PandaGO'), description: null }, undefined);
    } else {
      // an unrecognised appendix B category: kept for the record, never booked
      charge(c, { kind: 'period_charge', bookedAs: 'none', description: shown(c.category).slice(0, DESCRIPTION_MAX) }, undefined);
    }
  }

  // The weekly Platform Fee has no order day of its own: the last sales day, or the nearest earlier day that can pay it.
  const ordered = [...byDate.values()].sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  const feeKind = deductionFor('foodpanda', 'platform_fee').kind;
  for (const c of weekly) {
    const covering = [...ordered].reverse().find((d) => compare(subtract(room(d), c.netTotal), ZERO) >= 0);
    const day = covering ?? ordered[ordered.length - 1];
    if (day && !covering) warnings.push(`The weekly platform fee on this invoice is larger than any single sales day: it was placed on ${day.salesDate}, please check.`);
    if (!day) warnings.push('This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.');
    if (day) {
      figured(day.salesDate, () => put(day.buckets, feeKind, c.netTotal));
      day.feeMonthNote = c.feeMonthNote;
    }
    const note = c.feeMonthNote ? c.feeMonthNote.slice(0, DESCRIPTION_MAX) : null;
    // with no sales day there is nothing to book it against: kept for the record, booked as nothing, a person decides
    if (day) charge(c, { kind: 'platform_fee_weekly', bookedAs: bookedAsOf(feeKind, 'Platform Fee'), description: note }, day);
    else charge(c, { kind: 'period_charge', bookedAs: 'none', description: note ?? 'Platform Fee' }, undefined);
  }

  const days = ordered.map((d) => {
    const date = d.salesDate;
    // The invoice's balance already has the order-column fees taken off; the ads and the weekly fee come off the payout separately.
    const netPayout = figured(date, () => subtract(subtract(d.balance, d.buckets.marketing), d.otherLines.filter((l) => l.kind === 'platform_fee_weekly').reduce((t, l) => add(t, l.amount), ZERO)));
    return finishDay({
      salesDate: date,
      platform: 'foodpanda',
      orderValue: d.orderValue,
      grossInfo: d.grossInfo,
      commission: d.buckets.commission,
      marketing: d.buckets.marketing,
      platformFee: d.buckets.platformFee,
      vendorDiscount: d.vendorDiscount,
      loanDeduction: ZERO,
      loanDisbursal: ZERO,
      netPayout,
      payoutReference: invoice.invoiceNumber,
      payoutDate: invoice.invoiceDate,
      paymentArrivalDate: null,
      paidState: 'not_paid',
      feeMonthNote: d.feeMonthNote,
      loanLines: [],
      otherLines: d.otherLines,
    });
  });
  return { days, periodLines, waitingForRows: [], warnings };
}

/* ------------------------------------------------------------------ the table CHECKs, in code first */

const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const bad = (message: string) => intakeRefusal('STAGED_BAD_VALUE', message);

/** A figure the table's finite CHECK would accept; a refusal naming the field otherwise. */
function checkedMoney(value: unknown, what: string): Money {
  try {
    return money(value as string);
  } catch {
    throw bad(`The ${what} is not a valid amount.`);
  }
}

/**
 * Mirrors what the tables would refuse (finite money, a loan amount above zero, PandaGO never booked, a description of at most 200
 * characters) plus the sign of commission, so a bad stage stops in code with a named refusal instead of as a database error.
 */
export function checkStagedDay(day: StagedDay): void {
  const on = shown(day.salesDate);
  if (!ISO_DATE.test(day.salesDate)) throw bad('A staged day has a sales date that is not a real date.');
  for (const field of STAGED_MONEY_FIELDS) checkedMoney(day[field], `${field} figure on ${on}`);
  if (compare(money(day.commission), ZERO) < 0) throw bad(`The commission on ${on} is negative; commission is stored as a positive cost.`);
  for (const [name, date] of [['payout date', day.payoutDate], ['payment arrival date', day.paymentArrivalDate]] as const) {
    if (date !== null && !ISO_DATE.test(date)) throw bad(`The ${name} on ${on} is not a real date.`);
  }
  for (const l of day.loanLines) {
    const amount = checkedMoney(l.amount, `loan ${l.kind} amount on ${on}`);
    if (compare(amount, ZERO) <= 0) throw bad(`A loan ${l.kind} on ${on} must be above zero.`);
  }
  checkOtherLines(day.otherLines, on);
}

function checkOtherLines(lines: readonly StagedOtherLine[], on: string): void {
  for (const l of lines) {
    checkedMoney(l.amount, `${l.kind} amount on ${on}`);
    if (l.kind === 'pandago' && l.bookedAs !== 'none') throw bad(`A PandaGO line on ${on} cannot be booked.`);
    if (l.description !== null && l.description.length > DESCRIPTION_MAX) throw bad(`A line description on ${on} is over ${DESCRIPTION_MAX} characters.`);
    if (l.lineDate !== null && !ISO_DATE.test(l.lineDate)) throw bad(`A ${l.kind} line on ${on} has a date that is not a real date.`);
  }
}

/** The same checks for lines that belong to the file but to no single day (PandaGO items, an ad with no order day, a fee with no sales day). */
export function checkStagedPeriodLines(lines: readonly StagedOtherLine[]): void {
  checkOtherLines(lines, 'the invoice period');
}
