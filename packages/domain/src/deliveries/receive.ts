/**
 * Receiving a delivery — T-166, and the seam five earlier tasks were waiting for.
 *
 * ⭐ **One transaction, three consequences.** Until this function existed, T-161's movements,
 * T-162's layers and T-163's postings each had tests but no caller. Receiving is what makes them
 * one act:
 *
 * ```
 * 1. a stock movement per line          quantity  (T-161)
 * 2. a FIFO layer per line              cost      (T-162)
 * 3. one journal entry for the whole    value     (T-163)  Dr 1310/1320/1330 · Cr 2120
 * ```
 *
 * ⚠️ **All three or none.** §16.11: *"their financial effect posts to the GL in the same
 * transaction. No overnight job, no drift window."* v1's equivalent cascade is explicitly
 * non-atomic and documents its own accepted risk (OC-14); the constraint that forced that is gone,
 * so the shape goes with it.
 *
 * ## ⭐ Where an undecided line parks, and why it is never guessed
 *
 * A line with no `locationId` goes to the store's **Receiving** room; if there is none, the
 * default room; if there is no default, any active room. It is **never dropped and never guessed**
 * — v1 names this as a deliberate fix over its own earlier behaviour of silently defaulting, *"so
 * stock is never lost."*
 */
import { add, decimal, multiplyQuantityByFactor, toCentavos, ZERO, type Decimal, type Money } from '@shareat/core/money';
import { stockLayersRepo, stockLedgerRepo, type Tx } from '@shareat/db';
import { resolveReceivingLocation, type LocationLike } from '../stock-locations/rules';
import { lineCost as costOf } from '../stock/layers';
import { closedStockPeriodSentence } from '../stock/period-guard';
import {
  INVENTORY_ACCOUNT_BY_ITEM_KIND,
  postReceiptValue,
  type ReceiptLine,
} from '../stock/receipt-posting';
import { quantity, toThousandths, type Quantity } from '../stock/quantity';

export interface ReceiveLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemKind: string;
  /** In PURCHASE units, as counted at the dock. */
  readonly receivedQuantity: Quantity;
  /** `1 purchase unit = conversionFactor × base units`, snapshotted on the line. */
  readonly conversionFactor: string;
  /** Per PURCHASE unit, as typed. */
  readonly unitCost: string;
  /** NULL parks the line in Receiving — see this file's header. */
  readonly locationId: string | null;
  /** S5.3b — the DB line's own position, named in the no-location refusal below. Optional: this
   *  function has direct test callers that build lines by hand with no `lineNo` at all, and the
   *  refusal falls back to a deictic phrase when it is absent. */
  readonly lineNo?: string;
}

export interface ReceiveDeliveryInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly deliveryId: string;
  /** YYYY-MM-DD. */
  readonly deliveredOn: string;
  readonly lines: readonly ReceiveLineInput[];
  /** The store's rooms, for the parking decision. */
  readonly locations: readonly LocationLike[];
  readonly receivedBy: string;
}

export interface ReceiveResult {
  readonly ok: true;
  readonly entryId: string;
  readonly movements: readonly { lineId: string; movementId: string; locationId: string }[];
  readonly layers: readonly { lineId: string; layerId: string }[];
  readonly totalValue: Money;
}

export type ReceiveOutcome = ReceiveResult | { readonly ok: false; readonly reason: string; readonly userReason?: string };

/**
 * Receive a delivery: stock in, cost layered, value posted — atomically.
 *
 * ⚠️ `tx` is required. This is the one place in the domain where three subsystems must commit
 * together, so it always joins a transaction the caller owns.
 */
export async function receiveDelivery(tx: Tx, input: ReceiveDeliveryInput): Promise<ReceiveOutcome> {
  // T-369 S4a (DEF-528): a closed month's stock stays as it was - said in words, before the first write.
  const closed = await closedStockPeriodSentence(tx, input.orgId, input.deliveredOn, 'received');
  if (closed) return { ok: false, reason: closed, userReason: closed };

  if (input.lines.length === 0) {
    return {
      ok: false,
      reason: 'a delivery with no lines receives nothing',
      userReason: 'A delivery with no lines receives nothing.',
    };
  }

  const parkingLocation = resolveReceivingLocation(input.locations);
  if (!parkingLocation && input.lines.some((l) => l.locationId === null)) {
    // ⛔ Refuse rather than invent a room. A store with no active location cannot hold stock, and
    // writing the movement anyway is exactly how v1 lost it.
    const idx = input.lines.findIndex((l) => l.locationId === null);
    const unparkable = input.lines[idx]!;
    const n = unparkable.lineNo ?? String(idx + 1);
    return {
      ok: false,
      reason: 'a line has no location and the store has no Receiving, default, or active room to park it in',
      userReason: `Line ${n} has no location, and the store has no Receiving, default, or active room to park it in.`,
    };
  }

  // ⭐ **Every precondition is checked BEFORE the first write**, and that ordering is the whole
  // "all three or none" promise. `postReceiptValue` returns `ok:false` rather than throwing, so a
  // refusal discovered AFTER the movements and layers were written would leave the transaction to
  // COMMIT them — v1's non-atomic cascade, faithfully reproduced by accident.
  //
  // ⚠️ Caught by `receive-delivery.test.ts`'s rollback case, which asserted zero movements and
  // found one. The test was written expecting this to be right; it was not.
  for (const [idx, line] of input.lines.entries()) {
    // T-489: something DID arrive but the conversion rounds it to nothing - refuse, never skip (before the first write).
    if (toThousandths(line.receivedQuantity) !== 0n && toThousandths(toBaseUnits(line.receivedQuantity, line.conversionFactor)) === 0n) {
      const sentence = `The unit conversion for line ${line.lineNo ?? String(idx + 1)} is so small that ${line.receivedQuantity} purchase units round to zero base units. Fix the item's conversion factor first.`;
      return { ok: false, reason: sentence, userReason: sentence };
    }
    if (!INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind]) {
      return {
        ok: false,
        reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1`,
        userReason: "This item's kind has no inventory account set up. Ask an admin to fix it before receiving this item.",
      };
    }
  }

  const movements: { lineId: string; movementId: string; locationId: string }[] = [];
  const layers: { lineId: string; layerId: string }[] = [];
  const receiptLines: ReceiptLine[] = [];

  for (const line of input.lines) {
    // ⭐ Base units are what the ledger is keyed to. The purchase unit is what the supplier
    // billed in, and the two are reconciled HERE, once — never left for a later reader to guess.
    const baseQuantity = toBaseUnits(line.receivedQuantity, line.conversionFactor);
    if (toThousandths(baseQuantity) === 0n) {
      // A line received as zero is a legitimate "nothing arrived" — it carries its shortage
      // reason on the document and simply moves no stock.
      continue;
    }

    const locationId = line.locationId ?? parkingLocation!;
    // ⭐ ONE implementation of "quantity x rate -> money", shared with the FIFO planner.
    const lineCost = costOf(line.receivedQuantity, line.unitCost);
    const baseUnitCost = perBaseUnit(lineCost, baseQuantity);

    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId,
      itemId: line.itemId,
      movedAt: new Date(`${input.deliveredOn}T00:00:00Z`),
      quantity: baseQuantity,
      kind: 'receipt',
      sourceType: 'delivery',
      sourceId: input.deliveryId,
      createdBy: input.receivedBy,
    });
    movements.push({ lineId: line.lineId, movementId: movement.id, locationId });

    // ⚠️ The layer is per STORE while the movement is per LOCATION — T-162's two grains. Parking a
    // line in Receiving and moving it to the kitchen later changes no cost at all.
    const layer = await stockLayersRepo.createLayer(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      itemId: line.itemId,
      receivedAt: new Date(`${input.deliveredOn}T00:00:00Z`),
      quantity: baseQuantity,
      unitCost: baseUnitCost,
      source: 'delivery',
      sourceId: input.deliveryId,
      movementId: movement.id,
    });
    layers.push({ lineId: line.lineId, layerId: layer.id });

    receiptLines.push({ itemId: line.itemId, itemKind: line.itemKind, lineCost });
  }

  if (receiptLines.length === 0) {
    return {
      ok: false,
      reason: 'every line was received as zero — nothing to post',
      userReason: 'Every line was received as zero — nothing to post.',
    };
  }

  const posted = await postReceiptValue(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    receiptId: input.deliveryId,
    receivedOn: input.deliveredOn,
    lines: receiptLines,
    postedBy: input.receivedBy,
  });
  if (!posted.ok) {
    // ⛔ Unreachable given the pre-validation above — and if it is ever reached, the movements and
    // layers are already written, so returning would commit a half-receipt. THROW, so the
    // transaction unwinds and the caller sees the failure it actually is.
    throw new Error(`receiveDelivery: posting refused after stock was written — ${posted.reason}`);
  }

  return {
    ok: true,
    entryId: posted.entryId,
    movements,
    layers,
    totalValue: add(...receiptLines.map((l) => l.lineCost), ZERO),
  };
}

/**
 * `purchase quantity × conversionFactor`, in thousandths of the base unit.
 *
 * ⭐ T-489 (DEF-780): the factor is applied at its full six decimals (`numeric(14,6)`) in scaled bigint, and the product
 * is rounded HALF-UP away from zero once, at the third decimal. It was `Math.round(Number(factor) * 1000)` - the factor
 * cut to three decimals through a float - so 0.0625 became 0.063 and anything under 0.0005 became 0.
 *
 * ⭐ Exported for `documents.ts`'s duplicate-risk check, which must compare an INCOMING draft
 * quantity (still in purchase units) against on-hand (in base units) - the same "one
 * implementation" reasoning as `lineCost` above.
 */
export function toBaseUnits(purchaseQuantity: Quantity, conversionFactor: string): Quantity {
  return multiplyQuantityByFactor(purchaseQuantity, decimal(conversionFactor, '14,6'));
}

/**
 * Cost per BASE unit, to 4dp — what a FIFO layer is keyed on.
 *
 * ⚠️ Rounded half-up at the fourth place, once. The layer's total value is then
 * `remaining × unitCost`, so a rounding here is a fraction of a centavo across a whole layer —
 * and T-163's invoice true-up corrects the real number anyway.
 *
 * ⭐ Exported — T-170 reuses it for a supplier-return line's weighted-average unit cost when one
 * line's quantity was relieved from more than one layer. One implementation of "money ÷ quantity
 * → 4dp", not a second copy.
 */
export function perBaseUnit(lineCost: Money, baseQuantity: Quantity): Decimal<'14,4'> {
  const raw = toCentavos(lineCost);
  const centavos = raw < 0n ? -raw : raw;
  const units = toThousandths(baseQuantity);
  if (units === 0n) return decimal('0.0000', '14,4');
  // centavos (10^2) × 10^5 / thousandths (10^3) → 10^4 scale.
  const scaled = (centavos * 100_000n * 2n + units) / (units * 2n);
  const negative = raw < 0n;
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, '0');
  // T-371 R2 — through the one mint, at `stock_layers.unit_cost`'s (14,4) shape, never a bare string.
  return decimal(`${negative ? '-' : ''}${whole}.${frac}`, '14,4');
}
