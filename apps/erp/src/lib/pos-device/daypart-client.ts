/**
 * T-559 R1 - the tablet's own copy of the daypart window logic (pure), so the ERP /pos can price lunch and dinner offline. Ported from the POS app's
 * T-510 S4b copy. A client file may not import the domain package (T-424 boundary), so this restates the part of packages/domain/src/menu/daypart.ts the
 * tablet needs: does a window hold an instant, when does the next window open or close, and which priced slot of a variant applies. The two are held
 * together by apps/erp/tests/t559-daypart-client.test.ts, which runs one table of instants x windows x zones through BOTH. NO imports from @shareat/*.
 * Change the domain file and that test goes red until this one follows.
 *
 * A window is store-local wall clock: days 0 = Sunday .. 6, `start` / `end` 'HH:MM'. `end < start` is overnight and belongs to the day it STARTS on.
 * Start inclusive, end exclusive. Anything malformed or unusable (zone, instant) fails closed: holds nothing, no boundary.
 */
export interface DaypartWindow { readonly days: readonly number[]; readonly start: string; readonly end: string }
/** The snapshot menu's `hours`: the store zone and the windows `slots` name. */
export interface DaypartHours { readonly timeZone: string; readonly dayparts: readonly (DaypartWindow & { readonly id: string })[] }
/** A store-channel offer as the projection sends it (the part of ChannelOffer this file reads). */
export type SlotOffer =
  | { readonly orderable: true; readonly amount: string | null; readonly bundleHeads: number | null; readonly extraHeadAmount: string | null }
  | { readonly orderable: false; readonly notOffered: string; readonly availableFrom?: string | null };
export type OrderableOffer = Extract<SlotOffer, { orderable: true }>;
/** A variant as far as pricing goes: `channels.store` is "live at fetch time"; `slots` (dayparted variants only) are every priced daypart, any time of day. */
export interface SlottedVariant { readonly channels: { readonly store: SlotOffer }; readonly slots?: readonly { readonly daypartId: string; readonly store: SlotOffer }[] }
export type SlotAnswer =
  | { orderable: true; offer: OrderableOffer }
  | { orderable: false; reason: string; availableFrom?: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::(00))?$/;
const DAY_MS = 86_400_000;

const minutesOf = (hhmm: string): number | null => {
  const m = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmmOf = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function valid(w: DaypartWindow): boolean {
  if (!Array.isArray(w.days) || w.days.length === 0 || new Set(w.days).size !== w.days.length) return false;
  if (!w.days.every((d: number) => Number.isInteger(d) && d >= 0 && d <= 6)) return false;
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
    } catch {
      f = null;
    }
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
    if (offsetMs(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return [hi];
}

/** Does the window hold this instant, in the store's zone? */
export function contains(w: DaypartWindow, instant: Date, timeZone: string): boolean {
  if (!valid(w) || !usable(instant, timeZone)) return false;
  const s = minutesOf(w.start)!, e = minutesOf(w.end)!;
  const { dow, minuteOfDay: m } = localParts(instant, timeZone);
  if (s < e) return w.days.includes(dow) && m >= s && m < e;
  return (w.days.includes(dow) && m >= s) || (w.days.includes((dow + 6) % 7) && m < e);
}

function scan(windows: readonly DaypartWindow[], instant: Date, timeZone: string, opensOnly: boolean): { at: Date; time: string } | null {
  if (!usable(instant, timeZone)) return null;
  const now = instant.getTime(), today = localParts(instant, timeZone);
  let best: { at: Date; time: string } | null = null;
  const consider = (instants: number[], time: string) => {
    for (const t of instants) if (t > now && (best === null || t < best.at.getTime())) best = { at: new Date(t), time };
  };
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
export const nextBoundary = (windows: readonly DaypartWindow[], instant: Date, timeZone: string): Date | null => scan(windows, instant, timeZone, false)?.at ?? null;

/** The next opening only (never a closing): its instant and store-local 'HH:MM'; null when none. */
export const nextOpening = (windows: readonly DaypartWindow[], instant: Date, timeZone: string): { at: Date; time: string } | null => scan(windows, instant, timeZone, true);

/** Only slots that carry a STORE row count (a daypart that prices just the online channel says nothing about the till). */
const storeSlots = (v: SlottedVariant) => (v.slots ?? []).filter((s) => s.store.orderable || s.store.notOffered !== 'no_offer');
export const hasStoreSlots = (v: SlottedVariant): boolean => storeSlots(v).length > 0;

/**
 * The store offer a variant has at `at`, answering exactly what the domain's `resolveLiveOffer` answers (held by the parity test).
 * No store slots: the server's `channels.store` (a menu without dayparts, or online-only dayparts, works unchanged).
 * Store slots: a WITHDRAWN row offers nothing (it is not live, so it never holds `at`: "not offered now"). Among the live rows, an unknown or malformed
 * window on ANY of them makes the whole variant unanswerable, and two windows holding `at` do too; the one window that holds `at` gives its offer.
 * Every failure is `no_price_for_this_time` (never another window's price); when it is only closed it also says when it opens.
 */
export function resolveSlot(v: SlottedVariant, hours: DaypartHours | undefined, at: Date): SlotAnswer {
  const rows = storeSlots(v);
  if (rows.length === 0) {
    const c = v.channels.store;
    if (c.orderable) return { orderable: true, offer: c };
    return { orderable: false, reason: c.notOffered, ...(c.availableFrom ? { availableFrom: c.availableFrom } : {}) };
  }
  const NO_PRICE: SlotAnswer = { orderable: false, reason: 'no_price_for_this_time' };
  if (!hours) return NO_PRICE;
  const live = rows.flatMap((s) => {
    if (!s.store.orderable && s.store.notOffered === 'withdrawn') return [];
    const w = hours.dayparts.find((d) => d.id === s.daypartId);
    return [{ s, w }];
  });
  if (live.some(({ w }) => !w || !valid(w))) return NO_PRICE;
  const holding = live.filter(({ w }) => contains(w!, at, hours.timeZone));
  if (holding.length > 1) return NO_PRICE;
  if (holding.length === 0) {
    const opening = nextOpening(live.map(({ w }) => w!), at, hours.timeZone);
    return { ...NO_PRICE, ...(opening ? { availableFrom: opening.time } : {}) } as SlotAnswer;
  }
  const only = holding[0]!.s.store;
  return only.orderable ? { orderable: true, offer: only } : { orderable: false, reason: only.notOffered };
}
