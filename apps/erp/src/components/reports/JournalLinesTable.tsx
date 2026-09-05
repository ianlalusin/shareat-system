import { formatMoney, type Money } from '@shareat/core/money';

export interface JournalLineRow {
  entryId: string;
  entryDate: string;
  sourceType: string;
  sourceId: string;
  status: 'draft' | 'posted' | 'reversed';
  memo: string | null;
  lineMemo: string | null;
  debit: Money;
  credit: Money;
}

/**
 * The drill-down table — T-209c. One row per journal LINE on the queried account, not per entry;
 * shows enough to identify the source document (date, source type, source id, memo) without
 * routing to that document's own screen (out of scope — see the task doc).
 */
export function JournalLinesTable({ rows, totalDebit, totalCredit }: { rows: JournalLineRow[]; totalDebit: Money; totalCredit: Money }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Memo</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.entryId}-${i}`} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="px-3 py-1.5 tabular-nums">{r.entryDate}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-neutral-500">
                {r.sourceType}
                {r.status === 'reversed' ? (
                  <span className="ml-2 rounded bg-red-100 px-1 py-0.5 text-red-800 dark:bg-red-950 dark:text-red-300">
                    reversed
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-1.5 text-neutral-600 dark:text-neutral-400">{r.lineMemo ?? r.memo ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(r.debit)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(r.credit)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2" colSpan={3}>Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalDebit)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(totalCredit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
