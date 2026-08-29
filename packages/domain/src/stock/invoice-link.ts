/**
 * Clearing `2120` when the supplier invoice arrives — T-163's second posting.
 *
 * ⛔ **This corrects T-163's own spec, which had the two shares the wrong way round.** Reported
 * rather than quietly implemented differently (§3.4a): a planner's spec is a hypothesis, and
 * patching around a defect destroys the evidence it was wrong.
 *
 * The spec's test 4 reads: *"100 kg received at ₱300, 40 kg consumed, then the invoice says ₱310.
 * The 60 open re-value; the 40 consumed keep ₱300; **`5450` takes ₱600**."* ⚠️ ₱600 is `60 × ₱10`
 * — the **open** share, which belongs to inventory. The consumed share is `40 × ₱10 = ₱400`, and
 * that is what has nowhere else to go.
 *
 * ## The rule, stated correctly
 *
 * ⭐ **The variance splits by open-versus-consumed share.**
 *
 * ```
 * Dr 2120                       the provisional total this receipt parked there
 * Dr/Cr 1310|1320|1330          the OPEN share — stock still on the shelf, re-costed
 * Dr/Cr 5450                    the CONSUMED share — its COGS is already posted, possibly in a
 *                               closed period, and must not be rewritten
 * Cr 2110  (party = supplier)   what the supplier actually billed
 * ```
 *
 * This is T-162 invariant 10 seen from the other side: *"correcting a provisional layer's unit
 * cost re-values only its OPEN remainder… it does not rewrite a closed month."*
 *
 * ## ⚠️ And what the tolerance actually governs
 *
 * The spec also said *"within tolerance, no `5450` line"*. Taken literally that is unimplementable:
 * when the whole receipt has been consumed there is no open remainder to absorb the difference,
 * and an entry with nowhere to put it **cannot balance**.
 *
 * ⭐ **So the ₱0.99 tolerance governs the FINDING, not the posting.** The money always lands where
 * it belongs; the tolerance decides whether a human is asked to look. That keeps v1's real
 * judgement — *never block a real invoice over a rounding gap* — while removing a case where the
 * books could not be written at all.
 */
import { fromCentavos, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { toThousandths, type Quantity } from './quantity';
import { AP_ACCOUNT, GRNI_ACCOUNT, INVOICE_MATCH_TOLERANCE, PRICE_VARIANCE_ACCOUNT } from './receipt-posting';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import type { Tx } from '@shareat/db';

export interface VarianceSplit {
  /** Re-costs the stock still on hand. */
  readonly inventoryShare: Money;
  /** The part whose COGS is already posted and must not be rewritten. */
  readonly consumedShare: Money;
  /** `inventoryShare + consumedShare`, exactly. */
  readonly total: Money;
  /** True when the total is inside ₱0.99 — advisory only. */
  readonly withinTolerance: boolean;
}

/**
 * Split a variance by how much of the receipt is still on the shelf.
 *
 * Pure, and computed in integers throughout: the inventory share is rounded once and the consumed
 * share is **the remainder**, so the two always sum to the total exactly and the entry always
 * balances. ⛔ Never round both independently — that is how a one-centavo hole appears in a
 * journal entry that looks correct on both sides.
 */
export function splitVariance(
  variance: Money,
  openQuantity: Quantity,
  receivedQuantity: Quantity,
): VarianceSplit {
  const received = toThousandths(receivedQuantity);
  const open = toThousandths(openQuantity);
  const varianceCentavos = toCentavos(variance);

  if (received <= 0n) {
    // Nothing was received, so nothing is open: the whole difference is a pure price correction.
    return finish(ZERO, variance, variance);
  }

  const clampedOpen = open < 0n ? 0n : open > received ? received : open;
  const inventoryCentavos = divideRoundHalfUp(varianceCentavos * clampedOpen, received);
  const inventoryShare = fromCentavos(inventoryCentavos);

  return finish(inventoryShare, subtract(variance, inventoryShare), variance);
}

function finish(inventoryShare: Money, consumedShare: Money, total: Money): VarianceSplit {
  const magnitude = toCentavos(total) < 0n ? subtract(ZERO, total) : total;
  return {
    inventoryShare,
    consumedShare,
    total,
    withinTolerance: toCentavos(magnitude) <= toCentavos(INVOICE_MATCH_TOLERANCE),
  };
}

function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const q = a / b;
  const rounded = (a % b) * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export interface LinkInvoiceInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly receiptId: string;
  readonly supplierInvoiceId: string;
  readonly supplierId: string;
  /** YYYY-MM-DD — the invoice's own date, which may fall in a later period than the receipt. */
  readonly invoicedOn: string;
  /** What the receipt provisionally credited to `2120`. */
  readonly provisionalTotal: Money;
  /** What the supplier actually billed. */
  readonly invoicedTotal: Money;
  /** The inventory account the receipt debited — from the item's kind. */
  readonly inventoryAccount: string;
  readonly receivedQuantity: Quantity;
  /** How much of that quantity is still unconsumed, right now. */
  readonly openQuantity: Quantity;
  readonly postedBy?: string | null;
}

export interface LinkInvoiceResult {
  readonly ok: true;
  readonly entryId: string;
  readonly created: boolean;
  readonly split: VarianceSplit;
}

export async function linkInvoiceToReceipt(
  tx: Tx,
  input: LinkInvoiceInput,
): Promise<LinkInvoiceResult | { ok: false; reason: string }> {
  if (toCentavos(input.invoicedTotal) <= 0n) {
    return { ok: false, reason: 'an invoice must be for a positive amount' };
  }

  const variance = subtract(input.invoicedTotal, input.provisionalTotal);
  const split = splitVariance(variance, input.openQuantity, input.receivedQuantity);

  const lines: PostEntryLine[] = [
    // ⭐ Exactly what this receipt parked there — never a bulk sweep of the account.
    { accountCode: GRNI_ACCOUNT, storeId: input.storeId, debit: input.provisionalTotal },
    {
      accountCode: AP_ACCOUNT,
      storeId: input.storeId,
      credit: input.invoicedTotal,
      partyType: 'supplier',
      partyId: input.supplierId,
    },
  ];

  pushSigned(lines, input.inventoryAccount, input.storeId, split.inventoryShare);
  pushSigned(lines, PRICE_VARIANCE_ACCOUNT, input.storeId, split.consumedShare);

  const result = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.invoicedOn,
    sourceType: 'stock_receipt_invoice',
    sourceId: input.supplierInvoiceId,
    idempotencyKey: `stock_receipt:${input.receiptId}:invoice:${input.supplierInvoiceId}`,
    memo: 'Supplier invoice received; goods-received clearing reversed',
    postedBy: input.postedBy ?? null,
    lines,
  });

  return { ok: true, entryId: result.entryId, created: result.created, split };
}

/** A zero share posts NO line at all — invariant 1's "no zero-amount lines" (§16.1). */
function pushSigned(lines: PostEntryLine[], accountCode: string, storeId: string, amount: Money): void {
  const cents = toCentavos(amount);
  if (cents === 0n) return;
  lines.push(
    cents > 0n
      ? { accountCode, storeId, debit: amount }
      : { accountCode, storeId, credit: fromCentavos(-cents) },
  );
}
