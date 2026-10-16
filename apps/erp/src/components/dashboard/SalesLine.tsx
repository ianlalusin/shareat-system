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

function build(values: number[], max: number): [number, number][] {
  const n = values.length;
  return values.map((v, i) => {
    const x = n === 1 ? (i === 0 ? 0 : W) : (i * W) / (n - 1);
    const y = BASE - (max > 0 ? (v / max) * (BASE - TOP) : 0);
    return [x, y];
  });
}

const f = (n: number) => n.toFixed(1);

/**
 * Smooth curve through every point (monotone cubic, Fritsch-Carlson): it passes exactly through each day's
 * value and never overshoots between two days, so a zero day stays on the baseline and no bump rises above
 * the real busiest day.
 */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 3) return 'M ' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join(' L ');
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / dx[i]!);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = 'M ' + f(pts[0]![0]) + ' ' + f(pts[0]![1]);
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ' C ' + f(x0 + h) + ' ' + f(y0 + t[i]! * h) + ' ' + f(x1 - h) + ' ' + f(y1 - t[i + 1]! * h) + ' ' + f(x1) + ' ' + f(y1);
  }
  return d;
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
  const curPath = smoothPath(curPts);
  const prevPath = smoothPath(prevPts);
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
        <defs>
          {/* Low days deep red, the top days bright neon (Ian, 16 Oct). One chart per page, so a fixed id. */}
          <linearGradient id="sales-neon" gradientUnits="userSpaceOnUse" x1="0" y1={BASE} x2="0" y2={TOP}>
            <stop offset="0" stopColor="#8a0f22" />
            <stop offset="0.55" stopColor="#e3122f" />
            <stop offset="1" stopColor="#ff3b5c" />
          </linearGradient>
        </defs>
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
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          // Neon look (Ian, 16 Oct): thin bright red core plus a screen-space glow, so the SVG's
          // non-uniform scaling cannot stretch the blur.
          style={{
            stroke: 'url(#sales-neon)',
            filter: 'drop-shadow(0 0 2px rgba(255,31,68,0.9)) drop-shadow(0 0 7px rgba(255,31,68,0.55))',
          }}
        />
      </svg>
      <div className="dash-pop absolute h-0 w-0" style={{ left: peakX + '%', top: peakY * 100 + '%' }}>
        <span
          className="absolute -left-[6px] -top-[6px] h-3 w-3 rounded-full"
          style={{
            background: '#ff3b5c',
            boxShadow: '0 0 0 3px var(--canvas), 0 0 10px 4px rgba(255,59,92,0.75), 0 0 26px 10px rgba(255,59,92,0.35)',
          }}
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
          <span className="h-[2px] w-[22px] rounded-sm" style={{ background: 'linear-gradient(90deg, #8a0f22, #ff3b5c)' }} />
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
