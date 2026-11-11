'use client';

/**
 * T-526 R3 - usePosState: polls `/api/pos/state` every 3 s while the tab is visible and keeps the last body. The decisions (a 304 changes nothing,
 * two failures in a row mean Offline, a hidden tab asks nothing) are `pollPosState`'s; this hook only schedules it. No state library.
 */
import { useEffect, useRef, useState } from 'react';
import { POS_POLL_INTERVAL_MS } from './constants';
import { initialPosState, pollPosState, type PosState } from './pos-state';

/** T-527: the drain dispatches this on `document` after it removed events; the poll answers at once instead of waiting for its next beat. */
export const POS_STATE_REFRESH_EVENT = 'pos-state-refresh';

export function usePosState(storeId: string | null): PosState {
  const [state, setState] = useState<PosState>(initialPosState);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (!storeId) return;
    // Another store's version number means nothing here, so a store change starts from nothing (never a stale 304).
    latest.current = initialPosState;
    setState(initialPosState);
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await pollPosState({ fetch: (...a) => fetch(...a), storeId, visibilityState: () => document.visibilityState }, latest.current);
        if (!stopped && next !== latest.current) setState(next);
      } finally {
        inFlight = false;
      }
    };
    const onRefresh = (e: Event) => (e as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(tick());
    document.addEventListener(POS_STATE_REFRESH_EVENT, onRefresh);
    void tick();
    const timer = setInterval(tick, POS_POLL_INTERVAL_MS);
    // Coming back to a visible tab refreshes at once instead of waiting for the next beat.
    const onVisible = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener(POS_STATE_REFRESH_EVENT, onRefresh);
    };
  }, [storeId]);

  return state;
}
