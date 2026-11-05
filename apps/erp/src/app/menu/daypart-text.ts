/**
 * T-510 S3: how a daypart's days and hours read to a person. Plain words only ("Lunch", "from 17:00"), never "slot".
 * Days are 0 = Sunday .. 6 = Saturday in the data; a person reads Monday first.
 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const dayName = (d: number): string => LONG[d] ?? '';
export const dayShort = (d: number): string => SHORT[d] ?? '';

/** "Every day", "Mon to Fri" (a run of three or more days), or the days listed ("Sat, Sun"). */
export function daysText(days: readonly number[]): string {
  const have = new Set(days);
  const week = WEEK_ORDER.filter((d) => have.has(d));
  if (week.length === 7) return 'Every day';
  if (week.length === 0) return 'No days';
  // A run of 3+ neighbouring days (Mon..Sun order) reads as "Mon to Fri".
  const first = WEEK_ORDER.indexOf(week[0] as (typeof WEEK_ORDER)[number]);
  const isRun = week.every((d, i) => WEEK_ORDER[first + i] === d);
  if (week.length >= 3 && isRun) return `${dayShort(week[0] as number)} to ${dayShort(week[week.length - 1] as number)}`;
  return week.map(dayShort).join(', ');
}

/** "08:00 to 17:00", or "17:00 to 08:00 next day" when the window runs past midnight (end earlier than start). */
export function windowText(start: string, end: string): string {
  return `${start} to ${end}${end < start ? ' next day' : ''}`;
}
