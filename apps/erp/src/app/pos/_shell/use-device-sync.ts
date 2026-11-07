'use client';

/**
 * T-526 R3/R4/R5 - everything the shell does with the tablet's own store: refresh the snapshot, promote the pending PIN verifier, send the
 * outbox, and remember who is holding the tablet while it is offline. Paired tablet only; a phone or a kitchen browser has no device store use.
 * The logic lives in the plain modules next to this file (and is tested there); this hook only schedules it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { countPending, drain, isSnapshotUsable, listPending, listVerifiers, readSnapshot, type CachedSnapshot, type PosEvent, type PosEventResult } from '@/lib/pos-device';
import { POS_DRAIN_INTERVAL_MS, POS_OFFLINE_ACTOR_KEY, POS_OFFLINE_SNAPSHOT_MAX_AGE_MS, POS_POLL_INTERVAL_MS, POS_SNAPSHOT_REFRESH_MS } from './constants';
import { makePosSend } from './drain-send';
import { POS_STATE_REFRESH_EVENT } from './use-pos-state';
import { browserPromoteJar, promoteAfterTabletSignIn } from './pending-verifier';
import { showNeedsInternetOnce } from './offline-band';
import { refreshSnapshot, type SnapshotBody } from './snapshot-sync';
import { restoredOfflineActor, type OfflineActor } from './offline-actor';
import type { SnapshotStaff } from './verifier-expiry';

export type { OfflineActor };

/** What the Orders tab reads from the cached snapshot (T-527): the stand list and the menu. */
export interface SnapshotOrdersPart {
  stands: { id: string; number: number }[];
  menu: unknown;
}

export interface DeviceSync {
  /** The cached snapshot's staff list (empty until one exists). */
  staff: SnapshotStaff[];
  /** The cached snapshot's stands and menu; null until one exists. */
  ordersSnapshot: SnapshotOrdersPart | null;
  /** The outbox as it stands (the events not yet sent), oldest first: the Orders tab applies them on top of the server's list (T-527). */
  pendingEvents: PosEvent[];
  /** Asks for a send now; a request made while one is running is sent right after it (T-527). */
  requestDrain: () => void;
  /** The Orders tab hears every result list from the drain's send wrapper, BEFORE the outbox drops those events (T-527 refusal notice). */
  setResultsHandler: (handler: ((sent: PosEvent[], results: PosEventResult[]) => void) | null) => void;
  /** True once the first refresh finished and there is still no usable snapshot: the tablet has never been online here. */
  needsInternet: boolean;
  unpaired: boolean;
  pending: number;
  sending: boolean;
  conflicts: number;
  clearConflicts: () => void;
  refreshPending: () => Promise<void>;
  drainNow: () => Promise<void>;
  offlineActor: OfflineActor | null;
  setOfflineActor: (actor: OfflineActor | null) => void;
}

function staffOf(s: CachedSnapshot | null): SnapshotStaff[] {
  return (s?.body as Partial<SnapshotBody> | undefined)?.staff ?? [];
}

function ordersPartOf(s: CachedSnapshot | null): SnapshotOrdersPart | null {
  const b = s?.body as Partial<SnapshotOrdersPart> | undefined;
  return b && Array.isArray(b.stands) && b.menu ? { stands: b.stands, menu: b.menu } : null;
}

const sameEvents = (a: PosEvent[], b: PosEvent[]): boolean => a.length === b.length && a.every((e, i) => e.seq === b[i]!.seq);

export function useDeviceSync(input: { paired: boolean; personId: string; online: boolean }): DeviceSync {
  const { paired, personId, online } = input;
  const [snapshot, setSnapshot] = useState<CachedSnapshot | null>(null);
  // null until the first refresh finished; then whether the cached snapshot is inside the offline limit.
  const [usable, setUsable] = useState<boolean | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [pending, setPending] = useState(0);
  const [pendingEvents, setPendingEvents] = useState<PosEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  const [actor, setActor] = useState<OfflineActor | null>(null);
  const draining = useRef(false);
  const again = useRef(false);
  const onResults = useRef<((sent: PosEvent[], results: PosEventResult[]) => void) | null>(null);

  const setOfflineActor = useCallback((next: OfflineActor | null) => {
    setActor(next);
    if (!next) {
      try {
        window.sessionStorage.removeItem(POS_OFFLINE_ACTOR_KEY);
      } catch {
        // nothing to clear
      }
    }
  }, []);

  const refreshPending = useCallback(async () => {
    setPending(await countPending());
    const list = await listPending(500);
    setPendingEvents((prev) => (sameEvents(prev, list) ? prev : list));
  }, []);

  const drainNow = useCallback(async () => {
    if (draining.current) {
      again.current = true; // something was added while a send was running: send again right after it
      return;
    }
    draining.current = true;
    setSending(true);
    try {
      const send = makePosSend((...a) => fetch(...a));
      const report = await drain(async (batch) => {
        const outcome = await send(batch);
        if (outcome.kind === 'ok') onResults.current?.(batch, outcome.results);
        return outcome;
      });
      if (report.stopped === 'http' && report.status === 401) setUnpaired(true);
      if (report.conflicts.length > 0) setConflicts((n) => n + report.conflicts.length);
      // Ask the poll to answer at once. The Orders tab keeps a dropped event on screen until that answer and the table's body have both landed (settle.ts).
      if (report.removed > 0) document.dispatchEvent(new CustomEvent(POS_STATE_REFRESH_EVENT, { detail: { waits: [] } }));
    } finally {
      draining.current = false;
      setSending(false);
      await refreshPending();
      if (again.current) {
        again.current = false;
        void drainNow();
      }
    }
  }, [refreshPending]);

  const requestDrain = useCallback(() => {
    void refreshPending();
    void drainNow();
  }, [refreshPending, drainNow]);
  const setResultsHandler = useCallback((handler: ((sent: PosEvent[], results: PosEventResult[]) => void) | null) => {
    onResults.current = handler;
  }, []);

  // Snapshot: on mount and every 5 minutes. The first pass also promotes the pending verifier, which is ALWAYS consumed (R4).
  useEffect(() => {
    if (!paired) return;
    let stopped = false;
    let first = true;
    const run = async () => {
      const result = await refreshSnapshot({ fetch: (...a) => fetch(...a), nowMs: Date.now() });
      if (stopped) return;
      if (result.kind === 'unpaired') setUnpaired(true);
      const snap = await readSnapshot();
      if (stopped) return;
      setSnapshot(snap);
      setUsable(isSnapshotUsable(snap, Date.now(), POS_OFFLINE_SNAPSHOT_MAX_AGE_MS));
      if (first) {
        first = false;
        await promoteAfterTabletSignIn({ storage: window.sessionStorage, jar: browserPromoteJar(), staff: staffOf(snap), personId, nowMs: Date.now() }).catch(() => undefined);
      }
    };
    void run();
    const timer = setInterval(run, POS_SNAPSHOT_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [paired, personId]);

  // The waiting count follows the outbox every poll beat; an online tablet with something waiting sends it every 10 s, never from a hidden tab.
  useEffect(() => {
    if (!paired) return;
    void refreshPending();
    const count = setInterval(() => void refreshPending(), POS_POLL_INTERVAL_MS);
    const send = setInterval(() => {
      if (online && document.visibilityState === 'visible') void drainNow();
    }, POS_DRAIN_INTERVAL_MS);
    return () => {
      clearInterval(count);
      clearInterval(send);
    };
  }, [paired, online, drainNow, refreshPending]);

  // Who is holding the tablet offline survives a reload (sessionStorage), but is put back only by `restoredOfflineActor`'s rules: offline, a usable
  // snapshot, and the person's verifier still on the device. Waits for the first refresh (usable !== null) so an empty cache never clears it.
  useEffect(() => {
    if (!paired || online || usable === null) return;
    let stopped = false;
    void (async () => {
      try {
        const raw = window.sessionStorage.getItem(POS_OFFLINE_ACTOR_KEY);
        if (!raw) return;
        const restored = restoredOfflineActor({
          raw,
          online,
          snapshotUsable: isSnapshotUsable(snapshot, Date.now(), POS_OFFLINE_SNAPSHOT_MAX_AGE_MS),
          staff: staffOf(snapshot),
          verifierPersonIds: new Set((await listVerifiers()).map((v) => v.personId)),
        });
        if (stopped) return;
        if (restored) setActor((cur) => cur ?? restored);
        else window.sessionStorage.removeItem(POS_OFFLINE_ACTOR_KEY);
      } catch {
        // storage blocked: no offline actor survives a reload, which is the safe direction
      }
    })();
    return () => {
      stopped = true;
    };
  }, [paired, online, usable, snapshot]);

  useEffect(() => {
    if (!actor) return;
    const timer = setInterval(() => {
      if (!isSnapshotUsable(snapshot, Date.now(), POS_OFFLINE_SNAPSHOT_MAX_AGE_MS)) setOfflineActor(null);
    }, 60_000);
    return () => clearInterval(timer);
  }, [actor, snapshot, setOfflineActor]);

  return {
    staff: staffOf(snapshot),
    ordersSnapshot: ordersPartOf(snapshot),
    pendingEvents,
    requestDrain,
    setResultsHandler,
    needsInternet: showNeedsInternetOnce({ paired, snapshotUsable: usable, unpaired }),
    unpaired,
    pending,
    sending,
    conflicts,
    clearConflicts: () => setConflicts(0),
    refreshPending,
    drainNow,
    offlineActor: actor,
    setOfflineActor,
  };
}
