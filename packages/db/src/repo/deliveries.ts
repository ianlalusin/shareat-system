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
import { and, asc, desc, eq, sql } from 'drizzle-orm';
// ⛔ T-218 — Manila, never bare current_date (DEF-172).
import { MANILA_TODAY } from './sql-time';
import {
  deliveries,
  deliveryLines,
  type DeliveryKind,
  type DeliveryStatus,
  type ShortageReason,
} from '../../schema/deliveries';
import { items } from '../../schema/items';
import {
  stockLocations,
  type LocationPurpose,
  type LocationRole,
  type LocationStatus,
} from '../../schema/stock-locations';
import { suppliers } from '../../schema/suppliers';
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

// -------------------------------------------------------------------------------------
// T-166 / DEF-135 — the document itself: draft a supplier delivery or a cash purchase,
// add its lines, receive it. Extends this file rather than forking it — `getDelivery`,
// `getDeliveryLine` and `createCommissaryDelivery` above are T-170/T-173's own callers and
// stay untouched.
// -------------------------------------------------------------------------------------

export interface InsertDeliveryInput {
  readonly orgId: string;
  readonly storeId: string;
  /** ⚠️ Never 'commissary' here — `createDeliveryDocument` refuses it before this is called;
   *  only `createCommissaryDelivery` above writes that kind. */
  readonly kind: DeliveryKind;
  readonly supplierId: string | null;
  readonly referenceNo: string | null;
  readonly deliveredOn: string;
  readonly proofFileId: string | null;
  readonly createdBy: string;
}

export async function insertDelivery(tx: Tx, input: InsertDeliveryInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(deliveries)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      kind: input.kind,
      supplierId: input.supplierId,
      referenceNo: input.referenceNo,
      deliveredOn: input.deliveredOn,
      proofFileId: input.proofFileId,
      createdBy: input.createdBy,
    })
    .returning({ id: deliveries.id });
  return row!;
}

export interface InsertDeliveryLineInput {
  readonly lineNo: string;
  readonly itemId: string;
  readonly orderedQuantity: string;
  readonly purchaseUnit: string;
  readonly conversionFactor: string;
  readonly unitCost: string;
  /** `null` — the create-time draft, same as receive time: park in Receiving, never guess. */
  readonly locationId: string | null;
}

export async function insertDeliveryLines(
  tx: Tx,
  deliveryId: string,
  lines: readonly InsertDeliveryLineInput[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(deliveryLines).values(
    lines.map((l) => ({
      deliveryId,
      lineNo: l.lineNo,
      itemId: l.itemId,
      orderedQuantity: l.orderedQuantity,
      purchaseUnit: l.purchaseUnit,
      conversionFactor: l.conversionFactor,
      unitCost: l.unitCost,
      locationId: l.locationId,
    })),
  );
}

export interface DeliveryDocumentLine {
  readonly id: string;
  readonly lineNo: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly itemKind: string;
  readonly baseUnit: string;
  readonly orderedQuantity: string;
  readonly receivedQuantity: string | null;
  readonly purchaseUnit: string;
  readonly conversionFactor: string;
  readonly unitCost: string;
  readonly locationId: string | null;
  readonly shortageReason: ShortageReason | null;
  readonly overReceiptAllowed: boolean;
}

export interface DeliveryDocument {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly kind: DeliveryKind;
  readonly supplierId: string | null;
  readonly supplierName: string | null;
  readonly referenceNo: string | null;
  readonly deliveredOn: string;
  readonly status: DeliveryStatus;
  readonly proofFileId: string | null;
  readonly receivedAt: Date | null;
  readonly receivedBy: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lines: readonly DeliveryDocumentLine[];
}

/** Header + lines, joined out to what a screen (and `receiveDeliveryDocument`) needs to show or
 *  act on — item code/name/kind/base unit, supplier name. */
export async function getDeliveryDocument(tx: Tx, id: string): Promise<DeliveryDocument | undefined> {
  const [header] = await tx
    .select({
      id: deliveries.id,
      orgId: deliveries.orgId,
      storeId: deliveries.storeId,
      kind: deliveries.kind,
      supplierId: deliveries.supplierId,
      supplierName: suppliers.name,
      referenceNo: deliveries.referenceNo,
      deliveredOn: deliveries.deliveredOn,
      status: deliveries.status,
      proofFileId: deliveries.proofFileId,
      receivedAt: deliveries.receivedAt,
      receivedBy: deliveries.receivedBy,
      voidedAt: deliveries.voidedAt,
      voidReason: deliveries.voidReason,
      createdBy: deliveries.createdBy,
      createdAt: deliveries.createdAt,
    })
    .from(deliveries)
    .leftJoin(suppliers, eq(suppliers.id, deliveries.supplierId))
    .where(eq(deliveries.id, id));
  if (!header) return undefined;

  const lines = await tx
    .select({
      id: deliveryLines.id,
      lineNo: deliveryLines.lineNo,
      itemId: deliveryLines.itemId,
      itemCode: items.code,
      itemName: items.name,
      itemKind: items.kind,
      baseUnit: items.baseUnit,
      orderedQuantity: deliveryLines.orderedQuantity,
      receivedQuantity: deliveryLines.receivedQuantity,
      purchaseUnit: deliveryLines.purchaseUnit,
      conversionFactor: deliveryLines.conversionFactor,
      unitCost: deliveryLines.unitCost,
      locationId: deliveryLines.locationId,
      shortageReason: deliveryLines.shortageReason,
      overReceiptAllowed: deliveryLines.overReceiptAllowed,
    })
    .from(deliveryLines)
    .innerJoin(items, eq(items.id, deliveryLines.itemId))
    .where(eq(deliveryLines.deliveryId, id))
    .orderBy(asc(deliveryLines.lineNo));

  return { ...header, lines };
}

export interface DeliveryListRow {
  readonly id: string;
  readonly kind: DeliveryKind;
  readonly supplierName: string | null;
  readonly referenceNo: string | null;
  readonly deliveredOn: string;
  readonly status: DeliveryStatus;
  readonly lineCount: number;
  readonly total: string;
}

/** Newest first. `total` is Σ ordered×unitCost while draft, Σ received×unitCost once received —
 *  a draft has no received quantity yet, so the two can never both apply to one row. */
export async function listDeliveries(tx: Tx, storeId: string): Promise<DeliveryListRow[]> {
  return tx
    .select({
      id: deliveries.id,
      kind: deliveries.kind,
      supplierName: suppliers.name,
      referenceNo: deliveries.referenceNo,
      deliveredOn: deliveries.deliveredOn,
      status: deliveries.status,
      lineCount: sql<number>`count(${deliveryLines.id})::int`,
      total: sql<string>`coalesce(sum(
        case when ${deliveries.status} = 'received'
          then coalesce(${deliveryLines.receivedQuantity}, 0) * ${deliveryLines.unitCost}
          else ${deliveryLines.orderedQuantity} * ${deliveryLines.unitCost}
        end
      ), 0)::text`,
    })
    .from(deliveries)
    .leftJoin(suppliers, eq(suppliers.id, deliveries.supplierId))
    .leftJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
    .where(eq(deliveries.storeId, storeId))
    .groupBy(deliveries.id, suppliers.name)
    .orderBy(desc(deliveries.createdAt));
}

export interface UpdateLineReceiptInput {
  readonly receivedQuantity: string;
  readonly shortageReason: ShortageReason | null;
  readonly overReceiptAllowed: boolean;
  readonly locationId: string | null;
}

export async function updateLineReceipt(tx: Tx, lineId: string, input: UpdateLineReceiptInput): Promise<void> {
  await tx
    .update(deliveryLines)
    .set({
      receivedQuantity: input.receivedQuantity,
      shortageReason: input.shortageReason,
      overReceiptAllowed: input.overReceiptAllowed,
      locationId: input.locationId,
    })
    .where(eq(deliveryLines.id, lineId));
}

/** ⚠️ Written BEFORE the per-line receipt fields, on purpose — `delivery_lines_shortage_explained_trg`
 *  (migration 0066) reads the delivery's CURRENT status, so a line update written while the header is
 *  still `draft` would fire the trigger against the wrong status and validate nothing at all. */
export async function markReceived(
  tx: Tx,
  id: string,
  input: { receivedBy: string; receivedAt: Date },
): Promise<void> {
  await tx
    .update(deliveries)
    .set({ status: 'received', receivedAt: input.receivedAt, receivedBy: input.receivedBy })
    .where(eq(deliveries.id, id));
}

/** Structurally a `LocationLike` (`packages/domain/src/stock-locations/rules.ts`) — kept as a
 *  same-shaped local type rather than importing the domain's type into the repo layer. */
export interface DeliveryLocationRow {
  readonly id: string;
  readonly role: LocationRole;
  readonly purpose: LocationPurpose;
  readonly isDefault: boolean;
  readonly status: LocationStatus;
}

export async function listLocationsLike(tx: Tx, storeId: string): Promise<DeliveryLocationRow[]> {
  return tx
    .select({
      id: stockLocations.id,
      role: stockLocations.role,
      purpose: stockLocations.purpose,
      isDefault: stockLocations.isDefault,
      status: stockLocations.status,
    })
    .from(stockLocations)
    .where(eq(stockLocations.storeId, storeId));
}

export interface RecentDeliveryForRisk {
  readonly supplierId: string | null;
  readonly referenceNo: string | null;
  readonly deliveredOn: string;
  readonly itemIds: readonly string[];
}

/**
 * Deliveries at this store from the last `days` days — what `duplicateRisk` compares a new draft
 * against.
 *
 * ⚠️ **Deliberately INCLUDES voided rows**, though the task text for this function reads
 * "(non-void)". Found while writing this file's own closing test: `duplicateRisk`'s `same_reference`
 * warning fires only when an EXISTING entry matches the new draft's (supplier, reference) — but
 * the hard unique index (`deliveries_supplier_reference_key`) already refuses any two NON-void
 * deliveries sharing those two values, org-wide, with no day window at all. So a non-void match
 * would always hit the index first and throw before the warning is ever computed — the warning
 * branch would be dead code. `duplicate-risk.ts`'s own header names the one case where it is NOT
 * dead: *"a voided prior document that the unique index deliberately excludes."* Excluding void
 * rows here would remove the only real path to that warning. Reported per bible §3.4a rather than
 * silently kept "(non-void)" and left unreachable.
 */
export async function recentDeliveriesForRisk(
  tx: Tx,
  storeId: string,
  days: number,
): Promise<RecentDeliveryForRisk[]> {
  const rows = await tx
    .select({
      id: deliveries.id,
      supplierId: deliveries.supplierId,
      referenceNo: deliveries.referenceNo,
      deliveredOn: deliveries.deliveredOn,
      itemId: deliveryLines.itemId,
    })
    .from(deliveries)
    .innerJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
    .where(
      and(
        eq(deliveries.storeId, storeId),
        sql`${deliveries.deliveredOn} >= (${MANILA_TODAY} - make_interval(days => ${days}))`,
      ),
    );

  const byDelivery = new Map<string, { supplierId: string | null; referenceNo: string | null; deliveredOn: string; itemIds: string[] }>();
  for (const r of rows) {
    const existing = byDelivery.get(r.id);
    if (existing) {
      existing.itemIds.push(r.itemId);
    } else {
      byDelivery.set(r.id, { supplierId: r.supplierId, referenceNo: r.referenceNo, deliveredOn: r.deliveredOn, itemIds: [r.itemId] });
    }
  }
  return [...byDelivery.values()];
}
