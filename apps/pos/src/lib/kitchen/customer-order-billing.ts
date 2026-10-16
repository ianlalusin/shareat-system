/**
 * Billing for orders a diner placed themselves from the CUSTOMER app.
 *
 * ## Why these orders bill late
 *
 * A staff-placed add-on (`AddonsPOSModal`) writes its bill line and its kitchen
 * ticket together: a cashier keying an item in has already agreed to sell it.
 * A diner tapping their own phone has not — so a customer-app order writes a
 * kitchen ticket ONLY, and the bill line appears when the kitchen marks the
 * item served. The diner is charged for what they were actually handed, and an
 * order the kitchen cancels never reaches the bill at all.
 *
 * ## The contract with the CUSTOMER repo
 *
 * The CUSTOMER app's order route writes a ticket carrying:
 *
 *   source:        "customer_app"
 *   billOnServe:   true
 *   billLineId:    null            // set here, on the FIRST serve
 *   pendingBillLine: PendingBillLine
 *
 * Everything needed to price the line travels on the ticket, so the kitchen
 * never re-reads the catalog and a later price change cannot retroactively
 * alter what the diner was quoted.
 *
 * `billLineId` staying null until the first serve is load-bearing: the kitchen
 * cancel path voids against `billLineId`, so a never-served ticket correctly
 * touches no bill line. See `shouldVoidBilledQty` for the partial-serve case.
 *
 * These two repos deploy separately, so treat this shape as a published
 * interface — widen it additively, never rename a field in place.
 */

export type PendingBillLineModifier = {
  groupId: string;
  groupName: string;
  valueId: string;
  valueName: string;
  priceDelta: number;
};

export type PendingBillLine = {
  /**
   * The bill line this ticket's servings accumulate onto.
   *
   * Uses POS's own scheme — `addon_{productId}_{unitPrice}_{modHash}` — so a
   * customer order and a staff order for the identical item and modifiers land
   * on ONE line, and every existing void / discount / receipt path keeps
   * working with no knowledge that a customer was involved.
   */
  lineId: string;
  itemId: string;
  itemName: string;
  category: string | null;
  /** Base price excluding modifiers, matching `sessionBillLines.unitPrice`. */
  unitPrice: number;
  modifiers: PendingBillLineModifier[] | null;
  modifiersText: string | null;
  modifiersTotal: number | null;
  kitchenLocationId: string | null;
  kitchenLocationName: string | null;
  note: string | null;
};

/**
 * The shape these guards read off a ticket. Deliberately loose on
 * `pendingBillLine` — it arrives from Firestore (written by a separately
 * deployed app), so it is validated at runtime rather than trusted by type.
 */
type TicketLike = {
  type?: string | null;
  source?: string | null;
  billOnServe?: boolean | null;
  billLineId?: string | null;
  pendingBillLine?: Record<string, any> | null;
};

/**
 * The pending line for a ticket that must be billed on serve, or null when
 * this ticket bills the ordinary way (or not at all).
 */
export function pendingBillLineFor(ticket: TicketLike): PendingBillLine | null {
  if (ticket?.billOnServe !== true) return null;
  const pending = ticket?.pendingBillLine;
  if (!pending || !pending.lineId || !pending.itemId) return null;
  return pending as PendingBillLine;
}

/**
 * Whether cancelling the unserved remainder of a ticket should void quantity
 * off the bill.
 *
 * For a normal add-on: yes — the full quantity was billed up front, so the
 * unserved part has to come back off.
 *
 * For a bill-on-serve ticket: NEVER. Its line only ever carries the quantity
 * already served, so voiding the remainder would subtract quantity that was
 * never charged and drive the line negative. A partially-served customer order
 * (1 of 3 served, 2 cancelled) is already correct at 1 billed.
 */
export function shouldVoidBilledQty(ticket: TicketLike): boolean {
  return ticket?.type === "addon" && !!ticket?.billLineId && ticket?.billOnServe !== true;
}

/**
 * The `sessionBillLines` document for the first serve of a customer order.
 *
 * Field-for-field the shape `AddonsPOSModal.performAdd` writes, so the cashier,
 * the receipt and the analytics pipeline cannot tell the two apart — except for
 * `orderedVia`, which is additive and exists so staff can see where it came
 * from. Timestamps and actor stamps are merged in by the caller, which holds
 * the live SDK handles.
 */
export function buildCustomerOrderBillLine(
  pending: PendingBillLine,
  qtyServed: number
): Record<string, any> {
  return {
    id: pending.lineId,
    type: "addon",
    itemId: pending.itemId,
    itemName: pending.itemName,
    category: pending.category ?? null,
    barcode: null,
    unitPrice: pending.unitPrice,
    qtyOrdered: qtyServed,
    discountType: null,
    discountValue: 0,
    discountQty: 0,
    freeQty: 0,
    voidedQty: 0,
    kitchenLocationId: pending.kitchenLocationId ?? null,
    kitchenLocationName: pending.kitchenLocationName ?? null,
    modifiers: pending.modifiers?.length ? pending.modifiers : null,
    modifiersText: pending.modifiersText || null,
    modifiersTotal: pending.modifiers?.length ? pending.modifiersTotal ?? 0 : null,
    note: pending.note || null,
    /** Provenance, for the cashier's benefit. Not read by any billing logic. */
    orderedVia: "customer_app",
  };
}
