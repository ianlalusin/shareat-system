/**
 * T-510 S4b - the menu clock. The adapter prices from the cached menu and the device clock, so the screens must re-adapt exactly when a daypart
 * window opens or closes, and when the app comes back to the front (a tablet that slept across 17:00). No network, no React: `useAdaptedAt`
 * (useErpMenu.ts) is a thin wrapper. The timer wakes at the earliest of the next window boundary the menu's own `hours` give and the cached
 * `nextChangeAt`; only a positive delay arms it. Tick, then re-arm (the menu may not have changed, so nothing else would).
 */
import { nextBoundary } from './daypart-client';
import type { ErpMenu as StoreMenuV2 } from './types';

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout wraps above this and would fire at once; clamp, the early tick is harmless

/** Milliseconds until the next moment the adapted menu can change, or null when nothing is ahead. Never 0 or negative. */
export function msUntilRecompute(menu: StoreMenuV2 | null, nextChangeAt: string | null, now: number): number | null {
  const ahead: number[] = [];
  if (menu?.hours) {
    const b = nextBoundary(menu.hours.dayparts, new Date(now), menu.hours.timeZone);
    if (b) ahead.push(b.getTime() - now);
  }
  if (nextChangeAt) ahead.push(Date.parse(nextChangeAt) - now);
  const positive = ahead.filter((ms) => Number.isFinite(ms) && ms > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
}

export interface ClockDeps {
  menu: StoreMenuV2 | null;
  nextChangeAt: string | null;
  onTick: () => void;
  now?: () => number;
  /** The page, for `visibilitychange`. Absent on a server. */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

/** Starts the clock; returns stop(). */
export function startClock(d: ClockDeps): () => void {
  const now = d.now ?? Date.now;
  const doc = d.doc === undefined ? (typeof document === 'undefined' ? null : document) : d.doc;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const ms = msUntilRecompute(d.menu, d.nextChangeAt, now());
    if (ms !== null) timer = setTimeout(() => { if (!stopped) { d.onTick(); arm(); } }, Math.min(ms, MAX_TIMEOUT_MS));
  };
  const onVisible = () => { if (!stopped && doc?.visibilityState === 'visible') { d.onTick(); arm(); } };
  doc?.addEventListener('visibilitychange', onVisible);
  arm();
  return () => { stopped = true; if (timer) clearTimeout(timer); doc?.removeEventListener('visibilitychange', onVisible); };
}
