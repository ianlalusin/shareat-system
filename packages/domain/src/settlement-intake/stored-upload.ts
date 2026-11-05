/**
 * T-511 S5b - read a settlement file back. `readSettlementBytes` turns the bytes of one file into what it said (the ingest calls it on the file it was just
 * handed); `readStoredUpload` does the same for an upload row, reading the ORIGINAL file from storage. The staging tables keep the figures, not the order
 * lists, so the day detail re-reads the file (docs/designs/channel-settlement-upload.md Component K). Both moved here from ingest.ts, not copied.
 * Reads only: nothing is written.
 */
import { filesRepo, settlementIntakeRepo, type Tx } from '@shareat/db';
import { resolveStorageDriver } from '../files/driver';
import { readFoodpandaInvoice, type FoodpandaInvoice } from './foodpanda-workbook';
import { readGrabTransactions, type GrabTransactionsFile } from './grab-transactions';
import { readGrabTransfers, type GrabTransfersFile } from './grab-transfers';
import { openSettlementZip } from './safe-zip';

export type SettlementFileKind = 'foodpanda_invoice' | 'grab_transactions' | 'grab_transfers';

/** What a file said, whatever its kind: the code that finds its channel and the numbers an upload row records. */
export interface StoredUpload {
  kind: SettlementFileKind;
  platform: 'grab' | 'foodpanda';
  code: string;
  periodFrom: string | null;
  periodTo: string | null;
  invoiceNumber: string | null;
  ordersRead: number;
  loanRowsRead: number;
  otherRowsRead: number;
  transactions?: GrabTransactionsFile;
  transfers?: GrabTransfersFile;
  foodpanda?: FoodpandaInvoice;
}

const extent = (dates: string[]): { from: string | null; to: string | null } => {
  const sorted = [...dates].sort();
  return { from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
};

export async function readSettlementBytes(kind: SettlementFileKind, bytes: Buffer): Promise<StoredUpload> {
  if (kind === 'foodpanda_invoice') {
    const invoice = await readFoodpandaInvoice((await openSettlementZip(bytes)).workbook);
    const { from, to } = extent(invoice.orders.length > 0 ? invoice.orders.map((o) => o.orderDate) : invoice.charges.flatMap((c) => (c.date ? [c.date] : [])));
    return {
      kind, platform: 'foodpanda', code: invoice.vendorCode, periodFrom: from, periodTo: to, invoiceNumber: invoice.invoiceNumber,
      ordersRead: invoice.orders.length, loanRowsRead: 0, otherRowsRead: invoice.charges.length, foodpanda: invoice,
    };
  }
  if (kind === 'grab_transactions') {
    const file = readGrabTransactions(bytes);
    const count = (k: string): number => file.rows.filter((r) => r.kind === k).length;
    return {
      kind, platform: 'grab', code: file.storeId, periodFrom: file.periodFrom, periodTo: file.periodTo, invoiceNumber: null,
      ordersRead: count('payment'), loanRowsRead: count('loan'), otherRowsRead: count('adjustment') + count('advertisement'), transactions: file,
    };
  }
  const file = readGrabTransfers(bytes);
  const { from, to } = extent(file.rows.map((r) => r.payoutDate.date));
  return { kind, platform: 'grab', code: file.storeId, periodFrom: from, periodTo: to, invoiceNumber: null, ordersRead: 0, loanRowsRead: 0, otherRowsRead: 0, transfers: file };
}

/**
 * The original file of an upload, read again with the same reader. null for an upload that does not exist in the org (another org's gives the same answer)
 * and for a stored file that is gone from storage. A file the reader now refuses raises the reader's own typed sentence.
 */
export async function readStoredUpload(tx: Tx, orgId: string, uploadId: string): Promise<StoredUpload | null> {
  const upload = await settlementIntakeRepo.findUploadById(tx, orgId, uploadId);
  if (!upload) return null;
  const file = await filesRepo.getById(tx, orgId, upload.fileId);
  if (!file) return null;
  let bytes: Uint8Array;
  try {
    bytes = await resolveStorageDriver().get(file.storagePath);
  } catch {
    return null;
  }
  return readSettlementBytes(upload.fileKind, Buffer.from(bytes));
}
