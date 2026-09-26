import { formatMoney, type Money } from '@shareat/core/money';

export interface StoreComparisonColumn {
  storeId: string;
  storeName: string;
  /** T-346 S3 (DEF-428), §3.5 / R6.3 — the same three states as the `/admin/stores` list badge:
   *  `Not yet open — no opening date set` / `Opens {d}` / `Opened {d}`. Precomputed by the page
   *  (`storesRepo.isPreOpening`) rather than this presentational component importing `@shareat/db`. */
  openingLabel: string;
  revenue: Money;
  costOfSales: Money;
  grossProfit: Money;
  operatingExpenses: Money;
  operatingIncome: Money;
  otherIncomeExpense: Money;
  netIncome: Money;
}

/**
 * The per-store P&L comparison — T-209c. Summary figures only (revenue, cost of sales, gross
 * profit, operating expenses, operating income, other income/expense, net income) — the same
 * seven figures `IncomeStatementTable` shows, not a full line-item matrix, because two stores can
 * post to different accounts and a column-per-account layout would be inconsistent between them.
 * Every figure here is `IncomeStatementResult` unchanged (phase-6 plan §2.1) — this component
 * does no arithmetic beyond `formatMoney`.
 */
export function StoreComparisonTable({ stores }: { stores: StoreComparisonColumn[] }) {
  const rows: { label: string; key: keyof Omit<StoreComparisonColumn, 'storeId' | 'storeName' | 'openingLabel'>; emphasis?: boolean }[] = [
    { label: 'Revenue (net of contra)', key: 'revenue' },
    { label: 'Cost of sales', key: 'costOfSales' },
    { label: 'Gross profit', key: 'grossProfit', emphasis: true },
    { label: 'Operating expenses', key: 'operatingExpenses' },
    { label: 'Operating income', key: 'operatingIncome', emphasis: true },
    { label: 'Other income and expense', key: 'otherIncomeExpense' },
    { label: 'Net income', key: 'netIncome', emphasis: true },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Figure</th>
            {stores.map((s) => (
              <th key={s.storeId} className="px-3 py-2 text-right font-medium">
                {s.storeName}
                <span className="block text-xs font-normal text-neutral-500 dark:text-neutral-400">
                  {s.openingLabel}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={
                row.emphasis
                  ? 'border-y border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900'
                  : 'border-b border-neutral-100 last:border-0 dark:border-neutral-900'
              }
            >
              <td className="px-3 py-2">{row.label}</td>
              {stores.map((s) => (
                <td key={s.storeId} className="px-3 py-2 text-right tabular-nums">{formatMoney(s[row.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
