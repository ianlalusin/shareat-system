/**
 * The only place SQL is written for fixed assets. docs/tasks/124-fixed-assets-and-depreciation.md.
 *
 * ## ⭐ The one function here that is the whole point of the task
 *
 * `accumulatedFromLedger` — because **accumulated depreciation is DERIVED, never stored**
 * (spec §3, DEF-044). v1 kept `accumulatedDepreciation` and `bookValue` as columns on the asset
 * and incremented them alongside the journal entry, giving two sources of truth for one number.
 * They diverged: v1's scheduler silently stopped for two months and the register still looked
 * perfectly fine, because the columns were only ever written by the thing that had stopped
 * running. There is no such column here, so there is nothing to diverge.
 *
 * ⚠️ **How an asset's depreciation is identified matters, and it is not by account.** v1 gave
 * every asset its own pair of accounts (`asset__{id}` / `contra_asset__{id}`); v2 has ONE control
 * account (1590) for every asset in the org, so the account cannot tell you whose charge a line
 * is. The attribution is `journal_entries.source_type = 'depreciation'` AND `source_id = the
 * asset id` — which is exactly why bible row 140 settles posting as PER ASSET. A per-category
 * entry would make this figure underivable, and with it the whole no-stored-accumulated design.
 *
 * ⛔ **No depreciation POSTING functions here.** Journal SQL is written in `repo/journal.ts` and
 * reached only through `postEntry` (bible §4.3). This file reads the ledger; it never writes it.
 */
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
import { recordGone } from './record-gone';
import { accounts } from '../../schema/accounts';
import { journalEntries, journalLines } from '../../schema/journal';
import {
  assetCategoryLives,
  assetPolicy,
  fixedAssets,
  type AssetCategory,
} from '../../schema/fixed-assets';

export type AssetStatus = 'active' | 'disposed' | 'pending_valuation';
export type DepreciationIntervalValue = 'monthly' | 'quarterly' | 'semiannual' | 'annually';
/** T-346 S2 (DEF-427). `null` only for a shell. */
export type InServiceSource = 'acquired' | 'store_opening' | 'set';

/** The account every depreciation charge credits — the contra-asset (spec §5). Named once here
 *  so a caller can never pass 1510 by accident. */
export const ACCUMULATED_DEPRECIATION_CODE = '1590';
/** The account every depreciation charge debits. Named once for the same reason. */
export const DEPRECIATION_EXPENSE_CODE = '6700';

export interface FixedAssetRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  category: AssetCategory;
  acquiredOn: string | null;
  cost: string | null;
  salvageValue: string | null;
  usefulLifeMonths: number;
  method: string;
  interval: DepreciationIntervalValue;
  status: AssetStatus;
  needsReview: boolean;
  notes: string | null;
  sourceExpenseId: string | null;
  /** T-346 S2 (DEF-427). `null` on a non-shell row means HELD — depreciates nothing yet. */
  inServiceOn: string | null;
  inServiceSource: InServiceSource | null;
  disposedOn: string | null;
  disposalReason: string | null;
  disposedBy: string | null;
  createdBy: string;
  createdAt: Date;
}

const COLUMNS = {
  id: fixedAssets.id,
  orgId: fixedAssets.orgId,
  storeId: fixedAssets.storeId,
  name: fixedAssets.name,
  category: fixedAssets.category,
  acquiredOn: fixedAssets.acquiredOn,
  cost: fixedAssets.cost,
  salvageValue: fixedAssets.salvageValue,
  usefulLifeMonths: fixedAssets.usefulLifeMonths,
  method: fixedAssets.method,
  interval: fixedAssets.interval,
  status: fixedAssets.status,
  needsReview: fixedAssets.needsReview,
  notes: fixedAssets.notes,
  sourceExpenseId: fixedAssets.sourceExpenseId,
  inServiceOn: fixedAssets.inServiceOn,
  inServiceSource: fixedAssets.inServiceSource,
  disposedOn: fixedAssets.disposedOn,
  disposalReason: fixedAssets.disposalReason,
  disposedBy: fixedAssets.disposedBy,
  createdBy: fixedAssets.createdBy,
  createdAt: fixedAssets.createdAt,
} as const;

// -------------------------------------------------------------------------------------
// Policy — the two config tables
// -------------------------------------------------------------------------------------

export interface AssetPolicyRow {
  id: string;
  orgId: string;
  capitalizationThreshold: string;
  defaultSalvageValue: string;
}

/**
 * The org's capitalisation policy, or `undefined` if none has been set.
 *
 * ⚠️ **`undefined` here means ABSENT, and absent is not the same as UNREADABLE** — the caller
 * must keep those apart. v1 collapsed them into one `return DEFAULTS` and its own code comment
 * records what that cost: the live policy was life 2 / salvage 100 against defaults of 5 / 0, so
 * every silent fallback *"understates depreciation by ~60% on everything capitalized afterwards"*
 * — permanently, because editing the expense later does not re-price the asset. A thrown read
 * propagates out of this function untouched, which is what lets `readPolicyOrRefuse` refuse.
 */
export async function findPolicy(tx: Tx, orgId: string): Promise<AssetPolicyRow | undefined> {
  const [row] = await tx
    .select({
      id: assetPolicy.id,
      orgId: assetPolicy.orgId,
      capitalizationThreshold: assetPolicy.capitalizationThreshold,
      defaultSalvageValue: assetPolicy.defaultSalvageValue,
    })
    .from(assetPolicy)
    .where(eq(assetPolicy.orgId, orgId))
    .limit(1);
  return row;
}

export async function upsertPolicy(
  tx: Tx,
  /** T-371 R6: `defaultSalvageValue` is NOT NULL DEFAULT 0 — a blank is OMITTED, so an insert takes the database
   *  default and an update leaves the stored value unchanged. Never a guessed `'0'`. */
  input: { orgId: string; capitalizationThreshold: Money; defaultSalvageValue?: Money },
): Promise<void> {
  // Drizzle writes DEFAULT for an `undefined` insert value and drops an `undefined` key from an update SET.
  await tx
    .insert(assetPolicy)
    .values({
      orgId: input.orgId,
      capitalizationThreshold: input.capitalizationThreshold,
      defaultSalvageValue: input.defaultSalvageValue,
    } satisfies SafeInsert<typeof assetPolicy>)
    .onConflictDoUpdate({
      target: assetPolicy.orgId,
      set: {
        capitalizationThreshold: input.capitalizationThreshold,
        defaultSalvageValue: input.defaultSalvageValue,
        updatedAt: sql`now()`,
      },
    });
}

/** The per-category default life, in MONTHS (bible row 140). Absent means "no category-specific
 *  default has been set", and the caller falls back to the org default of 24. */
export async function findCategoryLife(
  tx: Tx,
  orgId: string,
  category: AssetCategory,
): Promise<number | undefined> {
  const [row] = await tx
    .select({ usefulLifeMonths: assetCategoryLives.usefulLifeMonths })
    .from(assetCategoryLives)
    .where(and(eq(assetCategoryLives.orgId, orgId), eq(assetCategoryLives.category, category)))
    .limit(1);
  return row?.usefulLifeMonths;
}

export async function listCategoryLives(
  tx: Tx,
  orgId: string,
): Promise<{ category: AssetCategory; usefulLifeMonths: number }[]> {
  return tx
    .select({
      category: assetCategoryLives.category,
      usefulLifeMonths: assetCategoryLives.usefulLifeMonths,
    })
    .from(assetCategoryLives)
    .where(eq(assetCategoryLives.orgId, orgId))
    .orderBy(asc(assetCategoryLives.category));
}

export async function upsertCategoryLife(
  tx: Tx,
  input: { orgId: string; category: AssetCategory; usefulLifeMonths: number },
): Promise<void> {
  await tx
    .insert(assetCategoryLives)
    .values(input)
    .onConflictDoUpdate({
      target: [assetCategoryLives.orgId, assetCategoryLives.category],
      set: { usefulLifeMonths: input.usefulLifeMonths, updatedAt: sql`now()` },
    });
}

// -------------------------------------------------------------------------------------
// The register
// -------------------------------------------------------------------------------------

export interface InsertAssetInput {
  orgId: string;
  storeId: string;
  name: string;
  category: AssetCategory;
  acquiredOn: string | null;
  cost: Money | null;
  /** T-371 R6: nullable WITH a default of 0 — omit it for the default, `null` stores null. */
  salvageValue?: Money | null;
  usefulLifeMonths: number;
  interval: DepreciationIntervalValue;
  status: AssetStatus;
  needsReview: boolean;
  notes: string | null;
  sourceExpenseId: string | null;
  createdBy: string;
  /** T-346 S2 (DEF-427). Both optional — the migration's fill trigger derives whichever is absent
   *  (§3.3 step 4); the `/fixed-assets/new` "In service" choice supplies both when the operator
   *  named one explicitly. */
  inServiceSource?: InServiceSource | null;
  inServiceOn?: string | null;
}

export async function insertAsset(tx: Tx, input: InsertAssetInput): Promise<{ id: string }> {
  const [row] = await tx.insert(fixedAssets).values(input satisfies SafeInsert<typeof fixedAssets>).returning({ id: fixedAssets.id });
  return row!;
}

/** The asset, read `FOR UPDATE`. T-368 S3 (DEF-436): `updateAssetTerms` and the depreciation run both take
 *  this lock as their FIRST read, so a terms change and a run on one asset serialise - whichever commits
 *  second sees the other's result. */
export async function getByIdForUpdate(tx: Tx, orgId: string, id: string): Promise<FixedAssetRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId)))
    .limit(1)
    .for('update');
  return row as FixedAssetRow | undefined;
}

/** Takes the asset row's lock (`FOR UPDATE`), returning nothing. T-381 (DEF-606): `bookMissedMonth` serialises
 *  bookers PER ASSET so the loser re-reads after the winner commits and answers in words. */
export async function lockAssetRow(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM fixed_assets WHERE id = ${id} AND org_id = ${orgId} FOR UPDATE`);
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<FixedAssetRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId)))
    .limit(1);
  return row as FixedAssetRow | undefined;
}

/** An asset already created from this expense, if any — the capitalisation seam's idempotency.
 *  Approving the same expense twice must not mint a second asset. */
export async function findBySourceExpense(
  tx: Tx,
  orgId: string,
  expenseId: string,
): Promise<FixedAssetRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(fixedAssets)
    .where(and(eq(fixedAssets.orgId, orgId), eq(fixedAssets.sourceExpenseId, expenseId)))
    .limit(1);
  return row as FixedAssetRow | undefined;
}

export interface ListAssetsFilter {
  storeId?: string;
  status?: AssetStatus;
  category?: AssetCategory;
  needsReviewOnly?: boolean;
}

export async function listAssets(
  tx: Tx,
  orgId: string,
  filter: ListAssetsFilter = {},
): Promise<FixedAssetRow[]> {
  const conditions = [eq(fixedAssets.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(fixedAssets.storeId, filter.storeId));
  if (filter.status) conditions.push(eq(fixedAssets.status, filter.status));
  if (filter.category) conditions.push(eq(fixedAssets.category, filter.category));
  if (filter.needsReviewOnly) conditions.push(eq(fixedAssets.needsReview, true));

  const rows = await tx
    .select(COLUMNS)
    .from(fixedAssets)
    .where(and(...conditions))
    .orderBy(desc(fixedAssets.createdAt));
  return rows as FixedAssetRow[];
}

/** Every asset the depreciation run should consider for an org.
 *
 *  ⚠️ `status = 'active'` is load-bearing twice over: a DISPOSED asset stops charging (spec
 *  invariant 4), and a `pending_valuation` shell has no cost or acquisition date to build a
 *  schedule from, so including it would be a null-arithmetic bug rather than an accounting one. */
export async function listDepreciable(tx: Tx, orgId: string): Promise<FixedAssetRow[]> {
  const rows = await tx
    .select(COLUMNS)
    .from(fixedAssets)
    .where(and(eq(fixedAssets.orgId, orgId), eq(fixedAssets.status, 'active')))
    .orderBy(asc(fixedAssets.createdAt));
  return rows as FixedAssetRow[];
}

/** Clears `needsReview`. Auto-capitalisation sets it; only a human editing the terms clears it
 *  (spec invariant 5), which is why this is its own function and not part of a general update. */
export async function markReviewed(tx: Tx, orgId: string, id: string): Promise<void> {
  const updated = await tx
    .update(fixedAssets)
    .set({ needsReview: false, updatedAt: sql`now()` })
    .where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId)))
    .returning({ id: fixedAssets.id });
  if (updated.length === 0) {
    throw recordGone(`markReviewed: asset ${id} does not exist in org ${orgId}`, 'asset');
  }
}

export interface UpdateAssetTermsInput {
  name: string;
  category: AssetCategory;
  usefulLifeMonths: number;
  interval: DepreciationIntervalValue;
  salvageValue: Money | null;
  notes: string | null;
}

/**
 * Edits an asset's depreciation terms, and clears `needsReview` in the same statement.
 *
 * ⚠️ Restricted to `status = 'active'` in the WHERE clause, not checked in TypeScript first —
 * a disposed asset's terms are history, and a concurrent disposal between a caller's read and
 * this write must not quietly rewrite them. Zero rows affected throws, because an update that
 * changed nothing is indistinguishable from success.
 */
export async function updateTerms(
  tx: Tx,
  orgId: string,
  id: string,
  input: UpdateAssetTermsInput,
): Promise<void> {
  const updated = await tx
    .update(fixedAssets)
    .set({ ...input, needsReview: false, updatedAt: sql`now()` })
    .where(
      and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId), eq(fixedAssets.status, 'active')),
    )
    .returning({ id: fixedAssets.id });
  if (updated.length === 0) {
    throw recordGone(`updateTerms: asset ${id} does not exist in org ${orgId}, or is not active`, 'asset', 'active');
  }
}

export async function markDisposed(
  tx: Tx,
  orgId: string,
  id: string,
  input: { disposedOn: string; disposalReason: string; disposedBy: string },
): Promise<void> {
  const updated = await tx
    .update(fixedAssets)
    .set({ status: 'disposed', ...input, updatedAt: sql`now()` })
    .where(
      and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId), eq(fixedAssets.status, 'active')),
    )
    .returning({ id: fixedAssets.id });
  if (updated.length === 0) {
    throw recordGone(`markDisposed: asset ${id} does not exist in org ${orgId}, or is not active`, 'asset', 'active');
  }
}

/** Gives a `pending_valuation` shell its cost and acquisition date, making it active. The
 *  cutover's other half (T-134) — the schema's shape CHECK refuses any half-populated result. */
export async function valuateShell(
  tx: Tx,
  orgId: string,
  id: string,
  input: { acquiredOn: string; cost: Money; salvageValue: Money; usefulLifeMonths: number },
): Promise<void> {
  const updated = await tx
    .update(fixedAssets)
    .set({ ...input, status: 'active', updatedAt: sql`now()` })
    .where(
      and(
        eq(fixedAssets.id, id),
        eq(fixedAssets.orgId, orgId),
        eq(fixedAssets.status, 'pending_valuation'),
      ),
    )
    .returning({ id: fixedAssets.id });
  if (updated.length === 0) {
    throw recordGone(
      `valuateShell: asset ${id} does not exist in org ${orgId}, or is not pending_valuation`,
      'asset',
      'pending valuation',
    );
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived figures — read from the ledger, never from a column
// -------------------------------------------------------------------------------------

/**
 * Accumulated depreciation for ONE asset, computed from the journal.
 *
 * `credit − debit` on account 1590, over every non-draft entry whose source is this asset.
 * Signing it that way is what makes reversals free: a reversed entry keeps its lines and its
 * reversal carries the mirrored debit, so the pair nets to zero without this query knowing
 * anything about reversal. Filtering to `status = 'posted'` instead would count the original of
 * a reversed pair and miss its reversal, which reads as depreciation that never came back.
 */
export async function accumulatedFromLedger(
  tx: Tx,
  orgId: string,
  assetId: string,
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
        eq(journalEntries.sourceType, 'depreciation'),
        eq(journalEntries.sourceId, assetId),
        eq(accounts.code, ACCUMULATED_DEPRECIATION_CODE),
        ne(journalEntries.status, 'draft'),
      ),
    );
  return row?.total ?? '0';
}

/** The same figure for every asset in the org at once, as a map keyed by asset id.
 *  ⚠️ The register screen lists hundreds of assets; calling `accumulatedFromLedger` per row is
 *  the N+1 that makes a derived figure look expensive and tempts someone to store it again. */
export async function accumulatedByAsset(
  tx: Tx,
  orgId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      assetId: journalEntries.sourceId,
      total: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'depreciation'),
        eq(accounts.code, ACCUMULATED_DEPRECIATION_CODE),
        ne(journalEntries.status, 'draft'),
      ),
    )
    .groupBy(journalEntries.sourceId);
  return new Map(rows.map((r) => [r.assetId, r.total]));
}

/** The periods this asset has already been charged for, as `YYYY-MM` strings.
 *  Used to answer "what is still owed?" without re-deriving it from idempotency keys.
 *
 *  ⭐ **T-345 R1.1 — read from the KEY, not `entry_date`.** A missed-month catch-up is dated in the
 *  month it was BOOKED, not the month it belongs to (`asset:{id}:depreciation:{P}`, entry dated
 *  after P) — `entry_date` would report the catch-up twice (once for its real month, once — wrongly
 *  — under the booking month) and never report P itself. `repo/prepaid.ts`'s own `postedPeriods`
 *  already does this; the `(?:#\d+)?` tail is the same re-post-after-reversal shape. */
export async function postedDepreciationPeriods(
  tx: Tx,
  orgId: string,
  assetId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'depreciation'),
        eq(journalEntries.sourceId, assetId),
        eq(journalEntries.status, 'posted'),
      ),
    );
  const periods: string[] = [];
  for (const r of rows) {
    const m = /:depreciation:(\d{4}-\d{2})(?:#\d+)?$/.exec(r.key ?? '');
    if (m) periods.push(m[1]!);
  }
  return periods;
}

/** The same figure for every asset in the org at once, as a map keyed by asset id — the N+1 guard
 *  for `postedDepreciationPeriods`, the same reasoning `accumulatedByAsset` gives above: a caller
 *  walking every asset (T-345 §3.2/§3.3) must not call the single-asset version once per asset. */
export async function postedDepreciationPeriodsByAsset(
  tx: Tx,
  orgId: string,
): Promise<Map<string, Set<string>>> {
  const rows = await tx
    .select({ assetId: journalEntries.sourceId, key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'depreciation'),
        eq(journalEntries.status, 'posted'),
      ),
    );
  const byAsset = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = /:depreciation:(\d{4}-\d{2})(?:#\d+)?$/.exec(r.key ?? '');
    if (!m) continue;
    const set = byAsset.get(r.assetId) ?? new Set<string>();
    set.add(m[1]!);
    byAsset.set(r.assetId, set);
  }
  return byAsset;
}

/** Assets whose cost has never been capitalised to 1510 — the reconciliation hook T-135's OIL
 *  findings hang off. Kept here rather than in the audit package because it is one join away
 *  from the figures above and would otherwise duplicate them. */
export async function assetsMissingCapitalisation(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await tx
    .select({ id: fixedAssets.id, name: fixedAssets.name })
    .from(fixedAssets)
    .where(
      and(
        eq(fixedAssets.orgId, orgId),
        eq(fixedAssets.status, 'active'),
        isNull(fixedAssets.sourceExpenseId),
      ),
    );
  return rows;
}

// -------------------------------------------------------------------------------------
// T-346 S2 (DEF-427) — in-service date: reading what is posted, and writing the columns.
// -------------------------------------------------------------------------------------

export interface PostedDepreciationEntry {
  /** `YYYY-MM`, from the idempotency key — never `entry_date` (R1.2's own reasoning). */
  period: string;
  entryId: string;
  /** The 6700 debit — a decimal string, e.g. `'1000.00'`. */
  amount: string;
}

/** Every currently-POSTED depreciation entry for this asset, by period, with its own id and
 *  amount — `setAssetInService` (`fixed-assets/in-service.ts`) needs all three to decide which
 *  months a new schedule still owes at the SAME amount (kept) versus not (reversed, §3.4 step 2). */
export async function postedDepreciationEntries(
  tx: Tx,
  orgId: string,
  assetId: string,
): Promise<PostedDepreciationEntry[]> {
  const rows = await tx
    .select({ entryId: journalEntries.id, key: journalEntries.idempotencyKey, amount: journalLines.debit })
    .from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'depreciation'),
        eq(journalEntries.sourceId, assetId),
        eq(journalEntries.status, 'posted'),
        eq(accounts.code, DEPRECIATION_EXPENSE_CODE),
      ),
    );
  const out: PostedDepreciationEntry[] = [];
  for (const r of rows) {
    const m = /:depreciation:(\d{4}-\d{2})(?:#\d+)?$/.exec(r.key ?? '');
    if (m) out.push({ period: m[1]!, entryId: r.entryId, amount: r.amount });
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Every depreciation entry ever written for one (asset, period), reversed ones included, oldest first.
 * T-368 S2 (DEF-435).
 *
 * ⭐ A period is a SERIES, not a single row - the same correction prepaid's `entriesForPeriod` forced.
 * Reversing a month and running it again is the whole point of a correction, but `postEntry` keys off the
 * idempotency key, so re-using the original key would make the re-post a silent no-op; the reversed
 * attempt stays in the ledger, so the next attempt needs a key of its own (`depreciationRevisionKey`).
 *
 * ⚠️ The OR is parenthesised: `and(a, b or c)` without brackets reads as `(a and b) or c`, which would
 * match another organisation's rows.
 */
export async function depreciationEntriesForPeriod(
  tx: Tx,
  orgId: string,
  assetId: string,
  period: string,
): Promise<{ id: string; status: string; key: string }[]> {
  const base = `asset:${assetId}:depreciation:${period}`;
  const rows = await tx
    .select({ id: journalEntries.id, status: journalEntries.status, key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'depreciation'),
        eq(journalEntries.sourceId, assetId),
        sql`(${journalEntries.idempotencyKey} = ${base} or ${journalEntries.idempotencyKey} like ${base + '#%'})`,
      ),
    )
    .orderBy(asc(journalEntries.createdAt));
  return rows.map((r) => ({ id: r.id, status: r.status, key: r.key ?? '' }));
}

/** The key the NEXT posting of this (asset, period) should use: the plain key the first time, then `#2`,
 *  `#3`, ... after each reversal - idempotent per ATTEMPT while the period has one effective entry. */
export function depreciationRevisionKey(assetId: string, period: string, existing: { status: string }[]): string {
  const base = `asset:${assetId}:depreciation:${period}`;
  return existing.length === 0 ? base : `${base}#${existing.length + 1}`;
}

/**
 * Writes the in-service columns directly. ⚠️ **Does not replicate the fill trigger's own logic** —
 * for `'acquired'`/`'store_opening'`, `in_service_on` is left OUT of the SET list entirely, so
 * migration 0163's `fixed_assets_in_service_a_fill` derives it (RULES §6.3: the database derives
 * the default, not a second copy here). Only `'set'` carries an explicit value, because that is the
 * one source the trigger never overwrites. The caller (`setAssetInService`) computes the SAME
 * value independently beforehand, to plan which posted months to reverse before this write ever
 * runs — the migration's guard trigger is what actually enforces the result stays legal.
 */
export async function setInServiceSource(
  tx: Tx,
  orgId: string,
  id: string,
  input: { source: InServiceSource; inServiceOn?: string },
): Promise<void> {
  const updated = await tx
    .update(fixedAssets)
    .set({
      inServiceSource: input.source,
      ...(input.source === 'set' ? { inServiceOn: input.inServiceOn } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, orgId)))
    .returning({ id: fixedAssets.id });
  if (updated.length === 0) {
    throw recordGone(`setInServiceSource: asset ${id} does not exist in org ${orgId}`, 'asset');
  }
}
