/**
 * T-425 slice T - a controllable wall clock. Fakes ONLY `Date` (vitest fake timers with `toFake: ['Date']`), so the fake IndexedDB's
 * and the fake Firestore's real setTimeout/microtasks keep running while `Date.now()` is under the test's control.
 *   const clock = installFakeClock(1_800_000_000_000);  clock.now();  clock.advance(4 * 3600_000);  clock.uninstall();
 */
import { vi } from 'vitest';

export interface FakeClock {
  now(): number;
  /** Moves `Date.now()` forward by `ms` (synchronously; no timers fire). */
  advance(ms: number): number;
  set(ms: number): void;
  uninstall(): void;
}

export function installFakeClock(startMs = 1_800_000_000_000): FakeClock {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startMs);
  return {
    now: () => Date.now(),
    advance: (ms) => { vi.setSystemTime(Date.now() + ms); return Date.now(); },
    set: (ms) => vi.setSystemTime(ms),
    uninstall: () => vi.useRealTimers(),
  };
}
