/** T-387 S5. The easing maths behind CountUp, kept pure so it is tested without a DOM. */
export function easeOutCubic(t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(1 - t, 3);
}

/** What the number shows before any animation frame: the final value under reduced motion, else the animation's start (0). */
export function initialDisplay(o: { end: number; reducedMotion: boolean }): number {
  return o.reducedMotion ? o.end : 0;
}

export function countUpValue(o: { start: number; end: number; t: number; reducedMotion?: boolean }): number {
  if (o.reducedMotion) return o.end;
  const t = Math.min(1, Math.max(0, o.t));
  if (t === 0) return o.start;
  if (t === 1) return o.end;
  return o.start + (o.end - o.start) * easeOutCubic(t);
}
