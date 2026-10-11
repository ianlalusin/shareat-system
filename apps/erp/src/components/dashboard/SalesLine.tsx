/**
 * T-387 S5. The sales-by-day line: this range solid, the previous equal-length range dashed, the busiest
 * day marked. Server-rendered inline SVG; the draw-in motion is CSS-only and lives in globals.css inside
 * the no-preference block, so reduced motion gets the finished chart.
 */
export interface SalesLinePoint {
  label: string;
  current: number;
  previous: number;
}

const W = 1000;
const BASE = 350;
const TOP = 40;

function build(values: number[], max: number): string[] {
  const n = values.length;
  return values.map((v, i) => {
    const x = n === 1 ? (i === 0 ? 0 : W) : (i * W) / (n - 1);
    const y = BASE - (max > 0 ? (v / max) * (BASE - TOP) : 0);
    return x.toFixed(1) + ' ' + y.toFixed(1);
  });
}

export function SalesLine({
  points,
  chartLabel,
  curName,
  prevName,
  peakText,
  peakLabel,
}: {
  points: SalesLinePoint[];
  chartLabel: string;
  curName: string;
  prevName: string;
  peakText: string;
  peakLabel: string;
}) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => Math.max(p.current, p.previous)), 0);
  const cur = build(points.map((p) => p.current), max);
  const prev = build(points.map((p) => p.previous), max);
  // One day has one point: draw it as a flat segment so there is something to see.
  const curPts = points.length === 1 ? [cur[0]!, cur[0]!] : cur;
  const prevPts = points.length === 1 ? [prev[0]!, prev[0]!] : prev;
  const curPath = 'M ' + curPts.join(' L ');
  const prevPath = 'M ' + prevPts.join(' L ');
  const areaPath = curPath + ' L ' + W + ' ' + BASE + ' L 0 ' + BASE + ' Z';

  let peakIdx = 0;
  points.forEach((p, i) => {
    if (p.current > points[peakIdx]!.current) peakIdx = i;
  });
  const peakX = points.length === 1 ? 50 : (peakIdx / (points.length - 1)) * 100;
  const peakY = (BASE - (max > 0 ? (points[peakIdx]!.current / max) * (BASE - TOP) : 0)) / 360;
  const calloutRight = peakX > 60;

  const tickCount = Math.min(points.length, 7);
  const ticks =
    points.length === 1
      ? [points[0]!.label]
      : Array.from(
          { length: tickCount },
          (_, i) => points[Math.round((i * (points.length - 1)) / (tickCount - 1))]!.label,
        );

  return (
    <figure className="relative m-0 min-w-0">
      <svg
        viewBox={'0 0 ' + W + ' 360'}
        preserveAspectRatio="none"
        role="img"
        aria-label={chartLabel}
        className="block h-[300px] w-full overflow-visible sm:h-[360px]"
      >
        {[40, 143, 247].map((y) => (
          <line
            key={y}
            x1="0"
            x2={W}
            y1={y}
            y2={y}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--surface-border)' }}
          />
        ))}
        <line
          x1="0"
          x2={W}
          y1={BASE}
          y2={BASE}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          style={{ stroke: 'var(--ink)' }}
        />
        <path className="dash-fade-late" d={areaPath} fillOpacity="0.09" style={{ fill: 'var(--brand-ink)' }} />
        <path
          className="dash-fade"
          d={prevPath}
          fill="none"
          strokeWidth="2"
          strokeDasharray="6 6"
          vectorEffect="non-scaling-stroke"
          style={{ stroke: 'var(--muted)' }}
        />
        <path
          className="dash-line"
          d={curPath}
          pathLength={1}
          fill="none"
          strokeWidth="3.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ stroke: 'var(--brand-ink)' }}
        />
      </svg>
      <div className="dash-pop absolute h-0 w-0" style={{ left: peakX + '%', top: peakY * 100 + '%' }}>
        <span
          className="absolute -left-[7px] -top-[7px] h-3.5 w-3.5 rounded-full shadow-[0_0_0_4px_var(--canvas)]"
          style={{ background: 'var(--brand-ink)' }}
        />
        <span
          className={
            'absolute bottom-[18px] whitespace-nowrap rounded-[10px] bg-ink px-3 py-2 text-[13px] leading-snug text-canvas ' +
            (calloutRight ? 'right-0' : '-left-4')
          }
        >
          <b className="font-display text-lg">₱{peakText}</b>
          <br />
          {peakLabel}
        </span>
      </div>
      <div className="mt-2.5 flex justify-between text-xs text-muted tabular-nums">
        {ticks.map((t, i) => (
          <span key={t + '-' + i} className="min-w-0 text-center">
            {t}
          </span>
        ))}
      </div>
      <figcaption className="mt-3.5 flex gap-5 text-[13px] text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="h-[3px] w-[22px] rounded-sm" style={{ background: 'var(--brand-ink)' }} />
          {curName}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0 w-[22px] border-t-2 border-dashed border-muted" />
          {prevName}
        </span>
      </figcaption>
    </figure>
  );
}
