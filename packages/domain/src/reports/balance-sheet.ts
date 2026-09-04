/**
 * getBalanceSheet — the service layer over reportsRepo.getBalanceSheetLines, plus
 * getIncomeStatement for the current-earnings line (see §4 below).
 * docs/tasks/209-reporting-read-model-and-statements.md (T-209a).
 *
 * Thin, matching this codebase's own "why the service is thin" precedent
 * (packages/domain/src/ledger/post-entry.ts, packages/domain/src/reports/income-statement.ts):
 * the VIEW (packages/db/schema/views.ts) already decides what counts (posted/reversed
 * only, asset/liability/equity types) and how each is signed; this file's own job is:
 *
 *   1. Turn the caller's single `asOfDate` into the `{fromDate, toDate}` range
 *      `getBalanceSheetLines` needs — a balance sheet is a snapshot from inception, not a
 *      date range, and bible row 106 means there is never real data before an org's own
 *      creation, so an arbitrarily early `fromDate` constant is exact, not an approximation.
 *   2. Bucket the repo's per-account rows into the three named sections (Contract).
 *   3. Convert numeric(14,2) strings into `Money` (bible §6) and sum each section's total.
 *   4. ⭐ Fold the CURRENT, unclosed net income into `equity` as a derived line — see below.
 *      This is what makes `ties` (Assets == Liabilities + Equity) true at ANY date, not
 *      only immediately after a year-close.
 *   5. Carry the requested filter forward as `basis`, unchanged — same discipline as
 *      `getTrialBalance`'s own `basis` field.
 *
 * ### 4. Why a synthesised "Current period earnings" line, found while implementing, not planning
 *
 * A first draft computed `ties` as `assets == liabilities + equity` literally, over ONLY the
 * three balance-sheet types. It failed its own test the moment a posting touched an EXPENSE
 * account (e.g. ordinary depreciation: `Dr 6700 / Cr 1590`) — assets fell (1590 is a
 * contra-asset) but nothing on the liability/equity side moved, because the offsetting debit
 * landed in an expense account this statement does not include at all. That is not a bug in
 * the posting or the view; it is what "Assets = Liabilities + Equity" literally omits —
 * income and expense only become equity (via 3300 Retained earnings) at a formal year-close
 * (ADR-006), and this statement must tie on every ordinary business day between closes, not
 * only once a year. `docs/tasks/111-property-based-invariant-tests.md` proves the general
 * form (`Assets + Expenses = Liabilities + Equity + Income`) always holds; this is that same
 * identity, rearranged, rendered as a real line a reader can see rather than an internal
 * check — exactly the standard "Net income (current period)" line shown within Equity on any
 * interim balance sheet drawn before a formal close. Computed by calling `getIncomeStatement`
 * for the SAME range (inception → `asOfDate`, same `storeId`/`includeYearClose`) rather than
 * re-deriving revenue/expense signing a second time — Phase 6's own rule, §2.1: one query per
 * figure, never a second definition of the same number.
 */
import { reportsRepo, type Executor } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';
import { getIncomeStatement } from './income-statement';

/** Never a real transaction date in this project (bible row 106: v2 always starts from a
 *  zero point). Exact, not approximate, as the lower bound of "everything ever posted". */
const INCEPTION = '2000-01-01';

export interface BalanceSheetInput {
  orgId: string;
  /** Omit or pass null/undefined for "every store". */
  storeId?: string | null;
  /** Inclusive, YYYY-MM-DD. The snapshot date — a balance sheet has no "from". */
  asOfDate: string;
  /** Defaults to TRUE (ADR-006: a balance-sheet-style view includes the year-close entry
   *  by default — same reasoning and same default as the trial balance). */
  includeYearClose?: boolean;
}

export interface BalanceSheetLine {
  /** `null` for the one synthesised line — "Current period earnings" is not a ledger
   *  account and has no id/code (§4 above). */
  accountId: string | null;
  accountCode: string | null;
  accountName: string;
  /** Signed by the account's TYPE (bible row 106 / views.ts) — a negative line under
   *  `assetLines` IS a contra-asset account (e.g. 1590) reducing gross assets. */
  amount: Money;
}

export interface BalanceSheetBasis {
  orgId: string;
  storeId: string | null;
  asOfDate: string;
  includeYearClose: boolean;
}

export interface BalanceSheetResult {
  assetLines: BalanceSheetLine[];
  assets: Money;
  liabilityLines: BalanceSheetLine[];
  liabilities: Money;
  /** Includes one synthesised line, "Current period earnings" (§4), whenever it is
   *  non-zero — real ledger equity lines never include it themselves. */
  equityLines: BalanceSheetLine[];
  equity: Money;
  /** Assets == Liabilities + Equity, to the centavo, no tolerance — bible §16.1 invariant 9,
   *  true at any date because `equity` already folds in unclosed net income (§4). */
  ties: boolean;
  basis: BalanceSheetBasis;
}

function toLines(rows: reportsRepo.BalanceSheetRow[], type: reportsRepo.BalanceSheetRow['accountType']): BalanceSheetLine[] {
  return rows
    .filter((r) => r.accountType === type)
    .map((r) => ({
      accountId: r.accountId,
      accountCode: r.accountCode,
      accountName: r.accountName,
      amount: money(r.netAmount),
    }));
}

export async function getBalanceSheet(ex: Executor, input: BalanceSheetInput): Promise<BalanceSheetResult> {
  const storeId = input.storeId ?? null;
  const includeYearClose = input.includeYearClose ?? true;

  const [rows, incomeStatement] = await Promise.all([
    reportsRepo.getBalanceSheetLines(ex, {
      orgId: input.orgId,
      storeId,
      fromDate: INCEPTION,
      toDate: input.asOfDate,
      includeYearClose,
    }),
    // Same range and flags as this statement — §4 above. A year-close entry itself
    // transfers a CLOSED period's net income into 3300, so double-counting is not
    // possible: the closed period nets to zero here, and only the unclosed remainder
    // (this period's activity since the last close) survives into `currentEarnings`.
    getIncomeStatement(ex, {
      orgId: input.orgId,
      storeId,
      fromDate: INCEPTION,
      toDate: input.asOfDate,
      includeYearClose,
    }),
  ]);

  const assetLines = toLines(rows, 'asset');
  const liabilityLines = toLines(rows, 'liability');
  const equityLines = toLines(rows, 'equity');

  if (!equals(incomeStatement.netIncome, money('0'))) {
    equityLines.push({
      accountId: null,
      accountCode: null,
      accountName: 'Current period earnings (unclosed)',
      amount: incomeStatement.netIncome,
    });
  }

  const assets = add(...assetLines.map((l) => l.amount));
  const liabilities = add(...liabilityLines.map((l) => l.amount));
  const equity = add(...equityLines.map((l) => l.amount));

  return {
    assetLines,
    assets,
    liabilityLines,
    liabilities,
    equityLines,
    equity,
    ties: equals(assets, add(liabilities, equity)),
    basis: {
      orgId: input.orgId,
      storeId,
      asOfDate: input.asOfDate,
      includeYearClose,
    },
  };
}
