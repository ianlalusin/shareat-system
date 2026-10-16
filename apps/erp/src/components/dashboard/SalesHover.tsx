'use client';

import { useState } from 'react';

/**
 * Hover read-out for the sales line (Ian, 16 Oct): a guide line and dot snap to the nearest day, and a
 * small card that follows the pointer's height shows that day's date and sales. Pointer events cover
 * mouse and touch. Purely visual: the chart's aria-label and the busiest-day callout carry the data.
 */
export interface SalesHoverPoint {
  day: string;
  text: string;
  /** 0..1 from the top of the plot. */
  y: number;
  /** T-421. This day's channel split, small, under the total. */
  channels?: { name: string; color: string; text: string }[];
}

export function SalesHover({ points }: { points: SalesHoverPoint[] }) {
  const [hit, setHit] = useState<{ i: number; py: number } | null>(null);
  const n = points.length;
  if (n === 0) return null;

  const xOf = (i: number) => (n === 1 ? 0.5 : i / (n - 1));

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setHit({ i: n === 1 ? 0 : Math.round(fx * (n - 1)), py: fy });
  }

  const p = hit ? points[hit.i]! : null;
  const x = hit ? xOf(hit.i) : 0;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-[300px] touch-pan-y sm:h-[360px]"
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={() => setHit(null)}
    >
      {p && hit ? (
        <>
          <span
            className="pointer-events-none absolute top-0 h-full w-px"
            style={{ left: x * 100 + '%', background: 'var(--brand-ink)', opacity: 0.35 }}
          />
          <span
            className="pointer-events-none absolute -ml-[4px] -mt-[4px] h-2 w-2 rounded-full"
            style={{
              left: x * 100 + '%',
              top: p.y * 100 + '%',
              background: 'var(--brand-ink)',
              boxShadow: '0 0 0 2px var(--canvas)',
            }}
          />
          <span
            className={
              'pointer-events-none absolute -translate-y-1/2 whitespace-nowrap rounded-md border-l-2 px-2 py-1 text-[12px] leading-tight tabular-nums text-ink shadow-md ' +
              (x > 0.7 ? '-translate-x-[calc(100%+10px)]' : 'translate-x-[10px]')
            }
            style={{
              left: x * 100 + '%',
              top: hit.py * 100 + '%',
              borderColor: 'var(--brand-ink)',
              // A brand-tinted card so it reads apart from the dark busiest-day callout, in either theme.
              background: 'color-mix(in srgb, var(--canvas) 88%, var(--brand-ink))',
            }}
          >
            <span className="block text-muted">{p.day}</span>
            <b className="font-display text-[14px]">₱{p.text}</b>
            {p.channels && p.channels.length > 0 ? (
              <span className="mt-1 block text-[11px] text-muted">
                {p.channels.map((c) => (
                  <span key={c.name} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: c.color }} />
                    {c.name} ₱{c.text}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
