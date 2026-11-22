import { center, columnsFor, justify, printAmount, rule, wrap } from './layout';
import { TEST_LINE } from './receipt-text';
import type { PrintLayout, ReceiptHeader } from './types';

/**
 * T-628 - the deposit slip as plain text, one string per paper line, beside `formatReceipt`. Printed when a reservation deposit is taken (and again on a reprint): the customer's
 * proof of what they paid and for which table. NOTHING HERE IS COMPUTED: the amount and the times arrive worked out and print as given. It is not a sales receipt.
 */
export interface DepositSlipView {
  header: ReceiptHeader;
  customerName: string;
  partySize: number;
  /** Already formatted, e.g. `"02/11/26 7:00 PM"`. */
  reservedForLocal: string;
  takenAtLocal: string;
  /** The amount as a decimal string (`"1000.00"`). */
  amount: string;
  /** The method's name (`Cash`, `GCash`). */
  tenderName: string;
  /** A wallet's reference number; null for cash. */
  reference: string | null;
  takenBy: string;
  reprint: boolean;
}

function pushCentered(out: string[], text: string, cols: number): void {
  const trimmed = text.trim();
  if (!trimmed) {
    out.push('');
    return;
  }
  for (const line of wrap(trimmed, cols)) out.push(center(line, cols));
}

export function formatDepositSlip(view: DepositSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];
  pushCentered(out, view.header.businessName.toUpperCase(), cols);
  for (const address of view.header.addressLines) pushCentered(out, address, cols);
  if (view.header.tin !== null) pushCentered(out, `TIN: ${view.header.tin} ${view.header.vatRegistered ? 'VAT' : 'Non-VAT'}`, cols);
  out.push('');
  if (view.header.test) pushCentered(out, TEST_LINE, cols);
  if (view.reprint) pushCentered(out, 'REPRINT', cols);
  pushCentered(out, 'RESERVATION DEPOSIT', cols);
  out.push(...justify('NAME:', view.customerName, cols));
  out.push(...justify('PARTY:', String(view.partySize), cols));
  out.push(...justify('RESERVED FOR:', view.reservedForLocal, cols));
  out.push(...justify('TAKEN:', view.takenAtLocal, cols));
  out.push(rule(cols));
  out.push(...justify(view.tenderName.toUpperCase(), printAmount(view.amount), cols));
  if (view.reference !== null) for (const line of wrap(`Ref: ${view.reference}`, Math.max(1, cols - 2))) out.push(`  ${line}`);
  out.push(...justify('DEPOSIT PAID', printAmount(view.amount), cols));
  out.push(rule(cols));
  out.push(...justify('RECEIVED BY:', view.takenBy, cols));
  pushCentered(out, 'Keep this slip. The deposit is taken off your bill.', cols);
  pushCentered(out, 'Not an official receipt', cols);
  return out;
}
