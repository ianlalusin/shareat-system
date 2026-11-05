/**
 * T-511 S3 - the Grab Transfers (payout) file reader (`docs/tasks/511-settlement-upload-s3-spec.md` item 4). Pure: Buffer in, typed rows out.
 *
 * The 10 headers are an exact set, but the three bank headers (Bank Statement Code, Bank Name, Bank Account) are never indexed or read:
 * they are not mapped into the output at all. One Store ID per file.
 */
import { parseCsv, type CsvRecord } from '@shareat/core/csv';
import type { Money } from '@shareat/core/money';
import { READER_VERSION } from './version';
import { cellOf, checkStore, csvFailure, decodeGrabText, grabDateTime, grabMoneyRequired, grabTable, type GrabDateTime } from './grab-csv';
import { intakeRefusal, shown } from './refusal';

/** The 10 headers of a Grab Transfers export, trimmed. */
export const GRAB_TRANSFER_HEADERS = [
  'Date', 'Store Name', 'Store ID', 'Settlement ID', 'Net Total', 'Status', 'Transfer Date', 'Bank Statement Code', 'Bank Name', 'Bank Account',
] as const;

export type GrabPayoutStatus = 'completed' | 'processing';

export interface GrabTransferRow {
  line: number;
  settlementId: string;
  /** the payout's own date and time; the store-day it pays is the day BEFORE this date */
  payoutDate: GrabDateTime;
  netTotal: Money;
  status: GrabPayoutStatus;
  /** when the bank transfer happened; null while the payout is still processing */
  transferDate: GrabDateTime | null;
}

export interface GrabTransfersFile {
  storeId: string;
  storeName: string;
  rowCount: number;
  readerVersion: string;
  rows: GrabTransferRow[];
}

function statusOf(raw: string, line: number): GrabPayoutStatus {
  if (raw === 'Completed') return 'completed';
  if (raw === 'Processing') return 'processing';
  throw intakeRefusal('GRAB_UNKNOWN_VALUE', `Line ${line}: the Status "${shown(raw)}" is not one this system knows.`);
}

export function readGrabTransfers(bytes: Buffer): GrabTransfersFile {
  const text = decodeGrabText(bytes);
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (e) {
    throw csvFailure(e);
  }
  const table = grabTable(records, GRAB_TRANSFER_HEADERS);
  const rows: GrabTransferRow[] = [];
  let storeId: string | null = null;
  let storeName = '';
  const seen = new Map<string, number>();
  for (const record of table.rows) {
    const line = record.line;
    const cell = (name: string): string => cellOf(table, record, name);
    storeId = checkStore(storeId, cell('Store ID'), line);
    if (rows.length === 0) storeName = cell('Store Name').trim();
    const settlementId = cell('Settlement ID').trim();
    if (settlementId === '') throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "Settlement ID": the cell is empty.`);
    // compared in upper case: `abc` and `ABC` are the same payout
    const key = settlementId.toUpperCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw intakeRefusal('GRAB_BAD_ROW', `Line ${line} repeats the Settlement ID of line ${earlier}. A payout may appear only once, or its rows would be counted twice.`);
    }
    seen.set(key, line);
    const transfer = cell('Transfer Date').trim();
    rows.push({
      line,
      settlementId,
      payoutDate: grabDateTime(cell('Date'), 'Date', line),
      netTotal: grabMoneyRequired(cell('Net Total'), 'Net Total', line),
      status: statusOf(cell('Status').trim(), line),
      transferDate: transfer === '' ? null : grabDateTime(transfer, 'Transfer Date', line),
    });
  }
  return { storeId: storeId as string, storeName, rowCount: rows.length, readerVersion: READER_VERSION, rows };
}
