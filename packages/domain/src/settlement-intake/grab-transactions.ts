/**
 * T-511 S3 - the Grab Transactions file reader (`docs/tasks/511-settlement-upload-s3-spec.md` item 3). Pure: Buffer in, typed rows out.
 *
 * Headers are matched by trimmed name (exactly the 68 known ones, any order), never by position. Strict UTF-8, one Store ID per file.
 * `Created On` is the Manila wall clock as printed; its date is the business day. `Category` has a trailing space in real files, so it is
 * trimmed. An unknown category, subcategory or status refuses the file naming it (fail safe). Nothing identifying is read into the output:
 * no Transaction ID, Linked Transaction ID, order id, Booking ID, partner id, funding source, appeal link or customer refund field.
 */
import { parseCsv, type CsvRecord } from '@shareat/core/csv';
import type { Money } from '@shareat/core/money';
import { READER_VERSION } from './version';
import { cellOf, checkStore, csvFailure, decodeGrabText, grabDateTime, grabMoney, grabTable, type GrabDateTime } from './grab-csv';
import { intakeRefusal, shown } from './refusal';

export { parseGrabDateTime } from './grab-csv';
export type { GrabDateTime } from './grab-csv';

/** The 68 headers of a Grab Transactions export, trimmed. */
export const GRAB_TRANSACTION_HEADERS = [
  'Merchant Name', 'Merchant ID', 'Store Name', 'Store ID', 'Updated On', 'Created On', 'Type', 'Category', 'Subcategory', 'Status',
  'Transaction ID', 'Linked Transaction ID', 'Partner transaction ID 1', 'Partner transaction ID 2', 'Long Order ID', 'Short Order ID',
  'Booking ID', 'Order Channel', 'Order Type', 'Payment Method', 'Receiving account / Source of fund', 'Terminal ID', 'Channel', 'Offer Type',
  'Grab Fee (%)', 'Points Multiplier', 'Points Issued', 'Settlement ID', 'Transfer Date', 'Amount', 'Tax on Order Value',
  'Restaurant Packaging Charge', 'Non-Member Fee', 'Restaurant Service Charge', 'Offer', 'Discount (Merchant-Funded)',
  'Delivery Fee Discount (Merchant-Funded)', 'Delivery Charge (Grab Online Store)', 'Delivery Charge (Merchant Delivery)',
  'GrabExpress Delivery Service Fee', 'Net Sales', 'Net MDR', 'Tax on MDR', 'Grab Fee', 'Marketing success fee', 'Delivery Commission',
  'Channel Commission', 'Order commission', 'Step-up commission', 'GrabKitchen Commission', 'GrabKitchen Other Commission', 'Withholding Tax',
  'Total', 'Tax on MDR (%)', 'Delivery Commission (%)', 'Channel Commission (%)', 'Order Commission (%)',
  'Tax on GrabFood/GrabMart commission, adjustments, ads', 'Tax on Total GrabKitchen Commission', 'Cancellation Reason', 'Cancelled by',
  'Reason for Refund', 'Description', 'Incident group', 'Incident alias', 'Customer refund Item', 'Appeal link', 'Appeal status',
] as const;

export const GRAB_KINDS = ['payment', 'loan', 'adjustment', 'advertisement', 'cancelled'] as const;
export type GrabKind = (typeof GRAB_KINDS)[number];

export const GRAB_STATUSES = ['Transferred', 'Completed', 'Cancelled'] as const;
export type GrabStatus = (typeof GRAB_STATUSES)[number];

// A Map, not an object: file text such as `constructor` or `__proto__` must never find an inherited member.
const KIND_OF_CATEGORY: ReadonlyMap<string, GrabKind> = new Map<string, GrabKind>([
  ['Payment', 'payment'],
  ['Loans', 'loan'],
  ['Adjustment', 'adjustment'],
  ['Advertisement', 'advertisement'],
  ['Cancelled', 'cancelled'],
]);

/** The subcategories seen on real files. A category with an empty list carries no subcategory. */
export const GRAB_SUBCATEGORIES: Readonly<Record<GrabKind, readonly string[]>> = {
  payment: [],
  advertisement: [],
  cancelled: [],
  loan: ['Loan Deduction', 'Loan Disbursal'],
  adjustment: ['Deduction - Eater Compensation', 'Withholding Tax Remittance (non-taxable)', 'Compensation - Orders'],
};

const DESCRIPTION_MAX = 200;

export interface GrabTransactionRow {
  /** the line of the file the row starts on (the header is line 1) */
  line: number;
  createdOn: GrabDateTime;
  kind: GrabKind;
  subcategory: string | null;
  status: GrabStatus;
  settlementId: string | null;
  amount: Money | null;
  discount: Money | null;
  netSales: Money | null;
  channelCommission: Money | null;
  total: Money | null;
  /** adjustment rows only: the generic text, trimmed, at most 200 characters */
  description?: string;
}

export interface GrabTransactionsFile {
  storeId: string;
  storeName: string;
  periodFrom: string;
  periodTo: string;
  rowCount: number;
  readerVersion: string;
  rows: GrabTransactionRow[];
}

function kindOf(category: string, status: string, line: number): GrabKind {
  const mapped = KIND_OF_CATEGORY.get(category);
  if (mapped) return mapped;
  // Cancelled orders carry no category at all.
  if (category === '' && status === 'Cancelled') return 'cancelled';
  throw intakeRefusal(
    'GRAB_UNKNOWN_VALUE',
    category === '' ? `Line ${line}: the Category is blank and the order is not cancelled.` : `Line ${line}: the Category "${shown(category)}" is not one this system knows.`,
  );
}

function statusOf(raw: string, line: number): GrabStatus {
  const status = GRAB_STATUSES.find((s) => s === raw);
  if (!status) throw intakeRefusal('GRAB_UNKNOWN_VALUE', `Line ${line}: the Status "${shown(raw)}" is not one this system knows.`);
  return status;
}

function subcategoryOf(kind: GrabKind, raw: string, line: number): string | null {
  if (raw === '') return null;
  if (!GRAB_SUBCATEGORIES[kind].includes(raw)) {
    throw intakeRefusal('GRAB_UNKNOWN_VALUE', `Line ${line}: the Subcategory "${shown(raw)}" is not one this system knows.`);
  }
  return raw;
}

export function readGrabTransactions(bytes: Buffer): GrabTransactionsFile {
  const text = decodeGrabText(bytes);
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (e) {
    throw csvFailure(e);
  }
  const table = grabTable(records, GRAB_TRANSACTION_HEADERS);
  const rows: GrabTransactionRow[] = [];
  let storeId: string | null = null;
  let storeName = '';
  for (const record of table.rows) {
    const line = record.line;
    const cell = (name: string): string => cellOf(table, record, name);
    storeId = checkStore(storeId, cell('Store ID'), line);
    if (rows.length === 0) storeName = cell('Store Name').trim();
    const status = statusOf(cell('Status').trim(), line);
    const kind = kindOf(cell('Category').trim(), status, line);
    const subcategory = subcategoryOf(kind, cell('Subcategory').trim(), line);
    const createdOn = grabDateTime(cell('Created On'), 'Created On', line);
    const row: GrabTransactionRow = {
      line,
      createdOn,
      kind,
      subcategory,
      status,
      settlementId: cell('Settlement ID').trim() || null,
      amount: grabMoney(cell('Amount'), 'Amount', line),
      discount: grabMoney(cell('Discount (Merchant-Funded)'), 'Discount (Merchant-Funded)', line),
      netSales: grabMoney(cell('Net Sales'), 'Net Sales', line),
      channelCommission: grabMoney(cell('Channel Commission'), 'Channel Commission', line),
      total: grabMoney(cell('Total'), 'Total', line),
    };
    if (kind === 'adjustment') row.description = cell('Description').trim().slice(0, DESCRIPTION_MAX).trim();
    rows.push(row);
  }
  // ISO dates sort as text: the first and last are the period.
  const days = rows.map((r) => r.createdOn.date).sort();
  const periodFrom = days[0] as string;
  const periodTo = days[days.length - 1] as string;
  return { storeId: storeId as string, storeName, periodFrom, periodTo, rowCount: rows.length, readerVersion: READER_VERSION, rows };
}
