/**
 * Deliveries' SQL — T-168, extended by T-173.
 *
 * ⭐ **Why a commissary receipt writes a `deliveries` row at all**, when the order already records
 * everything: the branch's "what arrived today" surface is delivery-based, and it is the same
 * surface a manager checks against the crates on the floor. A commissary shipment that never
 * appears there is invisible to the one person positioned to notice it is wrong — which is v1's
 * situation and the reason the row exists.
 *
 * ⚠️ It carries **no posting of its own**. T-173's entry is the posting, and a second one would
 * double the branch's inventory. The row is a record, and the photo gate exempts it by kind
 * (`deliveries_proof_required_check`) precisely because it is system-generated: there is no paper
 * to photograph and the counterpart store's dispatch is the corroboration.
 */
import { eq } from 'drizzle-orm';
import { deliveries, deliveryLines, type ShortageReason } from '../../schema/deliveries';
import type { Tx } from '../client';

export interface DeliveryRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly supplierId: string | null;
}

/** ⭐ T-170 invariant 11: a return may not name a supplier the linked delivery did not come from. */
export async function getDelivery(tx: Tx, id: string): Promise<DeliveryRow | undefined> {
  const [row] = await tx
    .select({ id: deliveries.id, orgId: deliveries.orgId, storeId: deliveries.storeId, supplierId: deliveries.supplierId })
    .from(deliveries)
    .where(eq(deliveries.id, id));
  return row;
}

export interface DeliveryLineRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly itemId: string;
  readonly receivedQuantity: string | null;
}

/** ⭐ T-170 invariant 2: a return is capped at `received − already returned` for this line. */
export async function getDeliveryLine(tx: Tx, id: string): Promise<DeliveryLineRow | undefined> {
  const [row] = await tx
    .select({
      id: deliveryLines.id,
      deliveryId: deliveryLines.deliveryId,
      itemId: deliveryLines.itemId,
      receivedQuantity: deliveryLines.receivedQuantity,
    })
    .from(deliveryLines)
    .where(eq(deliveryLines.id, id));
  return row;
}

export interface CommissaryDeliveryLineInput {
  readonly lineNo: string;
  readonly itemId: string;
  /** What the commissary said it packed. */
  readonly orderedQuantity: string;
  /** What the branch signed for. May be short, and may be zero. */
  readonly receivedQuantity: string;
  readonly unit: string;
  /** The transfer rate. ⚠️ Already in the branch's base unit, so the factor is always 1. */
  readonly unitCost: string;
  readonly locationId: string;
  /**
   * ⚠️ Required by T-166's trigger whenever `received < ordered`, at ANY size. The 0.005 tolerance
   * that decides whether a MANAGER is asked to look does not reach here: the delivery line is a
   * faithful record of quantities, and a record that quietly rounded one would be worth less.
   */
  readonly shortageReason?: ShortageReason | null;
}

export interface CommissaryDeliveryInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly deliveredOn: string;
  /** The order this shipment came from — the branch's way back to the commissary's document. */
  readonly referenceNo: string;
  readonly receivedBy: string;
  readonly lines: readonly CommissaryDeliveryLineInput[];
}

/** The branch's own record of a commissary shipment. Posts nothing. */
export async function createCommissaryDelivery(
  tx: Tx,
  input: CommissaryDeliveryInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(deliveries)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      kind: 'commissary',
      referenceNo: input.referenceNo,
      deliveredOn: input.deliveredOn,
      status: 'received',
      receivedAt: new Date(),
      receivedBy: input.receivedBy,
      createdBy: input.receivedBy,
    })
    .returning({ id: deliveries.id });

  const delivery = row!;

  for (const line of input.lines) {
    await tx.insert(deliveryLines).values({
      deliveryId: delivery.id,
      lineNo: line.lineNo,
      itemId: line.itemId,
      orderedQuantity: line.orderedQuantity,
      receivedQuantity: line.receivedQuantity,
      purchaseUnit: line.unit,
      conversionFactor: '1',
      unitCost: line.unitCost,
      locationId: line.locationId,
      shortageReason: line.shortageReason ?? null,
    });
  }

  return delivery;
}
