import { formatMoney, type Money } from '@shareat/core/money';

export interface SalesPeriodRow {
  period: string | null;
  storeId: string | null;
  storeName?: string;
  total: Money;
}

export interface SalesChannelRow {
  channelId: string | null;
  channelName: string;
  isRemittedDaily: boolean;
  total: Money;
}

export interface SalesModeRow {
  mode: 'unli' | 'ala_carte';
  total: Money;
}

const MODE_LABEL: Record<SalesModeRow['mode'], string> = { unli: 'Unlimited', ala_carte: 'À la carte' };

export function SalesReconciliationIndicator({
  reconciles,
  ledgerTotal,
  channelTotal,
  modeTotal,
}: {
  reconciles: boolean;
  ledgerTotal: Money;
  channelTotal: Money;
  modeTotal: Money;
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
      <p className={reconciles ? 'text-lg font-bold text-emerald-800 dark:text-emerald-200' : 'text-2xl font-extrabold uppercase tracking-wide text-red-800 dark:text-red-100'}>
        {reconciles ? 'Reconciles' : 'DOES NOT RECONCILE'}
      </p>
      <p className={reconciles ? 'mt-1 text-sm text-emerald-700 dark:text-emerald-300' : 'mt-1 text-base font-semibold text-red-800 dark:text-red-100'}>
        Ledger {formatMoney(ledgerTotal)} {reconciles ? '=' : '≠'} channels {formatMoney(channelTotal)} {reconciles ? '=' : '≠'} modes {formatMoney(modeTotal)}
      </p>
      {!reconciles ? (
        <p className="mt-2 text-sm text-red-800 dark:text-red-100">
          This should never happen — the channel/mode breakdown (from `sales_days`) and the
          ledger total (from `journal_lines`) have drifted. Stop and investigate.
        </p>
      ) : null}
    </div>
  );
}

export function SalesPeriodTable({ rows, total }: { rows: SalesPeriodRow[]; total: Money }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Period</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.period ?? r.storeId}-${i}`} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="px-3 py-1.5">{r.storeName ?? r.period ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.total)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function SalesChannelTable({ rows, total }: { rows: SalesChannelRow[]; total: Money }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Channel</th>
            <th className="px-3 py-2 font-medium">Remitted daily</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.channelId ?? "pos-corrections"} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="px-3 py-1.5">{r.channelName}</td>
              <td className="px-3 py-1.5 text-xs text-neutral-500">{r.isRemittedDaily ? 'Yes' : 'No — receivable'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.total)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2" colSpan={2}>Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function SalesModeTable({ rows, total }: { rows: SalesModeRow[]; total: Money }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[320px] border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Mode</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mode} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="px-3 py-1.5">{MODE_LABEL[r.mode]}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(r.total)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
