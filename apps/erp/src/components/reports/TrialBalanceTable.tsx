import { formatMoney, type Money } from '@shareat/core/money';

export interface TrialBalanceTableLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: Money;
  credit: Money;
  balance: Money;
}

/**
 * The trial balance table — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "account code, name, debits, credits, balance; totals row." Presentation only — every
 * figure it renders was already computed by packages/domain/src/reports/trial-balance.ts;
 * this component does no arithmetic beyond `formatMoney` at the display edge.
 */
export function TrialBalanceTable({
  lines,
  totalDebit,
  totalCredit,
}: {
  lines: TrialBalanceTableLine[];
  totalDebit: Money;
  totalCredit: Money;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Code</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
            <th className="px-3 py-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.accountId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
              <td className="px-3 py-2 font-mono text-neutral-500 dark:text-neutral-400">{line.accountCode}</td>
              <td className="px-3 py-2">{line.accountName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(line.debit)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(line.credit)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">{formatMoney(line.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2" colSpan={2}>
              Total
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalCredit)}</td>
            <td className="px-3 py-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
