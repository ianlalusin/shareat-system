/**
 * T-528a — the POS v2 print text: plain-text paper documents, built from already-computed figures.
 *
 * No React, no `'use client'`, no database, no clock, no `apps/pos` import: everything the formatters
 * need arrives in their arguments, which is what lets them be tested line by line.
 */
export { center, columnsFor, justify, printAmount, rule, wrap } from './layout';
export { formatReceipt } from './receipt-text';
export { formatKitchenTicket, formatRefillSlip } from './kitchen-text';
export { formatOfflineXSlip, formatXSlip, formatZSlip } from './reading-text';
export { formatRefundSlip } from './refund-text';
export { receiptHeaderOf } from './header';
export type {
  FontMode,
  KitchenTicketView,
  OfflineXSlipView,
  PaperWidth,
  PrintLayout,
  ReceiptDiner,
  ReceiptHeader,
  ReceiptLine,
  ReceiptLineDiscount,
  ReceiptTender,
  ReceiptView,
  RefundSlipView,
  ReadingSlipView,
  RefillSlipView,
  ZSlipView,
} from './types';
