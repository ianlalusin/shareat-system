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
 * DISPATCH   Dr 1340 Inventory in transit   Cr 1310/1320/1330   (commissary — at COST)
 * RECEIPT    Cr 1340 at COST                Dr 1250 Due from related store   (commissary)
 *            Cr 5175 the transfer MARGIN
 *            Dr 1310/1320/1330              Cr 2150 Due to related store     (branch)
 * ```
 *
 * ⛔ **`1340` IS A COST ACCOUNT AND IS RELIEVED AT COST — the single rule that keeps it clean.**
 * The dispatch debits what the goods cost the commissary (FIFO, ₱300/kg); the transfer happens at
 * an agreed price that carries the processing work (₱310/kg). Those are different numbers *on
 * purpose* — T-133: *"the transfer PRICE carries the processing cost."* Crediting `1340` at the
 * transfer rate therefore leaves it **permanently negative by exactly the margin**, once per
 * shipment, ⚠️ **with a trial balance that still ties** — the ₱1,000 is merely in the wrong
 * account, so nothing announces it. The first cut of this module did precisely that; T-174's
 * fixture found it by asking what was actually stranded after a short receipt.
 *
 * ⭐ **The margin goes to `5175 Cost transferred to branches`, and only for goods that ARRIVE.**
 * That account's own comment has said since T-102b that it *"must ELIMINATE against the
 * commissary's transfer-out"*, and this is that job: the commissary expensed ₱1,000 of processing
 * labour through payroll, and crediting `5175` for ₱1,000 nets its P&L back to zero — which is
 * correct, because **an internal transfer earns nothing**. Consolidated, `5170 + 5175 = 0`.
 *
 * ⚠️ So `5175` is **load-bearing under perpetual**, not a periodic leftover kept for franchises.
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
 *
 * ## Outbound freight (T-372/DEF-127)
 *
 * `trade_orders.delivery_fee + other_fees`, on an INTERNAL order, is the cost of the truck that
 * made the trip — never a sale. It posts at RECEIPT, same as the goods, but as its OWN entry
 * (`postInternalFreight`), keyed `trade_order:<id>:receipt-freight`, never as extra legs on the
 * goods entry above:
 *
 * ```
 * FREIGHT   Dr 6630 Vehicle and transportation   (branch — bears the haulage in its own P&L)
 *           Cr 2150 Due to related store         (branch, party: commissary)
 *           Dr 1250 Due from related store       (commissary, party: branch)
 *           Cr 6630 Vehicle and transportation   (commissary — recovers its own driver/fuel cost)
 * ```
 *
 * ⭐ **The debit side is Ian's ruling (Q1 (a), 2026-09-30): the receiving branch bears the haulage,
 * not the commissary.** The credit side is who owed and paid for it — the SAME `2150`/`1250`
 * reciprocal pair the goods entry uses, because the branch now owes the commissary for the freight
 * exactly as it owes for the goods. The commissary's own `6630` credit recovers what it already
 * spent on the trip through its own expenses (fuel, driver payroll); consolidated, the two `6630`
 * legs net to zero — the same elimination `5175` performs for the transfer margin above.
 *
 * ⛔ **A separate entry, not separate legs on the goods one, because the goods entry can be ABSENT
 * when the freight is still owed:** `confirmReceipt` returns `entryId: null` when every line was
 * short-received to zero, and `receiveTradeOrder` skips calling it at all when every line is
 * ledger-only. The truck still ran either way.
 *
 * ⚠️ Called only on the `internal` customer-treatment branch (`receiveTradeOrder`'s existing
 * internal/external split) — a franchise's freight would be revenue, not a recovery, and is out of
 * this task's scope entirely.
 */
import { add, compare, decimal, fromCentavos, isZero, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { deliveriesRepo, stockLayersRepo, stockLedgerRepo, tradeDiscrepanciesRepo, type Tx } from '@shareat/db';
import type { ShortageReason } from '@shareat/db/schema';
import { consume } from '../stock/consume';
import type { Outcome } from './outcome';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { lineCost } from '../stock/layers';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { quantity, subtractQuantity, toThousandths, type Quantity } from '../stock/quantity';
import { internalFault } from '../shared/refusal';

export const IN_TRANSIT_ACCOUNT = '1340';
export const DUE_FROM_ACCOUNT = '1250';
export const DUE_TO_ACCOUNT = '2150';
/** ⭐ Where the transfer margin lands. Contra-COGS at the commissary; nets its processing to zero. */
export const TRANSFER_OUT_ACCOUNT = '5175';
/** ⭐ T-372/DEF-127. `6630 Vehicle and transportation` — the haulage account both legs of the
 *  freight entry use (COA-ALIGNMENT §4.1; `packages/db/seed/chart-of-accounts.ts:392`). Not a
 *  `requires_party` control account, so neither `6630` leg below carries a party. */
export const HAULAGE_ACCOUNT = '6630';

/**
 * ⚠️ A **measurement** tolerance, and it is v1's: `hasDiscrepancy` fires above 0.005 base units.
 * Five grams between what a commissary weighed out and a branch weighed in is two scales
 * disagreeing, not a discrepancy worth a manager's morning.
 *
 * ⛔ **Not the float defence T-161 deleted** — that one could never fire against exact decimals.
 * This one fires all the time and should.
 */
export const RECEIPT_DISCREPANCY_TOLERANCE: Quantity = quantity('0.005');

/**
 * The share of a line's dispatch cost that belongs to the quantity actually received.
 *
 * ⭐ Exact integer arithmetic on centavos and thousandths, rounded half-up — never floats, and
 * never a per-unit rate multiplied back out, which would drift the last centavo and leave `1340`
 * holding it forever. ⚠️ A full receipt returns the dispatch cost UNCHANGED rather than a
 * recomputation, so the account provably clears.
 */
export function proportionOfCost(dispatchCost: Money, received: Quantity, dispatched: Quantity): Money {
  const d = toThousandths(dispatched);
  if (d === 0n) return ZERO;
  const r = toThousandths(received);
  if (r >= d) return dispatchCost;
  return costOfQuantity(dispatchCost, received, dispatched);
}

/**
 * ⭐ T-372 S6b — `q` units valued at the line's per-unit dispatch cost (`dispatchCost / dispatched`): the same exact
 * half-up centavo arithmetic as `proportionOfCost`, WITHOUT its `received >= dispatched → dispatchCost` cap.
 * `proportionOfCost` would understate 30 of 20 at the full dispatch cost; the over-receipt's informational `value` is
 * the excess at cost, so it must not be capped. Informational only: nothing posts it.
 */
export function costOfQuantity(dispatchCost: Money, q: Quantity, dispatched: Quantity): Money {
  const d = toThousandths(dispatched);
  if (d === 0n) return ZERO;
  const total = toCentavos(dispatchCost);
  const scaled = total * toThousandths(q) * 2n;
  return fromCentavos((scaled + d) / (d * 2n));
}

/**
 * ⭐ T-372 S6b — the ONE place the cap lives. A receipt books what was SENT, never more: a branch that counted more than
 * the commissary dispatched books the dispatched quantity, and the excess is an `over` discrepancy row for a manager to
 * decide. There is no tolerance exception: a booked quantity above dispatched would relieve `1340` and `5175` against
 * goods the commissary never released. (The tolerance only decides whether an over ROW is raised.)
 */
export function bookedReceiptQuantity(dispatched: Quantity, counted: Quantity): Quantity {
  return toThousandths(counted) > toThousandths(dispatched) ? dispatched : counted;
}

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
): Promise<Outcome<{
  entryId: string;
  movementIds: string[];
  value: Money;
  /**
   * ⭐ Per line, what the goods COST — the figure the receipt must relieve `1340` at. Persist it
   * on `trade_order_lines.dispatch_cost`; the receipt reads it back rather than being told.
   */
  costByLineId: Readonly<Record<string, Money>>;
}>> {
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
  const costByLineId: Record<string, Money> = {};
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
    costByLineId[line.lineId] = consumed.totalCost;
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

  return { ok: true, entryId: posted.entryId, movementIds, value, costByLineId };
}

export interface ReceiptLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly branchItemId: string;
  readonly branchLocationId: string;
  readonly dispatchedQuantity: Quantity;
  /** ⭐ What the branch COUNTED. `confirmReceipt` books `bookedReceiptQuantity(dispatched, counted)`; any excess
   *  above dispatched is an `over` discrepancy row (T-372 S6b). */
  readonly receivedQuantity: Quantity;
  /** ⚠️ The branch's own base unit, when known. A mismatch flags and skips the balance. */
  readonly branchBaseUnit: string | null;
  readonly commissaryBaseUnit: string;
  /** The transfer rate captured on the line — what carries the commissary's processing cost. */
  readonly rate: string;
  /**
   * ⛔ **What the DISPATCHED quantity cost the commissary** — `dispatchOrder`'s `costByLineId`,
   * persisted on the order line. `1340` is relieved from this and never from `rate`; the
   * difference is the margin, and it goes to `5175`.
   */
  readonly dispatchCost: Money;
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
  /**
   * ⭐ T-174. Supplied when the order's lines are real rows, which is every path except a test
   * that posts a bare transfer. ⚠️ When a line's id is present here, a short receipt RAISES A
   * DISCREPANCY in this same transaction — so a shortfall cannot sit in `1340` without a row
   * naming it, and the day-open block can never disagree with the ledger.
   */
  readonly orderLineIdByLineId?: Readonly<Record<string, string>>;
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
  /** `shortfall` is the DIFFERENCE (dispatched − counted for `short`, counted − dispatched for `over`). */
  readonly discrepancies: readonly { lineId: string; shortfall: Quantity; id: string | null; direction: 'short' | 'over' }[];
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
  const discrepancies: { lineId: string; shortfall: Quantity; id: string | null; direction: 'short' | 'over' }[] = [];
  const unitMismatches: string[] = [];
  let receivedValue: Money = ZERO;
  let receivedCost: Money = ZERO;
  let dispatchedCost: Money = ZERO;

  // ---- Pass 1: decide everything, write nothing. ---------------------------------------------
  // ⭐ The T-166 lesson again: a refusal discovered on line 2 must not leave line 1's stock moved.
  const accepted: { line: ReceiptLineInput; account: string; value: Money; cost: Money }[] = [];
  const shortfalls: { line: ReceiptLineInput; shortfall: Quantity; direction: 'short' | 'over' }[] = [];
  /** ⭐ T-372 S6b: what each line BOOKS — the counted quantity capped at what was dispatched. */
  const bookedByLineId = new Map<string, Quantity>();

  for (const line of input.lines) {
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.branchItemKind];
    if (!account) {
      return {
        ok: false,
        reason: `item kind "${line.branchItemKind}" has no inventory account in COA-ALIGNMENT §4.1`,
      };
    }

    dispatchedCost = add(dispatchedCost, line.dispatchCost);

    // ⭐ T-372 S6b: the DISCREPANCY tests read what the branch COUNTED; everything that is booked reads `booked`.
    const booked = bookedReceiptQuantity(line.dispatchedQuantity, line.receivedQuantity);
    bookedByLineId.set(line.lineId, booked);
    const shortfall = subtractQuantity(line.dispatchedQuantity, line.receivedQuantity);
    if (toThousandths(shortfall) > toThousandths(RECEIPT_DISCREPANCY_TOLERANCE)) {
      shortfalls.push({ line, shortfall, direction: 'short' });
    }
    const excess = subtractQuantity(line.receivedQuantity, line.dispatchedQuantity);
    if (toThousandths(excess) > toThousandths(RECEIPT_DISCREPANCY_TOLERANCE)) {
      shortfalls.push({ line, shortfall: excess, direction: 'over' });
    }

    if (toThousandths(booked) === 0n) continue;

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

    const value = lineCost(booked, line.rate);
    if (compare(value, ZERO) <= 0) continue;
    const cost = proportionOfCost(line.dispatchCost, booked, line.dispatchedQuantity);
    accepted.push({ line, account, value, cost });
    receivedValue = add(receivedValue, value);
    receivedCost = add(receivedCost, cost);
  }

  // ---- Pass 2: write. ------------------------------------------------------------------------
  for (const { line } of accepted) {
    // ⭐ DEF-140 (2026-09-03). The movement's source is the order LINE row, not the order: two
    // commissary items may legitimately map to ONE branch item (a slab and its trimmed cut both
    // arriving as "pork belly"), and `stock_movements_source_pair_key` — one source touching one
    // (item, location) once — refused the second line's movement outright, with the whole receipt
    // rolled back. Per line, the index still does its job: a retried receipt of the same line
    // writes nothing new. `source_id` is a uuid, so it is the `trade_order_lines` id when the
    // caller supplied it (every real path does), and the order for a bare transfer with no rows.
    // ⚠️ The layer below keeps the ORDER as its source; nothing reads either back by id (grepped).
    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId, storeId: input.branchStoreId, locationId: line.branchLocationId,
      itemId: line.branchItemId, movedAt: new Date(`${input.receivedOn}T00:00:00Z`),
      quantity: bookedByLineId.get(line.lineId)!, kind: 'transfer_in',
      sourceType: 'trade_order_receipt',
      sourceId: input.orderLineIdByLineId?.[line.lineId] ?? input.orderId,
      createdBy: input.receivedBy,
    });
    branchMovements.push({ lineId: line.lineId, movementId: movement.id });

    // ⭐ The branch's layer is at the TRANSFER RATE, and that rate is the mechanism by which the
    // commissary's processing work reaches the branch's books — ₱310/kg, not ₱300 (T-133).
    // ⚠️ CONFIRMED, not provisional: the price is agreed and no invoice is coming.
    await stockLayersRepo.createLayer(tx, {
      orgId: input.orgId, storeId: input.branchStoreId, itemId: line.branchItemId,
      receivedAt: new Date(`${input.receivedOn}T00:00:00Z`),
      quantity: bookedByLineId.get(line.lineId)!, unitCost: decimal(line.rate, '14,4'),
      source: 'transfer_in', sourceId: input.orderId, movementId: movement.id,
    });
  }

  // ⭐ T-174: one row per short line, in THIS transaction. ⛔ There is no "raise a discrepancy"
  // action anywhere — if the shortfall and the row could be created separately, the day-open block
  // would be guarding a list that a failed second step can leave empty.
  for (const { line, shortfall, direction } of shortfalls) {
    const orderLineId = input.orderLineIdByLineId?.[line.lineId];
    if (!orderLineId) {
      discrepancies.push({ lineId: line.lineId, shortfall, id: null, direction });
      continue;
    }
    const created = await tradeDiscrepanciesRepo.create(tx, {
      direction,
      orgId: input.orgId,
      // ⚠️ The COMMISSARY's store. The stranded value is on ITS books, and it is its manager
      // who decides what happened — invariant 11.
      storeId: input.commissaryStoreId,
      orderId: input.orderId,
      orderLineId,
      quantity: shortfall,
      // ⭐ AT COST, because that is what is actually stranded in `1340`. ⚠️ Valuing the dispute at
      // the transfer rate would make every disposal relieve `1340` by more than the goods put
      // into it — the same ₱-per-shipment hole in a second place.
      //
      // ⭐ T-372 S6b: an `over` row's value is the EXCESS at the line's dispatch unit cost (uncapped), informational
      // only — it posts nothing and can be 0 when the dispatch cost is 0.
      value:
        direction === 'over'
          ? costOfQuantity(line.dispatchCost, shortfall, line.dispatchedQuantity)
          : subtract(
              line.dispatchCost,
              proportionOfCost(line.dispatchCost, line.receivedQuantity, line.dispatchedQuantity),
            ),
    });
    discrepancies.push({ lineId: line.lineId, shortfall, id: created.id, direction });
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
      // ⭐ T-372 S6b: the BOOKED quantity, so the branch's `deliveries` row never records more than was sent
      // (the T-166 over-receipt trigger would refuse it, and `over_receipt_allowed` must not be set from code —
      // that flag means a manager approved it). The excess lives on the `over` discrepancy row.
      receivedQuantity: bookedByLineId.get(line.lineId)!,
      unit: line.branchBaseUnit ?? line.commissaryBaseUnit,
      unitCost: decimal(line.rate, '14,4'),
      locationId: line.branchLocationId,
      shortageReason:
        toThousandths(bookedByLineId.get(line.lineId)!) < toThousandths(line.dispatchedQuantity)
          ? (line.shortageReason ?? 'other')
          : null,
    })),
  });

  // ⚠️ Nothing accepted — every line short to zero, or every line unit-blocked. There is no entry
  // to post, and the whole dispatched value stays in transit.
  if (compare(receivedValue, ZERO) <= 0) {
    return {
      ok: true, entryId: null, deliveryId: delivery.id, branchMovements, discrepancies,
      unitMismatches, value: ZERO, inTransitRemaining: dispatchedCost,
    };
  }

  // ⭐ ONE entry, TWO stores — bible landmine #27's fix. Both stores are rows in one database, so
  // this is a real ACID transaction, never v1's two best-effort writes.
  //
  // ⚠️ The branch's debit is ONE LEG PER LINE, at the account that line's own kind maps to — the
  // shape `postReceiptValue` already uses. A single leg at `lines[0]`'s account would post a
  // mixed receipt's `prepped` goods into `1310` and silently misstate both accounts.
  // ⭐ `1340` at COST; the margin to `5175`. Together they equal the transfer value, so the entry
  // balances against the two `receivedValue` legs below.
  const margin = subtract(receivedValue, receivedCost);
  const lines: PostEntryLine[] = [
    { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: receivedCost },
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

  // ⚠️ Only when there IS one. A transfer at cost has no margin, and
  // `journal_lines_exactly_one_side_check` rejects a zero-value leg. ⛔ A NEGATIVE margin — a
  // transfer priced below cost — is a debit, not an absent leg: it is a real subsidy of the branch
  // by the commissary and it belongs on the face of the books, not rounded away.
  if (compare(margin, ZERO) > 0) {
    lines.push({ accountCode: TRANSFER_OUT_ACCOUNT, storeId: input.commissaryStoreId, credit: margin });
  } else if (compare(margin, ZERO) < 0) {
    lines.push({
      accountCode: TRANSFER_OUT_ACCOUNT, storeId: input.commissaryStoreId,
      debit: subtract(ZERO, margin),
    });
  }

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
    // ⚠️ What stayed in transit, AT COST — which is what `1340` still holds. NOT written off here:
    // goods in a truck that never arrived are a real asset until a manager says otherwise (T-174).
    inTransitRemaining: subtract(dispatchedCost, receivedCost),
  };
}

export interface PostInternalFreightInput {
  readonly orgId: string;
  readonly commissaryStoreId: string;
  readonly branchStoreId: string;
  /** Store CODES, not uuids — same convention as `ConfirmReceiptInput` (DEF-040): `party_id` for a
   *  store line is the OTHER store's code. */
  readonly commissaryStoreCode: string;
  readonly branchStoreCode: string;
  readonly orderId: string;
  readonly receivedOn: string;
  /** `delivery_fee + other_fees` (R6) — ONE figure, already summed by the caller. */
  readonly freight: Money;
  readonly postedBy: string;
}

/**
 * T-372/DEF-127 — the outbound-freight entry (see this file's header). Posts the four R9 legs as
 * their own entry, in the SAME transaction as `confirmReceipt`, never folded into it.
 *
 * ⭐ Returns `null` for a zero freight — the common case (most internal orders carry no fee), and
 * `journal_lines_exactly_one_side_check` would reject a zero-value leg outright regardless.
 *
 * ⛔ A negative `freight` is an `internalFault`, never a `refuse()` or a bare, unnamed exception:
 * R5's `trade_orders_fees_non_negative_check` (migration 0175) plus `createTradeOrder`'s own refusal
 * (`trade/index.ts:307`) make this unreachable through any live path — a negative figure arriving
 * here means some OTHER writer bypassed both, which is this module's bug to report, not the
 * caller's refusal to word.
 */
export async function postInternalFreight(
  tx: Tx,
  input: PostInternalFreightInput,
): Promise<{ entryId: string } | null> {
  if (compare(input.freight, ZERO) < 0) {
    throw internalFault(
      `postInternalFreight: freight ${input.freight} for order ${input.orderId} is negative — ` +
        'unreachable through createTradeOrder (refuses a negative fee) or the fees CHECK (migration ' +
        '0175); some other writer produced this value.',
    );
  }
  if (isZero(input.freight)) return null;

  const posted = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.receivedOn,
    // ⚠️ Same (sourceType, sourceId) as the goods entry above (R7) — the two are told apart by
    // idempotency_key (`trade_order:<id>:receipt` vs `:receipt-freight`), never by source alone.
    sourceType: 'trade_order_receipt',
    sourceId: input.orderId,
    idempotencyKey: `trade_order:${input.orderId}:receipt-freight`,
    memo: 'Branch confirmed receipt — outbound freight charged to the branch',
    postedBy: input.postedBy,
    lines: [
      { accountCode: HAULAGE_ACCOUNT, storeId: input.branchStoreId, debit: input.freight },
      {
        accountCode: DUE_TO_ACCOUNT, storeId: input.branchStoreId, credit: input.freight,
        partyType: 'store', partyId: input.commissaryStoreCode,
      },
      {
        accountCode: DUE_FROM_ACCOUNT, storeId: input.commissaryStoreId, debit: input.freight,
        partyType: 'store', partyId: input.branchStoreCode,
      },
      { accountCode: HAULAGE_ACCOUNT, storeId: input.commissaryStoreId, credit: input.freight },
    ],
  });

  return { entryId: posted.entryId };
}
