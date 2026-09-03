/**
 * Duplicate-delivery risk — T-166. **Advisory. It warns; it never blocks.**
 *
 * ⭐ **The WARN-never-BLOCK design is the decision, not an implementation detail**, and v1 states
 * why in its own words: *"our job is to put the fact in front of them at the moment they can still
 * act on it."*
 *
 * ⛔ **Blocking would be wrong here, and it is worth being precise about why.** Legitimate double
 * drops happen — a supplier splits a load across two vans on the same morning. Bulk buys before a
 * long weekend genuinely double what is on hand. **Only the person holding the physical paper can
 * tell a re-key from a real second delivery**, and a system that refuses the real one teaches them
 * to work around it.
 *
 * ⚠️ The one case that IS refused outright is a *hard* duplicate — same supplier, same reference
 * number — and that lives in the database as a unique index, not here. This module handles the
 * cases where a human has to decide.
 *
 * Pure: no database, no clock. The caller supplies what it already knows.
 */
import {
  compareQuantity,
  fromThousandths,
  quantity,
  toThousandths,
  type Quantity,
} from '../stock/quantity';

export interface DuplicateRiskInput {
  readonly supplierId: string | null;
  readonly referenceNo: string | null;
  readonly deliveredOn: string;
  readonly itemIds: readonly string[];
  /** Deliveries already recorded for this store, recent enough to be relevant. */
  readonly existing: readonly {
    readonly supplierId: string | null;
    readonly referenceNo: string | null;
    readonly deliveredOn: string;
    readonly itemIds: readonly string[];
  }[];
  /** On-hand per item right now, for the overstock heuristic. */
  readonly onHandByItem: Readonly<Record<string, Quantity>>;
  /** What this delivery would add per item. */
  readonly incomingByItem: Readonly<Record<string, Quantity>>;
}

export interface DuplicateWarning {
  readonly code: 'same_reference' | 'same_item_same_day' | 'overstock';
  readonly message: string;
}

/**
 * ⭐ The self-scaling multiplier, kept from v1 and worth preserving verbatim.
 *
 * A delivery that **at least doubles** what is already on hand is suspicious *relative to that
 * item* — which is why it is a multiplier rather than an absolute quantity. A threshold of
 * "50 units" would scream on chopsticks and stay silent on beef.
 */
const OVERSTOCK_MULTIPLIER = 2;

export function duplicateRisk(input: DuplicateRiskInput): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = [];

  // 1. The same supplier and the same paper reference. ⚠️ The database refuses an exact match
  //    outright; this fires for the near-misses it cannot see — a different store, or a voided
  //    prior document that the unique index deliberately excludes.
  if (input.referenceNo && input.supplierId) {
    const match = input.existing.find(
      (e) => e.supplierId === input.supplierId && e.referenceNo === input.referenceNo,
    );
    if (match) {
      warnings.push({
        code: 'same_reference',
        message:
          `Reference "${input.referenceNo}" from this supplier was already recorded ` +
          `(${match.deliveredOn}). If this is the same paper, you are entering it twice.`,
      });
    }
  }

  // 2. The same item already recorded TODAY. The commonest real re-key: someone saves, the page
  //    looks unchanged, and they save again.
  const sameDay = input.existing.filter((e) => e.deliveredOn === input.deliveredOn);
  const repeated = input.itemIds.filter((id) => sameDay.some((e) => e.itemIds.includes(id)));
  if (repeated.length > 0) {
    warnings.push({
      code: 'same_item_same_day',
      message:
        // ⚠️ "recorded", not "received" — `existing` includes drafts and voided documents on
        // purpose (see `recentDeliveriesForRisk`), so a second draft of the same paper is warned
        // about before either is received.
        `${repeated.length} item(s) on this delivery were already recorded on a delivery dated ${input.deliveredOn} ` +
        `(drafts and voided ones included). A supplier splitting a load across two vans is normal; a second save of the same paper is not.`,
    });
  }

  // 3. This delivery at least doubles what is on hand.
  for (const [itemId, incoming] of Object.entries(input.incomingByItem)) {
    const onHand = input.onHandByItem[itemId];
    if (!onHand) continue;
    // ⚠️ Nothing on hand means nothing to compare against — a first delivery is not an overstock.
    if (compareQuantity(onHand, quantity('0')) <= 0) continue;

    const threshold = scale(onHand, OVERSTOCK_MULTIPLIER);
    if (compareQuantity(incoming, threshold) >= 0) {
      warnings.push({
        code: 'overstock',
        message:
          `This delivery adds ${incoming} against ${onHand} already on hand — at least ` +
          `${OVERSTOCK_MULTIPLIER}× the current stock. Expected before a long weekend; worth a ` +
          `second look otherwise.`,
      });
    }
  }

  return warnings;
}

/** Exact integer scaling — no float, so the threshold is reproducible. */
function scale(value: Quantity, factor: number): Quantity {
  return fromThousandths(toThousandths(value) * BigInt(factor));
}
