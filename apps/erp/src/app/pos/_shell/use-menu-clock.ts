'use client';

/** T-559 R3 - the hook around `startClock`: returns the time (ms) of the last tick, so every priced view that takes it re-renders at each boundary. */
import { useEffect, useState } from 'react';
import type { DaypartHours } from '@/lib/pos-device/daypart-client';
import { startClock } from './menu-clock';

export function useMenuClock(hours: DaypartHours | undefined, nextChangeAt: string | null): number {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    // startClock only arms a FUTURE timer; hours that arrive late (or change) would leave `at` stale until the next boundary, so catch up first.
    setAt(Date.now());
    return startClock({ hours, nextChangeAt, onTick: () => setAt(Date.now()) });
  }, [hours, nextChangeAt]);
  return at;
}
