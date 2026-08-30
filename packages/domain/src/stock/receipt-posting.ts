/**
 * The receipt posts its value — T-163.
 *
 * ## ⭐ What this closes, and it was measured rather than assumed
 *
 * ADR-009 counted the share of deliveries carrying a linked expense: **91% (May), 86% (Jun),
 * 89% (Jul), 76% (Aug — the WORST month, not the best)**. If linking were a new habit bedding in,
 * August would be highest. It is lowest, and the shape fits one explanation: *expensing LAGS
 * delivery.*
 *
 * ⚠️ **And the inversion is what makes it serious.** Stock on hand at any date is
 * disproportionately RECENT deliveries (1–2 week turnover), and recent deliveries are
 * disproportionately the UNLINKED ones — so **the cost basis is weakest for exactly the stock that
 * needs valuing.** Nobody would have found that by reasoning about it; it took counting.
 *
 * ⛔ It is not a discipline problem. It is what happens when "receive the goods" and "recognise
 * the cost" are one act performed once, whenever a human gets to it. **This module splits them.**
 *
 * ## The two postings
 *
 * ```
 * On receipt      Dr 1310/1320/1330 Inventory     Cr 2120 Goods received not invoiced
 * On invoice      Dr 2120                          Cr 2110 Accounts payable  (party = supplier)
 *                 Dr/Cr inventory   the OPEN share of any variance — stock still on the shelf
 *                 Dr/Cr 5450        the CONSUMED share — its COGS is already posted
 * ```
 *
 * ⚠️ The invoice half lives in `invoice-link.ts`, which also records why that split is what it is
 * and where this task's own spec had it backwards.
 *
 * ⭐ **The invoice CORRECTS a number that already exists; it does not create the first one.** That
 * is the whole difference, and it is why the books are never blind about stock on the shelf.
 *
 * ## ⭐ There is no `isExpensed` flag, and there never will be
 *
 * v1 stores `isExpensed`/`partiallyExpensed`, hand-set at **three independent call sites** that
 * each recompute the same two booleans. Discovery 20 read the alternatives at source: ERPNext's
 * `per_billed` and Odoo's `invoice_status` are **re-derived, never written**; Dolibarr's
 * hand-toggled `billed` is called from nowhere and is that field's own cautionary tale.
 *
 * ⭐ **Anything sitting in `2120` is a receipt whose invoice has not arrived.** A real account,
 * with a real balance, on the balance sheet — impossible to forget to maintain. See
 * `cost-confirmation.ts`.
 */
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import type { Tx } from '@shareat/db';

/**
 * ⚠️ **₱0.99, and it is a tuned business number rather than an epsilon.** v1 raised it from ₱0.01
 * because real supplier invoices carry centavo, VAT-rounding and weighing variance that used to
 * block a legitimate link. §16.6: purpose-tuned tolerances are carried as named constants WITH
 * their reason, never collapsed into one global epsilon.
 *
 * ⭐ **It governs the FINDING, not the posting** — see `invoice-link.ts`. The money always lands
 * where it belongs (open share to inventory, consumed share to `5450`); the tolerance decides only
 * whether a human is asked to look. ⛔ Never a block: v1's judgement was that a centavo-rounded
 * supplier invoice must still be linkable, and that judgement is kept.
 */
export const INVOICE_MATCH_TOLERANCE: Money = money('0.99');

/** COA-ALIGNMENT §4.1's crosswalk, keyed by the item's own kind. Not a new mapping. */
export const INVENTORY_ACCOUNT_BY_ITEM_KIND: Readonly<Record<string, string>> = {
  raw_material: '1310',
  meat_slab: '1310',
  meat_sliced: '1310',
  retail: '1310',
  supply: '1320',
  /** Produced goods — written by T-176's conversion, not by a supplier receipt. */
  prepped: '1330',
};

export const GRNI_ACCOUNT = '2120';
export const AP_ACCOUNT = '2110';
export const PRICE_VARIANCE_ACCOUNT = '5450';

export interface ReceiptLine {
  readonly itemId: string;
  readonly itemKind: string;
  /** Landed cost for the whole line, already allocated by T-151. */
  readonly lineCost: Money;
}

export interface PostReceiptInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly receiptId: string;
  /** YYYY-MM-DD. Resolved to a fiscal period by `postEntry`, never supplied as one. */
  readonly receivedOn: string;
  readonly lines: readonly ReceiptLine[];
  readonly postedBy?: string | null;
}

export type PostingResult =
  | { readonly ok: true; readonly entryId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Post a receipt's value: inventory up, `2120` up, in the caller's transaction.
 *
 * ⚠️ `tx` is required rather than optional. A receipt's value and its stock movement must commit
 * together or not at all (§16.11 — *no overnight job, no drift window*), so this call always joins
 * a transaction the caller already owns.
 */
export async function postReceiptValue(tx: Tx, input: PostReceiptInput): Promise<PostingResult> {
  if (input.lines.length === 0) {
    return { ok: false, reason: 'a receipt with no lines posts nothing' };
  }

  const lines: PostEntryLine[] = [];
  let total = ZERO;

  for (const line of input.lines) {
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind];
    if (!account) {
      // ⛔ Blocks rather than guessing. An unmapped kind means somebody added an item type and
      // nobody decided which asset it becomes — exactly the decision a default would bury.
      return {
        ok: false,
        reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1`,
      };
    }
    if (compare(line.lineCost, ZERO) <= 0) {
      return { ok: false, reason: `a receipt line must have a positive cost, got ${line.lineCost}` };
    }
    lines.push({ accountCode: account, storeId: input.storeId, debit: line.lineCost });
    total = add(total, line.lineCost);
  }

  // ⭐ One credit to 2120 for the whole receipt. The per-item detail is the layers, which is the
  // subledger; splitting the credit would put detail in two places and tie neither.
  lines.push({ accountCode: GRNI_ACCOUNT, storeId: input.storeId, credit: total });

  const result = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.receivedOn,
    sourceType: 'stock_receipt',
    sourceId: input.receiptId,
    idempotencyKey: `stock_receipt:${input.receiptId}:value`,
    memo: 'Goods received, invoice not yet arrived',
    postedBy: input.postedBy ?? null,
    lines,
  });
  return { ok: true, entryId: result.entryId, created: result.created };
}
