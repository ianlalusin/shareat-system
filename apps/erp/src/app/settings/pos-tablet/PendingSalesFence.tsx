'use client';

/**
 * T-563 R5 (audit P-004) - the friendly guard: while THIS browser's device outbox still holds unsent till actions, the Pair and Un-pair controls inside
 * the fence are disabled and one sentence says why. The outbox is IndexedDB, which the server cannot see, so the server's own rule (a batch is taken
 * only under a pairing of the same store, T-563 R3) is the backstop; this only stops a manager making the mistake by accident.
 * Any pending row counts: order and stand actions change tables that a sale closes, so all ten kinds are money events.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { countPending } from '@/lib/pos-device';
import { pendingSalesSentence } from './pending-sales';

/** The fence as drawn for a count: `null` = not read yet (or unreadable), which leaves the controls usable. */
export function FenceView({ count, children }: { count: number | null; children: ReactNode }) {
  const blocked = count !== null && count > 0;
  return (
    <fieldset disabled={blocked} className="m-0 min-w-0 space-y-3 border-0 p-0">
      {blocked ? (
        <p role="alert" className="text-sm text-warning-ink">
          {pendingSalesSentence(count)}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

export function PendingSalesFence({ children }: { children: ReactNode }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    countPending()
      .then((n) => alive && setCount(n))
      .catch(() => undefined); // no readable outbox here (a laptop that was never a tablet): nothing is waiting
    return () => {
      alive = false;
    };
  }, []);
  return <FenceView count={count}>{children}</FenceView>;
}
