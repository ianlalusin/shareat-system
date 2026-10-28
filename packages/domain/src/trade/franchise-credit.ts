/**
 * The shortage credit note - T-398 S5e. `docs/POSTING-PATTERNS.md` `trade_dispatch.franchise_transit_shortage`.
 *
 * The franchise (Padre Garcia) counted fewer goods at its door than the commissary shipped, so its books already owe only for what arrived. The
 * commissary's books still show the full bill. The 06:30 reconciliation raises one open `franchise_credit` discrepancy per short shipment line;
 * a HUMAN in the commissary's own organisation posts this note (never automatic). It writes only the commissary's books.
 *
 * ## The entry (store = the commissary, A7), ONE entry for every open row of the shipment
 *
 * - `DR 4950` the VALUE: per line, billed line total less `round(received x rate, 2)` - what the franchise actually booked, so the two sides agree
 *   to the centavo. Never `round(short x rate)`, which can differ by one centavo.
 * - `CR 1210` (party: the customer) for what is still open on the charge; `CR 2140` (party: the customer) for any part already collected, so the
 *   franchise holds a store credit instead of an over-credited receivable - `customer.return-credit`'s invariant 9, in the SAME entry.
 * - `DR 5300 / CR 5100` the COST: what the dispatch's own consumption relieved for the short quantity (pro-rata by quantity), never today's layers.
 *   The goods left and did not arrive: a loss, not a count variance (5400) and not a return (nothing comes back, no stock moves, no 1310).
 *
 * Afterwards `credited_total` on the shipment note moves through the seller-only definer, so the next reconciliation is clean.
 */
import { arRepo, interEntityRepo, stockLayersRepo, stockLedgerRepo, tradeDiscrepanciesRepo, tradeRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { add, compare, fromCentavos, money, multiplyToMoney, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { quantity, subtractQuantity, toThousandths } from '../stock/quantity';
import { gone, internalFault, refuse } from '../shared/refusal';

export interface FranchiseShortageCreditResult {
  readonly entryId: string;
  /** What the franchise is credited (DR 4950). */
  readonly value: string;
  /** What moves from COGS to loss (DR 5300 / CR 5100). */
  readonly cost: string;
}

/** a x b / c in whole units, rounded half-up (all positive). */
function proRata(amountCents: bigint, numerator: bigint, denominator: bigint): bigint {
  return (2n * amountCents * numerator + denominator) / (2n * denominator);
}

export async function postFranchiseShortageCredit(
  tx: Tx,
  actor: Actor,
  input: { shipmentId: string },
): Promise<FranchiseShortageCreditResult> {
  const shipment = await interEntityRepo.findById(tx, input.shipmentId);
  // A shipment this organisation did not send is invisible here exactly as a missing one is (the buyer may read the note, but cannot credit it).
  if (!shipment || shipment.orgId !== actor.orgId) {
    throw gone(`postFranchiseShortageCredit: shipment ${input.shipmentId} is not a shipment of org ${actor.orgId}.`, 'that shipment');
  }
  await authorize(tx, actor, 'resolve_trade_discrepancy', { storeId: shipment.storeId });

  // ⛔ T-494 (F27 / DEF-790): the order's charge is locked BEFORE anything is read or locked under it - the same lock `recordCollection`, the
  // write-off and `voidCharge` take - so a collection committing between this note's read of the open amount and its commit cannot over-credit
  // 1210. LOCK ORDER, everywhere: the charge row first, then the shipment / discrepancy rows (`openFranchiseCreditsOfShipment` is FOR UPDATE).
  const order = await tradeRepo.getOrderById(tx, actor.orgId, shipment.tradeOrderId);
  if (order?.arChargeId) await arRepo.lockChargesForAllocation(tx, actor.orgId, [order.arChargeId]);

  const open = await tradeDiscrepanciesRepo.openFranchiseCreditsOfShipment(tx, actor.orgId, shipment.id);
  if (open.length === 0) {
    if (compare(money(shipment.creditedTotal), ZERO) > 0) {
      throw refuse(
        `postFranchiseShortageCredit: shipment ${shipment.id} is already credited (${shipment.creditedTotal}).`,
        `The shortage on the shipment of ${shipment.shippedOn} has already been credited. Nothing more to post.`,
      );
    }
    throw refuse(
      `postFranchiseShortageCredit: shipment ${shipment.id} has no open franchise credit.`,
      `There is no shortage to credit on the shipment of ${shipment.shippedOn}. A credit note is posted after the 06:30 check finds the franchise received less than was sent.`,
    );
  }

  if (!order || !order.arChargeId) {
    throw internalFault(`postFranchiseShortageCredit: shipment ${shipment.id}'s order has no receivable charge.`);
  }
  const shipmentLines = new Map((await interEntityRepo.linesOf(tx, shipment.id)).map((l) => [l.id, l]));
  const orderLines = await tradeRepo.linesFor(tx, actor.orgId, order.id);
  const movements = await stockLedgerRepo.movementsBySource(tx, 'trade_order_dispatch', order.id);

  let totalValue: Money = ZERO;
  let totalCost: Money = ZERO;
  for (const row of open) {
    const line = shipmentLines.get(row.shipmentLineId);
    if (!line || line.receivedQuantity === null) {
      throw internalFault(`postFranchiseShortageCredit: discrepancy ${row.id} names a shipment line that was not counted.`);
    }
    const shipped = quantity(line.quantity);
    const received = quantity(line.receivedQuantity);
    const short = subtractQuantity(shipped, received);
    if (toThousandths(short) <= 0n) {
      throw internalFault(`postFranchiseShortageCredit: discrepancy ${row.id} is open but its line was received in full.`);
    }
    // What the franchise booked for this line is round(received x rate, 2); the credit is the rest of the line's bill.
    const value = subtract(money(line.lineTotal), multiplyToMoney(received, money(line.rate)));
    totalValue = add(totalValue, value);

    // The dispatch's own consumption for this ITEM across the order, shared between the item's lines by quantity.
    const orderLine = orderLines.find((l) => l.id === line.tradeOrderLineId);
    if (!orderLine) throw internalFault(`postFranchiseShortageCredit: order line ${line.tradeOrderLineId} is gone.`);
    const itemMovementIds = movements.filter((m) => m.itemId === orderLine.itemId).map((m) => m.id);
    const consumed = money(await stockLayersRepo.totalConsumedCost(tx, itemMovementIds));
    // The denominator is what the SHIPMENT carried of the item (its lines), which is what the dispatch consumed against.
    const itemOrderLineIds = new Set(orderLines.filter((l) => l.itemId === orderLine.itemId).map((l) => l.id));
    const itemQty = [...shipmentLines.values()]
      .filter((l) => itemOrderLineIds.has(l.tradeOrderLineId))
      .reduce((sum, l) => sum + toThousandths(quantity(l.quantity)), 0n);
    const cost = itemQty > 0n ? fromCentavos(proRata(toCentavos(consumed), toThousandths(short), itemQty)) : ZERO;
    totalCost = add(totalCost, cost);
  }

  // Already collected? Credit 1210 only up to what is still open on the charge; the rest is store credit, in the SAME entry.
  const outstanding = money(await arRepo.outstandingForCharge(tx, actor.orgId, order.arChargeId));
  const reduceAr = compare(totalValue, outstanding) <= 0 ? totalValue : outstanding;
  const storeCredit = subtract(totalValue, reduceAr);

  const lines: PostEntryLine[] = [
    { accountCode: '4950', storeId: shipment.storeId, debit: totalValue, lineMemo: `Credit note - shipment of ${shipment.shippedOn}` },
  ];
  if (compare(reduceAr, ZERO) > 0) {
    lines.push({
      accountCode: arRepo.AR_CONTROL_CODE, storeId: shipment.storeId, credit: reduceAr,
      partyType: 'customer', partyId: order.customerId, lineMemo: `Credit note - shipment of ${shipment.shippedOn}`,
    });
  }
  if (compare(storeCredit, ZERO) > 0) {
    lines.push({
      accountCode: arRepo.STORE_CREDIT_CODE, storeId: shipment.storeId, credit: storeCredit,
      partyType: 'customer', partyId: order.customerId, lineMemo: `Credit note - shipment of ${shipment.shippedOn}, already paid`,
    });
  }
  if (compare(totalCost, ZERO) > 0) {
    lines.push(
      { accountCode: '5300', storeId: shipment.storeId, debit: totalCost, lineMemo: `Goods not received - shipment of ${shipment.shippedOn}` },
      { accountCode: '5100', storeId: shipment.storeId, credit: totalCost, lineMemo: `Goods not received - shipment of ${shipment.shippedOn}` },
    );
  }

  const posted = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: toBusinessDate(),
    sourceType: 'trade_order_credit',
    sourceId: shipment.id,
    idempotencyKey: `franchise_credit:${shipment.id}:post`,
    memo: `Credit note - shortage on the shipment of ${shipment.shippedOn}`,
    postedBy: actor.personId,
    lines,
  });

  // The shipment note carries what was credited (seller-only definer; the app role's own UPDATE stays refused), then the to-do rows close.
  await interEntityRepo.creditShipment(tx, shipment.id, totalValue);
  for (const row of open) {
    await tradeDiscrepanciesRepo.resolveFranchiseCredit(tx, { id: row.id, journalEntryId: posted.entryId, resolvedBy: actor.personId });
  }
  return { entryId: posted.entryId, value: totalValue, cost: totalCost };
}
