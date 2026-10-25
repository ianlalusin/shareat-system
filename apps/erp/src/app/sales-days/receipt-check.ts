/**
 * T-472 S3 - the ONE line the Sales days page shows when the nightly receipt bridge found a day whose copied POS receipts differ
 * from the POS day total. Pure, so it is tested without a page. Plain wording; the newest mismatch is named, the rest are counted.
 */
import { formatMoney, fromCentavos } from '@shareat/core/money';

export interface ReceiptCheckMismatch {
  readonly storeId: string;
  readonly posCalendarDate: string;
  readonly differenceCentavos: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Null when there is nothing to say. `rows` is newest first. */
export function receiptCheckLine(rows: readonly ReceiptCheckMismatch[], storeName: (storeId: string) => string): string | null {
  const first = rows[0];
  if (!first) return null;
  const amount = formatMoney(fromCentavos(BigInt(Math.abs(first.differenceCentavos))));
  const more = rows.length > 1 ? ` (and ${rows.length - 1} more day${rows.length > 2 ? 's' : ''})` : '';
  return `Receipt check: ${storeName(first.storeId)} ${humanDate(first.posCalendarDate)} differs from the POS day total by ${amount}${more}.`;
}
