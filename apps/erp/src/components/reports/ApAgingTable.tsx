import { formatMoney, type Money } from '@shareat/core/money';

export interface ApAgingTableRow {
  supplierId: string;
  supplierName: string;
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

/**
 * The AP aging register — docs/tasks/209-reporting-read-model-and-statements.md (T-209b).
 *
 * Presentation only — every figure was already computed by
 * packages/domain/src/reports/ap-aging.ts; this component does no arithmetic beyond
 * `formatMoney` at the display edge, same discipline as BalanceSheetTable/IncomeStatementTable.
 * A local reconciliation indicator, not the shared `TieIndicator`, for the same reason
 * `BalanceSheetTieIndicator` isn't: "total debits = total credits" is the wrong sentence here —
 * "aging total = control account" is the one this screen actually proves.
 */
export function ApAgingReconciliationIndicator({
  reconciles,
  agingTotal,
  controlBalance,
}: {
  reconciles: boolean;
  agingTotal: Money;
  controlBalance: Money;
}) {
  return (
    <div
      role="status"
      className={
        reconciles
          ? 'rounded-lg border-2 border-emerald-600 bg-emerald-50 p-4 dark:border-emerald-500 dark:bg-emerald-950'
          : 'rounded-lg border-4 border-red-600 bg-red-100 p-4 dark:border-red-500 dark:bg-red-950'
      }
    >
      <p
        className={
          reconciles
            ? 'text-lg font-bold text-emerald-800 dark:text-emerald-200'
            : 'text-2xl font-extrabold uppercase tracking-wide text-red-800 dark:text-red-100'
        }
      >
        {reconciles ? 'Reconciles' : 'DOES NOT RECONCILE'}
      </p>
      <p
        className={
          reconciles
            ? 'mt-1 text-sm text-emerald-700 dark:text-emerald-300'
            : 'mt-1 text-base font-semibold text-red-800 dark:text-red-100'
        }
      >
        Aging total {formatMoney(agingTotal)} {reconciles ? '=' : '≠'} control account (2110){' '}
        {formatMoney(controlBalance)}
      </p>
      {!reconciles ? (
        <p className="mt-2 text-sm text-red-800 dark:text-red-100">
          This should never happen — the subledger and the ledger have drifted. Stop and
          investigate before trusting any other figure on this screen.
        </p>
      ) : null}
    </div>
  );
}

function Row({ row }: { row: ApAgingTableRow }) {
  return (
    <tr className="border-t border-neutral-200 dark:border-neutral-800">
      <td className="px-3 py-1.5">{row.supplierName}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(row.current)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(row.d1to30)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(row.d31to60)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(row.d61to90)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(row.d90plus)}</td>
      <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatMoney(row.total)}</td>
    </tr>
  );
}

export interface ApAgingTotals {
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export function ApAgingTable({ rows, totals }: { rows: ApAgingTableRow[]; totals: ApAgingTotals }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Supplier</th>
            <th className="px-3 py-2 text-right font-medium">Current</th>
            <th className="px-3 py-2 text-right font-medium">1-30 days</th>
            <th className="px-3 py-2 text-right font-medium">31-60 days</th>
            <th className="px-3 py-2 text-right font-medium">61-90 days</th>
            <th className="px-3 py-2 text-right font-medium">90+ days</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.supplierId} row={row} />
          ))}
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.current)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.d1to30)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.d31to60)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.d61to90)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.d90plus)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
