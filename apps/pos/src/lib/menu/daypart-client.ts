/**
 * T-510 S4b - the tablet's own copy of the daypart window logic (pure). A client file may not import the domain package (T-424 boundary),
 * so this restates the minimal part of packages/domain/src/menu/daypart.ts the tablet needs: does a window hold an instant, when does the next
 * window open or close. The two are held together by daypart-client.test.ts, which runs one table of instants x windows x zones through BOTH.
 * NO imports from @shareat/*. Change the domain file and that test goes red until this one follows.
 *
 * A window is store-local wall clock: days 0 = Sunday .. 6, `start` / `end` 'HH:MM'. `end < start` is overnight and belongs to the day it
 * STARTS on. Start inclusive, end exclusive. Anything malformed or unusable (zone, instant) fails closed: holds nothing, no boundary.
 */
export interface Window { readonly days: readonly number[]; readonly start: string; readonly end: string }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::(00))?$/;
const DAY_MS = 86_400_000;

const minutesOf = (hhmm: string): number | null => {
  const m = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmmOf = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function valid(w: Window): boolean {
  if (!Array.isArray(w.days) || w.days.length === 0 || new Set(w.days).size !== w.days.length) return false;
  if (!w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return false;
  const s = minutesOf(w.start), e = minutesOf(w.end);
  return s !== null && e !== null && s !== e;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatterFor(timeZone: unknown): Intl.DateTimeFormat | null {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null;
  let f = formatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch { f = null; }
    formatters.set(timeZone, f);
  }
  return f;
}
const usable = (instant: Date, timeZone: string): boolean => instant instanceof Date && !Number.isNaN(instant.getTime()) && formatterFor(timeZone) !== null;

interface Local { year: number; month: number; day: number; hour: number; minute: number; second: number; dow: number; minuteOfDay: number }
function localParts(instant: Date, timeZone: string): Local {
  const get: Record<string, number> = {};
  for (const p of formatterFor(timeZone)!.formatToParts(instant)) if (p.type !== 'literal') get[p.type] = Number(p.value);
  const hour = get.hour! % 24;
  return {
    year: get.year!, month: get.month!, day: get.day!, hour, minute: get.minute!, second: get.second!,
    dow: new Date(Date.UTC(get.year!, get.month! - 1, get.day!)).getUTCDay(), minuteOfDay: hour * 60 + get.minute!,
  };
}

const offsetMs = (ms: number, tz: string): number => {
  const p = localParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/** A store-local wall-clock time as UTC instants, ascending: one normally, both when clocks go back, the transition itself when DST skips it. */
function zonedToUtcAll(y: number, mo: number, d: number, h: number, mi: number, tz: string): number[] {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offsets = [...new Set([offsetMs(guess - DAY_MS, tz), offsetMs(guess, tz), offsetMs(guess + DAY_MS, tz)])];
  const ok = [...new Set(offsets.map((o) => guess - o).filter((t) => offsetMs(t, tz) === guess - t))].sort((a, b) => a - b);
  if (ok.length > 0) return ok;
  let lo = guess - Math.max(...offsets), hi = guess - Math.min(...offsets);
  const before = offsetMs(lo, tz);
  if (offsetMs(hi, tz) === before) return [hi];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(mid, tz) === before) lo = mid; else hi = mid;
  }
  return [hi];
}

/** Does the window hold this instant, in the store's zone? */
export function contains(w: Window, instant: Date, timeZone: string): boolean {
  if (!valid(w) || !usable(instant, timeZone)) return false;
  const s = minutesOf(w.start)!, e = minutesOf(w.end)!;
  const { dow, minuteOfDay: m } = localParts(instant, timeZone);
  if (s < e) return w.days.includes(dow) && m >= s && m < e;
  return (w.days.includes(dow) && m >= s) || (w.days.includes((dow + 6) % 7) && m < e);
}

function scan(windows: readonly Window[], instant: Date, timeZone: string, opensOnly: boolean): { at: Date; time: string } | null {
  if (!usable(instant, timeZone)) return null;
  const now = instant.getTime(), today = localParts(instant, timeZone);
  let best: { at: Date; time: string } | null = null;
  const consider = (instants: number[], time: string) => { for (const t of instants) if (t > now && (best === null || t < best.at.getTime())) best = { at: new Date(t), time }; };
  for (const w of windows) {
    if (!valid(w)) continue;
    const s = minutesOf(w.start)!, e = minutesOf(w.end)!;
    for (let off = -1; off <= 8; off++) {
      const day = new Date(Date.UTC(today.year, today.month - 1, today.day + off));
      if (!w.days.includes(day.getUTCDay())) continue;
      consider(zonedToUtcAll(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(s / 60), s % 60, timeZone), hhmmOf(s));
      if (opensOnly) continue;
      const endDay = e < s ? new Date(day.getTime() + DAY_MS) : day;
      consider(zonedToUtcAll(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), Math.floor(e / 60), e % 60, timeZone), hhmmOf(e));
    }
  }
  return best;
}

/** The next instant, strictly after `instant`, at which any window opens or closes; null when none or the zone/instant is unusable. */
export const nextBoundary = (windows: readonly Window[], instant: Date, timeZone: string): Date | null => scan(windows, instant, timeZone, false)?.at ?? null;

/** The next opening only (never a closing): its instant and store-local 'HH:MM'; null when none. */
export const nextOpening = (windows: readonly Window[], instant: Date, timeZone: string): { at: Date; time: string } | null => scan(windows, instant, timeZone, true);
