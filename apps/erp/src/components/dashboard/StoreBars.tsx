import { seriesColor } from './chart-colors';

/** T-387 S5. Share of sales per store as horizontal bars (CSS-only grow-in). Rendered only when more than one store is in scope. */
export function StoreBars({
  rows,
  subtitle,
}: {
  rows: Array<{ id: string; name: string; value: number; text: string }>;
  subtitle: string;
}) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center gap-4 border-t-2 border-ink pt-3">
        <h2 className="m-0 font-display text-[28px] font-bold leading-none">By store</h2>
        <span className="text-[13px] text-muted">{subtitle}</span>
      </div>
      {rows.map((r, i) => {
        const pct = total > 0 ? (r.value / total) * 100 : 0;
        return (
          <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5">
            <span className="font-display text-[26px] font-bold leading-none">{r.name}</span>
            <span className="text-base font-bold tabular-nums">
              ₱{r.text} <span className="font-medium text-muted">· {pct.toFixed(0)}%</span>
            </span>
            <span className="col-span-2 block h-2.5 overflow-hidden rounded-full bg-surface-border">
              <span
                className="dash-bar block h-full rounded-full"
                style={{ width: pct + '%', background: seriesColor(i), animationDelay: i * 120 + 'ms' }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}
