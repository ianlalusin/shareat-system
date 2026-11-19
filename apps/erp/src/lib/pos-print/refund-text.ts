import { center, columnsFor, justify, printAmount, rule, wrap } from './layout';
import type { PrintLayout, RefundSlipView } from './types';

/**
 * T-534 S4 - the refund slip as plain text, one string per paper line, beside `formatReceipt`. One copy, printed when the refund is saved.
 *
 * NOTHING HERE IS COMPUTED. The refund total, each line's amount and each method's amount arrive already worked out by the server and print exactly as given.
 * Shows: REFUND, the refund number, the ORIGINAL receipt number, when, the items refunded, the money back BY METHOD (with a wallet's reference), the reason and the approver.
 */
function pushCentered(out: string[], text: string, cols: number): void {
  const trimmed = text.trim();
  if (!trimmed) {
    out.push('');
    return;
  }
  for (const line of wrap(trimmed, cols)) out.push(center(line, cols));
}

function pushWrapped(out: string[], text: string, cols: number, indent = 0): void {
  for (const line of wrap(text, Math.max(1, cols - indent))) out.push(' '.repeat(indent) + line);
}

export function formatRefundSlip(view: RefundSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];
  pushCentered(out, view.header.businessName.toUpperCase(), cols);
  for (const address of view.header.addressLines) pushCentered(out, address, cols);
  if (view.header.tin !== null) pushCentered(out, `TIN: ${view.header.tin} ${view.header.vatRegistered ? 'VAT' : 'Non-VAT'}`, cols);
  out.push('');
  if (view.reprint) pushCentered(out, 'REPRINT', cols);
  pushCentered(out, 'REFUND', cols);
  out.push(...justify('REFUND NO:', view.refundNo, cols));
  out.push(...justify('RECEIPT:', view.receiptNo, cols));
  out.push(...justify('DATE:', view.refundedAtLocal, cols));
  out.push(rule(cols));
  for (const line of view.lines) out.push(...justify(`${line.qty} x ${line.name}`, printAmount(line.amount), cols));
  out.push(rule(cols));
  out.push(...justify('TOTAL REFUNDED', printAmount(view.total), cols));
  out.push(rule(cols));
  out.push('MONEY BACK');
  for (const p of view.payments) {
    out.push(...justify(p.name, printAmount(p.amount), cols));
    if (p.reference !== null) pushWrapped(out, `Ref: ${p.reference}`, cols, 2);
  }
  out.push(rule(cols));
  pushWrapped(out, `Reason: ${view.reason}`, cols);
  out.push(...justify('APPROVED BY:', view.approvedBy, cols));
  out.push(...justify('RECORDED BY:', view.recordedBy, cols));
  return out;
}
