import { formatBusinessDateTime } from '@shareat/core/datetime';

/**
 * T-510 S3: how a daypart's days and hours read to a person. Plain words only ("Lunch", "from 5:00 PM"), never "slot".
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

/** "08:00" -> "8:00 AM", "17:30" -> "5:30 PM", "00:00" -> "12:00 AM". Anything that is not HH:MM comes back unchanged. */
export function time12(hhmm: string): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return hhmm;
  // The app's one date formatter, so a time reads like every other time on screen (the +08:00 pins the clock to Manila).
  return formatBusinessDateTime(new Date(`1970-01-01T${hhmm}:00+08:00`), { timeStyle: 'short' });
}

/** "8:00 AM to 5:00 PM", or "5:00 PM to 8:00 AM next day" when the window runs past midnight (end earlier than start). */
export function windowText(start: string, end: string): string {
  // Zero-padded HH:MM sorts as time; the default sort, not `<`, because a relational operator on strings is what the numeric write guard flags.
  const overnight = end !== start && [start, end].sort()[0] === end;
  return `${time12(start)} to ${time12(end)}${overnight ? ' next day' : ''}`;
}
