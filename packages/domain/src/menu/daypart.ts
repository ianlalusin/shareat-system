/**
 * T-510 S2a - dayparts: a repeating weekly window on a menu offer (pure). docs/tasks/510-menu-dayparts.md R1, R3, R4.
 *
 * PURE: no database, no clock. Every function takes the instant and the store's IANA timezone (`stores.timezone`).
 *
 * A window is store-local wall clock: days of week (0 = Sunday .. 6), `start` and `end` as 'HH:MM'. `end < start` means
 * overnight, and an overnight window BELONGS TO THE DAY IT STARTS: Sunday 17:00-08:00 covers Sunday 17:00 through
 * Monday 07:59, so at Monday 03:00 the Sunday window applies and the Monday window (if any) does not. Start is
 * inclusive, end exclusive. `end === start` is refused.
 *
 * Timezone work is `Intl.DateTimeFormat` with an explicit `timeZone` (no new dependency). The business-day cut-off
 * (05:00) is a separate rule and not used here: a daypart is about price (R7).
 */

export interface DaypartWindow {
  readonly id: string;
  /** 0 = Sunday .. 6 = Saturday. The day the window STARTS on. */
  readonly days: readonly number[];
  /** Store-local 'HH:MM'. */
  readonly start: string;
  /** Store-local 'HH:MM'. Earlier than `start` means overnight; equal to `start` is refused. */
  readonly end: string;
}

export type DaypartInvalidReason =
  | 'days_empty'
  | 'days_duplicate'
  | 'days_out_of_range'
  | 'start_invalid'
  | 'end_invalid'
  | 'end_equals_start';

export type DaypartValidation = { readonly ok: true } | { readonly ok: false; readonly reason: DaypartInvalidReason };

/** 'HH:MM', or 'HH:MM:SS' as a Postgres `time` prints it. Seconds are accepted only when they are '00'. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::(00))?$/;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const DAY_MS = MINUTES_PER_DAY * 60_000;

/** 'HH:MM' (or 'HH:MM:00') as minutes since local midnight, or null when malformed. */
function minutesOf(hhmm: string): number | null {
  const m = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since midnight as the normalised 'HH:MM'. */
function hhmmOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function validateDaypart(w: DaypartWindow): DaypartValidation {
  if (w.days.length === 0) return { ok: false, reason: 'days_empty' };
  if (!w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, reason: 'days_out_of_range' };
  if (new Set(w.days).size !== w.days.length) return { ok: false, reason: 'days_duplicate' };
  const s = minutesOf(w.start);
  if (s === null) return { ok: false, reason: 'start_invalid' };
  const e = minutesOf(w.end);
  if (e === null) return { ok: false, reason: 'end_invalid' };
  if (e === s) return { ok: false, reason: 'end_equals_start' };
  return { ok: true };
}

const isValid = (w: DaypartWindow): boolean => validateDaypart(w).ok;

// ---- store-local time ------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat | null>();
/** The formatter for an explicit IANA zone, or null when the zone is missing or not a real zone. Never the machine zone. */
function formatterFor(timeZone: unknown): Intl.DateTimeFormat | null {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null;
  let f = formatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null;
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** Why the inputs cannot be used, or null when both are fine. The instant is checked first. */
function badInput(instantUtc: unknown, timeZone: unknown): 'invalid_instant' | 'invalid_time_zone' | null {
  if (!(instantUtc instanceof Date) || Number.isNaN(instantUtc.getTime())) return 'invalid_instant';
  return formatterFor(timeZone) === null ? 'invalid_time_zone' : null;
}

interface LocalParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday. */
  readonly dow: number;
  readonly minuteOfDay: number;
}

/** Callers have already passed `badInput`. */
function localParts(instant: Date, timeZone: string): LocalParts {
  const get: Record<string, number> = {};
  for (const p of formatterFor(timeZone)!.formatToParts(instant)) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  const year = get.year!;
  const month = get.month!;
  const day = get.day!;
  const hour = get.hour! % 24; // some engines print midnight as 24
  const minute = get.minute!;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: get.second!,
    dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minuteOfDay: hour * 60 + minute,
  };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(new Date(instantMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * A store-local wall-clock time as UTC instants (ms), ascending.
 * - An ordinary time gives one instant.
 * - A time that happens twice (clocks went back) gives both, so a boundary is never slept through.
 * - A time DST skips gives the transition itself: the first valid instant at or after the skipped time.
 */
function zonedToUtcAll(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number[] {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsets = [...new Set([offsetMs(guess - DAY_MS, timeZone), offsetMs(guess, timeZone), offsetMs(guess + DAY_MS, timeZone)])];
  const valid = [...new Set(offsets.map((o) => guess - o).filter((t) => offsetMs(t, timeZone) === guess - t))].sort((a, b) => a - b);
  if (valid.length > 0) return valid;
  // Skipped by a spring-forward: search for the transition between the instant read with the larger and with the smaller offset.
  let lo = guess - Math.max(...offsets);
  let hi = guess - Math.min(...offsets);
  const before = offsetMs(lo, timeZone);
  if (offsetMs(hi, timeZone) === before) return [hi];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return [hi];
}

// ---- containment -----------------------------------------------------------------------------------------------------

export function daypartContains(w: DaypartWindow, instantUtc: Date, timeZone: string): boolean {
  if (!isValid(w) || badInput(instantUtc, timeZone) !== null) return false; // fail closed
  const s = minutesOf(w.start)!;
  const e = minutesOf(w.end)!;
  const { dow, minuteOfDay: m } = localParts(instantUtc, timeZone);
  if (s < e) return w.days.includes(dow) && m >= s && m < e;
  // Overnight: the evening part belongs to today's window, the morning part to yesterday's.
  return (w.days.includes(dow) && m >= s) || (w.days.includes((dow + 6) % 7) && m < e);
}

// ---- overlap ---------------------------------------------------------------------------------------------------------

/** The window as half-open intervals of minutes on a Sunday-00:00-based week; a spill past Saturday wraps to the start. */
function weeklyIntervals(w: DaypartWindow): Array<[number, number]> {
  const s = minutesOf(w.start)!;
  const e = minutesOf(w.end)!;
  const length = e > s ? e - s : MINUTES_PER_DAY - s + e;
  const out: Array<[number, number]> = [];
  for (const d of w.days) {
    const from = d * MINUTES_PER_DAY + s;
    const to = from + length;
    if (to <= MINUTES_PER_WEEK) out.push([from, to]);
    else out.push([from, MINUTES_PER_WEEK], [0, to - MINUTES_PER_WEEK]);
  }
  return out;
}

/** True when some store-local instant is inside both windows. Adjacent windows (one ends where the other starts) do not overlap. */
export function daypartsOverlap(a: DaypartWindow, b: DaypartWindow): boolean {
  if (!isValid(a) || !isValid(b)) return false;
  const bs = weeklyIntervals(b);
  return weeklyIntervals(a).some(([af, at]) => bs.some(([bf, bt]) => af < bt && bf < at));
}

// ---- boundaries ------------------------------------------------------------------------------------------------------

interface Boundary {
  readonly at: Date;
  /** The store-local 'HH:MM' of the boundary. */
  readonly time: string;
}

/** The first window opening (`opensOnly`) or opening-or-closing strictly after `instantUtc`, scanning the coming 8 local days. Inputs already checked. */
function nextBoundary(windows: readonly DaypartWindow[], instantUtc: Date, timeZone: string, opensOnly: boolean): Boundary | null {
  const now = instantUtc.getTime();
  const today = localParts(instantUtc, timeZone);
  let best: Boundary | null = null;
  const consider = (instants: readonly number[], time: string): void => {
    for (const t of instants) {
      if (t > now && (best === null || t < best.at.getTime())) best = { at: new Date(t), time };
    }
  };
  for (const w of windows) {
    if (!isValid(w)) continue;
    const s = minutesOf(w.start)!;
    const e = minutesOf(w.end)!;
    const overnight = e < s;
    for (let off = -1; off <= 8; off++) {
      const day = new Date(Date.UTC(today.year, today.month - 1, today.day + off));
      if (!w.days.includes(day.getUTCDay())) continue;
      consider(zonedToUtcAll(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(s / 60), s % 60, timeZone), hhmmOf(s));
      if (opensOnly) continue;
      const endDay = overnight ? new Date(day.getTime() + DAY_MS) : day;
      consider(zonedToUtcAll(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), Math.floor(e / 60), e % 60, timeZone), hhmmOf(e));
    }
  }
  return best;
}

/**
 * The next UTC instant, strictly after `instantUtc`, at which any window opens or closes; null when there are no windows or
 * the time zone or instant is unusable. Use as `nextChangeAt`.
 */
export function nextDaypartBoundary(dayparts: readonly DaypartWindow[], instantUtc: Date, timeZone: string): Date | null {
  if (badInput(instantUtc, timeZone) !== null) return null;
  return nextBoundary(dayparts, instantUtc, timeZone, false)?.at ?? null;
}

// ---- which offer is live ---------------------------------------------------------------------------------------------

/** The fields the resolver reads; the offer row's price columns ride along untouched. */
export interface DaypartOfferRow {
  readonly id: string;
  readonly effectiveFrom: Date;
  readonly withdrawn: boolean;
  /** null = all day. */
  readonly daypartId: string | null;
}

export type LiveOfferInvalidReason =
  | 'mixed_all_day_and_daypart'
  | 'unknown_daypart'
  | 'invalid_daypart'
  | 'overlapping_dayparts'
  | 'tied_offers'
  | 'invalid_time_zone'
  | 'invalid_instant';

export type LiveOfferResult<O extends DaypartOfferRow> =
  | { readonly kind: 'offer'; readonly offer: O }
  | {
      readonly kind: 'not_offered_now';
      /** Store-local 'HH:MM' of the next window opening; null when nothing will open. */
      readonly availableFrom: string | null;
      /** That opening as a UTC instant (null when nothing will open). */
      readonly availableAt: Date | null;
      /** Store-local day of week (0 = Sunday .. 6) of that opening; null when nothing will open. */
      readonly availableDay: number | null;
    }
  | { readonly kind: 'invalid'; readonly reason: LiveOfferInvalidReason };

const NOTHING_AHEAD = { kind: 'not_offered_now', availableFrom: null, availableAt: null, availableDay: null } as const;

/**
 * R4 - which offer of ONE variant on ONE channel is live at `instantUtc`.
 *
 * Per daypart (null = all day) the latest offer with `effectiveFrom <= now` stands; if it is withdrawn that daypart offers
 * nothing. A variant with live dayparted offers resolves to the one whose window holds now, else "not offered now" with
 * `availableFrom` / `availableAt` / `availableDay` (the next window opening among its live dayparted offers only). A variant
 * with no live dayparted offer resolves to its live all-day offer. Everything that cannot be answered is `invalid`, never a
 * fallback to another price: a live all-day offer next to a live dayparted one (R3), a live offer whose daypart is unknown or
 * whose window is malformed, two live windows that both hold now, two latest offers tied on `effectiveFrom`, an unusable time
 * zone or instant. The reason never depends on the order of the input arrays.
 */
export function resolveLiveOffer<O extends DaypartOfferRow>(
  offers: readonly O[],
  dayparts: readonly DaypartWindow[],
  instantUtc: Date,
  timeZone: string,
): LiveOfferResult<O> {
  const bad = badInput(instantUtc, timeZone);
  if (bad) return { kind: 'invalid', reason: bad };

  const now = instantUtc.getTime();
  const latest = new Map<string | null, { at: number; rows: O[] }>();
  for (const o of offers) {
    const at = o.effectiveFrom.getTime();
    if (!(at <= now)) continue; // future (or unreadable) effectiveFrom: not in force
    const cur = latest.get(o.daypartId);
    if (!cur || at > cur.at) latest.set(o.daypartId, { at, rows: [o] });
    else if (at === cur.at) cur.rows.push(o);
  }
  if ([...latest.values()].some((g) => g.rows.length > 1)) return { kind: 'invalid', reason: 'tied_offers' };

  const standing = new Map<string | null, O>([...latest].map(([k, g]) => [k, g.rows[0]!]));
  const liveAllDay = standing.get(null);
  const allDay = liveAllDay && !liveAllDay.withdrawn ? liveAllDay : undefined;
  const liveDayparted = [...standing.entries()].filter(([id, o]) => id !== null && !o.withdrawn).map(([, o]) => o);

  if (allDay && liveDayparted.length > 0) return { kind: 'invalid', reason: 'mixed_all_day_and_daypart' };
  if (liveDayparted.length === 0) return allDay ? { kind: 'offer', offer: allDay } : NOTHING_AHEAD;

  const byId = new Map(dayparts.map((d) => [d.id, d]));
  const windows: DaypartWindow[] = [];
  for (const o of liveDayparted) {
    const w = byId.get(o.daypartId!);
    if (!w) return { kind: 'invalid', reason: 'unknown_daypart' };
    windows.push(w);
  }
  if (!windows.every(isValid)) return { kind: 'invalid', reason: 'invalid_daypart' };

  const holding = liveDayparted.filter((o) => daypartContains(byId.get(o.daypartId!)!, instantUtc, timeZone));
  if (holding.length > 1) return { kind: 'invalid', reason: 'overlapping_dayparts' };
  if (holding.length === 1) return { kind: 'offer', offer: holding[0]! };

  const next = nextBoundary(windows, instantUtc, timeZone, true);
  if (!next) return NOTHING_AHEAD;
  return { kind: 'not_offered_now', availableFrom: next.time, availableAt: next.at, availableDay: localParts(next.at, timeZone).dow };
}
