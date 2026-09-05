import { formatMoney, type Money } from '@shareat/core/money';

export type PosSideView =
  | { status: 'ok'; totalSales: Money; totalSessions: number }
  | { status: 'not_found' | 'not_configured' | 'unreachable'; message: string };

export type LedgerSideView =
  | { exists: true; status: string; totalSales: Money; posSourced: boolean }
  | { exists: false };

const POS_STATUS_LABEL: Record<string, string> = {
  not_found: 'No POS analytics for this store/date',
  not_configured: 'POS is not configured on this deployment',
  unreachable: 'POS could not be reached',
};

/**
 * The POS-day ↔ ledger reconciliation card — T-210. Every POS outcome is rendered as an
 * informational state, never an error page — `not_configured`/`unreachable` are expected,
 * first-class results (`POS_API_URL`/`POS_API_KEY` are optional), not failures.
 */
export function PosReconciliationCard({
  pos,
  ledger,
  matches,
  delta,
}: {
  pos: PosSideView;
  ledger: LedgerSideView;
  matches: boolean | null;
  delta: Money | null;
}) {
  const indicatorClass =
    matches === true
      ? 'border-2 border-emerald-600 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-950'
      : matches === false
        ? 'border-4 border-red-600 bg-red-100 dark:border-red-500 dark:bg-red-950'
        : 'border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <div className={`space-y-4 rounded-lg p-4 ${indicatorClass}`}>
      {matches !== null ? (
        <p className={matches ? 'text-lg font-bold text-emerald-800 dark:text-emerald-200' : 'text-2xl font-extrabold uppercase tracking-wide text-red-800 dark:text-red-100'}>
          {matches ? 'Matches' : 'DOES NOT MATCH'}
        </p>
      ) : (
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Not comparable</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">POS</p>
          {pos.status === 'ok' ? (
            <>
              <p className="text-xl font-semibold tabular-nums">{formatMoney(pos.totalSales)}</p>
              <p className="text-xs text-neutral-500">{pos.totalSessions} session(s)</p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">{POS_STATUS_LABEL[pos.status] ?? pos.message}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Shareat System</p>
          {ledger.exists ? (
            <>
              <p className="text-xl font-semibold tabular-nums">{formatMoney(ledger.totalSales)}</p>
              <p className="text-xs text-neutral-500">
                {ledger.status} · {ledger.posSourced ? 'POS-sourced' : 'manual'}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">No sales day recorded for this store/date.</p>
          )}
        </div>
      </div>

      {delta !== null ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Delta (POS − Shareat System): <span className="font-mono tabular-nums">{formatMoney(delta)}</span>
        </p>
      ) : null}
    </div>
  );
}
