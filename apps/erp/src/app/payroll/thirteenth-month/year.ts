/**
 * DEF-468: the 13th-month page's `?year=`. Absent means this year; anything else must be a four-digit year, or the person is told so
 * (the page used to preview this year for a blank or `abc`, which looks like an answer to the question they typed).
 */
export function parseYearParam(raw: string | undefined, currentYear: number): { year: number } | { error: string } {
  if (raw === undefined) return { year: currentYear };
  const year = /^\d{4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'The year must be a four-digit year, for example 2026.' };
  return { year };
}
