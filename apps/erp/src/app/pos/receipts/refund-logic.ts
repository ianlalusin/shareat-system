/**
 * T-534 S4 - the pure parts of the Refund dialog: what the picked items come to, how the money is split across the receipt's own paid rows by default, and the one-line problem
 * (or null) with a split. Every money figure for an item comes from the server (`amounts[q-1]`, the refund for q units: discounted, remainder-exact); the tablet only adds them up.
 */
import { fromCentavos, toCentavos, money } from '@shareat/core/money';
import { amountCents } from '../_payment/logic';

export interface RefundLineChoice {
  lineId: string;
  name: string;
  qty: number;
  /** How many can still be refunded. */
  left: number;
  /** The refund for q more units, at index q-1 (decimal text), from the server. */
  amounts: readonly string[];
}
export interface RefundPaymentChoice {
  /** Tells apart two ways of refunding one paid row (T-613 D1: its own method, and a method a correction moved money to): `paymentId:tenderId`. The split and references are keyed by it. */
  slotId: string;
  paymentId: string;
  tenderId: string;
  tenderName: string;
  kind: 'cash' | 'wallet';
  /** What this paid row can still give back (decimal text). */
  left: string;
}

export const centsToText = (c: bigint): string => String(fromCentavos(c));

/** What the picked quantities come to, in centavos (a quantity above what is left, or below zero, counts as nothing). */
export function refundTotalCents(lines: readonly RefundLineChoice[], qtys: Readonly<Record<string, number>>): bigint {
  let total = 0n;
  for (const l of lines) {
    const q = qtys[l.lineId] ?? 0;
    if (q > 0 && q <= l.left) total += toCentavos(money(l.amounts[q - 1] ?? '0'));
  }
  return total;
}

/** Cash first, then the other methods in payment order; paid rows with nothing left are skipped. */
export function refundOrder(payments: readonly RefundPaymentChoice[]): RefundPaymentChoice[] {
  const open = payments.filter((p) => amountCents(p.left) > 0n);
  return [...open.filter((p) => p.kind === 'cash'), ...open.filter((p) => p.kind !== 'cash')];
}

/** The default split of `totalCents` over the paid rows: cash first, each up to what it can take (centavos by payment id). The rest, if the rows cannot take it all, is left unassigned. */
export function autoSplit(payments: readonly RefundPaymentChoice[], totalCents: bigint): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  let rest = totalCents;
  for (const p of refundOrder(payments)) {
    const take = rest < amountCents(p.left) ? rest : amountCents(p.left);
    if (take > 0n) out[p.slotId] = take;
    rest -= take;
  }
  return out;
}

/** What is wrong with a split, in a sentence, or null when it is fine (each row within what it can take, the rows add up to the total, a wallet row has a reference). */
export function splitProblem(
  payments: readonly RefundPaymentChoice[],
  split: Readonly<Record<string, string>>,
  references: Readonly<Record<string, string>>,
  totalCents: bigint,
): string | null {
  let sum = 0n;
  for (const p of payments) {
    const cents = amountCents(split[p.slotId]);
    if (cents > amountCents(p.left)) return `${p.tenderName} can only take back ₱${p.left}.`;
    if (cents > 0n && p.kind === 'wallet' && (references[p.slotId] ?? '').trim().length < 4) return `Type the reference number for the money sent back by ${p.tenderName}.`;
    sum += cents;
  }
  if (totalCents > 0n && sum !== totalCents) return `The money going back (₱${centsToText(sum)}) must equal the refund (₱${centsToText(totalCents)}).`;
  return null;
}
