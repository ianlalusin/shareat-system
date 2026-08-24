import { formatMoney, type Money } from '@shareat/core/money';

export interface IncomeStatementTableLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: Money;
}

/**
 * The income statement — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "revenue (net of contra), cost of sales, gross profit, operating expenses, net income."
 *
 * `operatingIncome` and `otherIncomeExpenseLines` are shown too, clearly separated below
 * operating expenses — see packages/domain/src/reports/income-statement.ts's top comment
 * for why: Contract's own invariant-10 "net income" formula has no term for header 7000
 * (interest, platform-settlement gains, wastage recovery, cash over/short), and hiding
 * those accounts entirely would reproduce the exact "posted P&L account invisible to the
 * P&L" defect this project exists to eliminate — just for a different subset of accounts.
 * `operatingIncome` is shown as its own line specifically so it is never confused with the
 * final `netIncome` figure.
 */
function LineRows({ lines }: { lines: IncomeStatementTableLine[] }) {
  if (lines.length === 0) {
    return (
      <tr>
        <td className="px-3 py-1.5 pl-8 text-neutral-400 dark:text-neutral-600" colSpan={2}>
          (none)
        </td>
      </tr>
    );
  }
  return (
    <>
      {lines.map((line) => (
        <tr key={line.accountId}>
          <td className="px-3 py-1.5 pl-8 text-neutral-600 dark:text-neutral-400">
            <span className="mr-2 font-mono text-xs text-neutral-400 dark:text-neutral-600">{line.accountCode}</span>
            {line.accountName}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
            {formatMoney(line.amount)}
          </td>
        </tr>
      ))}
    </>
  );
}

function SubtotalRow({ label, amount, emphasis = false }: { label: string; amount: Money; emphasis?: boolean }) {
  return (
    <tr
      className={
        emphasis
          ? 'border-y border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900'
          : 'border-t border-neutral-200 font-medium dark:border-neutral-800'
      }
    >
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(amount)}</td>
    </tr>
  );
}

export function IncomeStatementTable({
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
}: {
  revenueLines: IncomeStatementTableLine[];
  revenue: Money;
  costOfSalesLines: IncomeStatementTableLine[];
  costOfSales: Money;
  grossProfit: Money;
  operatingExpenseLines: IncomeStatementTableLine[];
  operatingExpenses: Money;
  operatingIncome: Money;
  otherIncomeExpenseLines: IncomeStatementTableLine[];
  otherIncomeExpense: Money;
  netIncome: Money;
}) {
  const hasOther = otherIncomeExpenseLines.length > 0;

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <tbody>
          <tr className="bg-neutral-50 dark:bg-neutral-900">
            <td className="px-3 py-2 font-semibold" colSpan={2}>
              Revenue
            </td>
          </tr>
          <LineRows lines={revenueLines} />
          <SubtotalRow label="Total revenue (net of contra)" amount={revenue} />

          <tr className="bg-neutral-50 dark:bg-neutral-900">
            <td className="px-3 py-2 font-semibold" colSpan={2}>
              Cost of sales
            </td>
          </tr>
          <LineRows lines={costOfSalesLines} />
          <SubtotalRow label="Total cost of sales" amount={costOfSales} />

          <SubtotalRow label="Gross profit" amount={grossProfit} emphasis />

          <tr className="bg-neutral-50 dark:bg-neutral-900">
            <td className="px-3 py-2 font-semibold" colSpan={2}>
              Operating expenses
            </td>
          </tr>
          <LineRows lines={operatingExpenseLines} />
          <SubtotalRow label="Total operating expenses" amount={operatingExpenses} />

          <SubtotalRow label="Operating income" amount={operatingIncome} emphasis />

          {hasOther ? (
            <>
              <tr className="bg-neutral-50 dark:bg-neutral-900">
                <td className="px-3 py-2 font-semibold" colSpan={2}>
                  Other income and expense
                </td>
              </tr>
              <LineRows lines={otherIncomeExpenseLines} />
              <SubtotalRow label="Total other income and expense" amount={otherIncomeExpense} />
            </>
          ) : null}

          <tr className="border-t-2 border-neutral-400 bg-neutral-100 text-base font-bold dark:border-neutral-600 dark:bg-neutral-800">
            <td className="px-3 py-3">Net income</td>
            <td className="px-3 py-3 text-right tabular-nums">{formatMoney(netIncome)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
