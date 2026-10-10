/**
 * T-387 S5. Pure date helpers for the editorial dashboard.
 * Business dates are inclusive 'YYYY-MM-DD' strings; arithmetic is UTC-only so no zone can move a day.
 */
const DAY_MS = 86_400_000;

function parse(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Not a business date: ${d}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t).toISOString().slice(0, 10);
  if (back !== d) throw new Error(`Not a real calendar date: ${d}`);
  return t;
}

function fmt(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** The range of the same day count that ends the day before `from`. Reversed or malformed input throws. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const f = parse(from);
  const t = parse(to);
  if (f > t) throw new Error(`Reversed range: ${from}..${to}`);
  const days = Math.round((t - f) / DAY_MS) + 1;
  return { from: fmt(f - days * DAY_MS), to: fmt(f - DAY_MS) };
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
  const t = parse(today);
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: fmt(t - 6 * DAY_MS), to: today };
    case '30d':
      return { from: fmt(t - 29 * DAY_MS), to: today };
    case 'mtd':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    default:
      return null;
  }
}

/** Every business date from `from` to `to` inclusive. Throws on a reversed or malformed range. */
export function eachDay(from: string, to: string): string[] {
  const f = parse(from);
  const t = parse(to);
  if (f > t) throw new Error(`Reversed range: ${from}..${to}`);
  const out: string[] = [];
  for (let x = f; x <= t; x += DAY_MS) out.push(fmt(x));
  return out;
}

export function dayCount(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS) + 1;
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
