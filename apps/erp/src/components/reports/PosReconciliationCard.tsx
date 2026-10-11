import { formatMoney, type Money } from '@shareat/core/money';

export type PosSideView =
  | { status: 'ok'; paidTotal: Money; receiptCount: number }
  | { status: 'not_found' }
  | { status: 'none' };

export type LedgerSideView =
  | { exists: true; status: string; totalSales: Money; source: 'legacy_typed' | 'pos_v1_day_feed' }
  | { exists: false };

const SIDE_LABEL: Record<'not_found' | 'none', string> = {
  not_found: 'POS had no analytics for this store/date',
  none: 'Nothing stored for this store/date',
};

function Side({ title, subtitle, side }: { title: string; subtitle?: string; side: PosSideView }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</p>
      {subtitle ? <p className="text-xs text-neutral-500">{subtitle}</p> : null}
      {side.status === 'ok' ? (
        <>
          <p className="text-xl font-semibold tabular-nums">{formatMoney(side.paidTotal)}</p>
          <p className="text-xs text-neutral-500">{side.receiptCount} receipt(s)</p>
        </>
      ) : (
        <p className="text-sm text-neutral-500">{SIDE_LABEL[side.status]}</p>
      )}
    </div>
  );
}

/**
 * The POS-day reconciliation card - T-210, converted by T-375 S6. Both POS columns are STORED feeds (nothing is fetched
 * at render): "Posted basis" is what the ledger holds (the import, or the latest correction), "Latest check" is the newest stored check. The sales day's
 * own total follows. `Check POS again` is the page's form, not this card's.
 */
export function PosReconciliationCard({
  postedBasis,
  latest,
  ledger,
  matches,
  delta,
}: {
  postedBasis: PosSideView;
  latest: PosSideView;
  ledger: LedgerSideView;
  matches: boolean | null;
  delta: Money | null;
}) {
  const indicatorClass =
    matches === true
      ? 'border-2 border-success bg-success-soft'
      : matches === false
        ? 'border-4 border-danger bg-danger-surface'
        : 'border border-surface-border bg-canvas';

  return (
    <div className={`space-y-4 rounded-lg p-4 ${indicatorClass}`}>
      {matches !== null ? (
        <p className={matches ? 'text-lg font-bold text-success' : 'text-2xl font-extrabold uppercase tracking-wide text-danger'}>
          {matches ? 'Matches' : 'DOES NOT MATCH'}
        </p>
      ) : (
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Not comparable</p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Side title="Posted basis" subtitle="What the ledger holds: the import, or the latest correction." side={postedBasis} />
        <Side title="Latest check" side={latest} />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Shareat System</p>
          {ledger.exists ? (
            <>
              <p className="text-xl font-semibold tabular-nums">{formatMoney(ledger.totalSales)}</p>
              <p className="text-xs text-neutral-500">
                {ledger.status} · {ledger.source === 'pos_v1_day_feed' ? 'POS-sourced' : 'typed'}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">No sales day recorded for this store/date.</p>
          )}
        </div>
      </div>

      {delta !== null ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Delta (latest check − posted basis): <span className="font-mono tabular-nums">{formatMoney(delta)}</span>
        </p>
      ) : null}
    </div>
  );
}
