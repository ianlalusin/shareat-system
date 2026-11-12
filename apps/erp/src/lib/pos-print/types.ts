import type { Money } from '@shareat/core/money';

/**
 * T-528a — the shapes the POS v2 paper documents are formatted from.
 *
 * Every figure in here is ALREADY COMPUTED by the caller. Nothing in `pos-print` adds, subtracts,
 * multiplies or rounds money: the formatter's only job is to lay an existing number out on paper.
 * That boundary is the whole reason this folder is safe to test without a database.
 */

/** Thermal paper: 58 mm or 80 mm rolls. */
export type PaperWidth = 58 | 80;

/** Printer font: the dense Font B (`small`) fits more columns than Font A (`normal`). */
export type FontMode = 'small' | 'normal';

/** Which paper and which font — together they decide the column count. */
export interface PrintLayout {
  width: PaperWidth;
  font: FontMode;
}

/** The store's details. They arrive from settings; none of them is hard-coded here. */
export interface ReceiptHeader {
  businessName: string;
  addressLines: string[];
  tin: string | null;
  vatRegistered: boolean;
}

/** One discount applied to a line. `amount` is a POSITIVE figure and is printed with a minus sign. */
export interface ReceiptLineDiscount {
  label: string;
  qty: number;
  amount: Money;
}

/** One itemized line: qty × unit price = gross, its discounts, and the line net (bible row 439). */
export interface ReceiptLine {
  name: string;
  qty: number;
  unitPrice: Money;
  gross: Money;
  discounts: ReceiptLineDiscount[];
  net: Money;
}

/** One tender on the bill (bible row 438 allows several). `reference` is the GCash/card ref, if any. */
export interface ReceiptTender {
  name: string;
  amount: Money;
  reference: string | null;
  toCheck: boolean;
}

/** A senior/PWD diner whose discount is on this bill (bible row 437). */
export interface ReceiptDiner {
  dinerNo: number;
  kind: 'senior' | 'pwd';
  holderName: string;
  idNumber: string;
}

/** Everything one sales receipt prints, already resolved to strings and figures. */
export interface ReceiptView {
  header: ReceiptHeader;
  /** Already formatted by the caller, e.g. `"T1-000123"`. */
  receiptNo: string;
  /** Already formatted by the caller, e.g. `"07/11/26 19:42"` — no date formatting happens here. */
  issuedAtLocal: string;
  /** The stand label, or null for take-out. */
  tableLabel: string | null;
  heads: number | null;
  cashierName: string;
  lines: ReceiptLine[];
  subtotal: Money;
  discountTotal: Money;
  total: Money;
  tenders: ReceiptTender[];
  /** `"0.00"` when there is none. */
  change: Money;
  /** Senior/PWD diners, may be empty. */
  diners: ReceiptDiner[];
  /** From the store's settings; may be empty. */
  footerLines: string[];
  /** True → the receipt carries the line `OFFLINE SALE - TO SYNC`. */
  offline: boolean;
  /** True → the receipt carries the line `REPRINT`. */
  reprint: boolean;
  /** The VAT split under TOTAL, computed by the caller (`priceSession`). `null` prints no VAT block. */
  vat: null | {
    /** False → the exempt line is labelled `SC/PWD SALES` (v1 rule). */
    vatRegistered: boolean;
    vatableSales: Money;
    vatExemptSales: Money;
    vatAmount: Money;
    /** Already formatted by the caller from the database rate, e.g. `"12%"`. */
    vatRateLabel: string;
    /** `"0.00"` when there is no senior/PWD. */
    vatRemovedForScPwd: Money;
    /** The statutory percent only (vatRemovedForScPwd excluded), summed over the senior/PWD discounts, computed by the caller. `"0.00"` when there is none. VATable + VAT + VAT-exempt - this = TOTAL. */
    scPwdDiscount: Money;
  };
}

/** A kitchen ticket: one station's prep list for a sent round. */
export interface KitchenTicketView {
  stationName: string;
  tableLabel: string | null;
  ticketNo: string;
  sentAtLocal: string;
  items: { name: string; qty: number; note: string | null }[];
  offline: boolean;
}

/** A refill slip: the drinks a table asked for again. */
export interface RefillSlipView {
  tableLabel: string;
  sentAtLocal: string;
  items: { name: string; qty: number }[];
  offline: boolean;
}

/**
 * T-531: what an X-reading or a Z-reading prints (cash control, not a BIR document). Every figure is ALREADY COMPUTED (`readingFor`); times and the business date
 * arrive already formatted by the caller, in Manila time.
 */
export interface ReadingSlipView {
  header: ReceiptHeader;
  printedBy: string;
  windowFromLocal: string;
  windowToLocal: string;
  /** True: the window touches two business dates (a forgotten Z); the paper says so. */
  spansTwoDates: boolean;
  receiptCount: number;
  subtotal: Money;
  discounts: { senior: Money; pwd: Money; other: Money };
  discountTotal: Money;
  grossTotal: Money;
  unliSales: Money;
  alaCarteSales: Money;
  heads: number;
  packageSessions: number;
  seniorPwdDiners: number;
  /** One row per tender, the NET collected. */
  tenders: { name: string; amount: Money }[];
  /** T-558: Σ of the receipts' short payments (money not collected); printed only above zero. Optional: a view without it prints as before. */
  varianceTotal?: Money;
  /** T-558: receipts short by more than the tolerance (findings); printed only above zero. */
  shortfallCount?: number;
  /** Offline wallet payments still to check; printed only above zero. */
  toCheckCount: number;
  /** Receipts recorded after their window opened; printed only above zero. */
  lateCount: number;
}

/** A Z-reading: the X's figures plus the Z's own number, its business date and who approved it. */
export interface ZSlipView extends ReadingSlipView {
  zNo: number;
  /** Already formatted, e.g. `"02/11/26"`. */
  businessDateLocal: string;
  approvedBy: string;
  /** True: the paper carries the line `REPRINT`. */
  reprint: boolean;
}
