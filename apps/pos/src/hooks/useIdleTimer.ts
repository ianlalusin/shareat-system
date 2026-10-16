"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface UseIdleTimerOptions {
  /** Milliseconds of inactivity before isIdle flips true. */
  idleMs: number;
  /** Activity events to listen for. Defaults to mouse/key/touch/scroll. */
  events?: (keyof WindowEventMap)[];
  /** Debounce window for activity bursts (default 250 ms). */
  debounceMs?: number;
}

const DEFAULT_EVENTS: (keyof WindowEventMap)[] = [
  "mousemove",
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
];

/**
 * Tracks whether the page is idle. `isIdle` flips true after `idleMs` of
 * no activity from the listed events. Any new activity flips it back to
 * false and updates `lastActivityAt`.
 *
 * `kick()` lets callers manually reset the idle window (useful when an
 * external source — e.g. a Firestore push — should count as activity).
 */
export function useIdleTimer({
  idleMs,
  events = DEFAULT_EVENTS,
  debounceMs = 250,
}: UseIdleTimerOptions) {
  const [isIdle, setIsIdle] = useState(false);
  const [lastActivityAt, setLastActivityAt] = useState<number>(() => Date.now());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFiredRef = useRef<number>(Date.now());

  const armTimer = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsIdle(true), idleMs);
  }, [idleMs]);

  const onActivity = useCallback(() => {
    const now = Date.now();
    // Debounce so a burst of mousemoves doesn't thrash state.
    if (now - lastFiredRef.current < debounceMs) return;
    lastFiredRef.current = now;
    setLastActivityAt(now);
    setIsIdle(false);
    armTimer();
  }, [armTimer, debounceMs]);

  const kick = useCallback(() => {
    onActivity();
  }, [onActivity]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    armTimer();
    const handler = () => onActivity();
    events.forEach((e) =>
      window.addEventListener(e, handler, { passive: true })
    );
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armTimer, idleMs]);

  return { isIdle, lastActivityAt, kick };
}
