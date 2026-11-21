/**
 * T-534 S4 - turns the slip the refund route answers with (JSON: the time is ISO text) into the view `formatRefundSlip` prints. Nothing is computed: figures go through as given;
 * only the Manila-time text of the moment is made.
 */
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { money } from '@shareat/core/money';
import { receiptHeaderOf, type RefundSlipView } from '@/lib/pos-print';

export interface RefundSlipJson {
  refundNo: string;
  receiptNo: string;
  recordedAt: string;
  reason: string;
  total: string;
  lines: { name: string; qty: number; amount: string }[];
  payments: { tenderName: string; amount: string; referenceNo: string | null }[];
  approvedByName: string;
  recordedByName: string;
}
export interface RefundSlipContext {
  storeName: string;
  vatRegistered: boolean;
  /** T-585: the issuer identity (legal name, address, TIN); absent = the store name alone. */
  identity?: unknown;
  /** T-601 S4: the POS mode of the store; `test` puts TEST - NOT A SALE on the slip. */
  mode?: string;
}

export function refundSlipView(slip: RefundSlipJson, ctx: RefundSlipContext, reprint = false): RefundSlipView {
  return {
    header: receiptHeaderOf({ name: ctx.storeName, vatRegistered: ctx.vatRegistered, identity: ctx.identity, mode: ctx.mode }),
    refundNo: slip.refundNo,
    receiptNo: slip.receiptNo,
    refundedAtLocal: formatBusinessDateTime(new Date(slip.recordedAt), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''),
    lines: slip.lines.map((l) => ({ name: l.name, qty: l.qty, amount: money(l.amount) })),
    total: money(slip.total),
    payments: slip.payments.map((p) => ({ name: p.tenderName, amount: money(p.amount), reference: p.referenceNo })),
    reason: slip.reason,
    approvedBy: slip.approvedByName,
    recordedBy: slip.recordedByName,
    ...(reprint ? { reprint: true } : {}),
  };
}
