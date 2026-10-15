/**
 * T-168 / DEF-135 — SQL for `stock_usage_records` / `stock_usage_lines`, plus the two small reads
 * the usage screen needs from tables another lane owns (`stock_locations`, `departments`) — kept
 * HERE rather than in `packages/db/src/repo/stock-locations.ts` because that file is T-160's, and
 * a read this file needs is not a reason to edit someone else's in-flight file.
 *
 * ⭐ The domain module (`packages/domain/src/stock/usage-records.ts`) owns the rules; this file only
 * reads rows and writes what the domain decided (bible §4.3).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { stockUsageLines, stockUsageRecords, type UsageKind, type UsageStatus } from '../../schema/stock-usage';
import { departments, stockLocations } from '../../schema/stock-locations';
import { items } from '../../schema/items';
import { organizations } from '../../schema/organizations';
import { persons } from '../../schema/persons';
import { posUsagePullLines, posUsagePulls } from '../../schema/pos-mapping';
import { salesDays } from '../../schema/sales-days';
import type { Tx } from '../client';
import type { Decimal, Quantity } from '@shareat/core/money';

export interface UsageRecordRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly kind: UsageKind;
  readonly status: UsageStatus;
  /** YYYY-MM-DD. */
  readonly usedOn: string;
  readonly departmentId: string | null;
  readonly reasonCode: string | null;
  readonly adjustmentReason: string | null;
  readonly chargePersonId: string | null;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
  readonly voidedAt: Date | null;
  readonly voidedBy: string | null;
  readonly voidReason: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface InsertUsageRecordInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly kind: UsageKind;
  /** YYYY-MM-DD. */
  readonly usedOn: string;
  readonly departmentId?: string | null;
  readonly reasonCode?: string | null;
  readonly adjustmentReason?: string | null;
  readonly createdBy: string;
}

/**
 * ⚠️ Header only — no lines. `insertUsageLines` is the separate call, so a caller building a draft
 * line-by-line (`addUsageLine`) never has to re-supply the header.
 *
 * A storage/Receiving room, or an inactive one, throws here — `stock_usage_operating_location_trg`
 * (migration 0067) is the control (bible row 104: do not re-implement a DB-enforced rule). The
 * throw is unhandled by design; the caller's caller (`apps/erp/.../actions.ts`) translates it.
 */
export async function insertUsageRecord(tx: Tx, input: InsertUsageRecordInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(stockUsageRecords)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      kind: input.kind,
      usedOn: input.usedOn,
      departmentId: input.departmentId ?? null,
      reasonCode: input.reasonCode ?? null,
      adjustmentReason: input.adjustmentReason ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: stockUsageRecords.id });
  return row!;
}

export interface InsertUsageLineInput {
  readonly lineNo: string;
  readonly itemId: string;
  /** Decimal string. SIGNED only for `kind='adjustment'`, which this pass never writes. */
  readonly quantity: Quantity;
}

export async function insertUsageLines(
  tx: Tx,
  recordId: string,
  lines: readonly InsertUsageLineInput[],
): Promise<{ id: string }[]> {
  if (lines.length === 0) return [];
  return tx
    .insert(stockUsageLines)
    .values(lines.map((l) => ({ recordId, lineNo: l.lineNo, itemId: l.itemId, quantity: l.quantity })))
    .returning({ id: stockUsageLines.id });
}

export async function getUsageRecord(tx: Tx, id: string): Promise<UsageRecordRow | undefined> {
  const [row] = await tx
    .select({
      id: stockUsageRecords.id,
      orgId: stockUsageRecords.orgId,
      storeId: stockUsageRecords.storeId,
      locationId: stockUsageRecords.locationId,
      kind: stockUsageRecords.kind,
      status: stockUsageRecords.status,
      usedOn: stockUsageRecords.usedOn,
      departmentId: stockUsageRecords.departmentId,
      reasonCode: stockUsageRecords.reasonCode,
      adjustmentReason: stockUsageRecords.adjustmentReason,
      chargePersonId: stockUsageRecords.chargePersonId,
      postedAt: stockUsageRecords.postedAt,
      postedBy: stockUsageRecords.postedBy,
      voidedAt: stockUsageRecords.voidedAt,
      voidedBy: stockUsageRecords.voidedBy,
      voidReason: stockUsageRecords.voidReason,
      createdBy: stockUsageRecords.createdBy,
      createdAt: stockUsageRecords.createdAt,
    })
    .from(stockUsageRecords)
    .where(eq(stockUsageRecords.id, id));
  return row as UsageRecordRow | undefined;
}

export interface UsageRecordListRow {
  readonly id: string;
  readonly kind: UsageKind;
  readonly status: UsageStatus;
  readonly usedOn: string;
  readonly locationName: string;
  readonly reasonCode: string | null;
  readonly lineCount: number;
}

/** Newest first, per store. Two queries rather than one join-and-group — a record with zero lines
 *  (never happens in practice, but nothing here assumes it cannot) still has to appear once. */
export async function listUsageRecords(tx: Tx, storeId: string): Promise<UsageRecordListRow[]> {
  const rows = await tx
    .select({
      id: stockUsageRecords.id,
      kind: stockUsageRecords.kind,
      status: stockUsageRecords.status,
      usedOn: stockUsageRecords.usedOn,
      locationName: stockLocations.name,
      reasonCode: stockUsageRecords.reasonCode,
      createdAt: stockUsageRecords.createdAt,
    })
    .from(stockUsageRecords)
    .innerJoin(stockLocations, eq(stockLocations.id, stockUsageRecords.locationId))
    .where(eq(stockUsageRecords.storeId, storeId))
    .orderBy(desc(stockUsageRecords.createdAt));

  if (rows.length === 0) return [];

  const counts = await tx
    .select({ recordId: stockUsageLines.recordId, n: sql<number>`count(*)::int` })
    .from(stockUsageLines)
    .where(
      inArray(
        stockUsageLines.recordId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(stockUsageLines.recordId);
  const countByRecord = new Map(counts.map((c) => [c.recordId, c.n]));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    usedOn: r.usedOn,
    locationName: r.locationName,
    reasonCode: r.reasonCode,
    lineCount: countByRecord.get(r.id) ?? 0,
  }));
}

export interface UsageLineRow {
  readonly id: string;
  readonly recordId: string;
  readonly lineNo: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly itemKind: string;
  readonly baseUnit: string;
  readonly quantity: string;
  readonly movementId: string | null;
}

export async function listUsageLines(tx: Tx, recordId: string): Promise<UsageLineRow[]> {
  return tx
    .select({
      id: stockUsageLines.id,
      recordId: stockUsageLines.recordId,
      lineNo: stockUsageLines.lineNo,
      itemId: stockUsageLines.itemId,
      itemCode: items.code,
      itemName: items.name,
      itemKind: items.kind,
      baseUnit: items.baseUnit,
      quantity: stockUsageLines.quantity,
      movementId: stockUsageLines.movementId,
    })
    .from(stockUsageLines)
    .innerJoin(items, eq(items.id, stockUsageLines.itemId))
    .where(eq(stockUsageLines.recordId, recordId))
    .orderBy(asc(stockUsageLines.lineNo));
}

export async function deleteUsageLine(tx: Tx, lineId: string): Promise<void> {
  await tx.delete(stockUsageLines).where(eq(stockUsageLines.id, lineId));
}

/** The whole draft, header and lines together — the FK cascade takes the lines. Callers check the
 *  record is still `draft` BEFORE calling this; the repo enforces no business rule (bible §4.3). */
export async function deleteUsageDraft(tx: Tx, id: string): Promise<void> {
  await tx.delete(stockUsageRecords).where(eq(stockUsageRecords.id, id));
}

export async function setUsageLineMovement(tx: Tx, lineId: string, movementId: string): Promise<void> {
  await tx.update(stockUsageLines).set({ movementId }).where(eq(stockUsageLines.id, lineId));
}

export async function markUsagePosted(tx: Tx, id: string, postedBy: string): Promise<void> {
  await tx
    .update(stockUsageRecords)
    .set({ status: 'posted', postedAt: new Date(), postedBy })
    .where(eq(stockUsageRecords.id, id));
}

export async function markUsageVoid(tx: Tx, id: string, voidedBy: string, voidReason: string): Promise<void> {
  await tx
    .update(stockUsageRecords)
    .set({ status: 'void', voidedAt: new Date(), voidedBy, voidReason })
    .where(eq(stockUsageRecords.id, id));
}

export interface LocationOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** ⭐ Only the rooms a usage may legally be drawn from — role `operating`, purpose `normal`,
 *  `active`. Offering only these client-side means a real cook almost never meets the DB trigger
 *  that also enforces this; the trigger is still the control (T-160/T-168's split). */
export async function listOperatingLocations(tx: Tx, storeId: string): Promise<LocationOption[]> {
  return tx
    .select({ id: stockLocations.id, code: stockLocations.code, name: stockLocations.name })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.storeId, storeId),
        eq(stockLocations.role, 'operating'),
        eq(stockLocations.purpose, 'normal'),
        eq(stockLocations.status, 'active'),
      ),
    )
    .orderBy(asc(stockLocations.name));
}

export interface DepartmentOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export async function listDepartments(tx: Tx, orgId: string): Promise<DepartmentOption[]> {
  return tx
    .select({ id: departments.id, code: departments.code, name: departments.name })
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.status, 'active')))
    .orderBy(asc(departments.name));
}

/** ⭐ bible §4.3 layering fix (2026-09-03). The usage detail screen's room label — one more small
 *  `stock_locations` read that belongs here for the same reason `listOperatingLocations` does (this
 *  file's header): a read this screen needs is not a reason to edit T-160's in-flight file. */
export async function locationName(tx: Tx, locationId: string): Promise<string> {
  const [row] = await tx
    .select({ name: stockLocations.name })
    .from(stockLocations)
    .where(eq(stockLocations.id, locationId));
  return row?.name ?? 'Unknown room';
}

// -----------------------------------------------------------------------------------------
// T-401 S6 - the usage tolerance band: what was expected, what was recorded, the band, and the store's draft queue
// -----------------------------------------------------------------------------------------

/**
 * ACTUAL for one (store, day): per item, the sum of that day's `usage` records that are draft or posted (never void; wastage,
 * adjustment and opening are not compared). The sum is `numeric` in SQL and comes back as text, so no float ever touches it.
 */
export async function usageActualsForDay(tx: Tx, storeId: string, usedOn: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ itemId: stockUsageLines.itemId, total: sql<string>`sum(${stockUsageLines.quantity})::text` })
    .from(stockUsageLines)
    .innerJoin(stockUsageRecords, eq(stockUsageRecords.id, stockUsageLines.recordId))
    .where(
      and(
        eq(stockUsageRecords.storeId, storeId),
        eq(stockUsageRecords.usedOn, usedOn),
        eq(stockUsageRecords.kind, 'usage'),
        inArray(stockUsageRecords.status, ['draft', 'posted']),
      ),
    )
    .groupBy(stockUsageLines.itemId);
  return new Map(rows.map((r) => [r.itemId, r.total]));
}

/**
 * EXPECTED for one (store, business date) from the stored plan: per item, the sum of the live (non-void) pull's direct and
 * recipe lines that are not blocked. It is the plan, not what a pull posted, so it survives the pull being finalized.
 */
export async function expectedFromPullForDay(tx: Tx, storeId: string, businessDate: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ itemId: posUsagePullLines.itemId, total: sql<string>`sum(${posUsagePullLines.quantity})::text` })
    .from(posUsagePullLines)
    .innerJoin(posUsagePulls, eq(posUsagePulls.id, posUsagePullLines.pullId))
    .innerJoin(salesDays, eq(salesDays.id, posUsagePulls.salesDayId))
    .where(
      and(
        eq(posUsagePulls.storeId, storeId),
        eq(salesDays.businessDate, businessDate),
        sql`${posUsagePulls.status} <> 'void'`,
        inArray(posUsagePullLines.section, ['direct', 'recipe']),
        sql`${posUsagePullLines.itemId} is not null`,
        sql`${posUsagePullLines.quantity} is not null`,
        sql`${posUsagePullLines.blocked} is null`,
      ),
    )
    .groupBy(posUsagePullLines.itemId);
  return new Map(rows.filter((r) => r.itemId !== null).map((r) => [r.itemId as string, r.total]));
}

/** The org's tolerance and each named item's override (`null` = none), as stored text (e.g. `0.1000`). */
export async function usageTolerancesFor(
  tx: Tx,
  orgId: string,
  itemIds: readonly string[],
): Promise<{ org: string; byItem: Map<string, string | null> }> {
  const [org] = await tx.select({ t: organizations.usageTolerance }).from(organizations).where(eq(organizations.id, orgId));
  const rows =
    itemIds.length === 0
      ? []
      : await tx
          .select({ id: items.id, t: items.usageTolerance })
          .from(items)
          .where(and(eq(items.orgId, orgId), inArray(items.id, [...itemIds])));
  return { org: org?.t ?? '0.1000', byItem: new Map(rows.map((r) => [r.id, r.t])) };
}

/** Sets the org tolerance (text, already validated by the domain) and returns the value it replaced. */
export async function setOrgUsageTolerance(tx: Tx, orgId: string, tolerance: Decimal<'5,4'>): Promise<{ previous: string } | undefined> {
  const [before] = await tx.select({ t: organizations.usageTolerance }).from(organizations).where(eq(organizations.id, orgId)).for('update');
  if (!before) return undefined;
  await tx.update(organizations).set({ usageTolerance: tolerance, updatedAt: new Date() }).where(eq(organizations.id, orgId));
  return { previous: before.t };
}

/** Sets (text) or clears (`null`) one item's override; returns the value it replaced, or undefined when the item is not this org's. */
export async function setItemUsageTolerance(
  tx: Tx,
  orgId: string,
  itemId: string,
  tolerance: Decimal<'5,4'> | null,
): Promise<{ previous: string | null; name: string } | undefined> {
  const [before] = await tx
    .select({ t: items.usageTolerance, name: items.name })
    .from(items)
    .where(and(eq(items.orgId, orgId), eq(items.id, itemId)))
    .for('update');
  if (!before) return undefined;
  await tx.update(items).set({ usageTolerance: tolerance, updatedAt: new Date() }).where(and(eq(items.orgId, orgId), eq(items.id, itemId)));
  return { previous: before.t, name: before.name };
}

export interface StoreUsageQueueRow {
  readonly id: string;
  readonly kind: UsageKind;
  readonly status: UsageStatus;
  readonly usedOn: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly reasonCode: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly lines: readonly { readonly itemId: string; readonly itemName: string; readonly unit: string; readonly quantity: string }[];
}

/** The store's usage drafts waiting for a manager, oldest first, each with who recorded it and its lines. Not filtered to any one author. */
export async function listStoreUsageQueue(tx: Tx, storeId: string): Promise<StoreUsageQueueRow[]> {
  const rows = await tx
    .select({
      id: stockUsageRecords.id,
      kind: stockUsageRecords.kind,
      status: stockUsageRecords.status,
      usedOn: stockUsageRecords.usedOn,
      locationId: stockUsageRecords.locationId,
      locationName: stockLocations.name,
      reasonCode: stockUsageRecords.reasonCode,
      createdAt: stockUsageRecords.createdAt,
      createdBy: stockUsageRecords.createdBy,
      createdByName: persons.displayName,
    })
    .from(stockUsageRecords)
    .innerJoin(stockLocations, eq(stockLocations.id, stockUsageRecords.locationId))
    .innerJoin(persons, eq(persons.id, stockUsageRecords.createdBy))
    .where(and(eq(stockUsageRecords.storeId, storeId), eq(stockUsageRecords.status, 'draft')))
    .orderBy(asc(stockUsageRecords.createdAt), asc(stockUsageRecords.id));
  if (rows.length === 0) return [];
  const lines = await tx
    .select({
      recordId: stockUsageLines.recordId,
      lineNo: stockUsageLines.lineNo,
      itemId: stockUsageLines.itemId,
      itemName: items.name,
      unit: items.baseUnit,
      quantity: stockUsageLines.quantity,
    })
    .from(stockUsageLines)
    .innerJoin(items, eq(items.id, stockUsageLines.itemId))
    .where(inArray(stockUsageLines.recordId, rows.map((r) => r.id)))
    .orderBy(asc(stockUsageLines.recordId), asc(stockUsageLines.lineNo));
  const byRecord = new Map<string, StoreUsageQueueRow['lines'][number][]>();
  for (const l of lines) {
    const list = byRecord.get(l.recordId) ?? [];
    list.push({ itemId: l.itemId, itemName: l.itemName, unit: l.unit, quantity: l.quantity });
    byRecord.set(l.recordId, list);
  }
  return rows.map((r) => ({ ...r, lines: byRecord.get(r.id) ?? [] }));
}
