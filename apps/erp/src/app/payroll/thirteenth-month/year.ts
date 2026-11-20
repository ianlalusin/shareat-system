/**
 * DEF-468: the 13th-month page's `?year=`. Absent means this year; anything else must be a year from 2000 to 2099, or the person is told so
 * (the page used to preview this year for a blank or `abc`, which looks like an answer to the question they typed).
 */
export function parseYearParam(raw: string | undefined, currentYear: number): { year: number } | { error: string } {
  if (raw === undefined) return { year: currentYear };
  // 2000-2099 by shape, so no relational comparison on a number parsed from text (t371's NaN-blind rule).
  if (!/^20\d{2}$/.test(raw.trim())) return { error: 'The year must be a four-digit year, for example 2026.' };
  return { year: Number(raw.trim()) };
}
