/**
 * T-511 S3 - the Foodpanda invoice workbook reader (`docs/tasks/511-settlement-upload-s3-spec.md` item 6). Pure: a workbook Buffer in
 * (the `.xls` entry of the settlement zip, really an xlsx), a typed invoice out. Nothing is written to disk.
 *
 * Headers are matched by ONE normaliser and a canonical table, whole text against whole text (never `startsWith`: `foodpanda Commission`
 * prefixes three headers). The workbook comes in two layouts, 34 columns (has Surcharge Fee and Cancellation Fee) and 32 (has neither);
 * every column is found by its words, never by position. Rows with no Order Code (the `=SUBTOTAL` table row) are skipped. Money cells are
 * JS numbers and must be exact to two decimals; percent columns are text and are ignored. The Order Code, the Official Document Number and
 * every customer field are never read into the output. The PDF is not read.
 */
import { ZERO, add, money, subtract, type Money } from '@shareat/core/money';
import { READER_VERSION } from './version';
import { intakeRefusal, shown } from './refusal';
import { normalizeXlsx } from './safe-zip';
import { readSheetsInWorker } from './xlsx-worker-host';

export const FOODPANDA_MAX_ORDER_ROWS = 5_000;
export const FOODPANDA_MAX_CHARGE_ROWS = 200;

/** Appendix A: the normalised header text (case is not compared) -> the field it carries. Both layouts share these words. */
export const FOODPANDA_COLUMNS = {
  'Official Document Number': 'officialDocument',
  'Invoice Number': 'invoiceNumber',
  'Invoice Date': 'invoiceDate',
  'Partner Name': 'partnerName',
  'Vendor Code': 'vendorCode',
  'Order Code': 'orderCode',
  Reversal: 'reversal',
  'Order Date': 'orderDate',
  'Delivery Mode': 'deliveryMode',
  'Customer Refund (Wastage)': 'customerRefund',
  'Gross Food Value / Product Value By Customer': 'gross',
  'Container Charges Paid By Customer': 'container',
  'MOV Paid By Customer': 'mov',
  'Partner Delivery Fee Paid By Customer': 'partnerDeliveryFee',
  'Voucher Paid By Vendor': 'vendorVoucher',
  'Discount Paid By Vendor': 'vendorDiscount',
  'Pandabox Voucher Paid By Vendor': 'pandaboxVoucher',
  'Sales Revenue Via foodpanda After Partner Funded Discounts': 'revenueAfterDiscounts',
  'Surcharge Fee': 'surcharge',
  '1/2% Withholding Tax': 'withholdingTax',
  'Waiting Time Fee': 'waitingTimeFee',
  'Cancellation Fee': 'cancellationFee',
  'foodpanda Commission Base': 'commissionBase',
  'foodpanda Commission Percentage': 'commissionPercentage',
  'foodpanda Commission': 'commission',
  'Pandabox Fee Paid By Vendor': 'pandaboxFee',
  'Customer Targeting Fee Percentage': 'targetingPercentage',
  'Customer Targeting Fee Paid By Vendor': 'targetingFee',
  'Delivery Fee Campaign Paid By Vendor': 'campaignFee',
  'Tax On Partner Charges': 'taxOnCharges',
  'Expanded Withholding Tax': 'expandedWithholdingTax',
  'Already Received Amount By Vendor': 'alreadyReceived',
  'Cancelled Orders (Wastage)': 'cancelledWastage',
  'Balance to be paid to Partner': 'balance',
} as const;
type OrderField = (typeof FOODPANDA_COLUMNS)[keyof typeof FOODPANDA_COLUMNS];

/** Appendix B: the same idea, 11 columns. */
export const FOODPANDA_CHARGE_COLUMNS = {
  'Official Document Number': 'officialDocument',
  'Invoice Number': 'invoiceNumber',
  'Invoice Date': 'invoiceDate',
  Category: 'category',
  Description: 'description',
  'Vendor Code': 'vendorCode',
  'Subject to VAT rate': 'vatRate',
  Quantity: 'quantity',
  'Unit Price': 'unitPrice',
  'Net Total': 'netTotal',
  EWT: 'ewt',
} as const;
type ChargeField = (typeof FOODPANDA_CHARGE_COLUMNS)[keyof typeof FOODPANDA_CHARGE_COLUMNS];

/** Present in both layouts and needed to read an order. The rest (document number, partner name, flags, rate columns) may be absent. */
const REQUIRED_ORDER_FIELDS: readonly OrderField[] = [
  'invoiceNumber', 'invoiceDate', 'vendorCode', 'orderCode', 'orderDate', 'gross', 'container', 'mov', 'partnerDeliveryFee', 'vendorVoucher',
  'vendorDiscount', 'pandaboxVoucher', 'revenueAfterDiscounts', 'withholdingTax', 'waitingTimeFee', 'commission', 'pandaboxFee', 'targetingFee',
  'campaignFee', 'taxOnCharges', 'expandedWithholdingTax', 'alreadyReceived', 'cancelledWastage', 'balance',
];
/** Every amount column of Appendix A: a row with any of these filled in and no Order Code is not a blank or total row. */
const MONEY_FIELDS: readonly OrderField[] = [
  'gross', 'container', 'mov', 'partnerDeliveryFee', 'vendorVoucher', 'vendorDiscount', 'pandaboxVoucher', 'revenueAfterDiscounts', 'surcharge',
  'withholdingTax', 'waitingTimeFee', 'cancellationFee', 'commissionBase', 'commission', 'pandaboxFee', 'targetingFee', 'campaignFee', 'taxOnCharges',
  'expandedWithholdingTax', 'alreadyReceived', 'cancelledWastage', 'balance',
];
const hasValue = (v: unknown): boolean => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
const REQUIRED_CHARGE_FIELDS: readonly ChargeField[] = ['invoiceNumber', 'invoiceDate', 'category', 'description', 'vendorCode', 'vatRate', 'netTotal', 'ewt'];

/**
 * One normaliser for every header: CRLF to LF; cut at the first newline (the long headers carry formula notes on later lines); cut at the
 * first `=` (formula text, with or without a space before it); trim; remove ONE trailing letter token `(A)` / `(AH)` (a lower-case word
 * such as `(Wastage)` survives); collapse spaces. The result is matched whole against the canonical table.
 */
export function normalizeFoodpandaHeader(raw: string): string {
  const firstLine = (raw.replace(/\r\n?/g, '\n').split('\n')[0] ?? '').split('=')[0] ?? '';
  return firstLine.trim().replace(/\s*\([A-Z]{1,2}\)$/, '').replace(/\s+/g, ' ').trim();
}

export type FoodpandaLayout = '34' | '32';
export type FoodpandaChargeKind = 'cpc_ad' | 'platform_fee' | 'pandago' | 'other';

export interface FoodpandaOrder {
  /** YYYY-MM-DD, the date printed (no time of day, no zone) */
  orderDate: string;
  reversal: boolean;
  deliveryMode: string | null;
  customerRefund: boolean;
  /** K */
  gross: Money;
  /** O */
  vendorVoucher: Money;
  /** P */
  vendorDiscount: Money;
  /** Q */
  pandaboxVoucher: Money;
  /** R, after the partner-funded discounts */
  revenueAfterDiscounts: Money;
  /** S; null in the 32 layout, which has no such column */
  surcharge: Money | null;
  /** T */
  withholdingTax: Money;
  /** U */
  waitingTimeFee: Money;
  /** V; null in the 32 layout */
  cancellationFee: Money | null;
  /** Y (W in the 32 layout) */
  commission: Money;
  /** Z */
  pandaboxFee: Money;
  /** AB */
  targetingFee: Money;
  /** AC */
  campaignFee: Money;
  /** AD */
  taxOnCharges: Money;
  /** AE */
  expandedWithholdingTax: Money;
  /** AF */
  alreadyReceived: Money;
  cancelledWastage: Money;
  /** AH, the balance to be paid to the partner */
  balance: Money;
  /** R as printed minus R recomputed from K+L+M+N-O-P-Q; 0.00 when the row is consistent. Returned, never refused on. */
  revenueIdentityDifference: Money;
  /** the balance as printed minus the balance recomputed for the layout; 0.00 when the row is consistent. Returned, never refused on. */
  balanceIdentityDifference: Money;
}

export interface FoodpandaCharge {
  category: string;
  kind: FoodpandaChargeKind;
  /** CPC: the ISO date inside the description. PandaGO: the month-first M.DD.YYYY date. Otherwise null. */
  date: string | null;
  /** Platform Fee only: the description's text about which month the fee is for */
  feeMonthNote: string | null;
  /** the percentage in `Subject to VAT rate`, e.g. 12 */
  vatRate: number;
  netTotal: Money;
  ewt: Money;
}

export interface FoodpandaInvoice {
  invoiceNumber: string;
  /** YYYY-MM-DD, the end of the invoice period */
  invoiceDate: string;
  vendorCode: string;
  partnerName: string | null;
  /** null for an Appendix-B-only invoice (PandaGO items), which has no order sheet */
  layout: FoodpandaLayout | null;
  orders: FoodpandaOrder[];
  charges: FoodpandaCharge[];
  readerVersion: string;
}

/* ------------------------------------------------------------------ small readers */

const lookup = <F extends string>(table: Readonly<Record<string, F>>): ReadonlyMap<string, F> =>
  new Map(Object.entries(table).map(([text, field]) => [text.toLowerCase(), field]));
const ORDER_LOOKUP = lookup<OrderField>(FOODPANDA_COLUMNS);
const CHARGE_LOOKUP = lookup<ChargeField>(FOODPANDA_CHARGE_COLUMNS);

const labelOf = <F extends string>(table: Readonly<Record<string, F>>, field: F): string => Object.keys(table).find((k) => table[k] === field) ?? field;

/** header cell -> field, refusing an unknown or repeated header by name. Blank header cells are ignored. */
function mapHeaders<F extends string>(header: unknown[], known: ReadonlyMap<string, F>, sheet: string): Map<F, number> {
  const at = new Map<F, number>();
  header.forEach((cell, position) => {
    const raw = typeof cell === 'string' ? cell : cell === null || cell === undefined ? '' : String(cell);
    const text = normalizeFoodpandaHeader(raw);
    if (text === '') return;
    const field = known.get(text.toLowerCase());
    if (!field) throw intakeRefusal('FOODPANDA_UNKNOWN_COLUMN', `${sheet}: the column "${shown(text)}" is not one this system knows.`);
    if (at.has(field)) throw intakeRefusal('FOODPANDA_UNKNOWN_COLUMN', `${sheet}: the column "${shown(text)}" appears more than once.`);
    at.set(field, position);
  });
  return at;
}

function requireFields<F extends string>(at: ReadonlyMap<F, number>, required: readonly F[], table: Readonly<Record<string, F>>, sheet: string): void {
  for (const field of required) {
    if (!at.has(field)) throw intakeRefusal('FOODPANDA_MISSING_COLUMN', `${sheet}: the column "${labelOf(table, field)}" is missing.`);
  }
}

const cellAt = <F extends string>(row: unknown[], at: ReadonlyMap<F, number>, field: F): unknown => {
  const position = at.get(field);
  return position === undefined ? null : (row[position] ?? null);
};

const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

const two = (n: number): string => String(n).padStart(2, '0');
function isoIfReal(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${year}-${two(month)}-${two(day)}` : null;
}

function badValue(where: string, column: string, what: string): never {
  throw intakeRefusal('FOODPANDA_BAD_VALUE', `${where}, column "${column}": ${what}`);
}

function dateCell(v: unknown, where: string, column: string): string {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return badValue(where, column, `${shown(String(v ?? ''))} is not a date.`);
  // The cell is a Date at 00:00Z whose UTC fields ARE the printed calendar day (slice 1 notes), so read those fields.
  return `${v.getUTCFullYear()}-${two(v.getUTCMonth() + 1)}-${two(v.getUTCDate())}`;
}

function moneyCell(v: unknown, where: string, column: string): Money {
  if (typeof v !== 'number') return badValue(where, column, v === null || v === undefined ? 'an amount is required and the cell is empty.' : `"${shown(String(v))}" is not a number.`);
  try {
    return money(v);
  } catch {
    return badValue(where, column, `${shown(String(v))} is not an amount with at most two decimal places.`);
  }
}

const plus = (plusses: Money[], minuses: Money[]): Money => subtract(add(ZERO, ...plusses), add(ZERO, ...minuses));

/* ------------------------------------------------------------------ Appendix A */

interface OrderSheet {
  layout: FoodpandaLayout;
  orders: FoodpandaOrder[];
  invoiceNumber: string;
  invoiceDate: string;
  vendorCode: string;
  partnerName: string | null;
}

function readOrders(data: unknown[][]): OrderSheet | null {
  const header = data[0];
  if (!header) throw intakeRefusal('FOODPANDA_MISSING_COLUMN', 'Appendix A: the sheet has no header row.');
  const at = mapHeaders(header, ORDER_LOOKUP, 'Appendix A');
  const hasSurcharge = at.has('surcharge');
  const hasCancellation = at.has('cancellationFee');
  if (hasSurcharge !== hasCancellation) {
    throw intakeRefusal(
      'FOODPANDA_UNKNOWN_LAYOUT',
      `Appendix A: the sheet has ${hasSurcharge ? 'Surcharge Fee but no Cancellation Fee' : 'Cancellation Fee but no Surcharge Fee'}. Known layouts have both or neither.`,
    );
  }
  const layout: FoodpandaLayout = hasSurcharge ? '34' : '32';
  requireFields(at, REQUIRED_ORDER_FIELDS, FOODPANDA_COLUMNS, 'Appendix A');

  const orders: FoodpandaOrder[] = [];
  let invoiceNumber = '';
  let invoiceDate = '';
  let vendorCode = '';
  let partnerName: string | null = null;
  for (let r = 1; r < data.length; r++) {
    const row = data[r] ?? [];
    if (textOf(cellAt(row, at, 'orderCode')) === '') {
      // Only the uncached `=SUBTOTAL` table row (every amount blank) may be skipped; a row with amounts and no Order Code is a defect.
      if (MONEY_FIELDS.some((f) => hasValue(cellAt(row, at, f)))) {
        throw intakeRefusal('FOODPANDA_BAD_VALUE', `Appendix A row ${r + 1} has amounts but no Order Code, so it is not the total row and cannot be skipped.`);
      }
      continue;
    }
    if (orders.length >= FOODPANDA_MAX_ORDER_ROWS) {
      throw intakeRefusal('FOODPANDA_TOO_MANY_ROWS', `Appendix A has more than ${FOODPANDA_MAX_ORDER_ROWS.toLocaleString('en-US')} order rows, so the file was refused.`);
    }
    const where = `Appendix A row ${r + 1}`;
    const number = textOf(cellAt(row, at, 'invoiceNumber'));
    const vendor = textOf(cellAt(row, at, 'vendorCode')).toUpperCase();
    if (orders.length === 0) {
      invoiceNumber = number;
      vendorCode = vendor;
      invoiceDate = dateCell(cellAt(row, at, 'invoiceDate'), where, 'Invoice Date');
      partnerName = textOf(cellAt(row, at, 'partnerName')) || null;
    } else if (number !== invoiceNumber || vendor !== vendorCode) {
      throw intakeRefusal('FOODPANDA_MIXED_INVOICE', `${where} belongs to a different invoice or vendor than the rows above it. Upload one invoice at a time.`);
    }
    const m = (field: OrderField): Money => moneyCell(cellAt(row, at, field), where, labelOf(FOODPANDA_COLUMNS, field));
    const optional = (field: OrderField): Money | null => (at.has(field) ? m(field) : null);

    const reversalText = textOf(cellAt(row, at, 'reversal')).toUpperCase();
    if (reversalText !== '' && reversalText !== 'X') badValue(where, 'Reversal', `"${shown(reversalText)}" is not X or blank.`);
    const refundText = textOf(cellAt(row, at, 'customerRefund')).toUpperCase();
    if (refundText !== '' && refundText !== 'N' && refundText !== 'Y') badValue(where, 'Customer Refund (Wastage)', `"${shown(refundText)}" is not Y or N.`);

    const gross = m('gross');
    const container = m('container');
    const mov = m('mov');
    const partnerDeliveryFee = m('partnerDeliveryFee');
    const vendorVoucher = m('vendorVoucher');
    const vendorDiscount = m('vendorDiscount');
    const pandaboxVoucher = m('pandaboxVoucher');
    const revenueAfterDiscounts = m('revenueAfterDiscounts');
    const surcharge = optional('surcharge');
    const withholdingTax = m('withholdingTax');
    const waitingTimeFee = m('waitingTimeFee');
    const cancellationFee = optional('cancellationFee');
    const commission = m('commission');
    const pandaboxFee = m('pandaboxFee');
    const targetingFee = m('targetingFee');
    const campaignFee = m('campaignFee');
    const taxOnCharges = m('taxOnCharges');
    const expandedWithholdingTax = m('expandedWithholdingTax');
    const alreadyReceived = m('alreadyReceived');
    const cancelledWastage = m('cancelledWastage');
    const balance = m('balance');

    // Figures near the numeric(14,2) ceiling overflow the sums below; that is a named refusal, not a raw RangeError.
    let revenueIdentityDifference: Money;
    let balanceIdentityDifference: Money;
    try {
      revenueIdentityDifference = subtract(revenueAfterDiscounts, plus([gross, container, mov, partnerDeliveryFee], [vendorVoucher, vendorDiscount, pandaboxVoucher]));
      balanceIdentityDifference = subtract(
        balance,
        plus(
          [revenueAfterDiscounts, surcharge ?? ZERO, expandedWithholdingTax],
          [withholdingTax, waitingTimeFee, cancellationFee ?? ZERO, commission, pandaboxFee, targetingFee, campaignFee, taxOnCharges, alreadyReceived],
        ),
      );
    } catch {
      throw intakeRefusal('FOODPANDA_BAD_VALUE', `${where}: the amounts are too large to add up.`);
    }

    orders.push({
      orderDate: dateCell(cellAt(row, at, 'orderDate'), where, 'Order Date'),
      reversal: reversalText === 'X',
      deliveryMode: textOf(cellAt(row, at, 'deliveryMode')) || null,
      customerRefund: refundText === 'Y',
      gross,
      vendorVoucher,
      vendorDiscount,
      pandaboxVoucher,
      revenueAfterDiscounts,
      surcharge,
      withholdingTax,
      waitingTimeFee,
      cancellationFee,
      commission,
      pandaboxFee,
      targetingFee,
      campaignFee,
      taxOnCharges,
      expandedWithholdingTax,
      alreadyReceived,
      cancelledWastage,
      balance,
      revenueIdentityDifference,
      balanceIdentityDifference,
    });
  }
  return orders.length === 0 ? null : { layout, orders, invoiceNumber, invoiceDate, vendorCode, partnerName };
}

/* ------------------------------------------------------------------ Appendix B */

interface ChargeSheet {
  charges: FoodpandaCharge[];
  invoiceNumber: string;
  invoiceDate: string;
  vendorCode: string;
}

function kindOf(category: string, description: string): FoodpandaChargeKind {
  if (/^pandago\b/i.test(description)) return 'pandago';
  if (category === 'Organic Placement (CPC)') return 'cpc_ad';
  if (category === 'Platform Fee') return 'platform_fee';
  return 'other';
}

function chargeDate(kind: FoodpandaChargeKind, description: string): string | null {
  if (kind === 'cpc_ad') {
    const m = /(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/.exec(description);
    return m ? isoIfReal(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (kind === 'pandago') {
    const m = /(?<![0-9])([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})(?![0-9])/.exec(description);
    return m ? isoIfReal(Number(m[3]), Number(m[1]), Number(m[2])) : null;
  }
  return null;
}

function readCharges(data: unknown[][]): ChargeSheet | null {
  const header = data[0];
  if (!header) throw intakeRefusal('FOODPANDA_MISSING_COLUMN', 'Appendix B: the sheet has no header row.');
  const at = mapHeaders(header, CHARGE_LOOKUP, 'Appendix B');
  requireFields(at, REQUIRED_CHARGE_FIELDS, FOODPANDA_CHARGE_COLUMNS, 'Appendix B');
  const charges: FoodpandaCharge[] = [];
  let invoiceNumber = '';
  let invoiceDate = '';
  let vendorCode = '';
  for (let r = 1; r < data.length; r++) {
    const row = data[r] ?? [];
    const category = textOf(cellAt(row, at, 'category'));
    if (category === '') continue;
    if (charges.length >= FOODPANDA_MAX_CHARGE_ROWS) {
      throw intakeRefusal('FOODPANDA_TOO_MANY_ROWS', `Appendix B has more than ${FOODPANDA_MAX_CHARGE_ROWS} charge rows, so the file was refused.`);
    }
    const where = `Appendix B row ${r + 1}`;
    const number = textOf(cellAt(row, at, 'invoiceNumber'));
    const vendor = textOf(cellAt(row, at, 'vendorCode')).toUpperCase();
    if (charges.length === 0) {
      invoiceNumber = number;
      vendorCode = vendor;
      invoiceDate = dateCell(cellAt(row, at, 'invoiceDate'), where, 'Invoice Date');
    } else if (number !== invoiceNumber || vendor !== vendorCode) {
      throw intakeRefusal('FOODPANDA_MIXED_INVOICE', `${where} belongs to a different invoice or vendor than the rows above it. Upload one invoice at a time.`);
    }
    const description = textOf(cellAt(row, at, 'description'));
    const kind = kindOf(category, description);
    const vat = /^\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*$/.exec(textOf(cellAt(row, at, 'vatRate')));
    if (!vat) badValue(where, 'Subject to VAT rate', `"${shown(textOf(cellAt(row, at, 'vatRate')))}" is not a percentage such as 12%.`);
    charges.push({
      category,
      kind,
      date: chargeDate(kind, description),
      feeMonthNote: kind === 'platform_fee' ? description.replace(/\s*:\s*[A-Za-z0-9]{1,12}$/, '') || null : null,
      vatRate: Number((vat as RegExpExecArray)[1]),
      netTotal: moneyCell(cellAt(row, at, 'netTotal'), where, 'Net Total'),
      ewt: moneyCell(cellAt(row, at, 'ewt'), where, 'EWT'),
    });
  }
  return charges.length === 0 ? null : { charges, invoiceNumber, invoiceDate, vendorCode };
}

/* ------------------------------------------------------------------ the invoice */

/**
 * Reads `Appendix A` (orders) and `Appendix B` (charges). Appendix B alone is valid: the PandaGO-only invoice has no orders.
 *
 * Runs `normalizeXlsx` itself first (zip caps, no DOCTYPE or ENTITY, rels links inside the zip, then a re-pack with true sizes), so a caller
 * cannot forget it; calling it beforehand is harmless. The library then reads the two sheets inside a worker thread with a memory limit and a timer
 * (`readSheetsInWorker`): a hostile worksheet ends as XLSX_TOO_HEAVY or XLSX_TOO_SLOW instead of freezing or killing the server. The row
 * caps (5,000 orders, 200 charges) apply after the read.
 */
export async function readFoodpandaInvoice(workbook: Buffer): Promise<FoodpandaInvoice> {
  if (workbook.length === 0) throw intakeRefusal('FILE_EMPTY', 'The file is empty, so there is nothing to read.');
  // The worker gets only the re-packed zip, never the original bytes (the library trusts local-header sizes; see `normalizeXlsx`).
  const sheets = await readSheetsInWorker(await normalizeXlsx(workbook));
  if (!sheets.a && !sheets.b) throw intakeRefusal('FOODPANDA_NO_SHEETS', 'The workbook has neither an "Appendix A" nor an "Appendix B" sheet.');
  const a = sheets.a ? readOrders(sheets.a) : null;
  const b = sheets.b ? readCharges(sheets.b) : null;
  const first = a ?? b;
  if (!first) throw intakeRefusal('FOODPANDA_NO_SHEETS', 'The workbook has no order rows and no charge rows.');
  if (a && b && (a.invoiceNumber !== b.invoiceNumber || a.vendorCode !== b.vendorCode)) {
    throw intakeRefusal('FOODPANDA_MIXED_INVOICE', 'Appendix A and Appendix B belong to different invoices or vendors. Upload one invoice at a time.');
  }
  return {
    invoiceNumber: first.invoiceNumber,
    invoiceDate: first.invoiceDate,
    vendorCode: first.vendorCode,
    partnerName: a?.partnerName ?? null,
    layout: a?.layout ?? null,
    orders: a?.orders ?? [],
    charges: b?.charges ?? [],
    readerVersion: READER_VERSION,
  };
}
