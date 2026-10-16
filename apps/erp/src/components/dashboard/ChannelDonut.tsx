import { seriesColor } from './chart-colors';

/** T-387 S5. Sales by channel: a donut that fills in (CSS-only) beside a legend that carries every value as text. */
export function ChannelDonut({
  rows,
  subtitle,
}: {
  rows: Array<{ id: string; name: string; value: number; text: string; color?: string }>;
  subtitle: string;
}) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  let acc = 0;
  const arcs = rows.map((r, i) => {
    const pct = total > 0 ? (r.value / total) * 100 : 0;
    const arc = {
      ...r,
      pct,
      dash: pct.toFixed(3) + ' ' + (100 - pct).toFixed(3),
      offset: (-acc).toFixed(3),
      color: r.color ?? seriesColor(i),
    };
    acc += pct;
    return arc;
  });
  const top = arcs.reduce<(typeof arcs)[number] | null>((best, a) => (best === null || a.pct > best.pct ? a : best), null);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center gap-4 border-t-2 border-ink pt-3">
        <h2 className="m-0 font-display text-[28px] font-bold leading-none">By channel</h2>
        <span className="text-[13px] text-muted">{subtitle}</span>
      </div>
      <div className="flex flex-wrap items-center gap-8">
        <div className="relative h-[200px] w-[200px] flex-none">
          <svg viewBox="0 0 42 42" className="h-[200px] w-[200px] -rotate-90" aria-hidden="true">
            <circle cx="21" cy="21" r="15.915" fill="none" strokeWidth="5" style={{ stroke: 'var(--surface-border)' }} />
            {arcs.map((a, i) => (
              <circle
                key={a.id}
                className="dash-ring"
                cx="21"
                cy="21"
                r="15.915"
                fill="none"
                strokeWidth="5"
                strokeDasharray={a.dash}
                strokeDashoffset={a.offset}
                style={{ stroke: a.color, animationDelay: i * 150 + 'ms' }}
              />
            ))}
          </svg>
          {top ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <span className="font-display text-4xl font-bold leading-none">{top.pct.toFixed(0)}%</span>
              <span className="mt-1 text-[13px] text-muted">{top.name}</span>
            </div>
          ) : null}
        </div>
        <ul className="m-0 flex min-w-[180px] flex-1 list-none flex-col gap-3.5 p-0">
          {arcs.map((a) => (
            <li key={a.id} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 text-[15px]">
              <span className="h-3.5 w-3.5 rounded" style={{ background: a.color }} />
              <span className="font-semibold">{a.name}</span>
              <span className="text-muted tabular-nums">
                ₱{a.text} · {a.pct.toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
