/**
 * T-387 S5. Pure date helpers for the editorial dashboard.
 * Business dates are inclusive 'YYYY-MM-DD' strings. Validation and day stepping come from
 * `@shareat/core/datetime` (`parseBusinessDate`, `addDays`); no helper here reads the clock or lifts a
 * date out of an instant.
 */
import { addDays, parseBusinessDate } from '@shareat/core/datetime';

const DAY_MS = 86_400_000;

/** Whole days since the epoch for a validated business date. Integer arithmetic only. */
function epochDay(d: string): number {
  const [y, m, dd] = parseBusinessDate(d).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd) / DAY_MS;
}

/** The range of the same day count that ends the day before `from`. Reversed or malformed input throws. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = dayCount(from, to);
  if (days < 1) throw new Error(`Reversed range: ${from}..${to}`);
  const f = parseBusinessDate(from);
  return { from: addDays(f, -days), to: addDays(f, -1) };
}

export type RangePreset = 'today' | '7d' | '30d' | 'mtd';

export const RANGE_PRESETS: ReadonlyArray<{ key: RangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'mtd', label: 'Month to date' },
];

/** Resolve a preset against today's business date. Unknown keys return null. */
export function presetRange(key: string | undefined, today: string): { from: string; to: string } | null {
  const t = parseBusinessDate(today);
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(t, -6), to: today };
    case '30d':
      return { from: addDays(t, -29), to: today };
    case 'mtd':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    default:
      return null;
  }
}

/** Every business date from `from` to `to` inclusive. Throws on a reversed or malformed range. */
export function eachDay(from: string, to: string): string[] {
  const n = dayCount(from, to);
  if (n < 1) throw new Error(`Reversed range: ${from}..${to}`);
  const f = parseBusinessDate(from);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(f, i));
  return out;
}

/** Inclusive day count; zero or negative when `to` is before `from`. Throws on malformed input. */
export function dayCount(from: string, to: string): number {
  return epochDay(to) - epochDay(from) + 1;
}

const MAX_RANGE_DAYS = 366;
const MIN_RANGE_START = '2000-01-01';

/** The range the page will use: a preset if `range` names one, else a valid from/to, else month to date. */
export function resolveRange(
  sp: { range?: string; from?: string; to?: string },
  today: string,
): { from: string; to: string; preset: RangePreset | null } {
  const p = presetRange(sp.range, today);
  if (p) return { ...p, preset: sp.range as RangePreset };
  const from = sp.from ?? today.slice(0, 7) + '-01';
  const to = sp.to ?? today;
  try {
    const prev = previousRange(from, to);
    // Cap: a year at most, and nothing before 2000 (the previous range must also stay on the calendar Postgres accepts).
    if (dayCount(from, to) > MAX_RANGE_DAYS || prev.from < MIN_RANGE_START) throw new Error('range out of bounds');
    return { from, to, preset: null };
  } catch {
    return { from: today.slice(0, 7) + '-01', to: today, preset: null };
  }
}

/** 'Tue 6 Oct' (weekday true) or '6 Oct'. UTC-pinned so no zone moves the day. */
export function shortDay(d: string, weekday = false): string {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-PH', {
    ...(weekday ? { weekday: 'short' as const } : {}),
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** 125000 -> '125,000.00'. Display only. */
export function fmtNum(n: number | string): string {
  return new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
}
