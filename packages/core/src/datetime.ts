/**
 * Dates, times, and the business day.
 *
 * PROJECT_BIBLE.md §6:
 *   - The database stores `timestamptz`, always UTC.
 *   - The business timezone is Asia/Manila, defined ONCE, imported everywhere.
 *   - Where a day boundary carries meaning, the row has an explicit `business_date`
 *     computed on write — never re-derived per query at read time.
 *
 * §12 landmine 7: server runtimes are UTC, so a bare `toLocaleTimeString` silently shifts
 * Philippine times by 8 hours. This module is the only sanctioned way to format or bucket
 * a business date on the server.
 *
 * §12 landmine 26: v1 had FOUR coexisting date idioms, one with no timezone pinning at
 * all. There is exactly one here. Do not add a second.
 */

/** The single business timezone. Everything day-shaped derives from this. */
export const BUSINESS_TIMEZONE = 'Asia/Manila' as const;

/** A calendar date in the business timezone, as `YYYY-MM-DD`. Maps to Postgres `date`. */
export type BusinessDate = string & { readonly __brand: 'BusinessDate' };

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The business date an instant falls on.
 *
 * Note this is a plain midnight-to-midnight boundary in Manila. If a module needs a
 * different cut-off (a sales day that closes at 4am, say), that belongs in that module as
 * an explicit, named rule — not as a quiet change to this function.
 */
export function toBusinessDate(instant: Date = new Date()): BusinessDate {
  return ymdFormatter.format(instant) as BusinessDate;
}

/** Days in a proleptic-Gregorian month. Plain integer arithmetic: a Date.UTC round-trip maps years 0-99 to the 1900s. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Parse a `YYYY-MM-DD` string, rejecting anything malformed rather than coercing.
 * Years are limited to 1900-2999: the helpers are only correct in that range (ICU reads the
 * Julian calendar before 1582, and 9999-12-31 rolls into year 10000 where toISOString goes expanded).
 */
export function parseBusinessDate(value: string): BusinessDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid business date: ${JSON.stringify(value)} (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`Invalid business date: ${value}`);
  }
  return value as BusinessDate;
}

/**
 * The UTC instant range covering a business date: [start, end).
 * Use a half-open range in queries so nothing is double-counted or missed at the boundary.
 */
export function businessDayRange(date: BusinessDate): { start: Date; end: Date } {
  const start = zonedMidnightToUtc(date);
  const next = addDays(date, 1);
  return { start, end: zonedMidnightToUtc(next) };
}

/** UTC instant for a calendar date/time. `Date.UTC` maps years 0-99 to 1900-1999; setUTCFullYear does not. */
function utcDate(y: number, m: number, d: number, h: number, mi: number, s: number): Date {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt;
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = utcDate(y, m, d, 0, 0, 0);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10) as BusinessDate;
}

/**
 * Midnight of a business date, as a UTC instant.
 *
 * The Philippines has had no DST since 1978 and a fixed +08:00 offset, but this resolves
 * the offset from the zone database rather than hardcoding it — a hardcoded offset is the
 * kind of assumption that survives right up until it does not.
 */
function zonedMidnightToUtc(date: BusinessDate): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = utcDate(y, m, d, 0, 0, 0).getTime();
  const offsetMs = zoneOffsetMs(new Date(guess));
  return new Date(guess - offsetMs);
}

function zoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = utcDate(
    get('year'),
    get('month'),
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  ).getTime();
  return asUtc - instant.getTime();
}

/** Format an instant for display in business time. Never use raw `toLocale*` on the server. */
export function formatBusinessDateTime(
  instant: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat('en-PH', {
    ...options,
    timeZone: BUSINESS_TIMEZONE,
  }).format(instant);
}
