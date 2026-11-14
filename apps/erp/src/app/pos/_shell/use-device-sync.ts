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
import { heldSalesCount, nextHeldOrigins } from './held-sales';
import { POS_STATE_REFRESH_EVENT } from './use-pos-state';
import { browserPromoteJar, promoteAfterTabletSignIn } from './pending-verifier';
import { showNeedsInternetOnce } from './offline-band';
import { refreshSnapshot, snapshotNextChangeAt, type SnapshotBody } from './snapshot-sync';
import { restoredOfflineActor, type OfflineActor } from './offline-actor';
import { paymentPartOf, type SnapshotPaymentPart } from './payment-part';
import type { SnapshotStaff } from './verifier-expiry';

export type { OfflineActor, SnapshotPaymentPart };

/** What the Orders tab reads from the cached snapshot (T-527): the stand list and the menu. */
export interface SnapshotOrdersPart {
  stands: { id: string; number: number }[];
  menu: unknown;
  /** T-559: when the menu next changes (a 304 keeps this fresh from `x-next-change-at`); drives the shell's menu clock and a snapshot re-fetch at that time. */
  nextChangeAt?: string | null;
  /** T-539 S3: minutes before a table tile turns red. Null when the cached snapshot is older than the rule (no tile turns red until the next refresh). */
  tableWarnMinutes?: number | null;
  /** T-576: the store asks for a manager PIN on a line cancel / line discount. False when the cached snapshot is older than the rule (nothing is asked until the next refresh). */
  requirePinLineActions?: boolean;
  /** T-528: what the Payment screen prices and pays with. Null when the cached snapshot is older than the fields it needs (the tablet must go online once). */
  payment?: SnapshotPaymentPart | null;
}
export interface DeviceSync {
  /** The cached snapshot's staff list (empty until one exists). */
  staff: SnapshotStaff[];
  /** The cached snapshot's stands and menu; null until one exists. */
  ordersSnapshot: SnapshotOrdersPart | null;
  /** The outbox as it stands (the events not yet sent), oldest first: the Orders tab applies them on top of the server's list (T-527). */
  pendingEvents: PosEvent[];
  /** True once the outbox has been read at least once (T-529: the outage print must not judge a list that is still empty because it was not loaded). */
  pendingLoaded: boolean;
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
  /** T-563: waiting sales made under another store's pairing that the server refused to take here (0 when none). */
  heldSales: number;
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
  const b = s?.body as (Partial<SnapshotOrdersPart> & Record<string, unknown>) | undefined;
  if (!b || !Array.isArray(b.stands) || !b.menu) return null;
  const warn = (b.rules as { tableWarnMinutes?: unknown } | undefined)?.tableWarnMinutes;
  const requirePin = (b.rules as { requirePinLineActions?: unknown } | undefined)?.requirePinLineActions === true;
  return { stands: b.stands, menu: b.menu, nextChangeAt: snapshotNextChangeAt(s), tableWarnMinutes: typeof warn === 'number' ? warn : null, requirePinLineActions: requirePin, payment: paymentPartOf(b) };
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
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  const [heldOrigins, setHeldOrigins] = useState<string[]>([]);
  const [actor, setActor] = useState<OfflineActor | null>(null);
  const draining = useRef(false);
  const again = useRef(false);
  const onResults = useRef<((sent: PosEvent[], results: PosEventResult[]) => void) | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

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
    // The whole outbox in one read (T-530a: `listPending` takes a count and has no cap): the Orders projection, the outage print and its printed-set must see EVERY pending event.
    const list = await listPending(await countPending());
    setPendingEvents((prev) => (sameEvents(prev, list) ? prev : list));
    setPendingLoaded(true);
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
      setHeldOrigins((prev) => nextHeldOrigins(prev, report));
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
    refreshRef.current = run;
    void run();
    const timer = setInterval(run, POS_SNAPSHOT_REFRESH_MS);
    return () => {
      stopped = true;
      refreshRef.current = null;
      clearInterval(timer);
    };
  }, [paired, personId]);

  // T-559 R3: a scheduled price change is fetched when it is due, not up to 5 minutes later. A 304 moves `nextChangeAt` (touchSnapshot), which re-arms this; a
  // time already past arms nothing, so a stale time cannot loop.
  const nextChange = snapshotNextChangeAt(snapshot);
  useEffect(() => {
    const ms = nextChange ? Date.parse(nextChange) - Date.now() : NaN;
    if (!paired || !(ms > 0)) return;
    const t = setTimeout(() => void refreshRef.current?.(), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [paired, nextChange]);

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
    pendingLoaded,
    requestDrain,
    setResultsHandler,
    needsInternet: showNeedsInternetOnce({ paired, snapshotUsable: usable, unpaired }),
    unpaired,
    pending,
    sending,
    conflicts,
    heldSales: heldSalesCount(pendingEvents, heldOrigins, (snapshot?.body as Partial<SnapshotBody> | undefined)?.device?.pairingId ?? null),
    clearConflicts: () => setConflicts(0),
    refreshPending,
    drainNow,
    offlineActor: actor,
    setOfflineActor,
  };
}
