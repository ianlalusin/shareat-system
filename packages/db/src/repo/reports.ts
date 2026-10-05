/**
 * reports repo — the ONLY place reporting SQL is written (PROJECT_BIBLE.md §4.3).
 * docs/tasks/110-reporting-views-and-screens.md.
 *
 * Both functions here are READS: they take an `Executor` (a `Database` or an open `Tx`),
 * never require a transaction of their own (client.ts's own comment: "a transaction or
 * the base connection, for read paths that need no transaction"). Every figure comes
 * straight from `v_trial_balance` / `v_income_statement` (packages/db/schema/views.ts) —
 * this file adds nothing but the caller-supplied filter (org, store, date range,
 * year-close inclusion) and a second, small GROUP BY that collapses those views' own
 * per-entry-date rows into per-account totals for the requested range. No business rule
 * lives here — "is this a P&L account" and "which category" are already answered by the
 * view; this file never re-derives them.
 */
import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  journalEntries,
  journalLines,
  salesChannels,
  salesDayChannels,
  salesDays,
  vBalanceSheet,
  vIncomeStatement,
  vTrialBalance,
} from '../../schema';
import { add, isZero, money } from '@shareat/core/money';
import type { Executor } from '../client';

export interface DateRangeFilter {
  orgId: string;
  /** Omit or pass null/undefined for "every store". */
  storeId?: string | null;
  /** Inclusive, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive, YYYY-MM-DD. */
  toDate: string;
  /** Defaults to true — see the domain layer for the per-report DEFAULT policy
   * (ADR-006: a date-range P&L excludes it by default, a balance-sheet-style view
   * includes it by default). This repo function only applies whatever the caller says;
   * it does not decide the default. */
  includeYearClose?: boolean;
}

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: 'debit' | 'credit';
  /** Decimal string, numeric(14,2) — never a float (bible §6). */
  debitTotal: string;
  creditTotal: string;
  netBalance: string;
}

/**
 * Per-account debit/credit totals and the signed closing balance, for the given org,
 * optional store, and inclusive date range — Contract §2. Queries `v_trial_balance`,
 * which is itself grouped finer (by entry_date) than "per account" precisely so an
 * arbitrary range can be filtered here; this is the query that re-aggregates it back up
 * to one row per account. An account with NO activity at all in range is simply absent —
 * a NULL entry_date/etc never matched the WHERE, so GROUP BY never produced a row for it.
 * That is NOT the same as an account whose activity NETS to zero within range (e.g. a
 * year-close entry zeroing a revenue account, or a sale exactly offset by its own
 * reversal) — that account DID contribute rows, so it still appears here, correctly, with
 * debit_total/credit_total/net_balance of 0.00. Do not conflate "no row" with "zero
 * balance"; only the former means "never touched in this range". The domain layer decides
 * whether to still list every chart-of-accounts account or only active ones (Contract's
 * screen text — "an explicit ties/DOES NOT TIE indicator" — cares about the totals, not
 * about listing untouched accounts).
 */
export async function getTrialBalance(ex: Executor, filter: DateRangeFilter): Promise<TrialBalanceRow[]> {
  const includeYearClose = filter.includeYearClose ?? true;

  const conditions = [
    eq(vTrialBalance.orgId, filter.orgId),
    gte(vTrialBalance.entryDate, filter.fromDate),
    lte(vTrialBalance.entryDate, filter.toDate),
  ];
  if (filter.storeId) {
    conditions.push(eq(vTrialBalance.storeId, filter.storeId));
  }
  if (!includeYearClose) {
    conditions.push(ne(vTrialBalance.sourceType, 'year_close'));
  }

  const rows = await ex
    .select({
      accountId: vTrialBalance.accountId,
      accountCode: vTrialBalance.accountCode,
      accountName: vTrialBalance.accountName,
      accountType: vTrialBalance.accountType,
      normalBalance: vTrialBalance.normalBalance,
      debitTotal: sql<string>`coalesce(sum(${vTrialBalance.debitTotal}), 0)::numeric(14,2)`,
      creditTotal: sql<string>`coalesce(sum(${vTrialBalance.creditTotal}), 0)::numeric(14,2)`,
      netBalance: sql<string>`coalesce(sum(${vTrialBalance.netBalance}), 0)::numeric(14,2)`,
    })
    .from(vTrialBalance)
    .where(and(...conditions))
    .groupBy(
      vTrialBalance.accountId,
      vTrialBalance.accountCode,
      vTrialBalance.accountName,
      vTrialBalance.accountType,
      vTrialBalance.normalBalance,
    )
    .orderBy(vTrialBalance.accountCode);

  return rows as TrialBalanceRow[];
}

export type IncomeStatementCategory =
  | 'revenue'
  | 'cost_of_sales'
  | 'operating_expense'
  | 'other_income_expense'
  | 'other';

export interface IncomeStatementRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'income' | 'expense';
  category: IncomeStatementCategory;
  debitTotal: string;
  creditTotal: string;
  /** Signed by the account's TYPE (income credit-positive, expense debit-positive) —
   * see views.ts's top comment for why this, not normal_balance, is what makes
   * contra-revenue net correctly with zero account-specific logic here. */
  netAmount: string;
}

/**
 * Per-account income-statement rows for the given org, optional store, and inclusive
 * date range — Contract §3. Restricted to income/expense accounts by the view itself.
 * `category` is what lets the domain layer build revenue / cost-of-sales / operating-
 * expense / gross-profit / net-income without ANY hardcoded account list (exit-gate
 * condition 3, invariant 8).
 */
export async function getIncomeStatementLines(
  ex: Executor,
  filter: DateRangeFilter,
): Promise<IncomeStatementRow[]> {
  const includeYearClose = filter.includeYearClose ?? false;

  const conditions = [
    eq(vIncomeStatement.orgId, filter.orgId),
    gte(vIncomeStatement.entryDate, filter.fromDate),
    lte(vIncomeStatement.entryDate, filter.toDate),
  ];
  if (filter.storeId) {
    conditions.push(eq(vIncomeStatement.storeId, filter.storeId));
  }
  if (!includeYearClose) {
    conditions.push(ne(vIncomeStatement.sourceType, 'year_close'));
  }

  const rows = await ex
    .select({
      accountId: vIncomeStatement.accountId,
      accountCode: vIncomeStatement.accountCode,
      accountName: vIncomeStatement.accountName,
      accountType: vIncomeStatement.accountType,
      category: vIncomeStatement.category,
      debitTotal: sql<string>`coalesce(sum(${vIncomeStatement.debitTotal}), 0)::numeric(14,2)`,
      creditTotal: sql<string>`coalesce(sum(${vIncomeStatement.creditTotal}), 0)::numeric(14,2)`,
      netAmount: sql<string>`coalesce(sum(${vIncomeStatement.netAmount}), 0)::numeric(14,2)`,
    })
    .from(vIncomeStatement)
    .where(and(...conditions))
    .groupBy(
      vIncomeStatement.accountId,
      vIncomeStatement.accountCode,
      vIncomeStatement.accountName,
      vIncomeStatement.accountType,
      vIncomeStatement.category,
    )
    .orderBy(vIncomeStatement.category, vIncomeStatement.accountCode);

  return rows as IncomeStatementRow[];
}

export interface BalanceSheetRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'asset' | 'liability' | 'equity';
  debitTotal: string;
  creditTotal: string;
  /** Signed by the account's TYPE (asset debit-positive, liability/equity credit-positive) —
   * see views.ts's top comment. Never the account's own `normal_balance`. */
  netAmount: string;
}

/**
 * Per-account balance-sheet rows for the given org, optional store, and inclusive date
 * range — T-209a. Restricted to asset/liability/equity accounts by the view itself. The
 * domain layer passes `fromDate` as the earliest possible date and `toDate` as the
 * as-of date, because a balance sheet is a snapshot from inception, not a range — bible
 * row 106 means there is never real data before an org's own creation.
 */
export async function getBalanceSheetLines(ex: Executor, filter: DateRangeFilter): Promise<BalanceSheetRow[]> {
  const includeYearClose = filter.includeYearClose ?? true;

  const conditions = [
    eq(vBalanceSheet.orgId, filter.orgId),
    gte(vBalanceSheet.entryDate, filter.fromDate),
    lte(vBalanceSheet.entryDate, filter.toDate),
  ];
  if (filter.storeId) {
    conditions.push(eq(vBalanceSheet.storeId, filter.storeId));
  }
  if (!includeYearClose) {
    conditions.push(ne(vBalanceSheet.sourceType, 'year_close'));
  }

  const rows = await ex
    .select({
      accountId: vBalanceSheet.accountId,
      accountCode: vBalanceSheet.accountCode,
      accountName: vBalanceSheet.accountName,
      accountType: vBalanceSheet.accountType,
      debitTotal: sql<string>`coalesce(sum(${vBalanceSheet.debitTotal}), 0)::numeric(14,2)`,
      creditTotal: sql<string>`coalesce(sum(${vBalanceSheet.creditTotal}), 0)::numeric(14,2)`,
      netAmount: sql<string>`coalesce(sum(${vBalanceSheet.netAmount}), 0)::numeric(14,2)`,
    })
    .from(vBalanceSheet)
    .where(and(...conditions))
    .groupBy(vBalanceSheet.accountId, vBalanceSheet.accountCode, vBalanceSheet.accountName, vBalanceSheet.accountType)
    .orderBy(vBalanceSheet.accountType, vBalanceSheet.accountCode);

  return rows as BalanceSheetRow[];
}

export interface AccountEntryLine {
  entryId: string;
  entryDate: string;
  sourceType: string;
  sourceId: string;
  status: 'draft' | 'posted' | 'reversed';
  memo: string | null;
  lineMemo: string | null;
  storeId: string | null;
  partyType: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
}

/**
 * The drill-down — T-209c. Line-level, NOT aggregated: every journal line posted to one
 * account, for the given org/optional store/date range. `status in ('posted','reversed')`
 * matches every reporting view's own filter exactly (views.ts's top comment) so the sum of
 * what this returns never disagrees with the report line that linked here.
 */
export async function getAccountEntries(
  ex: Executor,
  filter: DateRangeFilter & { accountId: string },
): Promise<AccountEntryLine[]> {
  const includeYearClose = filter.includeYearClose ?? true;

  const conditions = [
    eq(journalEntries.orgId, filter.orgId),
    eq(journalLines.accountId, filter.accountId),
    gte(journalEntries.entryDate, filter.fromDate),
    lte(journalEntries.entryDate, filter.toDate),
    inArray(journalEntries.status, ['posted', 'reversed']),
  ];
  if (filter.storeId) {
    conditions.push(eq(journalLines.storeId, filter.storeId));
  }
  if (!includeYearClose) {
    conditions.push(ne(journalEntries.sourceType, 'year_close'));
  }

  const rows = await ex
    .select({
      entryId: journalEntries.id,
      entryDate: journalEntries.entryDate,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      status: journalEntries.status,
      memo: journalEntries.memo,
      lineMemo: journalLines.lineMemo,
      storeId: journalLines.storeId,
      partyType: journalLines.partyType,
      partyId: journalLines.partyId,
      debit: sql<string>`${journalLines.debit}::text`,
      credit: sql<string>`${journalLines.credit}::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(journalEntries.entryDate, journalLines.lineNo);

  return rows as AccountEntryLine[];
}

// -------------------------------------------------------------------------------------
// T-210 — sales reporting over the ledger. docs/tasks/210-sales-reporting-over-the-ledger.md.
// -------------------------------------------------------------------------------------

export type SalesRollupGrouping = 'day' | 'month' | 'store';

export interface SalesByPeriodRow {
  /** Set for groupBy 'day'/'month' (a date or 'YYYY-MM' string); null for 'store'. */
  period: string | null;
  /** Set for groupBy 'store'; null otherwise. */
  storeId: string | null;
  total: string;
}

/**
 * Recognised sales revenue (`4100`+`4150`, `source_type='sale'`), grouped by day, month, or
 * store. `status in ('posted','reversed')` matches every other view/query in this file — a
 * voided sales day's reversal entry inherits the ORIGINAL entry's `source_type` (`reverseEntry`),
 * so the pair nets to zero here exactly as it does everywhere else, with no special case.
 */
export async function getSalesByPeriod(
  ex: Executor,
  filter: { orgId: string; storeId?: string | null; fromDate: string; toDate: string; groupBy: SalesRollupGrouping },
): Promise<SalesByPeriodRow[]> {
  const groupExpr =
    filter.groupBy === 'month'
      ? sql`to_char(je.entry_date, 'YYYY-MM')`
      : filter.groupBy === 'store'
        ? sql`jl.store_id`
        : sql`je.entry_date`;

  const rows = (await ex.execute(sql`
    select
      ${groupExpr} as group_key,
      coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${filter.orgId}
      and je.source_type = 'sale'
      and je.status in ('posted', 'reversed')
      and je.entry_date >= ${filter.fromDate} and je.entry_date <= ${filter.toDate}
      and a.code in ('4100', '4150')
      ${filter.storeId ? sql`and jl.store_id = ${filter.storeId}` : sql``}
    group by ${groupExpr}
    order by ${groupExpr}
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    period: filter.groupBy === 'store' ? null : String(r.group_key),
    storeId: filter.groupBy === 'store' ? String(r.group_key) : null,
    total: Number(r.total).toFixed(2),
  }));
}

export interface SalesChannelRollupRow {
  /** Null only on the synthetic "POS corrections" line (T-375 R14). */
  channelId: string | null;
  channelName: string;
  isRemittedDaily: boolean;
  total: string;
}

export interface SalesModeRollupRow {
  mode: 'unli' | 'ala_carte';
  total: string;
}

/**
 * The channel and mode breakdown — from `sales_days`/`sales_day_channels`, `status='verified'`,
 * NOT from `journal_lines`. See the task doc §2: the revenue credit lines T-123 posts (`4100`/
 * `4150`) carry no channel party at all, so this dimension genuinely does not exist on the
 * ledger. `status='verified'` is an exact proxy for "posted and still standing" — `voidSalesDay`
 * always flips status to `voided` in the same transaction that reverses the entry — so this
 * carries the same posted-only guarantee `getSalesByPeriod` gets from `journal_lines` directly.
 * The domain layer asserts the two SUM to the same figure, which is the actual proof.
 */
export async function getSalesByChannelAndMode(
  ex: Executor,
  filter: { orgId: string; storeId?: string | null; fromDate: string; toDate: string },
): Promise<{ channels: SalesChannelRollupRow[]; modes: SalesModeRollupRow[] }> {
  const conditions = [
    eq(salesDays.orgId, filter.orgId),
    eq(salesDays.status, 'verified' as const),
    gte(salesDays.businessDate, filter.fromDate),
    lte(salesDays.businessDate, filter.toDate),
  ];
  if (filter.storeId) conditions.push(eq(salesDays.storeId, filter.storeId));

  const [channelRows, modeRows] = await Promise.all([
    ex
      .select({
        channelId: salesChannels.id,
        channelName: salesChannels.name,
        isRemittedDaily: salesChannels.isRemittedDaily,
        total: sql<string>`coalesce(sum(${salesDayChannels.amount}), 0)::numeric(14,2)`,
      })
      .from(salesDayChannels)
      .innerJoin(salesDays, eq(salesDayChannels.salesDayId, salesDays.id))
      .innerJoin(salesChannels, eq(salesDayChannels.channelId, salesChannels.id))
      .where(and(...conditions))
      .groupBy(salesChannels.id, salesChannels.name, salesChannels.isRemittedDaily)
      .orderBy(salesChannels.name),
    ex
      .select({
        unliSales: sql<string>`coalesce(sum(${salesDays.unliSales}), 0)::numeric(14,2)`,
        alaCarteSales: sql<string>`coalesce(sum(${salesDays.alaCarteSales}), 0)::numeric(14,2)`,
      })
      .from(salesDays)
      .where(and(...conditions)),
  ]);

  // T-375 S4 (R14). A FEED day's platform sales are typed channel rows composed into the day at verify (R8), so
  // they are in the ledger's 4150 but not in the day's own a la carte figure: add them to that mode. A POS correction
  // (S6) posts a delta to 4100/4150 under its own source id, and so does the reversal of a corrected day; both are
  // already in the ledger total, so they enter the modes (per account) and the channels (one synthetic line).
  // Refunds post to 4950, outside 4100/4150, so they enter neither side.
  const platformRows = await ex
    .select({ total: sql<string>`coalesce(sum(${salesDayChannels.amount}), 0)::numeric(14,2)` })
    .from(salesDayChannels)
    .innerJoin(salesDays, eq(salesDayChannels.salesDayId, salesDays.id))
    .innerJoin(salesChannels, eq(salesDayChannels.channelId, salesChannels.id))
    .where(and(...conditions, eq(salesDays.source, 'pos_v1_day_feed' as const), eq(salesChannels.isRemittedDaily, false)));
  const corrections = (await ex.execute(sql`
    select a.code as code, coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${filter.orgId}
      and je.source_type = 'sale'
      and je.status in ('posted', 'reversed')
      and je.entry_date >= ${filter.fromDate} and je.entry_date <= ${filter.toDate}
      and a.code in ('4100', '4150')
      and je.source_id in (select c.id::text from sales_day_pos_corrections c where c.org_id = ${filter.orgId})
      ${filter.storeId ? sql`and jl.store_id = ${filter.storeId}` : sql``}
    group by a.code
  `)) as unknown as { code: string; total: string }[];
  const correctionOf = (code: string) => money(corrections.find((r) => r.code === code)?.total ?? '0');
  const unliCorrection = correctionOf('4100');
  const alaCorrection = correctionOf('4150');

  const modeRow = modeRows[0];
  const channels = channelRows as SalesChannelRollupRow[];
  const correctionTotal = add(unliCorrection, alaCorrection);
  if (!isZero(correctionTotal)) {
    channels.push({ channelId: null, channelName: 'POS corrections', isRemittedDaily: false, total: String(correctionTotal) });
  }
  return {
    channels,
    modes: [
      { mode: 'unli', total: String(add(money(modeRow?.unliSales ?? '0'), unliCorrection)) },
      {
        mode: 'ala_carte',
        total: String(add(money(modeRow?.alaCarteSales ?? '0'), money(platformRows[0]?.total ?? '0'), alaCorrection)),
      },
    ],
  };
}
