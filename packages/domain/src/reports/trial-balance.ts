/**
 * getTrialBalance — the service layer over reportsRepo.getTrialBalance.
 * docs/tasks/110-reporting-views-and-screens.md.
 *
 * Thin, matching this codebase's own "why the service is thin" precedent
 * (packages/domain/src/ledger/post-entry.ts): the VIEW (packages/db/schema/views.ts)
 * already decides what counts (posted/reversed only) and how it's signed; the REPO
 * (packages/db/src/repo/reports.ts) already applies the filter and re-aggregates to
 * per-account totals. This file's only job is:
 *
 *   1. Decide the DEFAULT for `includeYearClose` — true, per ADR-006: a trial balance is
 *      closer to a balance-sheet-as-of than to a date-range P&L (it lists asset/liability/
 *      equity accounts too, not only income/expense), and ADR-006 requires those to
 *      INCLUDE the year-close entry by default. The income statement's own default is the
 *      opposite — see income-statement.ts.
 *   2. Convert the repo's raw numeric(14,2) strings into `Money` (bible §6 — no arithmetic
 *      on raw numbers in feature code) and sum the totals.
 *   3. Compute `ties` — Contract §2's whole point: `SUM(debit) = SUM(credit)`, exactly,
 *      no tolerance. Invariant 5 (a filter must never break the tie) is a property of the
 *      VIEW's grain (every filter here operates at the entry_date / store_id level, never
 *      splitting a single journal_entry's lines across the boundary — see views.ts's own
 *      comment) — this function does not special-case it; it just sums what comes back.
 *   4. Carry the requested filter forward as `basis`, unchanged — Contract §5: "Both must
 *      state their basis: the date range, which stores, and whether the year-close entry
 *      is included." The PAGE renders this; this function only reports what it actually
 *      queried, not what the caller asked for in some other shape.
 */
import { reportsRepo, type Executor } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';

export interface TrialBalanceInput {
  orgId: string;
  /** Omit or pass null/undefined for "every store". */
  storeId?: string | null;
  /** Inclusive, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive, YYYY-MM-DD. */
  toDate: string;
  /** Defaults to TRUE (ADR-006: balance-sheet-as-of semantics). */
  includeYearClose?: boolean;
}

export interface TrialBalanceLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: 'debit' | 'credit';
  debit: Money;
  credit: Money;
  balance: Money;
}

export interface TrialBalanceBasis {
  orgId: string;
  storeId: string | null;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
}

export interface TrialBalanceResult {
  lines: TrialBalanceLine[];
  totalDebit: Money;
  totalCredit: Money;
  /** The whole point of Contract §2 — SUM(debit) = SUM(credit), no tolerance. */
  ties: boolean;
  basis: TrialBalanceBasis;
}

export async function getTrialBalance(ex: Executor, input: TrialBalanceInput): Promise<TrialBalanceResult> {
  const storeId = input.storeId ?? null;
  const includeYearClose = input.includeYearClose ?? true;

  const rows = await reportsRepo.getTrialBalance(ex, {
    orgId: input.orgId,
    storeId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    includeYearClose,
  });

  const lines: TrialBalanceLine[] = rows.map((r) => ({
    accountId: r.accountId,
    accountCode: r.accountCode,
    accountName: r.accountName,
    accountType: r.accountType,
    normalBalance: r.normalBalance,
    debit: money(r.debitTotal),
    credit: money(r.creditTotal),
    balance: money(r.netBalance),
  }));

  const totalDebit = add(...lines.map((l) => l.debit));
  const totalCredit = add(...lines.map((l) => l.credit));

  return {
    lines,
    totalDebit,
    totalCredit,
    ties: equals(totalDebit, totalCredit),
    basis: {
      orgId: input.orgId,
      storeId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      includeYearClose,
    },
  };
}
