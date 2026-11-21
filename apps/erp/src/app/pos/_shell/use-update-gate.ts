'use client';

/**
 * T-621 S1 - the update gate's schedule. A deploy installs a new service worker that WAITS (public/sw.js); this hook lets it take over only when
 * `mayActivateUpdate` says so (nothing waiting to send, no payment screen open, online), and checks again each time one of those changes.
 * While held, the shell shows a quiet note (never a modal, never blocks selling).
 *
 * The Payment screen says it is open through `usePaymentScreenOpen` (a counter, so two mounts never clear each other).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activatePosUpdate, mayActivateUpdate, watchPosUpdate } from './offline-sw';

let paymentScreens = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const paymentOpenNow = () => paymentScreens > 0;

/** Call from the Payment screen: marks it open while mounted. */
export function usePaymentScreenOpen(): void {
  useEffect(() => {
    paymentScreens += 1;
    notify();
    return () => {
      paymentScreens -= 1;
      notify();
    };
  }, []);
}

/** Returns true while an update is ready but held back. */
export function useUpdateGate(input: { waiting: number; online: boolean }): boolean {
  const paymentOpen = useSyncExternalStore(subscribe, paymentOpenNow, () => false);
  const [ready, setReady] = useState(false);
  const sent = useRef(false);
  useEffect(() => watchPosUpdate(setReady), []);
  const go = ready && mayActivateUpdate({ waiting: input.waiting, paymentOpen, online: input.online });
  useEffect(() => {
    if (!go || sent.current) return;
    sent.current = true;
    void activatePosUpdate().finally(() => {
      sent.current = false; // a failed hand-over is tried again on the next change; a good one reloads the page
    });
  }, [go]);
  return ready;
}
