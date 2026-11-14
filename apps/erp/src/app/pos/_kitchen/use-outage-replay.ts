'use client';

/**
 * T-529 R3 - the shell's half of the outage print. The poll needs two misses (about 6 s) before it says Offline, so an order saved in that window was
 * not printed at the moment it was sent. Whenever the tablet is offline, every pending outbox order or refill that has not been printed is printed
 * now (`printUnprinted`; `app.outagePrinted` makes it once per event, across switches and reloads). It also forgets the seqs the outbox has dropped.
 */
import { useEffect, useRef } from 'react';
import type { PosEvent } from '@/lib/pos-device';
import { getMeta, setMeta } from '@/lib/pos-device';
import type { SnapshotOrdersPart } from '../_shell/use-device-sync';
import { reportOutage, reportOutageError } from './outage-jobs';
import { pruneOutagePrinted, pruneOutagePrintedToPending, printUnprinted } from './outage-replay';
import { outageDeps } from './use-outage-print';

export function useOutageReplay(i: { paired: boolean; online: boolean; snapshot: SnapshotOrdersPart | null; pending: PosEvent[]; loaded: boolean; openStands: unknown[] | null }): void {
  const { paired, online, snapshot, pending, loaded, openStands } = i;
  const seen = useRef<number[] | null>(null);
  // Forget what the outbox dropped. The first read after a load keeps only what is still pending; after that, only what vanished since the last read
  // (an event just saved may not be in this list yet, and its printed mark must stay).
  useEffect(() => {
    if (!paired || !loaded) return;
    const now = pending.map((e) => e.seq);
    const before = seen.current;
    seen.current = now;
    void (before === null ? pruneOutagePrintedToPending({ getMeta, setMeta }, now) : pruneOutagePrinted({ getMeta, setMeta }, before.filter((s) => !now.includes(s)))).catch(() => undefined);
  }, [paired, loaded, pending]);
  useEffect(() => {
    if (!paired || online || !loaded || pending.length === 0) return;
    const labels = Object.fromEntries(((openStands ?? []) as { sessionId: string; standNumber: number | null }[]).map((s) => [s.sessionId, s.standNumber === null ? null : String(s.standNumber)]));
    const deps = outageDeps({ online, snapshot, tableLabels: labels });
    if (!deps) return;
    void printUnprinted(deps, pending)
      .then(reportOutage)
      .catch(reportOutageError);
  }, [paired, online, loaded, pending, snapshot, openStands]);
}
