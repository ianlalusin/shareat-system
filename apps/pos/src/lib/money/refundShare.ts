/**
 * T-424 Ruling 6 (M2) - what a refund of N units of a receipt line is worth: its share of what the customer actually PAID.
 *
 * `allocate(receipt total in centavos, by line net)` gives every line its paid amount (VAT added on top at VAT-exclusive stores, the
 * senior/PWD VAT removal and 20%, discounts, loyalty and charges are all inside `total`). Units of a line take equal shares, the LAST unit
 * of a line takes the remainder, so every refund of one receipt together can never exceed its `total` (DEF-590).
 *
 * Pure and shared: the POS v2 server uses it to price a refund, and the refund dialog uses it to show the same number before the PIN.
 * The money module (`centavos.ts`) does all the arithmetic.
 */
import { allocate, storedPesosToCentavos } from './centavos';

export interface ShareLine {
  id: string;
  qtyOrdered: number;
  freeQty?: number | null;
  voidedQty?: number | null;
  unitPrice: number;
}

/** Units of a line that were actually sold and not voided or free. */
export function netQtyOf(l: Pick<ShareLine, 'qtyOrdered' | 'freeQty' | 'voidedQty'>): number {
  return Math.max(0, Number(l.qtyOrdered ?? 0) - Number(l.freeQty ?? 0) - Number(l.voidedQty ?? 0));
}

/** Each line's paid amount in centavos, or null when nothing on the receipt can be refunded (a zero total, or no sold units). */
export function paidShares(lines: ShareLine[], receiptTotalPesos: number): number[] | null {
  const totalC = storedPesosToCentavos(receiptTotalPesos);
  // A negative price would make a negative weight (allocate throws): such a line weighs 0 and the total is shared across the other lines.
  const nets = lines.map((l) => Math.max(0, netQtyOf(l) * storedPesosToCentavos(l.unitPrice)));
  if (totalC <= 0 || nets.every((n) => n === 0)) return null;
  return allocate(totalC, nets);
}

/**
 * The refund, in centavos, for `qty` more units of line `index`, when `alreadyRefunded` units of it were refunded before.
 * `shares` is `paidShares(...)`. The caller has checked `qty <= netQty - alreadyRefunded`.
 */
export function unitsRefundCentavos(lines: ShareLine[], shares: number[], index: number, alreadyRefunded: number, qty: number): number {
  const line = lines[index]!;
  const q = netQtyOf(line);
  const share = shares[index]!;
  const base = Math.floor(share / q);
  return qty * base + (alreadyRefunded + qty === q ? share - q * base : 0);
}
