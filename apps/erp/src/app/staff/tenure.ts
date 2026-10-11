/**
 * T-387 S7 - the tenure line on a staff card.
 *
 * Whole CALENDAR months once at least one has passed (the day of month decides), whole weeks from 7 days, whole
 * days under 7. A year or more is "N yr", plus " M mo" when months remain. Same day is "today"; a start date in
 * the future is "not started". Both arguments are business dates (`YYYY-MM-DD`).
 */
function parts(date: string): { y: number; m: number; d: number; utc: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d, utc: Date.UTC(y, m - 1, d) };
}

export function formatTenure(startedOn: string, today: string): string {
  const s = parts(startedOn);
  const t = parts(today);
  const days = Math.round((t.utc - s.utc) / 86_400_000);
  if (days < 0) return 'not started';
  if (days === 0) return 'today';

  const months = (t.y - s.y) * 12 + (t.m - s.m) - (t.d < s.d ? 1 : 0);
  if (months >= 12) {
    const yr = Math.floor(months / 12);
    const mo = months % 12;
    return mo > 0 ? `${yr} yr ${mo} mo` : `${yr} yr`;
  }
  if (months >= 1) return `${months} mo`;
  if (days >= 7) return `${Math.floor(days / 7)} wk`;
  return `${days} d`;
}
