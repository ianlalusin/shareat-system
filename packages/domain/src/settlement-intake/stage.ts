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
import { ZERO, add, compare, fromCentavos, money, negate, subtract, toCentavos, type Money } from '@shareat/core/money';
import { buildRuleBook, type RuleBook } from '../business-rules/book';
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
  /** T-511 S6c: the VAT of THIS line (same sign as `amount`, 2 decimals); set for `period_charge` only, whose VAT rides in no day. Elsewhere the VAT is inside the day's platformFee. */
  vat?: Money;
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
  /** PandaGO rows as printed, summed (a credit, so negative: the cash PandaGO riders collected for the partner outweighs the fees); null when the invoice has none. For the screen note only, never booked. */
  pandagoNetTotal: Money | null;
  /** what Foodpanda PAYS the partner for PandaGO: the printed total after the VAT on its rows, as a positive magnitude; null when the invoice has none. For the screen note only, never booked. */
  pandagoReceivable: Money | null;
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
  return { days, periodLines: [], waitingForRows, warnings: [], pandagoNetTotal: null, pandagoReceivable: null };
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
  /** platform fee taken by the order columns alone, before any Appendix B charge, VAT or rounding line */
  orderFees: Money;
  /** sum of (Appendix B net in centavos x VAT percent) on this day: x100 of the exact VAT in centavos */
  vatNumerator: bigint;
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

/* Exact centavo arithmetic (bigint, never a float). Rounding is half away from zero, as the Money type's own multiply does. */
const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const roundedDiv = (num: bigint, den: bigint): bigint => {
  const q = (2n * abs(num) + den) / (2n * den);
  return num < 0n ? -q : q;
};
const floorDiv = (num: bigint, den: bigint): bigint => (num >= 0n ? num / den : -((-num + den - 1n) / den));

/**
 * THE one copy of the VAT rounding: `numerator` is the sum of (net centavos x VAT percent) and the answer is the VAT in centavos, rounded half away from zero ONCE.
 * Staging (per period line, and per invoice for the days), the "VAT lost" warning and the review screen's VAT on fees all call it.
 */
export function vatCentavosOf(numerator: bigint): bigint {
  return roundedDiv(numerator, 100n);
}

/**
 * The 12% VAT the PDF adds on Appendix B is rounded ONCE on the invoice, then handed to the days so the shares add up to it exactly:
 * each day gets the centavos below its exact share, the leftover centavos go one each to the days with the largest remainder (ties: the earlier day).
 */
function applyVat(ordered: FoodpandaAcc[]): void {
  const total = vatCentavosOf(ordered.reduce((t, d) => t + d.vatNumerator, 0n));
  const floors = ordered.map((d) => floorDiv(d.vatNumerator, 100n));
  let leftover = total - floors.reduce((t, n) => t + n, 0n);
  const byRemainder = ordered.map((d, i) => ({ i, rem: d.vatNumerator - floors[i]! * 100n })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of byRemainder) {
    if (leftover <= 0n) break;
    floors[i] = floors[i]! + 1n;
    leftover -= 1n;
  }
  ordered.forEach((d, i) => figured(d.salesDate, () => put(d.buckets, 'platformFee', fromCentavos(floors[i]!))));
}

const NOT_USUAL_RULE = 'The withholding on this invoice does not match the usual rule, so the net can differ from the PDF by the withholding of the odd orders.';

/** The VAT percent of an additional charge as a whole number; a fraction, a negative or an enormous rate is refused by name, never turned into a crash. */
function vatPercentOf(c: FoodpandaCharge): bigint {
  if (!Number.isInteger(c.vatRate) || c.vatRate < 0) throw intakeRefusal('STAGED_BAD_VALUE', `The VAT rate ${c.vatRate} on an additional charge is not one this screen can read. Ask for help.`);
  return BigInt(c.vatRate);
}

/** The VAT of one charge that no day carries: its net x its own printed rate, rounded half up once (never a constant rate). */
const periodVat = (c: FoodpandaCharge): Money => fromCentavos(vatCentavosOf(toCentavos(c.netTotal) * vatPercentOf(c)));

/** A charge with no day to carry it: its VAT is not in any day (it is staged on the period line, S6c, and booked from there). */
const vatLostWarning = (c: FoodpandaCharge): string =>
  `This invoice has an ad charge (or platform fee) of ${c.netTotal} on a day with no orders, so its ${c.vatRate}% VAT of ${periodVat(c)} is not included in any day. It needs review.`;

/**
 * T-512 (T-511 S5c) - the two business rules staging reads, as plain numbers so this file stays pure: the withholding rate and the VAT percent, each in
 * basis points (percent x 100). The caller resolves them from the rule book on the invoice's last sales day (`stageRulesOn`) and passes them in; a call
 * with no rules uses the registry defaults (0.5% and 12%), which is what every staged file was computed with before the rules were a table.
 */
export interface StageRules {
  withholdingBp: bigint;
  vatBp: bigint;
}

export const STAGE_RULE_KEYS = ['tax.withholding_rate_percent', 'tax.vat_percent'] as const;

/** The staging rules in force on one date, from a rule book loaded for `STAGE_RULE_KEYS`. */
export function stageRulesOn(book: RuleBook, date: string): StageRules {
  return { withholdingBp: book.valueOn('tax.withholding_rate_percent', date).basisPoints(), vatBp: book.valueOn('tax.vat_percent', date).basisPoints() };
}

/** The day whose rules apply to a whole invoice: its last sales day (the invoice date when it has no orders). */
export function foodpandaRuleDate(invoice: FoodpandaInvoice): string {
  return invoice.orders.reduce((last, o) => (o.orderDate.localeCompare(last) > 0 ? o.orderDate : last), invoice.orders[0]?.orderDate ?? invoice.invoiceDate);
}

// The registry defaults, read from the registry itself (an empty book answers every key with its default): no second copy of 0.5 and 12.
const DEFAULT_STAGE_RULES: StageRules = stageRulesOn(buildRuleBook([]), '1970-01-01');

/**
 * The PDF takes the withholding once on the invoice; the workbook rounds it per order. The remainder is (sum of the workbook's per-order withholding) less
 * the rate applied to the summed base, rounded once. The base is column R, or R / (1 + VAT) for the Lipa invoices: the one under which the rate reproduces EVERY
 * order's withholding. When neither does, nothing is guessed: no remainder and a warning.
 */
function withholdingRounding(orders: readonly FoodpandaOrder[], rules: StageRules): { remainder: bigint; warning: string | null } {
  const withheld = orders.reduce((t, o) => t + toCentavos(o.withholdingTax), 0n);
  const bases: bigint[][] = [orders.map((o) => toCentavos(o.revenueAfterDiscounts)), orders.map((o) => roundedDiv(toCentavos(o.revenueAfterDiscounts) * 10000n, 10000n + rules.vatBp))];
  for (const base of bases) {
    if (orders.every((o, i) => roundedDiv(base[i]! * rules.withholdingBp, 10000n) === toCentavos(o.withholdingTax))) {
      return { remainder: withheld - roundedDiv(base.reduce((t, n) => t + n, 0n) * rules.withholdingBp, 10000n), warning: null };
    }
  }
  return { remainder: 0n, warning: orders.length === 0 ? null : NOT_USUAL_RULE };
}

/** What a day can still pay: its order value less its commission, marketing and fees so far. */
const room = (d: FoodpandaAcc): Money => subtract(subtract(subtract(d.orderValue, d.buckets.commission), d.buckets.marketing), d.buckets.platformFee);

export function stageFoodpandaDays(invoice: FoodpandaInvoice, _matched: Omit<MatchedChannel, 'isActive'>, rules: StageRules = DEFAULT_STAGE_RULES): StagedFile {
  const byDate = new Map<string, FoodpandaAcc>();
  for (const o of invoice.orders) {
    let day = byDate.get(o.orderDate);
    if (!day) {
      day = { salesDate: o.orderDate, orderValue: ZERO, grossInfo: ZERO, vendorDiscount: ZERO, balance: ZERO, buckets: emptyBuckets(), orderFees: ZERO, vatNumerator: 0n, otherLines: [], feeMonthNote: null };
      byDate.set(o.orderDate, day);
    }
    figured(o.orderDate, () => addOrder(day, o));
  }
  for (const d of byDate.values()) d.orderFees = d.buckets.platformFee;
  const periodLines: StagedOtherLine[] = [];
  const warnings: string[] = [];
  const weekly: FoodpandaCharge[] = [];
  const charge = (c: FoodpandaCharge, line: Omit<StagedOtherLine, 'amount' | 'lineDate'>, day: FoodpandaAcc | undefined): void => {
    // a charge with no sales day and no date of its own is dated by the invoice (its date is read from the file); a date the file gives still wins
    const l: StagedOtherLine = { ...line, amount: c.netTotal, lineDate: line.kind === 'period_charge' ? (c.date ?? invoice.invoiceDate) : c.date };
    if (day) day.otherLines.push(l);
    else periodLines.push(l);
  };
  for (const c of invoice.charges) {
    if (c.kind === 'platform_fee') {
      weekly.push(c);
    } else if (c.kind === 'cpc_ad') {
      const kind = deductionFor('foodpanda', 'cpc_ad').kind;
      const day = c.date ? byDate.get(c.date) : undefined;
      const pct = vatPercentOf(c);
      if (day) figured(day.salesDate, () => { put(day.buckets, kind, c.netTotal); day.vatNumerator += toCentavos(c.netTotal) * pct; });
      else warnings.push(vatLostWarning(c));
      charge(c, { kind: 'advertisement', bookedAs: bookedAsOf(kind, 'CPC ad'), description: null }, day);
    } else if (c.kind === 'pandago') {
      charge(c, { kind: 'pandago', bookedAs: bookedAsOf(deductionFor('foodpanda', 'pandago').kind, 'PandaGO'), description: null }, undefined);
    } else {
      // an unrecognised appendix B category: kept for the record, never booked
      charge(c, { kind: 'period_charge', bookedAs: 'none', description: shown(c.category).slice(0, DESCRIPTION_MAX), vat: periodVat(c) }, undefined);
    }
  }

  // The weekly Platform Fee has no order day of its own: the last sales day, or the nearest earlier day that can pay it.
  const ordered = [...byDate.values()].sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  const feeKind = deductionFor('foodpanda', 'platform_fee').kind;
  for (const c of weekly) {
    const covering = [...ordered].reverse().find((d) => compare(subtract(room(d), c.netTotal), ZERO) >= 0);
    const day = covering ?? ordered[ordered.length - 1];
    if (day && !covering) warnings.push(`The weekly platform fee on this invoice is larger than any single sales day: it was placed on ${day.salesDate}, please check.`);
    if (!day) {
      warnings.push('This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.');
      warnings.push(vatLostWarning(c));
    }
    if (day) {
      const pct = vatPercentOf(c);
      figured(day.salesDate, () => { put(day.buckets, feeKind, c.netTotal); day.vatNumerator += toCentavos(c.netTotal) * pct; });
      day.feeMonthNote = c.feeMonthNote;
    }
    const note = c.feeMonthNote ? c.feeMonthNote.slice(0, DESCRIPTION_MAX) : null;
    // with no sales day there is nothing to book it against: kept for the record, booked as nothing, a person decides
    if (day) charge(c, { kind: 'platform_fee_weekly', bookedAs: bookedAsOf(feeKind, 'Platform Fee'), description: note }, day);
    else charge(c, { kind: 'period_charge', bookedAs: 'none', description: note ?? 'Platform Fee', vat: periodVat(c) }, undefined);
  }

  applyVat(ordered);
  const rounding = withholdingRounding(invoice.orders, rules);
  if (rounding.warning) warnings.push(rounding.warning);
  const lastDay = ordered[ordered.length - 1];
  if (lastDay && rounding.remainder !== 0n) {
    const amount = fromCentavos(-rounding.remainder);
    figured(lastDay.salesDate, () => put(lastDay.buckets, 'platformFee', amount));
    lastDay.otherLines.push({ kind: 'adjustment', bookedAs: 'platformFee', amount, lineDate: null, description: 'withholding rounding to the PDF total' });
  }

  const days = ordered.map((d) => {
    const date = d.salesDate;
    // The invoice's balance already has the order-column fees taken off; the ads, the weekly fee, the VAT on them and the rounding line come off the payout separately.
    const netPayout = figured(date, () => subtract(subtract(d.balance, d.buckets.marketing), subtract(d.buckets.platformFee, d.orderFees)));
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
  const pandago = invoice.charges.filter((c) => c.kind === 'pandago');
  const pandagoNetTotal = pandago.length === 0 ? null : add(...pandago.map((c) => c.netTotal));
  const pandagoVat = pandago.reduce((t, c) => t + toCentavos(c.netTotal) * vatPercentOf(c), 0n);
  const pandagoReceivable = pandagoNetTotal === null ? null : fromCentavos(abs(toCentavos(pandagoNetTotal) + vatCentavosOf(pandagoVat)));
  return { days, periodLines, waitingForRows: [], warnings, pandagoNetTotal, pandagoReceivable };
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
