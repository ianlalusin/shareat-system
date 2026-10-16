/**
 * T-387 S5. The sales-by-day line: this range solid, the previous equal-length range dashed, the busiest
 * day marked. Server-rendered inline SVG; the draw-in motion is CSS-only and lives in globals.css inside
 * the no-preference block, so reduced motion gets the finished chart.
 */
import { SalesHover } from './SalesHover';

export interface SalesLinePoint {
  label: string;
  current: number;
  previous: number;
  /** Full date for the hover card, e.g. "Sat, Oct 10". */
  day?: string;
  /** Formatted sales for the hover card, without the peso sign. */
  text?: string;
  /** T-421. This day's channel split for the hover card, in donut order. */
  channels?: { name: string; color: string; text: string }[];
}

export interface SalesChannelLine {
  key: string;
  name: string;
  /** The donut's colour for this channel. */
  color: string;
  /** One value per point, in pesos; null breaks the line there (that day's split does not match the ledger). */
  values: (number | null)[];
  /** The negative "POS corrections" channel: thin dashed line. */
  dashed?: boolean;
}
export interface SalesLegendItem {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
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
  lines,
  legend,
  note,
}: {
  points: SalesLinePoint[];
  chartLabel: string;
  curName: string;
  prevName: string;
  peakText: string;
  peakLabel: string;
  /** T-421. One thin line per sales channel under the gross line. */
  lines?: SalesChannelLine[];
  legend?: SalesLegendItem[];
  note?: string;
}) {
  if (points.length === 0) return null;
  const chLines = lines ?? [];
  const hasLines = chLines.length > 0;
  const lineMax = Math.max(0, ...chLines.flatMap((l) => l.values.map((v) => v ?? 0)));
  const max = Math.max(...points.map((p) => Math.max(p.current, p.previous)), lineMax, 0);
  const cur = build(points.map((p) => p.current), max);
  const prev = build(points.map((p) => p.previous), max);
  // One day has one point: draw it as a flat segment so there is something to see.
  const curPts = points.length === 1 ? [cur[0]!, cur[0]!] : cur;
  const prevPts = points.length === 1 ? [prev[0]!, prev[0]!] : prev;
  const curPath = smoothPath(curPts);
  const prevPath = smoothPath(prevPts);

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

  // Thin channel lines: runs of consecutive days, so a null day leaves a gap. A lone day is a dot.
  const channelPaths = chLines.map((l) => {
    const pts = build(l.values.map((v) => v ?? 0), max).map(([x, y], i) => [x, Math.min(y, BASE), l.values[i] !== null] as const);
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    for (const [x, y, ok] of pts) {
      if (ok) run.push([x, y]);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    const d = runs.map((r) => (r.length === 1 ? smoothPath([r[0]!, r[0]!]) : smoothPath(r))).join(' ');
    return { l, d };
  });

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
        <path
          className="dash-fade"
          d={prevPath}
          fill="none"
          strokeWidth={hasLines ? '1.5' : '2'}
          strokeOpacity={hasLines ? '0.45' : undefined}
          strokeDasharray="6 6"
          vectorEffect="non-scaling-stroke"
          style={{ stroke: 'var(--muted)' }}
        />
        {channelPaths.map(({ l, d }) => (
          <path
            key={l.key}
            d={d}
            fill="none"
            strokeWidth="1.5"
            strokeOpacity="0.9"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={l.dashed ? '5 4' : undefined}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: l.color }}
          />
        ))}
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
      <SalesHover
        points={points.map((p, i) => ({
          day: p.day ?? p.label,
          text: p.text ?? String(p.current),
          y: Number(cur[i]![1]) / 360,
          channels: p.channels,
        }))}
      />
      <div className="dash-pop absolute h-0 w-0" style={{ left: peakX + '%', top: peakY * 100 + '%' }}>
        <span
          className="absolute -left-[7px] -top-[7px] h-3.5 w-3.5 rounded-full"
          style={{
            background: 'var(--brand-ink)',
            boxShadow: '0 0 0 4px var(--canvas)',
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
      {hasLines ? null : (
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
      )}
      {legend && legend.length > 0 ? (
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[13px] text-muted">
          <li className="inline-flex items-center gap-2">
            <span className="h-[3px] w-[18px] rounded-sm" style={{ background: 'var(--brand-ink)' }} />
            Gross sales
          </li>
          <li className="inline-flex items-center gap-2">
            <span className="h-0 w-[18px] border-t-2 border-dashed border-muted" />
            {prevName}
          </li>
          {legend.map((l) => (
            <li key={l.key} className="inline-flex items-center gap-2">
              <span
                className="h-0 w-[18px] border-t-[2px]"
                style={{ borderColor: l.color, borderTopStyle: l.dashed ? 'dashed' : 'solid' }}
              />
              {l.name}
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="m-0 mt-2 text-[13px] text-muted">{note}</p> : null}
    </figure>
  );
}
