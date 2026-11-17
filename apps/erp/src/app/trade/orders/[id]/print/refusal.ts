/**
 * T-589 B4b. Why a delivery receipt cannot be printed for an order the person CAN open, in plain words.
 * `null` means "stay a 404": the order is dispatched or received and the person simply lacks the right to print it,
 * so nothing is said about it. (An id that does not exist, or that the person cannot open, never reaches here.)
 */
export function receiptRefusal(order: { status: string; arChargeId: string | null }): string | null {
  if (order.status === 'draft' || order.status === 'confirmed') return "A draft can't be printed yet. Dispatch it first.";
  if (order.status === 'void') return 'This order was voided, so there is no delivery receipt to print.';
  if ((order.status === 'dispatched' || order.status === 'received') && !order.arChargeId) {
    return 'This order was not sold on account (for example, a transfer between branches), so it has no delivery receipt.';
  }
  return null;
}
