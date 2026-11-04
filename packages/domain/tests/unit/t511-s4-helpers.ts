/**
 * T-511 S4 - shared test helpers for staging (NOT a test file: vitest only collects *.test.ts).
 *
 * Everything here is the INDEPENDENT oracle: expected staged figures are computed straight from the fixture files with plain
 * BigInt centavo arithmetic and the CSV parser from the S3 helpers, never by calling `stage.ts`. The Foodpanda oracle starts from the
 * S3 reader's typed output (the reader is slice 3, already tested; only `stage` is under test here) and from the slice-1 balance sums.
 */
import type { FoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { fixture, parseGrab, type GrabCsv } from './t511-s3-helpers';

/* ------------------------------------------------------------------ centavo arithmetic */

export function cents(text: string | number): bigint {
  const s = String(text).trim();
  if (s === '') return 0n;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [i = '0', f = ''] = body.split('.');
  const v = BigInt(i === '' ? '0' : i) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -v : v;
}

export function fmt(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

export const sum = (xs: Iterable<bigint>): bigint => {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
};

/* ------------------------------------------------------------------ Grab oracle */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `13 Oct 2026 1:49 AM` -> '2026-10-13' (the printed Manila date, own tiny parser). */
export function printedDate(text: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) /.exec(text.trim());
  if (!m) throw new Error(`oracle: not a Grab date: ${text}`);
  return `${m[3]}-${String(MONTHS.indexOf(m[2] as string) + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

export function dayBeforeIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface ExpectedLoanLine {
  kind: 'deduction' | 'disbursal';
  amount: string;
  /** the line of the file the row sits on (header is line 1) */
  fileLine: number;
}
export interface ExpectedOtherLine {
  /** the Category (Advertisement) or the adjustment Subcategory the row carries */
  source: string;
  /** cost positive, credit negative: the negation of the row's Total */
  amount: string;
  lineDate: string;
}
export interface ExpectedGrabDay {
  salesDate: string;
  settlementId: string;
  payoutDate: string;
  paid: boolean;
  transferDate: string | null;
  orderValue: string;
  grossInfo: string;
  commission: string;
  marketing: string;
  platformFee: string;
  loanDeduction: string;
  loanDisbursal: string;
  netPayout: string;
  unexplained: string;
  loanLines: ExpectedLoanLine[];
  otherLines: ExpectedOtherLine[];
}

const col = (g: GrabCsv, name: string): number => {
  const i = g.headers.findIndex((h) => h.trim() === name);
  if (i < 0) throw new Error(`oracle: no column ${name}`);
  return i;
};

/**
 * The independent per-store-day expectation for a Grab Transactions + Transfers pair. A payout with no rows in the Transactions file is
 * NOT staged (it is `waiting_for_rows`), returned separately. Rules: spec 511-s4 (stage.ts) and the S3 fixture analysis:
 * order value = sum of Net Sales of Payment rows; commission = minus the sum of Channel Commission; marketing = minus the Total of Advertisement
 * rows; platform fee = minus the Total of Adjustment rows; loan deduction = minus the Total of Loan Deduction rows; disbursal = the Total of
 * Loan Disbursal rows; net payout = payout Net Total minus the disbursal; unexplained = net payout - (order value - commission - marketing -
 * platform fee - loan deduction). All verified to be 0.00 on every Lipa, Malvar and Banay October payout.
 */
export function grabOracle(txBytes: Buffer, trBytes: Buffer): { days: Map<string, ExpectedGrabDay>; waiting: { settlementId: string; salesDate: string }[] } {
  const tx = parseGrab(txBytes);
  const tr = parseGrab(trBytes);
  const c = {
    category: col(tx, 'Category'), sub: col(tx, 'Subcategory'), settle: col(tx, 'Settlement ID'), total: col(tx, 'Total'), created: col(tx, 'Created On'),
    net: col(tx, 'Net Sales'), amount: col(tx, 'Amount'), comm: col(tx, 'Channel Commission'),
  };
  const bySettlement = new Map<string, { row: string[]; line: number }[]>();
  tx.rows.forEach((row, i) => {
    const id = (row[c.settle] ?? '').trim().toUpperCase();
    if (id === '') return;
    const list = bySettlement.get(id) ?? [];
    list.push({ row, line: i + 2 });
    bySettlement.set(id, list);
  });
  const days = new Map<string, ExpectedGrabDay>();
  const waiting: { settlementId: string; salesDate: string }[] = [];
  for (const t of tr.rows) {
    const settlementId = (t[col(tr, 'Settlement ID')] ?? '').trim();
    const payoutDate = printedDate(t[col(tr, 'Date')] as string);
    const salesDate = dayBeforeIso(payoutDate);
    const rows = bySettlement.get(settlementId.toUpperCase()) ?? [];
    if (rows.length === 0) {
      waiting.push({ settlementId, salesDate });
      continue;
    }
    const cat = (r: string[]): string => (r[c.category] ?? '').trim();
    const sub = (r: string[]): string => (r[c.sub] ?? '').trim();
    const pay = rows.filter((x) => cat(x.row) === 'Payment');
    const adjustments = rows.filter((x) => cat(x.row) === 'Adjustment');
    const ads = rows.filter((x) => cat(x.row) === 'Advertisement');
    const loans = rows.filter((x) => cat(x.row) === 'Loans');
    const orderValue = sum(pay.map((x) => cents(x.row[c.net] as string)));
    const grossInfo = sum(pay.map((x) => cents(x.row[c.amount] as string)));
    const commission = -sum(pay.map((x) => cents(x.row[c.comm] as string)));
    const marketing = -sum(ads.map((x) => cents(x.row[c.total] as string)));
    const platformFee = -sum(adjustments.map((x) => cents(x.row[c.total] as string)));
    const loanDeduction = -sum(loans.filter((x) => sub(x.row) === 'Loan Deduction').map((x) => cents(x.row[c.total] as string)));
    const loanDisbursal = sum(loans.filter((x) => sub(x.row) === 'Loan Disbursal').map((x) => cents(x.row[c.total] as string)));
    const netPayout = cents(t[col(tr, 'Net Total')] as string) - loanDisbursal;
    const unexplained = netPayout - (orderValue - commission - marketing - platformFee - loanDeduction);
    const transfer = (t[col(tr, 'Transfer Date')] ?? '').trim();
    days.set(salesDate, {
      salesDate,
      settlementId,
      payoutDate,
      paid: (t[col(tr, 'Status')] ?? '').trim() === 'Completed',
      transferDate: transfer === '' ? null : printedDate(transfer),
      orderValue: fmt(orderValue),
      grossInfo: fmt(grossInfo),
      commission: fmt(commission),
      marketing: fmt(marketing),
      platformFee: fmt(platformFee),
      loanDeduction: fmt(loanDeduction),
      loanDisbursal: fmt(loanDisbursal),
      netPayout: fmt(netPayout),
      unexplained: fmt(unexplained),
      loanLines: loans.map((x) => ({
        kind: sub(x.row) === 'Loan Disbursal' ? ('disbursal' as const) : ('deduction' as const),
        amount: fmt(sub(x.row) === 'Loan Disbursal' ? cents(x.row[c.total] as string) : -cents(x.row[c.total] as string)),
        fileLine: x.line,
      })),
      otherLines: [...adjustments, ...ads].map((x) => ({
        source: cat(x.row) === 'Advertisement' ? 'Advertisement' : sub(x.row),
        amount: fmt(-cents(x.row[c.total] as string)),
        lineDate: printedDate(x.row[c.created] as string),
      })),
    });
  }
  return { days, waiting };
}

/** Every (transactions, transfers) fixture pair the tests stage. */
export const GRAB_PAIRS: { name: string; tx: string; tr: string }[] = [
  { name: 'Lipa October', tx: 'grab-lipa-oct-transactions.csv', tr: 'grab-lipa-oct-transfers.csv' },
  { name: 'Malvar October', tx: 'grab-malvar-oct-transactions.csv', tr: 'grab-malvar-oct-transfers.csv' },
  { name: 'Banay October', tx: 'grab-banay-oct-transactions.csv', tr: 'grab-banay-oct-transfers.csv' },
  { name: 'Banay 15-30 September', tx: 'grab-banay-sep15-30-transactions.csv', tr: 'grab-banay-sep15-30-transfers.csv' },
  { name: 'Malvar June with Advertisement rows', tx: 'grab-malvar-jun-advertisement-transactions.csv', tr: 'grab-malvar-jun-jul-transfers.csv' },
];

/* ------------------------------------------------------------------ Foodpanda oracle */

/** The five Foodpanda invoices with orders, and the slice-1 Balance sums (docs/discovery/grab-foodpanda-settlement-files.md B4). */
export const FP_FIXTURES = [
  { name: 'Banay 15 Oct', file: 'foodpanda-banay-oct19-34col.zip', balance: '14512.09', days: 8 },
  { name: 'Malvar 7 Oct', file: 'foodpanda-malvar-oct12-34col.zip', balance: '9700.16', days: 7 },
  { name: 'Lipa 15 Oct', file: 'foodpanda-lipa-oct19-34col-feerow.zip', balance: '70018.44', days: 9 },
  { name: 'Lipa 30 Sep', file: 'foodpanda-lipa-oct5-34col.zip', balance: '85747.71', days: 9 },
  { name: 'Lipa 15 Jul (32 columns)', file: 'foodpanda-lipa-jul15-32col.zip', balance: '81972.28', days: 9 },
] as const;

export async function readFpFixture(file: string): Promise<FoodpandaInvoice> {
  const z = await openSettlementZip(fixture(file));
  return readFoodpandaInvoice(z.workbook);
}

const m = (v: string | null | undefined): bigint => (v === null || v === undefined ? 0n : cents(v));

export interface ExpectedFpDay {
  salesDate: string;
  orderValue: bigint;
  grossInfo: bigint;
  commission: bigint;
  /** information only: voucher + discount + pandabox voucher (O + P + Q) */
  vendorDiscount: bigint;
  /** cost columns T,U,V,Z,AB,AC,AD minus the credits Surcharge Fee (S) and Expanded Withholding Tax (AE); NOT including the weekly Platform Fee */
  platformFeeOrders: bigint;
  balance: bigint;
  /** CPC ads dated this day */
  cpc: bigint[];
}

/** Per order-day sums from the reader's typed orders and charges. */
export function fpOracle(inv: FoodpandaInvoice): { days: Map<string, ExpectedFpDay>; weeklyFee: bigint; weeklyNote: string | null } {
  const days = new Map<string, ExpectedFpDay>();
  for (const o of inv.orders) {
    const d =
      days.get(o.orderDate) ??
      ({ salesDate: o.orderDate, orderValue: 0n, grossInfo: 0n, commission: 0n, vendorDiscount: 0n, platformFeeOrders: 0n, balance: 0n, cpc: [] } as ExpectedFpDay);
    d.orderValue += m(o.revenueAfterDiscounts);
    d.grossInfo += m(o.gross);
    d.commission += m(o.commission);
    d.vendorDiscount += m(o.vendorVoucher) + m(o.vendorDiscount) + m(o.pandaboxVoucher);
    d.platformFeeOrders +=
      m(o.withholdingTax) + m(o.waitingTimeFee) + m(o.cancellationFee) + m(o.pandaboxFee) + m(o.targetingFee) + m(o.campaignFee) + m(o.taxOnCharges) -
      m(o.surcharge) - m(o.expandedWithholdingTax);
    d.balance += m(o.balance);
    days.set(o.orderDate, d);
  }
  let weeklyFee = 0n;
  let weeklyNote: string | null = null;
  for (const c of inv.charges) {
    if (c.kind === 'cpc_ad' && c.date) days.get(c.date)?.cpc.push(m(c.netTotal));
    if (c.kind === 'platform_fee') {
      weeklyFee += m(c.netTotal);
      weeklyNote = c.feeMonthNote;
    }
  }
  return { days, weeklyFee, weeklyNote };
}

/**
 * Where the weekly Platform Fee should land: the invoice's last sales day, or, when that day's order value less its own fees (commission,
 * marketing, order-column fees) does not cover the fee, the nearest earlier day that does. Null when no day covers it.
 */
export function expectedWeeklyDay(days: Map<string, ExpectedFpDay>, fee: bigint): string | null {
  const dates = [...days.keys()].sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = days.get(dates[i] as string) as ExpectedFpDay;
    if (d.orderValue - d.commission - sum(d.cpc) - d.platformFeeOrders >= fee) return dates[i] as string;
  }
  return null;
}
