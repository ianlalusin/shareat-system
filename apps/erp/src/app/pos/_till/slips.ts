/**
 * T-531 R6 - turns the day close's figures (as the API sends them: JSON, so dates are ISO text) into the views `formatXSlip` / `formatZSlip` print.
 * Nothing is computed here: figures go through as given; only the Manila-time text of a window or a business date is made.
 */
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { money, type Money } from '@shareat/core/money';
import { receiptHeaderOf, type ReadingSlipView, type ZSlipView } from '@/lib/pos-print';

/** A reading as it travels over JSON (`Reading` of the domain with its Dates as ISO text). Optional fields are absent from older callers. */
export interface ReadingJson {
  receiptCount: number;
  grossTotal: string;
  subtotal: string;
  discountTotal: string;
  /** T-627: Σ of the store charges (inside `grossTotal`); absent from older callers. */
  chargeTotal?: string;
  discounts: { senior: string; pwd: string; other: string };
  byTender: { name: string; amount: string }[];
  toCheckCount: number;
  lateCount: number;
  spansTwoDates: boolean;
  /** T-558: the short payments of the window and how many receipts are findings. */
  varianceTotal?: string;
  shortfallCount?: number;
  unliSales?: string;
  alaCarteSales?: string;
  heads?: number;
  packageSessions?: number;
  seniorPwdDiners?: number;
  /** T-534 S2: absent from older callers. */
  convert?: { cashIn: string; cashOut: string; net: string; count: number };
  /** T-534 S4: refunds of the window (the tender rows are already net of them); absent from older callers. */
  refunds?: { total: string; cash: string; count: number };
  windowStart?: string;
  windowEnd?: string;
}

export interface SlipContext {
  storeName: string;
  vatRegistered: boolean;
  printedBy: string;
  /** T-585: the issuer identity (legal name, address, TIN); absent from older callers, which print the store name only. */
  identity?: unknown;
  /** T-601 S4: the POS mode of the store; `test` puts TEST - NOT A SALE on the slip. */
  mode?: string;
}

const amountOf = (s: string | undefined): Money => money(s ?? '0.00');
const stamp = (iso: string | undefined): string =>
  iso ? formatBusinessDateTime(new Date(iso), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : '';

/** The Manila date of a business date text (`2026-11-02` -> `02/11/26`); a business date is already a calendar day, so no time zone enters. */
export const businessDateLocal = (businessDate: string): string => {
  const [y = '', m = '', d = ''] = businessDate.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

export function readingSlipView(reading: ReadingJson, ctx: SlipContext): ReadingSlipView {
  return {
    header: receiptHeaderOf({ name: ctx.storeName, vatRegistered: ctx.vatRegistered, identity: ctx.identity, mode: ctx.mode }),
    printedBy: ctx.printedBy,
    windowFromLocal: stamp(reading.windowStart),
    windowToLocal: stamp(reading.windowEnd),
    spansTwoDates: reading.spansTwoDates,
    receiptCount: reading.receiptCount,
    subtotal: amountOf(reading.subtotal),
    discounts: { senior: amountOf(reading.discounts.senior), pwd: amountOf(reading.discounts.pwd), other: amountOf(reading.discounts.other) },
    discountTotal: amountOf(reading.discountTotal),
    ...(reading.chargeTotal ? { chargeTotal: amountOf(reading.chargeTotal) } : {}),
    grossTotal: amountOf(reading.grossTotal),
    unliSales: amountOf(reading.unliSales),
    alaCarteSales: amountOf(reading.alaCarteSales),
    heads: reading.heads ?? 0,
    packageSessions: reading.packageSessions ?? 0,
    seniorPwdDiners: reading.seniorPwdDiners ?? 0,
    tenders: reading.byTender.map((t) => ({ name: t.name, amount: amountOf(t.amount) })),
    ...(reading.convert ? { convert: { cashIn: amountOf(reading.convert.cashIn), cashOut: amountOf(reading.convert.cashOut), count: reading.convert.count } } : {}),
    ...(reading.refunds ? { refunds: { total: amountOf(reading.refunds.total), count: reading.refunds.count } } : {}),
    varianceTotal: amountOf(reading.varianceTotal),
    shortfallCount: reading.shortfallCount ?? 0,
    toCheckCount: reading.toCheckCount,
    lateCount: reading.lateCount,
  };
}

export function zSlipView(reading: ReadingJson, ctx: SlipContext, z: { zNo: number; businessDate: string; approvedBy: string; reprint: boolean }): ZSlipView {
  return { ...readingSlipView(reading, ctx), zNo: z.zNo, businessDateLocal: businessDateLocal(z.businessDate), approvedBy: z.approvedBy, reprint: z.reprint };
}
