/**
 * The commissary → branch transfer: dispatch, then receipt — T-172 and T-173.
 *
 * ⭐ **The rule the whole pipeline rests on, and it is one sentence:**
 *
 * > **Everything posts at CONFIRM RECEIPT, keyed to what the branch actually RECEIVED — never to
 * > what was fulfilled or dispatched.**
 *
 * v1 arrived at this after the alternative failed, and said so: *"this avoids the previous
 * mismatch where dispatched-fulfilled qty differed from received qty and the AR had to be
 * retroactively credited."* It is also Phase 2 §3.3's already-adopted rule, reached independently
 * from the sell side. Two roads, one destination.
 *
 * ## ⛔ What v1 does here that v2 must NOT copy
 *
 * v1's own header: *"Branch: stock IN … **NO AP is posted here** — the branch recognizes the cost
 * later by expensing the commissary delivery. Commissary: **AR debit** for received total, stock
 * OUT, arTransaction doc + AR customer outstanding bumped."*
 *
 * ⭐ **A branch is not a customer of its own company.** v1 books branch sales as revenue, which is
 * why it then needed an `excludeBranchSales` flag to stop its own insights being wrong — the
 * exclusion is the tell that the recognition was wrong upstream. And v1's "recognise the cost
 * later" step is a window in which a branch holds stock it has not accounted for, which is exactly
 * the expensing lag ADR-009 measured.
 *
 * **v2 posts the four-leg internal transfer at receipt and nothing afterwards.**
 *
 * ## The two postings
 *
 * ```
 * DISPATCH   Dr 1340 Inventory in transit   Cr 1310/1330   (commissary only — nothing crosses)
 * RECEIPT    Cr 1340                        Dr 1250 Due from related store   (commissary)
 *            Dr 1310/1320/1330              Cr 2150 Due to related store     (branch)
 * ```
 *
 * ⛔ **NOTHING CALLS THESE TWO FUNCTIONS YET, AND THAT IS DELIBERATE.** `dispatchTradeOrder`
 * (`../trade/index.ts`) still posts the PERIODIC internal transfer — `1250`/`5175` and
 * `5170`/`2150` — and it is what a real order goes through today. **T-165 is the switch**, last in
 * the wave: it rewires that function's internal branch onto these two and retires the `5170`/`5175`
 * legs. ⚠️ **Wiring a caller to both would count one transfer twice**, once through the P&L and
 * once through the balance sheet, and the trial balance would still tie — so nothing would say so.
 *
 * ⚠️ `1340` exists for exactly this and has been seeded and unused since T-102. Without it, goods
 * are invisible between the two stores — the same gap T-167's in-transit reservation closes inside
 * one store.
 */
import { add, compare, subtract, ZERO, type Money } from '@shareat/core/money';
import { deliveriesRepo, stockLayersRepo, stockLedgerRepo, type Tx } from '@shareat/db';
import type { ShortageReason } from '@shareat/db/schema';
import { consume } from '../stock/consume';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { lineCost } from '../stock/layers';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { quantity, subtractQuantity, toThousandths, type Quantity } from '../stock/quantity';

export const IN_TRANSIT_ACCOUNT = '1340';
export const DUE_FROM_ACCOUNT = '1250';
export const DUE_TO_ACCOUNT = '2150';

/**
 * ⚠️ A **measurement** tolerance, and it is v1's: `hasDiscrepancy` fires above 0.005 base units.
 * Five grams between what a commissary weighed out and a branch weighed in is two scales
 * disagreeing, not a discrepancy worth a manager's morning.
 *
 * ⛔ **Not the float defence T-161 deleted** — that one could never fire against exact decimals.
 * This one fires all the time and should.
 */
export const RECEIPT_DISCREPANCY_TOLERANCE: Quantity = quantity('0.005');

export interface DispatchLineInput {
  readonly lineId: string;
  readonly itemId: string;
  /**
   * ⚠️ The COMMISSARY item's kind, which decides which asset account is relieved. ⛔ Not
   * assumable: a commissary's whole job is turning `raw_material` (`1310`) into `prepped`
   * (`1330`), so it is the one store where hard-coding `1310` is guaranteed to be wrong.
   */
  readonly itemKind: string;
  readonly sourceLocationId: string;
  readonly fulfilledQuantity: Quantity;
}

export interface DispatchInput {
  readonly orgId: string;
  readonly commissaryStoreId: string;
  readonly orderId: string;
  readonly dispatchedOn: string;
  readonly lines: readonly DispatchLineInput[];
  readonly dispatchedBy: string;
  /** On-hand per item, for the gate. ⚠️ An item ABSENT here is untracked. */
  readonly onHandByItem: Readonly<Record<string, Quantity>>;
}

export type Outcome<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/**
 * Dispatch: the goods leave the commissary's shelf for the truck.
 *
 * ⭐ **The stock gate FAILS CLOSED here** — an item with no tracked balance is refused, because it
 * is the *commissary's* data problem and refusing makes them fix it. ⚠️ The same predicate fails
 * OPEN at receipt (see `confirmReceipt`), and the asymmetry is deliberate.
 */
export async function dispatchOrder(
  tx: Tx,
  input: DispatchInput,
): Promise<Outcome<{ entryId: string; movementIds: string[]; value: Money }>> {
  if (input.lines.length === 0) return { ok: false, reason: 'a dispatch with no lines moves nothing' };

  // ⭐ EVERY refusal is decided before the first write — the T-166 lesson. Validating inside the
  // write loop leaves stock moved and value unposted when line 2 is the bad one.
  const short: string[] = [];
  for (const line of input.lines) {
    if (!INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind]) {
      // ⛔ Blocks rather than guessing, exactly as `postReceiptValue` does. An unmapped kind means
      // somebody added an item type and nobody decided which asset it becomes.
      return {
        ok: false,
        reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1`,
      };
    }
    const onHand = input.onHandByItem[line.itemId];
    if (onHand === undefined) {
      short.push(`${line.itemId} (no tracked balance — set the commissary's inventory first)`);
      continue;
    }
    if (toThousandths(line.fulfilledQuantity) > toThousandths(onHand)) {
      short.push(`${line.itemId} (${line.fulfilledQuantity} of ${onHand})`);
    }
  }
  if (short.length > 0) {
    return { ok: false, reason: `cannot dispatch more than the commissary holds: ${short.join(', ')}` };
  }

  const movementIds: string[] = [];
  const credits: PostEntryLine[] = [];
  let value: Money = ZERO;

  for (const line of input.lines) {
    // Relieve the commissary's own layers — the cost travels with the goods.
    const consumed = await consume(tx, {
      orgId: input.orgId, storeId: input.commissaryStoreId, locationId: line.sourceLocationId,
      itemId: line.itemId, quantity: line.fulfilledQuantity,
      movedAt: new Date(`${input.dispatchedOn}T00:00:00Z`),
      kind: 'transfer_out', sourceType: 'trade_order_dispatch', sourceId: input.orderId,
      createdBy: input.dispatchedBy,
    });
    if (!consumed.ok) return consumed;
    movementIds.push(consumed.movementId);
    value = add(value, consumed.totalCost);
    // ⚠️ One credit PER LINE, at the account its own kind maps to — the shape `postReceiptValue`
    // already uses. ⛔ A `journal_lines_exactly_one_side_check` rejects a zero-value leg, so a
    // line that cost nothing must not produce one.
    if (compare(consumed.totalCost, ZERO) > 0) {
      credits.push({
        accountCode: INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind]!,
        storeId: input.commissaryStoreId,
        credit: consumed.totalCost,
      });
    }
  }

  if (compare(value, ZERO) <= 0) {
    return { ok: false, reason: 'a dispatch whose goods cost nothing posts nothing' };
  }

  // ⚠️ Same store, same org. Nothing crosses to the branch yet — T-173 is the only place the two
  // stores' books touch.
  const posted = await postEntry(tx, {
    orgId: input.orgId, entryDate: input.dispatchedOn,
    sourceType: 'trade_order_dispatch', sourceId: input.orderId,
    idempotencyKey: `trade_order:${input.orderId}:dispatch`,
    memo: 'Goods dispatched to branch — in transit',
    postedBy: input.dispatchedBy,
    lines: [
      { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, debit: value },
      ...credits,
    ],
  });

  return { ok: true, entryId: posted.entryId, movementIds, value };
}

export interface ReceiptLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly branchItemId: string;
  readonly branchLocationId: string;
  readonly dispatchedQuantity: Quantity;
  readonly receivedQuantity: Quantity;
  /** ⚠️ The branch's own base unit, when known. A mismatch flags and skips the balance. */
  readonly branchBaseUnit: string | null;
  readonly commissaryBaseUnit: string;
  /** The transfer rate captured on the line — what carries the commissary's processing cost. */
  readonly rate: string;
  /**
   * ⚠️ The **BRANCH** item's kind, not the commissary's. They differ routinely and that is the
   * point of the map: a commissary ships `prepped` marinated pork out of `1330`, and the branch
   * receives it as the `raw_material` it will cook, into `1310`.
   */
  readonly branchItemKind: string;
  /**
   * Why the branch signed for less than the commissary packed, when it did. ⚠️ The branch person
   * picks it at the receipt screen; `other` is the honest fallback, because at receipt time the
   * cause genuinely is not known yet — that is what T-174 investigates.
   */
  readonly shortageReason?: ShortageReason | null;
}

export interface ConfirmReceiptInput {
  readonly orgId: string;
  readonly commissaryStoreId: string;
  readonly branchStoreId: string;
  /** Store CODES, not uuids — `party_id` for a store line is the other store's code (DEF-040). */
  readonly commissaryStoreCode: string;
  readonly branchStoreCode: string;
  readonly orderId: string;
  readonly receivedOn: string;
  readonly lines: readonly ReceiptLineInput[];
  readonly receivedBy: string;
}

export interface ConfirmReceiptResult {
  /**
   * ⭐ The branch's own record of what arrived — a `deliveries` row of kind `commissary`, written
   * always, including for the lines this receipt refused. It posts nothing; T-173's entry is the
   * posting. It exists so a commissary shipment appears on the same "what arrived today" surface
   * as a supplier's, which is where a manager compares paperwork to crates.
   */
  readonly deliveryId: string;
  /**
   * ⚠️ **`null` when nothing was accepted** — every line short-delivered to zero or blocked by a
   * unit mismatch. The receipt happened and is worth returning; there is simply nothing to post,
   * and `journal_lines_exactly_one_side_check` rejects a zero-value leg outright.
   */
  readonly entryId: string | null;
  readonly branchMovements: readonly { lineId: string; movementId: string }[];
  readonly discrepancies: readonly { lineId: string; shortfall: Quantity }[];
  readonly unitMismatches: readonly string[];
  readonly value: Money;
  readonly inTransitRemaining: Money;
}

/**
 * Confirm receipt — the one event where both stores' books move, in one transaction.
 *
 * ⭐ Everything is keyed to `receivedQuantity`. A short receipt does **not** block: it posts what
 * arrived and leaves the difference in `1340` for T-174 to dispose of. ⛔ Blocking here is what
 * forced v1's retroactive AR credits.
 */
export async function confirmReceipt(
  tx: Tx,
  input: ConfirmReceiptInput,
): Promise<Outcome<ConfirmReceiptResult>> {
  if (input.lines.length === 0) return { ok: false, reason: 'a receipt with no lines posts nothing' };

  const branchMovements: { lineId: string; movementId: string }[] = [];
  const discrepancies: { lineId: string; shortfall: Quantity }[] = [];
  const unitMismatches: string[] = [];
  let receivedValue: Money = ZERO;
  let dispatchedValue: Money = ZERO;

  // ---- Pass 1: decide everything, write nothing. ---------------------------------------------
  // ⭐ The T-166 lesson again: a refusal discovered on line 2 must not leave line 1's stock moved.
  const accepted: { line: ReceiptLineInput; account: string; value: Money }[] = [];

  for (const line of input.lines) {
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.branchItemKind];
    if (!account) {
      return {
        ok: false,
        reason: `item kind "${line.branchItemKind}" has no inventory account in COA-ALIGNMENT §4.1`,
      };
    }

    dispatchedValue = add(dispatchedValue, lineCost(line.dispatchedQuantity, line.rate));

    const shortfall = subtractQuantity(line.dispatchedQuantity, line.receivedQuantity);
    if (toThousandths(shortfall) > toThousandths(RECEIPT_DISCREPANCY_TOLERANCE)) {
      discrepancies.push({ lineId: line.lineId, shortfall });
    }

    if (toThousandths(line.receivedQuantity) === 0n) continue;

    // ⭐ UNIT-MISMATCH GUARD, and v1's two load-bearing details are kept:
    //   1. enforced only when the branch's unit is KNOWN — the guard refuses to act on an
    //      assumption it cannot check;
    //   2. computed before the write, so a retry cannot duplicate the warning.
    //
    // ⛔ **v1 skips the balance and books the value anyway. v2 skips BOTH, and the difference is
    // the whole point of perpetual inventory:** debiting the branch's `1310` for goods its stock
    // ledger never received puts the account and the subledger permanently out of tie, and no
    // later count can explain the gap. The value stays in `1340` — the goods are physically at
    // the branch and not yet in its books, which is also what gets the base unit fixed.
    if (line.branchBaseUnit && line.branchBaseUnit !== line.commissaryBaseUnit) {
      unitMismatches.push(
        `${line.branchItemId}: received in "${line.commissaryBaseUnit}" but the branch item is set to ` +
        `"${line.branchBaseUnit}". Stock was NOT added and the value stays in transit — fix the ` +
        `item's base unit, then confirm again.`,
      );
      continue;
    }

    const value = lineCost(line.receivedQuantity, line.rate);
    if (compare(value, ZERO) <= 0) continue;
    accepted.push({ line, account, value });
    receivedValue = add(receivedValue, value);
  }

  // ---- Pass 2: write. ------------------------------------------------------------------------
  for (const { line } of accepted) {
    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId, storeId: input.branchStoreId, locationId: line.branchLocationId,
      itemId: line.branchItemId, movedAt: new Date(`${input.receivedOn}T00:00:00Z`),
      quantity: line.receivedQuantity, kind: 'transfer_in',
      sourceType: 'trade_order_receipt', sourceId: input.orderId, createdBy: input.receivedBy,
    });
    branchMovements.push({ lineId: line.lineId, movementId: movement.id });

    // ⭐ The branch's layer is at the TRANSFER RATE, and that rate is the mechanism by which the
    // commissary's processing work reaches the branch's books — ₱310/kg, not ₱300 (T-133).
    // ⚠️ CONFIRMED, not provisional: the price is agreed and no invoice is coming.
    await stockLayersRepo.createLayer(tx, {
      orgId: input.orgId, storeId: input.branchStoreId, itemId: line.branchItemId,
      receivedAt: new Date(`${input.receivedOn}T00:00:00Z`),
      quantity: line.receivedQuantity, unitCost: line.rate,
      source: 'transfer_in', sourceId: input.orderId, movementId: movement.id,
    });
  }

  // ⚠️ Written from EVERY line, not just the accepted ones — a shipment whose units were wrong
  // still arrived, and the row is how anyone finds out.
  const delivery = await deliveriesRepo.createCommissaryDelivery(tx, {
    orgId: input.orgId,
    storeId: input.branchStoreId,
    deliveredOn: input.receivedOn,
    referenceNo: input.orderId,
    receivedBy: input.receivedBy,
    lines: input.lines.map((line) => ({
      lineNo: line.lineId,
      itemId: line.branchItemId,
      orderedQuantity: line.dispatchedQuantity,
      receivedQuantity: line.receivedQuantity,
      unit: line.branchBaseUnit ?? line.commissaryBaseUnit,
      unitCost: line.rate,
      locationId: line.branchLocationId,
      shortageReason:
        toThousandths(line.receivedQuantity) < toThousandths(line.dispatchedQuantity)
          ? (line.shortageReason ?? 'other')
          : null,
    })),
  });

  // ⚠️ Nothing accepted — every line short to zero, or every line unit-blocked. There is no entry
  // to post, and the whole dispatched value stays in transit.
  if (compare(receivedValue, ZERO) <= 0) {
    return {
      ok: true, entryId: null, deliveryId: delivery.id, branchMovements, discrepancies,
      unitMismatches, value: ZERO, inTransitRemaining: dispatchedValue,
    };
  }

  // ⭐ ONE entry, TWO stores — bible landmine #27's fix. Both stores are rows in one database, so
  // this is a real ACID transaction, never v1's two best-effort writes.
  //
  // ⚠️ The branch's debit is ONE LEG PER LINE, at the account that line's own kind maps to — the
  // shape `postReceiptValue` already uses. A single leg at `lines[0]`'s account would post a
  // mixed receipt's `prepped` goods into `1310` and silently misstate both accounts.
  const lines: PostEntryLine[] = [
    { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: receivedValue },
    {
      accountCode: DUE_FROM_ACCOUNT, storeId: input.commissaryStoreId, debit: receivedValue,
      partyType: 'store', partyId: input.branchStoreCode,
    },
    ...accepted.map((a) => ({
      accountCode: a.account, storeId: input.branchStoreId, debit: a.value,
    })),
    {
      accountCode: DUE_TO_ACCOUNT, storeId: input.branchStoreId, credit: receivedValue,
      partyType: 'store', partyId: input.commissaryStoreCode,
    },
  ];

  const posted = await postEntry(tx, {
    orgId: input.orgId, entryDate: input.receivedOn,
    sourceType: 'trade_order_receipt', sourceId: input.orderId,
    idempotencyKey: `trade_order:${input.orderId}:receipt`,
    memo: 'Branch confirmed receipt — cost transferred',
    postedBy: input.receivedBy,
    lines,
  });

  return {
    ok: true,
    entryId: posted.entryId,
    deliveryId: delivery.id,
    branchMovements,
    discrepancies,
    unitMismatches,
    value: receivedValue,
    // ⚠️ What stayed in transit. NOT written off here — goods in a truck that never arrived are a
    // real asset until a manager says otherwise (T-174).
    inTransitRemaining: subtract(dispatchedValue, receivedValue),
  };
}
