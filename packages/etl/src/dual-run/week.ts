/**
 * T-392 S1 - week maths on date STRINGS (spec R1). A figure is placed in a week by its business date string
 * ('YYYY-MM-DD', Manila calendar), never by a timestamp. Pure; no "now", no local timezone.
 */
import { toBusinessDate } from '@shareat/core/datetime';

const DAY_MS = 86_400_000;

/** The calendar date of a UTC-midnight instant (08:00 in Manila, the same date), via the project's business-date helper. */
function fromUtcMs(ms: number): string {
  return toBusinessDate(new Date(ms));
}

/** 'YYYY-MM-DD' or v1's legacy 'YYYYMMDD' -> 'YYYY-MM-DD'; null for anything else or an impossible date. */
export function normaliseBusinessDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) || fromUtcMs(ms) !== iso ? null : iso;
}

function toUtcMs(date: string): number {
  const norm = normaliseBusinessDate(date);
  if (norm === null) throw new Error(`not a calendar date: ${JSON.stringify(date)}`);
  const [y, m, d] = norm.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, n: number): string {
  return fromUtcMs(toUtcMs(date) + n * DAY_MS);
}

/** The Monday of the week containing `date`. Throws on a non-date. */
export function weekStartOf(date: string): string {
  const ms = toUtcMs(date);
  const mondayBased = (new Date(ms).getUTCDay() + 6) % 7;
  return fromUtcMs(ms - mondayBased * DAY_MS);
}

/** Seven dates, Monday to Sunday, of the week beginning `weekStart`. */
export function datesInWeek(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * The Manila calendar date of an instant (the day rolls at 16:00 UTC). For provenance and a --through default ONLY;
 * it must never place a figure in a week.
 */
export function manilaDateOf(ms: number): string {
  return toBusinessDate(new Date(ms));
}
