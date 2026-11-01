import { formatMoney, type Money } from '@shareat/core/money';
import { LinkRow, RowLink } from '@/components/ui';

export interface PlatformAgingTableRow {
  channelId: string;
  channelName: string;
  storeLabel: string;
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export interface PlatformAgingTotalsView {
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

const CELL = 'px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400';

/** T-507 - "Due from delivery platforms": what Grab, Foodpanda and the like still owe, aged like the customer section. */
export function PlatformAgingSection({
  rows,
  totals,
  waitingForVerification,
  reconciles,
  controlBalance,
}: {
  rows: PlatformAgingTableRow[];
  totals: PlatformAgingTotalsView;
  waitingForVerification: number;
  reconciles: boolean;
  controlBalance: Money;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Due from delivery platforms</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Only verified sales days appear here. {waitingForVerification} day(s) with platform sales are waiting for verification.{' '}
        <a href="/sales-days?status=unverified" className="inline-flex min-h-11 items-center underline hover:no-underline">
          See the days waiting
        </a>
      </p>
      {!reconciles ? (
        <p role="status" className="text-sm font-semibold text-danger">
          DOES NOT RECONCILE: platform total {formatMoney(totals.total)} differs from the platform receivable accounts {formatMoney(controlBalance)}.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">No platform money is owed.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Platform</th>
                <th className="px-3 py-2 text-right font-medium">Current</th>
                <th className="px-3 py-2 text-right font-medium">1-30 days</th>
                <th className="px-3 py-2 text-right font-medium">31-60 days</th>
                <th className="px-3 py-2 text-right font-medium">61-90 days</th>
                <th className="px-3 py-2 text-right font-medium">90+ days</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LinkRow key={r.channelId} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-3 py-1.5">
                    <RowLink href={`/channel-settlements?channel=${r.channelId}`}>{r.channelName}</RowLink>{' '}
                    <span className="text-xs text-neutral-500">{r.storeLabel}</span>
                  </td>
                  <td className={CELL}>{formatMoney(r.current)}</td>
                  <td className={CELL}>{formatMoney(r.d1to30)}</td>
                  <td className={CELL}>{formatMoney(r.d31to60)}</td>
                  <td className={CELL}>{formatMoney(r.d61to90)}</td>
                  <td className={CELL}>{formatMoney(r.d90plus)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatMoney(r.total)}</td>
                </LinkRow>
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
      )}
    </section>
  );
}
