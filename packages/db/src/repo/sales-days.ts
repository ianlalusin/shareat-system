/**
 * The only place SQL is written for sales days. docs/tasks/123-sales-day.md.
 *
 * ⭐ **`findOldestUnverifiedBefore` is the create-block's whole mechanism** (bible row 126) — see
 * its own comment for the three carve-outs that stop it deadlocking.
 *
 * ⛔ **No remittance functions here, deliberately.** A remittance references the days it covers
 * and is pooled across them (T-136, bible row 128); putting it on the day is exactly the v1 shape
 * that makes pooling impossible.
 */
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { salesChannels, salesDayChannels, salesDays } from '../../schema/sales-days';

export type SalesDayStatus = 'open' | 'submitted' | 'verified' | 'voided';

/** The statuses that mean "this day has not yet recognised its revenue". The create-block and
 *  every readiness check key off this ONE definition — v1 re-stated its equivalent in three
 *  separate readers with a note saying "keep them in sync if you add a 4th", which is exactly the
 *  drift this constant exists to prevent. */
export const UNVERIFIED_STATUSES = ['open', 'submitted'] as const;

export interface SalesDayRow {
  id: string;
  orgId: string;
  storeId: string;
  businessDate: string;
  status: SalesDayStatus;
  posSourced: boolean;
  posSourcedAt: Date | null;
  totalSales: string;
  unliSales: string;
  alaCarteSales: string;
  seniorDiscount: string;
  pwdDiscount: string;
  otherDiscount: string;
  comps: string;
  serviceCharge: string;
  otherCharges: string;
  cashCollected: string;
  onlineCollected: string;
  creditSales: string;
  journalEntryId: string | null;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: Date | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: salesDays.id,
  orgId: salesDays.orgId,
  storeId: salesDays.storeId,
  businessDate: salesDays.businessDate,
  status: salesDays.status,
  posSourced: salesDays.posSourced,
  posSourcedAt: salesDays.posSourcedAt,
  totalSales: salesDays.totalSales,
  unliSales: salesDays.unliSales,
  alaCarteSales: salesDays.alaCarteSales,
  seniorDiscount: salesDays.seniorDiscount,
  pwdDiscount: salesDays.pwdDiscount,
  otherDiscount: salesDays.otherDiscount,
  comps: salesDays.comps,
  serviceCharge: salesDays.serviceCharge,
  otherCharges: salesDays.otherCharges,
  cashCollected: salesDays.cashCollected,
  onlineCollected: salesDays.onlineCollected,
  creditSales: salesDays.creditSales,
  journalEntryId: salesDays.journalEntryId,
  createdBy: salesDays.createdBy,
  submittedBy: salesDays.submittedBy,
  submittedAt: salesDays.submittedAt,
  verifiedBy: salesDays.verifiedBy,
  verifiedAt: salesDays.verifiedAt,
  voidedBy: salesDays.voidedBy,
  voidedAt: salesDays.voidedAt,
  voidReason: salesDays.voidReason,
  createdAt: salesDays.createdAt,
} as const;

// -------------------------------------------------------------------------------------
// Channels — per-store configuration
// -------------------------------------------------------------------------------------

export interface SalesChannelRow {
  id: string;
  name: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  isActive: boolean;
}

export async function listChannels(tx: Tx, orgId: string, storeId: string): Promise<SalesChannelRow[]> {
  return tx
    .select({
      id: salesChannels.id,
      name: salesChannels.name,
      isRemittedDaily: salesChannels.isRemittedDaily,
      receivableAccountCode: salesChannels.receivableAccountCode,
      isActive: salesChannels.isActive,
    })
    .from(salesChannels)
    .where(and(eq(salesChannels.orgId, orgId), eq(salesChannels.storeId, storeId)))
    .orderBy(asc(salesChannels.name));
}

// -------------------------------------------------------------------------------------
// Sales days
// -------------------------------------------------------------------------------------

export interface InsertSalesDayInput {
  orgId: string;
  storeId: string;
  businessDate: string;
  posSourced: boolean;
  posSourcedAt: Date | null;
  totalSales: string;
  unliSales: string;
  alaCarteSales: string;
  seniorDiscount: string;
  pwdDiscount: string;
  otherDiscount: string;
  comps: string;
  serviceCharge: string;
  otherCharges: string;
  cashCollected: string;
  onlineCollected: string;
  creditSales: string;
  createdBy: string;
}

export async function insertSalesDay(tx: Tx, input: InsertSalesDayInput): Promise<{ id: string }> {
  const [row] = await tx.insert(salesDays).values(input).returning({ id: salesDays.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<SalesDayRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(salesDays)
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId)))
    .limit(1);
  return row;
}

export async function findByBusinessDate(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
): Promise<SalesDayRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        eq(salesDays.businessDate, businessDate),
      ),
    )
    .limit(1);
  return row;
}

/**
 * ⭐ **The create-block** (bible row 126, T-123 §4.2): the oldest day for this store, strictly
 * BEFORE `businessDate`, that has not yet been verified.
 *
 * ⚠️ **`lt` — strictly before — is load-bearing, and so is what this function does NOT do.**
 * v1's carve-outs are what stop the rule deadlocking, and every one of them falls out of calling
 * this only on the create path:
 *
 *   - **Editing an existing draft** never calls it (the row is already there).
 *   - **Backfilling an OLDER date** passes an earlier `businessDate`, so the blocking day is not
 *     `lt` it — you can always go back and fill the gap that caused the block.
 *   - **Starting a shift** is a different document entirely. The block is about RECOGNITION,
 *     never about trading.
 *
 * `voided` is excluded because a voided day is a decision, not an omission.
 */
export async function findOldestUnverifiedBefore(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
): Promise<{ id: string; businessDate: string; status: SalesDayStatus } | undefined> {
  const [row] = await tx
    .select({ id: salesDays.id, businessDate: salesDays.businessDate, status: salesDays.status })
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        lt(salesDays.businessDate, businessDate),
        inArray(salesDays.status, [...UNVERIFIED_STATUSES]),
      ),
    )
    .orderBy(asc(salesDays.businessDate))
    .limit(1);
  return row;
}

export interface ListSalesDaysInput {
  orgId: string;
  storeId?: string;
  status?: SalesDayStatus;
  limit?: number;
}

export async function listSalesDays(tx: Tx, input: ListSalesDaysInput): Promise<SalesDayRow[]> {
  const filters = [eq(salesDays.orgId, input.orgId)];
  if (input.storeId) filters.push(eq(salesDays.storeId, input.storeId));
  if (input.status) filters.push(eq(salesDays.status, input.status));
  return tx
    .select(COLUMNS)
    .from(salesDays)
    .where(and(...filters))
    .orderBy(desc(salesDays.businessDate))
    .limit(input.limit ?? 100);
}

export interface UpdateDraftInput {
  posSourced?: boolean;
  posSourcedAt?: Date | null;
  totalSales?: string;
  unliSales?: string;
  alaCarteSales?: string;
  seniorDiscount?: string;
  pwdDiscount?: string;
  otherDiscount?: string;
  comps?: string;
  serviceCharge?: string;
  otherCharges?: string;
  cashCollected?: string;
  onlineCollected?: string;
  creditSales?: string;
}

/**
 * Header edits on an OPEN or SUBMITTED day only. The status predicate is repeated in the WHERE
 * clause on purpose — a concurrent verify() between the caller's read and this write must not
 * silently rewrite the figures a journal entry was posted from. Zero rows affected throws, because
 * an update that changed nothing is indistinguishable from success.
 */
export async function updateDraft(tx: Tx, orgId: string, id: string, patch: UpdateDraftInput): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const updated = await tx
    .update(salesDays)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(
      and(
        eq(salesDays.id, id),
        eq(salesDays.orgId, orgId),
        inArray(salesDays.status, [...UNVERIFIED_STATUSES]),
      ),
    )
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    throw new Error(`updateDraft: sales day ${id} does not exist in org ${orgId}, or is not open/submitted`);
  }
}

export async function markSubmitted(tx: Tx, orgId: string, id: string, submittedBy: string): Promise<void> {
  const updated = await tx
    .update(salesDays)
    .set({ status: 'submitted', submittedBy, submittedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId), eq(salesDays.status, 'open')))
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    throw new Error(`markSubmitted: sales day ${id} does not exist in org ${orgId}, or is not open`);
  }
}

export async function markVerified(
  tx: Tx,
  orgId: string,
  id: string,
  input: { verifiedBy: string; journalEntryId: string },
): Promise<void> {
  const updated = await tx
    .update(salesDays)
    .set({
      status: 'verified',
      verifiedBy: input.verifiedBy,
      verifiedAt: sql`now()`,
      journalEntryId: input.journalEntryId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(salesDays.id, id),
        eq(salesDays.orgId, orgId),
        inArray(salesDays.status, [...UNVERIFIED_STATUSES]),
      ),
    )
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    throw new Error(`markVerified: sales day ${id} does not exist in org ${orgId}, or is already verified/voided`);
  }
}

export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(salesDays)
    .set({ status: 'voided', voidedBy: input.voidedBy, voidedAt: sql`now()`, voidReason: input.voidReason, updatedAt: sql`now()` })
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId), eq(salesDays.status, 'verified')))
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    throw new Error(`markVoided: sales day ${id} does not exist in org ${orgId}, or is not verified`);
  }
}

// -------------------------------------------------------------------------------------
// The channel split
// -------------------------------------------------------------------------------------

export interface SalesDayChannelRow {
  id: string;
  channelId: string;
  channelName: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  amount: string;
  noSales: boolean;
}

/**
 * ⭐ Joined to the channel's own configuration, so `isRemittedDaily` is read from the ONE place it
 * is defined. That is what lets the remitted / non-remitted totals be derived rather than stored,
 * and it is why v1's stored non-remitted-total field has no counterpart here — on a v1 day
 * document that field silently held a copy of the day's own total (docs/GLOSSARY.md).
 */
export async function getChannelsForDay(tx: Tx, salesDayId: string): Promise<SalesDayChannelRow[]> {
  return tx
    .select({
      id: salesDayChannels.id,
      channelId: salesDayChannels.channelId,
      channelName: salesChannels.name,
      isRemittedDaily: salesChannels.isRemittedDaily,
      receivableAccountCode: salesChannels.receivableAccountCode,
      amount: salesDayChannels.amount,
      noSales: salesDayChannels.noSales,
    })
    .from(salesDayChannels)
    .innerJoin(salesChannels, eq(salesChannels.id, salesDayChannels.channelId))
    .where(eq(salesDayChannels.salesDayId, salesDayId))
    .orderBy(asc(salesChannels.name));
}

export interface InsertChannelInput {
  channelId: string;
  amount: string;
  noSales: boolean;
}

export async function replaceChannels(tx: Tx, salesDayId: string, rows: InsertChannelInput[]): Promise<void> {
  await tx.delete(salesDayChannels).where(eq(salesDayChannels.salesDayId, salesDayId));
  if (rows.length === 0) return;
  await tx.insert(salesDayChannels).values(rows.map((r) => ({ salesDayId, ...r })));
}
