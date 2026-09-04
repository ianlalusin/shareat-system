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
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { vBalanceSheet, vIncomeStatement, vTrialBalance } from '../../schema';
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
