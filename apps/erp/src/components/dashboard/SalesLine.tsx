/**
 * T-387 S5. The sales-by-day line: this range solid, the previous equal-length range dashed, the busiest
 * day marked. Server-rendered inline SVG; the draw-in motion is CSS-only and lives in globals.css inside
 * the no-preference block, so reduced motion gets the finished chart.
 */
import type { ReactNode } from 'react';
import { SalesHover } from './SalesHover';

export interface SalesLinePoint {
  label: string;
  current: number;
  previous: number;
  /** Full date for the hover card, e.g. "Sat, Oct 10". */
  day?: string;
  /** Formatted sales for the hover card, without the peso sign. */
  text?: string;
}

export interface SalesBarSegment {
  key: string;
  name: string;
  /** Pesos. Negative only for the "POS corrections" block, drawn hatched over the top of the stack. */
  value: number;
  /** A palette token string, the same one the donut uses for this channel. */
  color: string;
}
export interface SalesBar {
  segments: SalesBarSegment[];
}
export interface SalesLegendItem {
  key: string;
  name: string;
  color: string;
}

const W = 1000;
const BASE = 350;
const TOP = 40;

function build(values: number[], max: number, centred = false): [number, number][] {
  const n = values.length;
  return values.map((v, i) => {
    const x = centred ? ((i + 0.5) * W) / n : n === 1 ? (i === 0 ? 0 : W) : (i * W) / (n - 1);
    const y0 = BASE - (max > 0 ? (v / max) * (BASE - TOP) : 0);
    // With bars a net-negative day stays on the baseline (the hatch carries the negative part).
    return [x, centred ? Math.min(y0, BASE) : y0];
  });
}

const f = (n: number) => n.toFixed(1);
const peso = (v: number) =>
  '₱' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

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
  bars,
  legend,
  note,
}: {
  points: SalesLinePoint[];
  chartLabel: string;
  curName: string;
  prevName: string;
  peakText: string;
  peakLabel: string;
  /** T-421. One entry per point, aligned with `points`; an empty `segments` draws no stack for that day. */
  bars?: SalesBar[];
  legend?: SalesLegendItem[];
  note?: string;
}) {
  if (points.length === 0) return null;
  const hasBars = bars !== undefined && bars.length === points.length;
  const positiveSum = (b: SalesBar | undefined) => (b ? b.segments.reduce((n, s) => n + Math.max(s.value, 0), 0) : 0);
  const max = Math.max(
    ...points.map((p, i) => Math.max(p.current, p.previous, hasBars ? positiveSum(bars![i]) : 0)),
    0,
  );
  const cur = build(points.map((p) => p.current), max, hasBars);
  const prev = build(points.map((p) => p.previous), max, hasBars);
  // One day has one point: draw it as a flat segment so there is something to see.
  const flat = (p: [number, number]): [number, number][] => (hasBars ? [[0, p[1]], [W, p[1]]] : [p, p]);
  const curPts = points.length === 1 ? flat(cur[0]!) : cur;
  const prevPts = points.length === 1 ? flat(prev[0]!) : prev;
  const curPath = smoothPath(curPts);
  const prevPath = smoothPath(prevPts);
  const areaPath = hasBars
    ? curPath + ' L ' + f(curPts[curPts.length - 1]![0]) + ' ' + BASE + ' L ' + f(curPts[0]![0]) + ' ' + BASE + ' Z'
    : curPath + ' L ' + W + ' ' + BASE + ' L 0 ' + BASE + ' Z';

  let peakIdx = 0;
  points.forEach((p, i) => {
    if (p.current > points[peakIdx]!.current) peakIdx = i;
  });
  const peakX = hasBars
    ? ((peakIdx + 0.5) / points.length) * 100
    : points.length === 1
      ? 50
      : (peakIdx / (points.length - 1)) * 100;
  const peakY = (BASE - (max > 0 ? (points[peakIdx]!.current / max) * (BASE - TOP) : 0)) / 360;
  const calloutRight = peakX > 60;

  const tickCount = Math.min(points.length, 7);
  const tickIdx =
    points.length === 1
      ? [0]
      : Array.from({ length: tickCount }, (_, i) => Math.round((i * (points.length - 1)) / (tickCount - 1)));
  const ticks = tickIdx.map((i) => points[i]!.label);

  const scale = max > 0 ? (BASE - TOP) / max : 0;
  const band = W / points.length;
  const barW = band * 0.6;
  const hatchColors: string[] = [];
  const blocks: ReactNode[] = [];
  if (hasBars) {
    bars!.forEach((bar, i) => {
      const day = points[i]!.day ?? points[i]!.label;
      const x = (i + 0.5) * band - barW / 2;
      let top = BASE;
      for (const seg of bar.segments) {
        if (seg.value < 0) continue;
        const h = seg.value * scale;
        top -= h;
        blocks.push(
          <rect key={i + '-' + seg.key} x={f(x)} y={f(top)} width={f(barW)} height={f(h)} fill={seg.color} fillOpacity="0.85">
            <title>{day + ' · ' + seg.name + ' · ' + peso(seg.value)}</title>
          </rect>,
        );
      }
      for (const seg of bar.segments) {
        if (seg.value >= 0) continue;
        // Hatched, over the top of the stack: the solid part ends at the day's net total (the line's point).
        const lower = Math.min(cur[i]![1], BASE);
        const h = Math.min(-seg.value * scale, lower - TOP);
        let k = hatchColors.indexOf(seg.color);
        if (k < 0) k = hatchColors.push(seg.color) - 1;
        blocks.push(
          <rect key={i + '-' + seg.key} x={f(x)} y={f(lower - h)} width={f(barW)} height={f(h)} fill={'url(#sales-hatch-' + k + ')'}>
            <title>{day + ' · ' + seg.name + ' · ' + peso(seg.value)}</title>
          </rect>,
        );
      }
    });
  }

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
          {hatchColors.map((c, k) => (
            <pattern key={c} id={'sales-hatch-' + k} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" style={{ fill: 'var(--canvas)' }} fillOpacity="0.6" />
              <line x1="0" y1="0" x2="0" y2="6" strokeWidth="3" style={{ stroke: c }} />
            </pattern>
          ))}
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
        {blocks}
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
      <SalesHover
        points={points.map((p, i) => ({
          day: p.day ?? p.label,
          text: p.text ?? String(p.current),
          y: Number(cur[i]![1]) / 360,
        }))}
        centred={hasBars}
      />
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
      {hasBars ? (
        <div className="relative mt-2.5 h-4 text-xs text-muted tabular-nums">
          {ticks.map((t, k) => (
            <span
              key={t + '-' + k}
              className={
                'absolute top-0 whitespace-nowrap text-center ' +
                (k === 0 ? '' : k === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2')
              }
              style={{ left: ((tickIdx[k]! + 0.5) / points.length) * 100 + '%' }}
            >
              {t}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2.5 flex justify-between text-xs text-muted tabular-nums">
          {ticks.map((t, i) => (
            <span key={t + '-' + i} className="min-w-0 text-center">
              {t}
            </span>
          ))}
        </div>
      )}
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
      {legend && legend.length > 0 ? (
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[13px] text-muted">
          {legend.map((l) => (
            <li key={l.key} className="inline-flex items-center gap-2">
              <span className="h-3 w-3 rounded-sm" style={{ background: l.color }} />
              {l.name}
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="m-0 mt-2 text-[13px] text-muted">{note}</p> : null}
    </figure>
  );
}
