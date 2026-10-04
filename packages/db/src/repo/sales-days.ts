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
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { refuse } from '../refusal';
import { recordGone } from './record-gone';
import {
  salesChannels,
  salesDayChannels,
  salesDayTenders,
  salesDays,
} from '../../schema/sales-days';
import { moneyAccounts } from '../../schema/money-accounts';
import type { Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';

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
  /** ⭐ T-230, bible §13 row 180 — the channel's wastage policy. */
  wastageTypeMode: 'tracked' | 'instant';
  destinationMoneyAccountId: string | null;
  taxTreatment: string;
}

/**
 * Every channel configured for this store.
 *
 * ⚠️ **`activeOnly` defaults to FALSE, and that default is load-bearing.** `writeChannels`
 * (`domain/sales-days/create.ts`) validates a submitted channel against this list, and EDITING an
 * old sales day that names a since-retired channel has to keep working. A PICKER offering a new
 * choice passes `activeOnly: true`; a validator does not. T-230 shipped the first writer
 * `is_active` has ever had, so before it the distinction could not bite.
 */
export async function listChannels(
  tx: Tx,
  orgId: string,
  storeId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<SalesChannelRow[]> {
  const where = opts.activeOnly
    ? and(eq(salesChannels.orgId, orgId), eq(salesChannels.storeId, storeId), eq(salesChannels.isActive, true))
    : and(eq(salesChannels.orgId, orgId), eq(salesChannels.storeId, storeId));
  return tx
    .select({
      id: salesChannels.id,
      name: salesChannels.name,
      isRemittedDaily: salesChannels.isRemittedDaily,
      receivableAccountCode: salesChannels.receivableAccountCode,
      isActive: salesChannels.isActive,
      wastageTypeMode: salesChannels.wastageTypeMode,
      destinationMoneyAccountId: salesChannels.destinationMoneyAccountId,
      taxTreatment: salesChannels.taxTreatment,
    })
    .from(salesChannels)
    .where(where)
    .orderBy(asc(salesChannels.name));
}

// -------------------------------------------------------------------------------------
// Channel writes — T-230 (DEF-207). ⛔ No business rule lives here: eligibility of an account,
// who may write, and what a missing remittance flag means are all
// `packages/domain/src/sales-channels/index.ts`'s call.
// -------------------------------------------------------------------------------------

export interface InsertSalesChannelInput {
  orgId: string;
  storeId: string;
  name: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  wastageTypeMode: 'tracked' | 'instant';
}

export async function insertChannel(tx: Tx, input: InsertSalesChannelInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(salesChannels)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      name: input.name,
      isRemittedDaily: input.isRemittedDaily,
      receivableAccountCode: input.receivableAccountCode,
      wastageTypeMode: input.wastageTypeMode,
    })
    .returning({ id: salesChannels.id });
  return row!;
}

/** One channel, by id, scoped to the org. `storeId` comes back so the domain can gate on the
 *  channel's OWN store rather than one the caller supplied. */
export async function channelById(tx: Tx, orgId: string, channelId: string): Promise<(SalesChannelRow & { storeId: string }) | null> {
  const [row] = await tx
    .select({
      id: salesChannels.id,
      storeId: salesChannels.storeId,
      name: salesChannels.name,
      isRemittedDaily: salesChannels.isRemittedDaily,
      receivableAccountCode: salesChannels.receivableAccountCode,
      isActive: salesChannels.isActive,
      wastageTypeMode: salesChannels.wastageTypeMode,
      destinationMoneyAccountId: salesChannels.destinationMoneyAccountId,
      taxTreatment: salesChannels.taxTreatment,
    })
    .from(salesChannels)
    .where(and(eq(salesChannels.orgId, orgId), eq(salesChannels.id, channelId)))
    .limit(1);
  return row ?? null;
}

/**
 * The name-collision pre-read, normalised the same way the unique index is.
 * ⚠️ It exists ONLY to word the refusal — the index is the authority, and a caller that skips this
 * (or races another transaction) is still refused by the database.
 */
export async function channelByNormalisedName(
  tx: Tx,
  orgId: string,
  storeId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = (await tx.execute(sql`
    select id, name from sales_channels
     where org_id = ${orgId} and store_id = ${storeId}
       and lower(trim(name)) = lower(trim(${name}))
     limit 1
  `)) as unknown as Record<string, unknown>[];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}

/**
 * The eligibility facts a channel's `receivable_account_code` is judged on — T-230 invariant 4.
 * ⛔ Judgement itself is the domain's; this only reports what the account IS.
 *
 * ⚠️ `requires_party` is here and not obvious. `sales-days/routing.ts` debits this account with
 * `party_type = 'channel'`, and T-118's trigger refuses a party on an account that does not want
 * one — so an account with `requires_party = false` produces a channel that configures cleanly and
 * then blocks every sales day it appears on.
 */
export async function receivableAccountFor(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<{ code: string; name: string; isPostable: boolean; requiresParty: boolean; status: string } | null> {
  const [row] = (await tx.execute(sql`
    select code, name, is_postable, requires_party, status from accounts
     where org_id = ${orgId} and code = ${code} limit 1
  `)) as unknown as Record<string, unknown>[];
  if (!row) return null;
  return {
    code: String(row.code),
    name: String(row.name),
    isPostable: Boolean(row.is_postable),
    requiresParty: Boolean(row.requires_party),
    status: String(row.status),
  };
}

/** The receivable picker's list — postable, active, and party-bearing (invariant 4). */
export async function receivableAccountOptions(tx: Tx, orgId: string): Promise<{ code: string; name: string }[]> {
  const rows = (await tx.execute(sql`
    select code, name from accounts
     where org_id = ${orgId} and is_postable and requires_party and status = 'active'
     order by code
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ code: String(r.code), name: String(r.name) }));
}

export interface UpdateSalesChannelRow {
  name: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  wastageTypeMode: 'tracked' | 'instant';
}

/** ⛔ Does not touch `is_active`, `destination_money_account_id` or `tax_treatment` — T-230
 *  invariants 8 and 9. Retiring a channel and correcting one is not the same act. */
export async function updateChannel(
  tx: Tx,
  orgId: string,
  channelId: string,
  patch: UpdateSalesChannelRow,
): Promise<void> {
  await tx
    .update(salesChannels)
    .set({
      name: patch.name,
      isRemittedDaily: patch.isRemittedDaily,
      receivableAccountCode: patch.receivableAccountCode,
      wastageTypeMode: patch.wastageTypeMode,
      updatedAt: new Date(),
    })
    .where(and(eq(salesChannels.orgId, orgId), eq(salesChannels.id, channelId)));
}

export async function setChannelActive(
  tx: Tx,
  orgId: string,
  channelId: string,
  isActive: boolean,
): Promise<void> {
  await tx
    .update(salesChannels)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(salesChannels.orgId, orgId), eq(salesChannels.id, channelId)));
}

// -------------------------------------------------------------------------------------
// Sales days
// -------------------------------------------------------------------------------------

/**
 * T-371 C2 — every figure is a `Money` brand minted by `decimal()`.
 * ✎R13 the nine defaulted figures (NOT NULL DEFAULT '0') are OPTIONAL: a blank is omitted so the column
 * default applies, never a guessed zero. The three revenue figures (NOT NULL, no default) stay required.
 */
export type InsertSalesDayInput = Pick<
  SafeInsert<typeof salesDays>,
  'orgId' | 'storeId' | 'businessDate' | 'createdBy'
> & {
  posSourced: boolean;
  posSourcedAt: Date | null;
  totalSales: Money;
  unliSales: Money;
  alaCarteSales: Money;
  seniorDiscount?: Money;
  pwdDiscount?: Money;
  otherDiscount?: Money;
  comps?: Money;
  serviceCharge?: Money;
  otherCharges?: Money;
  cashCollected?: Money;
  onlineCollected?: Money;
  creditSales?: Money;
};

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

/**
 * T-369 S3 / R5 - the day, read with `SELECT ... FOR UPDATE`. `editSalesDay`, `voidSalesDay` and
 * `runVerify` each take this lock BEFORE any other read, so verify can never post figures an edit is
 * half-way through changing, and an edit can never land on a day a verify just posted. A plain
 * `getById` read under READ COMMITTED would let both pass their status check on the same snapshot.
 */
export async function getByIdForUpdate(tx: Tx, orgId: string, id: string): Promise<SalesDayRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(salesDays)
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId)))
    .limit(1)
    .for('update');
  return row;
}

/**
 * The LIVE day for this store and date - open, submitted or verified - never a voided one (T-369 S7:
 * a voided day frees its date; migration 0177 narrowed the unique index to match). At most one row can
 * qualify, which is what `limit(1)` was already assuming.
 */
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
        ne(salesDays.status, 'voided'),
      ),
    )
    .limit(1);
  return row;
}

/** Whether a day for this store and date was ever voided - the fact that makes re-entering the date a
 *  manager's decision, not staff's (T-369 S7, Ian Q1). */
export async function hasVoidedOn(tx: Tx, orgId: string, storeId: string, businessDate: string): Promise<boolean> {
  const rows = await tx
    .select({ id: salesDays.id })
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        eq(salesDays.businessDate, businessDate),
        eq(salesDays.status, 'voided'),
      ),
    )
    .limit(1);
  return rows.length > 0;
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

/** T-371 C2 — a figure, when present, is a `Money` brand; an absent one is left unchanged (✎R13). */
export interface UpdateDraftInput {
  posSourced?: boolean;
  posSourcedAt?: Date | null;
  totalSales?: Money;
  unliSales?: Money;
  alaCarteSales?: Money;
  seniorDiscount?: Money;
  pwdDiscount?: Money;
  otherDiscount?: Money;
  comps?: Money;
  serviceCharge?: Money;
  otherCharges?: Money;
  cashCollected?: Money;
  onlineCollected?: Money;
  creditSales?: Money;
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
    throw recordGone(
      `updateDraft: sales day ${id} does not exist in org ${orgId}, or is not open/submitted`,
      'sales day',
      'open or submitted',
    );
  }
}

export async function markSubmitted(tx: Tx, orgId: string, id: string, submittedBy: string): Promise<void> {
  const updated = await tx
    .update(salesDays)
    .set({ status: 'submitted', submittedBy, submittedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId), eq(salesDays.status, 'open')))
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    throw recordGone(`markSubmitted: sales day ${id} does not exist in org ${orgId}, or is not open`, 'sales day', 'open');
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
    throw recordGone(`markVerified: sales day ${id} does not exist in org ${orgId}, or is already verified/voided`, 'sales day');
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
    throw recordGone(`markVoided: sales day ${id} does not exist in org ${orgId}, or is not verified`, 'sales day', 'verified');
  }
}

/**
 * T-369 S3 / R3 - withdraw an UNVERIFIED day: `voided`, with who and why, and no journal entry (an
 * unverified day posted nothing). The status predicate is repeated in the WHERE, as `updateDraft`
 * does, so a verify that committed between the caller's read and this write is a refusal, not a
 * void of a day that has since posted.
 */
export async function markUnverifiedVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(salesDays)
    .set({ status: 'voided', voidedBy: input.voidedBy, voidedAt: sql`now()`, voidReason: input.voidReason, updatedAt: sql`now()` })
    .where(and(eq(salesDays.id, id), eq(salesDays.orgId, orgId), inArray(salesDays.status, [...UNVERIFIED_STATUSES])))
    .returning({ id: salesDays.id });
  if (updated.length === 0) {
    // The caller holds the row lock, so reaching here means the day moved between its read and this
    // write - say so plainly rather than with the generic "does not exist" text.
    throw refuse(
      `markUnverifiedVoided: sales day ${id} does not exist in org ${orgId}, or is not open/submitted`,
      'This sales day was verified or withdrawn by someone else a moment ago. Reload the page to see where it stands.',
    );
  }
}

/** Whether a POSTED remittance has an allocation on this store's business date - cash handed over and
 *  counted against that date. Re-entering a withdrawn date while one stands would let a second day claim
 *  money the first was already settled with (T-369 S7 audit). */
export async function hasPostedHandoverOn(tx: Tx, orgId: string, storeId: string, businessDate: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 from remittance_allocations ra join remittances r on r.id = ra.remittance_id
     where r.org_id = ${orgId} and r.store_id = ${storeId} and r.status = 'posted' and ra.business_date = ${businessDate}
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

export interface WithdrawBlockers {
  /** A POS usage pull for this day that is not void. */
  usagePull: boolean;
  /** An `order_wastages` row recorded against this day. */
  wastage: boolean;
  /** A POSTED remittance with an allocation on this day (by id, or by this store's date). */
  remittance: boolean;
}

/**
 * T-369 S3 / R3 - what else hangs off this day, read-only, one query each. Withdrawing a day that
 * still carries one of these would leave the dependent pointing at a voided day, so the domain
 * refuses and names it; nothing is reversed automatically.
 */
export async function withdrawBlockers(
  tx: Tx,
  orgId: string,
  day: { id: string; storeId: string; businessDate: string },
): Promise<WithdrawBlockers> {
  const exists = async (query: ReturnType<typeof sql>): Promise<boolean> => {
    const rows = (await tx.execute(query)) as unknown as unknown[];
    return rows.length > 0;
  };
  const usagePull = await exists(sql`
    select 1 from pos_usage_pulls where org_id = ${orgId} and sales_day_id = ${day.id} and status <> 'void' limit 1`);
  const wastage = await exists(sql`
    select 1 from order_wastages where org_id = ${orgId} and sales_day_id = ${day.id} limit 1`);
  const remittance = await exists(sql`
    select 1 from remittance_allocations ra join remittances r on r.id = ra.remittance_id
     where r.org_id = ${orgId} and r.status = 'posted'
       and (ra.sales_day_id = ${day.id} or (r.store_id = ${day.storeId} and ra.business_date = ${day.businessDate}))
     limit 1`);
  return { usagePull, wastage, remittance };
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

/** T-371 C2 — `amount` is a `Money` brand. */
export interface InsertChannelInput {
  channelId: string;
  amount: Money;
  noSales: boolean;
}

export async function replaceChannels(tx: Tx, salesDayId: string, rows: InsertChannelInput[]): Promise<void> {
  await tx.delete(salesDayChannels).where(eq(salesDayChannels.salesDayId, salesDayId));
  if (rows.length === 0) return;
  const values: (SafeInsert<typeof salesDayChannels> & { amount: Money })[] = rows.map((r) => ({
    salesDayId,
    channelId: r.channelId,
    amount: r.amount,
    noSales: r.noSales,
  }));
  await tx.insert(salesDayChannels).values(values);
}

// -------------------------------------------------------------------------------------
// ⭐ Tenders — WHERE the online money landed (DEF-068)
//
// ⚠️ Deliberately a separate pair from the channel functions above, not a widening of them.
// A channel says where the sale came FROM; a tender says where the money WENT. They are
// orthogonal, and folding them into one shape is precisely the conflation that let v2 ship
// without the second axis at all.
// -------------------------------------------------------------------------------------

export interface SalesDayTenderRow {
  id: string;
  moneyAccountId: string;
  moneyAccountName: string;
  custodian: string;
  amount: string;
}

export async function getTendersForDay(tx: Tx, salesDayId: string): Promise<SalesDayTenderRow[]> {
  return tx
    .select({
      id: salesDayTenders.id,
      moneyAccountId: salesDayTenders.moneyAccountId,
      moneyAccountName: moneyAccounts.name,
      custodian: moneyAccounts.custodian,
      amount: salesDayTenders.amount,
    })
    .from(salesDayTenders)
    .innerJoin(moneyAccounts, eq(moneyAccounts.id, salesDayTenders.moneyAccountId))
    .where(eq(salesDayTenders.salesDayId, salesDayId))
    .orderBy(asc(moneyAccounts.name));
}

/** T-371 C2 — `amount` is a `Money` brand. */
export interface InsertTenderInput {
  moneyAccountId: string;
  amount: Money;
}

/** Replace-wholesale, the same technique `replaceChannels` uses: a day's tender breakdown is
 *  one fact, and diffing rows would let a stale wallet survive an edit. */
export async function replaceTenders(
  tx: Tx,
  salesDayId: string,
  rows: InsertTenderInput[],
): Promise<void> {
  await tx.delete(salesDayTenders).where(eq(salesDayTenders.salesDayId, salesDayId));
  if (rows.length === 0) return;
  const values: (SafeInsert<typeof salesDayTenders> & { amount: Money })[] = rows.map((r) => ({
    salesDayId,
    moneyAccountId: r.moneyAccountId,
    amount: r.amount,
  }));
  await tx.insert(salesDayTenders).values(values);
}
