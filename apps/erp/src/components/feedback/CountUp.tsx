'use client';
/**
 * T-387 S5. A number that counts up once on mount. The SSR output and the first client render carry the
 * FINAL text, so the number is present without JS and under reduced motion nothing ever animates.
 * `text` is the formatted final value; `value` is its numeric form (for the animation only).
 */
import { useEffect, useRef, useState } from 'react';
import { countUpValue, initialDisplay } from './count-up';

export function CountUp({
  value,
  text,
  decimals = 2,
  durationMs = 1400,
  className,
}: {
  value: number;
  text: string;
  decimals?: number;
  durationMs?: number;
  className?: string;
}) {
  const [shown, setShown] = useState<string>(text);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = initialDisplay({ end: value, reducedMotion: reduced });
    if (start === value || !Number.isFinite(value)) {
      setShown(text);
      return;
    }
    const nf = new Intl.NumberFormat('en-PH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      setShown(t >= 1 ? text : nf.format(countUpValue({ start, end: value, t })));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [value, text, decimals, durationMs]);

  return <span className={className}>{shown}</span>;
}
