/**
 * The only place SQL is written for prepaid items. T-125.
 *
 * ## ⭐ `amortisedFromLedger` is the point of this file
 *
 * **Amortised-to-date and remaining are DERIVED, never stored** (spec §3.1, invariant 1). v1 kept
 * `amortizedToDate` and `remainingBookValue` as columns, hand-incremented at every write site and
 * — its own type admits — kept in sync *"by convention"*. They drifted so thoroughly that v1 ended
 * up with **two independent code paths computing "total remaining prepaid" that never read from
 * each other**. There is no such column here, so there is nothing to diverge.
 *
 * ⚠️ **How a charge is attributed matters, and it is not by account.** One control account
 * (`1400`) covers every prepaid item in the org, so the account cannot say whose charge a line is.
 * The attribution is `journal_entries.source_type = 'amortisation'` AND `source_id = the item id`
 * — the same reasoning bible row 140 settled for assets, and the reason posting is per item.
 *
 * ⚠️ **And the sign is the opposite of T-124's.** Depreciation CREDITS a contra-asset (1590), so
 * accumulated = credits − debits. Amortisation credits `1400` directly — the asset balance runs
 * down rather than being shadowed — so the released total is credits − debits **against 1400,
 * restricted to amortisation entries**, and the purchase's own debit must not be swept in. That is
 * what the `source_type` filter buys.
 *
 * ⛔ **No posting functions here.** Journal SQL lives in `repo/journal.ts` and is reached only
 * through `postEntry` (bible §4.3). This file reads the ledger; it never writes it.
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { recordGone } from './record-gone';
import type { SafeInsert, SafeUpdate } from './numeric-input';
import type { Money } from '@shareat/core/money';
import { accounts } from '../../schema/accounts';
import { journalEntries, journalLines } from '../../schema/journal';
import {
  prepaidItems,
  type PrepaidCategory,
  type PrepaidStatus,
} from '../../schema/prepaid';

/** The control account every prepaid item shares. */
export const PREPAID_ACCOUNT_CODE = '1400';
/** Where a released month lands in the P&L. */
export const AMORTISATION_EXPENSE_CODE = '6750';
/** `journal_entries.source_type` for a released month — the attribution key. */
export const AMORTISATION_SOURCE_TYPE = 'amortisation';

export interface PrepaidItemRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  category: PrepaidCategory;
  coverageStartDate: string;
  coverageMonths: number;
  totalCost: string;
  status: PrepaidStatus;
  needsReview: boolean;
  sourceExpenseId: string | null;
  writtenOffOn: string | null;
  writeOffReason: string | null;
  notes: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: prepaidItems.id,
  orgId: prepaidItems.orgId,
  storeId: prepaidItems.storeId,
  name: prepaidItems.name,
  category: prepaidItems.category,
  coverageStartDate: prepaidItems.coverageStartDate,
  coverageMonths: prepaidItems.coverageMonths,
  totalCost: prepaidItems.totalCost,
  status: prepaidItems.status,
  needsReview: prepaidItems.needsReview,
  sourceExpenseId: prepaidItems.sourceExpenseId,
  writtenOffOn: prepaidItems.writtenOffOn,
  writeOffReason: prepaidItems.writeOffReason,
  notes: prepaidItems.notes,
  createdAt: prepaidItems.createdAt,
} as const;

// -------------------------------------------------------------------------------------
// The register
// -------------------------------------------------------------------------------------

/** T-371 C2 — `totalCost` is a `Money` brand ((14,2)), minted by `decimal()`; an unparsed string cannot reach it. */
export type InsertPrepaidItemInput = Pick<
  SafeInsert<typeof prepaidItems>,
  | 'orgId'
  | 'storeId'
  | 'name'
  | 'category'
  | 'coverageStartDate'
  | 'coverageMonths'
  | 'needsReview'
  | 'sourceExpenseId'
  | 'notes'
  | 'createdBy'
> & { totalCost: Money };

export async function insertPrepaidItem(
  tx: Tx,
  input: InsertPrepaidItemInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(prepaidItems).values(input).returning({ id: prepaidItems.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PrepaidItemRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(prepaidItems)
    .where(and(eq(prepaidItems.id, id), eq(prepaidItems.orgId, orgId)))
    .limit(1);
  return row as PrepaidItemRow | undefined;
}

export interface ListPrepaidFilter {
  storeId?: string;
  status?: PrepaidStatus;
  /** True lists only the items whose coverage term was GUESSED and not yet confirmed (§11.2). */
  needsReview?: boolean;
}

export async function listPrepaidItems(
  tx: Tx,
  orgId: string,
  filter: ListPrepaidFilter = {},
): Promise<PrepaidItemRow[]> {
  const conditions = [eq(prepaidItems.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(prepaidItems.storeId, filter.storeId));
  if (filter.status) conditions.push(eq(prepaidItems.status, filter.status));
  if (filter.needsReview !== undefined) {
    conditions.push(eq(prepaidItems.needsReview, filter.needsReview));
  }

  const rows = await tx
    .select(COLUMNS)
    .from(prepaidItems)
    .where(and(...conditions))
    .orderBy(desc(prepaidItems.needsReview), asc(prepaidItems.coverageStartDate));
  return rows as PrepaidItemRow[];
}

/**
 * ⭐ The review counter — §11.2's "a place, not a notification".
 *
 * A single COUNT rather than a list length, because the banner is rendered on every load of the
 * module and the list it filters may be long.
 */
export async function countNeedingReview(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(prepaidItems)
    .where(
      and(
        eq(prepaidItems.orgId, orgId),
        eq(prepaidItems.needsReview, true),
        eq(prepaidItems.status, 'active'),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Confirms or corrects the coverage term. ⭐ **Only a human doing this clears `needs_review`** —
 * the same rule T-124 uses for assets. Nothing expires the queue and nothing auto-accepts: a
 * guessed default silently becoming permanent is the exact failure this task is built against.
 */
export async function confirmTerm(
  tx: Tx,
  orgId: string,
  id: string,
  input: Required<Pick<SafeUpdate<typeof prepaidItems>, 'coverageMonths' | 'coverageStartDate'>>,
): Promise<void> {
  const updated = await tx
    .update(prepaidItems)
    .set({ ...input, needsReview: false, updatedAt: sql`now()` })
    .where(and(eq(prepaidItems.id, id), eq(prepaidItems.orgId, orgId)))
    .returning({ id: prepaidItems.id });
  if (updated.length === 0) {
    throw recordGone(`confirmTerm: prepaid item ${id} does not exist in org ${orgId}`, 'prepaid item');
  }
}

export async function markStatus(
  tx: Tx,
  orgId: string,
  id: string,
  input: Pick<SafeUpdate<typeof prepaidItems>, 'writtenOffOn' | 'writeOffReason' | 'writtenOffBy'> & {
    status: PrepaidStatus;
  },
): Promise<void> {
  const updated = await tx
    .update(prepaidItems)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(prepaidItems.id, id), eq(prepaidItems.orgId, orgId)))
    .returning({ id: prepaidItems.id });
  if (updated.length === 0) {
    throw recordGone(`markStatus: prepaid item ${id} does not exist in org ${orgId}`, 'prepaid item');
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived figures — read from the ledger, never from a column
// -------------------------------------------------------------------------------------

/**
 * What this item has released into the P&L so far.
 *
 * ⚠️ Restricted to `source_type = 'amortisation'` so the PURCHASE's own debit to 1400 is not swept
 * in — without that filter a freshly-bought item would report itself partly amortised.
 */
export async function amortisedFromLedger(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<string> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, AMORTISATION_SOURCE_TYPE),
        eq(journalEntries.sourceId, itemId),
        eq(accounts.code, PREPAID_ACCOUNT_CODE),
        ne(journalEntries.status, 'draft'),
      ),
    );
  return row?.total ?? '0';
}

/**
 * The same figure for every item in the org at once, keyed by item id.
 *
 * ⚠️ The register lists every policy and licence; calling `amortisedFromLedger` per row is the N+1
 * that makes a derived figure look expensive and tempts someone to store it again.
 */
export async function amortisedByItem(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      itemId: journalEntries.sourceId,
      total: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, AMORTISATION_SOURCE_TYPE),
        eq(accounts.code, PREPAID_ACCOUNT_CODE),
        ne(journalEntries.status, 'draft'),
      ),
    )
    .groupBy(journalEntries.sourceId);
  return new Map(rows.map((r) => [r.itemId, r.total]));
}

/**
 * Which periods this item has already posted — `YYYY-MM`, from the idempotency keys themselves.
 *
 * ⭐ **The keys ARE the record of what ran.** A separate "posted periods" table would be a second
 * source of truth for something the ledger already knows, and would drift the moment a month was
 * reversed. Reading them back keeps one.
 */
export async function postedPeriods(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, AMORTISATION_SOURCE_TYPE),
        eq(journalEntries.sourceId, itemId),
        ne(journalEntries.status, 'draft'),
        // ⚠️ A REVERSED entry must not count as posted, or a corrected month could never be
        // re-run — which is exactly the hole §7.8 exists to close.
        ne(journalEntries.status, 'reversed'),
      ),
    );
  const periods = new Set<string>();
  for (const r of rows) {
    // ⚠️ The optional `#N` is a RE-POST after a reversal — see `nextRevisionKey`.
    const m = /:amortisation:(\d{4}-\d{2})(?:#\d+)?$/.exec(r.key ?? '');
    if (m) periods.add(m[1]!);
  }
  return periods;
}

/** The same figure for every item in the org at once, as a map keyed by item id — the N+1 guard
 *  for `postedPeriods`, same reasoning as `amortisedByItem` above: a caller walking every item
 *  (T-345 §3.2/§3.3) must not call the single-item version once per item. */
export async function postedPeriodsByItem(tx: Tx, orgId: string): Promise<Map<string, Set<string>>> {
  const rows = await tx
    .select({ itemId: journalEntries.sourceId, key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, AMORTISATION_SOURCE_TYPE),
        ne(journalEntries.status, 'draft'),
        ne(journalEntries.status, 'reversed'),
      ),
    );
  const byItem = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = /:amortisation:(\d{4}-\d{2})(?:#\d+)?$/.exec(r.key ?? '');
    if (!m) continue;
    const set = byItem.get(r.itemId) ?? new Set<string>();
    set.add(m[1]!);
    byItem.set(r.itemId, set);
  }
  return byItem;
}

/**
 * Every entry ever written for one (item, period), reversed ones included, oldest first.
 *
 * ⭐ **A period is a SERIES, not a single row**, and that is the correction §7.8 forced. Reversing
 * a month and re-posting it is the whole point of per-month reversal — but `postEntry` keys off
 * the idempotency key, so re-using the original key would make the re-post a silent no-op. The
 * reversed attempt stays in the ledger (it must — reversals never delete), so the next attempt
 * needs a key of its own.
 */
export async function entriesForPeriod(
  tx: Tx,
  orgId: string,
  itemId: string,
  period: string,
): Promise<{ id: string; status: string; key: string }[]> {
  const base = `prepaid:${itemId}:amortisation:${period}`;
  const rows = await tx
    .select({
      id: journalEntries.id,
      status: journalEntries.status,
      key: journalEntries.idempotencyKey,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        sql`${journalEntries.idempotencyKey} = ${base} or ${journalEntries.idempotencyKey} like ${base + '#%'}`,
      ),
    )
    .orderBy(asc(journalEntries.createdAt));
  return rows.map((r) => ({ id: r.id, status: r.status, key: r.key ?? '' }));
}

/**
 * The key the NEXT posting of this period should use.
 *
 * The first attempt is the plain key — the common case, and the one worth keeping readable.
 * A re-post after a reversal appends `#2`, `#3`, … so it is idempotent per ATTEMPT while the
 * period as a whole still has exactly one effective entry.
 */
export function nextRevisionKey(
  itemId: string,
  period: string,
  existing: { status: string }[],
): string {
  const base = `prepaid:${itemId}:amortisation:${period}`;
  return existing.length === 0 ? base : `${base}#${existing.length + 1}`;
}

/**
 * The one entry currently IN EFFECT for a month, so §7.8 can reverse it on its own.
 *
 * ⚠️ Not simply "the entry with the base key" — after a reversal and a re-post, the effective
 * entry is the latest one that has not itself been reversed. Reversing the original again would
 * double-count the correction.
 */
export async function activeEntryForPeriod(
  tx: Tx,
  orgId: string,
  itemId: string,
  period: string,
): Promise<{ id: string; status: string; key: string } | undefined> {
  const all = await entriesForPeriod(tx, orgId, itemId, period);
  return all.filter((e) => e.status !== 'reversed' && e.status !== 'draft').pop();
}
