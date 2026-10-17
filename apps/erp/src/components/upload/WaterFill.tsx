'use client';

/**
 * T-441 - the water that fills the upload shape. `percent` is the REAL upload percentage (0-99 while sending); `null` means
 * "cannot be measured" and the water rests at a low level with a slow ripple, never a made-up number.
 *
 * Theme tokens only (`--progress` over `--progress-soft`). The wave drifts sideways under `motion-safe:` only; under
 * reduced motion it is a flat level with no animation - the words still carry the percentage.
 */
export function WaterFill({ percent }: { percent: number | null }) {
  const level = percent === null ? 35 : Math.max(0, Math.min(100, percent));
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ backgroundColor: 'var(--progress-soft)' }} aria-hidden="true">
      <div
        className="absolute inset-x-0 bottom-0 transition-[height] duration-300 ease-out"
        style={{ height: `${level}%`, backgroundColor: 'var(--progress)', opacity: 0.85 }}
      >
        {/* The wave: a strip twice the shape's width so sliding it by half loops seamlessly. */}
        <svg
          className={`absolute -top-2 left-0 h-3 w-[200%] motion-safe:animate-water-drift ${percent === null ? 'motion-safe:animate-pulse' : ''}`}
          viewBox="0 0 200 12"
          preserveAspectRatio="none"
        >
          <path d="M0 6 Q 12.5 0 25 6 T 50 6 T 75 6 T 100 6 T 125 6 T 150 6 T 175 6 T 200 6 V12 H0 Z" style={{ fill: 'var(--progress)' }} />
        </svg>
      </div>
    </div>
  );
}
