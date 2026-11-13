/**
 * T-559 R3 - the shell's menu clock. The tablet prices from the cached snapshot menu and its own clock, so the priced views must re-render exactly when a
 * daypart window opens or closes, when the app comes back to the front (a tablet that slept across 17:00) and when it comes back online. No network, no React:
 * `useMenuClock` (use-menu-clock.ts) is a thin wrapper. One timer wakes at the earliest of the next window boundary the menu's own `hours` give and the cached
 * `nextChangeAt` (a scheduled price change); only a positive delay arms it. Tick, then re-arm (the menu may not have changed, so nothing else would).
 */
import { nextBoundary, type DaypartHours } from '@/lib/pos-device/daypart-client';

/** setTimeout wraps above this and would fire at once; clamp, the early tick is harmless. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Milliseconds until the next moment the priced views can change, or null when nothing is ahead. Never 0 or negative. */
export function msUntilRecompute(hours: DaypartHours | undefined, nextChangeAt: string | null, now: number): number | null {
  const ahead: number[] = [];
  if (hours) {
    const b = nextBoundary(hours.dayparts, new Date(now), hours.timeZone);
    if (b) ahead.push(b.getTime() - now);
  }
  if (nextChangeAt) ahead.push(Date.parse(nextChangeAt) - now);
  const positive = ahead.filter((ms) => Number.isFinite(ms) && ms > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
}

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
export interface ClockDeps {
  hours: DaypartHours | undefined;
  nextChangeAt: string | null;
  onTick: () => void;
  now?: () => number;
  /** The page, for `visibilitychange`. `null` or absent on a server. */
  doc?: (Target & { visibilityState: string }) | null;
  /** The window, for `online`. */
  win?: Target | null;
}

/** Starts the clock; returns stop(). */
export function startClock(d: ClockDeps): () => void {
  const now = d.now ?? Date.now;
  const doc = d.doc === undefined ? (typeof document === 'undefined' ? null : document) : d.doc;
  const win = d.win === undefined ? (typeof window === 'undefined' ? null : window) : d.win;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const ms = msUntilRecompute(d.hours, d.nextChangeAt, now());
    if (ms !== null) {
      timer = setTimeout(() => {
        if (stopped) return;
        d.onTick();
        arm();
      }, Math.min(ms, MAX_TIMEOUT_MS));
    }
  };
  const wake = () => {
    if (stopped) return;
    d.onTick();
    arm();
  };
  const onVisible = () => {
    if (doc?.visibilityState === 'visible') wake();
  };
  doc?.addEventListener('visibilitychange', onVisible);
  win?.addEventListener('online', wake);
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    doc?.removeEventListener('visibilitychange', onVisible);
    win?.removeEventListener('online', wake);
  };
}
