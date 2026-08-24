/**
 * getIncomeStatement — the service layer over reportsRepo.getIncomeStatementLines.
 * docs/tasks/110-reporting-views-and-screens.md.
 *
 * Buckets the repo's per-account rows into the Screen's named figures (Contract §5):
 * revenue (net of contra), cost of sales, gross profit, operating expenses, net income.
 * The bucketing key is `category`, which the VIEW already derived from each account's
 * PARENT HEADER (packages/db/schema/views.ts) — this file does not re-derive it and does
 * not hardcode a single account code anywhere. That is exit-gate condition 3 (invariant
 * 8): a new account posted under an existing header (4000/5000/6000/7000) appears here
 * with zero code change, because it already arrives in `rows` pre-categorised.
 *
 * ONE deliberate addition beyond the Contract's literal five figures, stated here rather
 * than silently: `operatingIncome` / `otherIncomeExpense` / `netIncome`. Contract's
 * invariant 10 defines "net income" as `revenue − contra − COGS − opex` — which, read
 * literally, is OPERATING income (it has no term for header 7000, "Other income and
 * expense" — interest, platform-settlement gains, wastage recovery, cash over/short).
 * docs/decisions/COA-ALIGNMENT.md §4.2 is explicit that those belong BELOW operating
 * profit but must still flow into TRUE net income ("net income is unchanged" when
 * reclassifying interest expense and loss-on-disposal out of OPEX). Silently leaving
 * header-7000 accounts off this report entirely would reproduce the exact defect class
 * this whole project exists to eliminate (bible §16.0: a posted P&L account invisible to
 * the P&L) — just for a different subset of accounts than v1's. So: `operatingIncome`
 * satisfies invariant 10's literal formula exactly (see the domain-level test), and
 * `netIncome = operatingIncome + otherIncomeExpense` is the fuller, standard-practice
 * figure. Both are returned; the screen shows both, clearly separated. See the task
 * report for the full reasoning.
 */
import { reportsRepo, type Executor } from '@shareat/db';
import { add, money, subtract, type Money } from '@shareat/core/money';

export interface IncomeStatementInput {
  orgId: string;
  /** Omit or pass null/undefined for "every store". */
  storeId?: string | null;
  /** Inclusive, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive, YYYY-MM-DD. */
  toDate: string;
  /** Defaults to FALSE (ADR-006: a date-range P&L excludes the year-close entry by
   * default; the trial balance's default is the opposite — see trial-balance.ts). */
  includeYearClose?: boolean;
}

export interface IncomeStatementLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Signed so revenue/other-income is positive-means-more, expense is
   * positive-means-more — matching v_income_statement's own net_amount convention. A
   * negative line under `revenueLines` IS a contra-revenue account netting downward. */
  amount: Money;
}

export interface IncomeStatementBasis {
  orgId: string;
  storeId: string | null;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
}

export interface IncomeStatementResult {
  revenueLines: IncomeStatementLine[];
  /** Net of contra (4900/4950 and any future contra-revenue account) — Contract §5. */
  revenue: Money;
  costOfSalesLines: IncomeStatementLine[];
  costOfSales: Money;
  grossProfit: Money;
  operatingExpenseLines: IncomeStatementLine[];
  operatingExpenses: Money;
  /** revenue − costOfSales − operatingExpenses — invariant 10's literal "net income". */
  operatingIncome: Money;
  otherIncomeExpenseLines: IncomeStatementLine[];
  /** Header 7000, net (income-positive) — see this file's top comment. */
  otherIncomeExpense: Money;
  /** operatingIncome + otherIncomeExpense — the fuller, standard-practice figure. */
  netIncome: Money;
  basis: IncomeStatementBasis;
}

function toLines(
  rows: reportsRepo.IncomeStatementRow[],
  category: reportsRepo.IncomeStatementCategory,
): IncomeStatementLine[] {
  return rows
    .filter((r) => r.category === category)
    .map((r) => ({
      accountId: r.accountId,
      accountCode: r.accountCode,
      accountName: r.accountName,
      amount: money(r.netAmount),
    }));
}

export async function getIncomeStatement(
  ex: Executor,
  input: IncomeStatementInput,
): Promise<IncomeStatementResult> {
  const storeId = input.storeId ?? null;
  const includeYearClose = input.includeYearClose ?? false;

  const rows = await reportsRepo.getIncomeStatementLines(ex, {
    orgId: input.orgId,
    storeId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    includeYearClose,
  });

  const revenueLines = toLines(rows, 'revenue');
  const costOfSalesLines = toLines(rows, 'cost_of_sales');
  const operatingExpenseLines = toLines(rows, 'operating_expense');
  const otherIncomeExpenseLines = toLines(rows, 'other_income_expense');
  // category='other' (an account with no recognised parent header) is deliberately not
  // surfaced as its own screen section — Contract §5 names exactly five figures, and no
  // account in the seeded chart of accounts can produce this category today (every leaf
  // parents to one of the seven fixed headers). See the task report.

  const revenue = add(...revenueLines.map((l) => l.amount));
  const costOfSales = add(...costOfSalesLines.map((l) => l.amount));
  const grossProfit = subtract(revenue, costOfSales);
  const operatingExpenses = add(...operatingExpenseLines.map((l) => l.amount));
  const operatingIncome = subtract(grossProfit, operatingExpenses);
  const otherIncomeExpense = add(...otherIncomeExpenseLines.map((l) => l.amount));
  const netIncome = add(operatingIncome, otherIncomeExpense);

  return {
    revenueLines,
    revenue,
    costOfSalesLines,
    costOfSales,
    grossProfit,
    operatingExpenseLines,
    operatingExpenses,
    operatingIncome,
    otherIncomeExpenseLines,
    otherIncomeExpense,
    netIncome,
    basis: {
      orgId: input.orgId,
      storeId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      includeYearClose,
    },
  };
}
