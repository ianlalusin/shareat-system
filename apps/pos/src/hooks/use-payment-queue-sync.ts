"use client";
import { useEffect, useRef, useCallback } from "react";
import { useOnlineStatus } from "./use-online-status";
import type { QueuedPayment } from "@/lib/offline/payment-queue";
import {
  listEffectItems,
  listRunnableEffectItems,
  migrateLegacyQueue,
  removeEffectItem,
  updateEffectItem,
} from "@/lib/outbox/effects-store";
import { notifyOutboxChanged } from "@/lib/outbox/outboxStatus";
import { useToast } from "./use-toast";

/**
 * Drains the deferred server effects (analytics, loyalty, PIN) from the IndexedDB effects store (T-425). An item runs only after its
 * receipt's ledger row is `acknowledged`, so apply-delta never runs before the receipt exists on the server. On first start the old
 * localStorage queue is copied across (a corrupt one is kept under `.corrupt` and reported).
 */
export function usePaymentQueueSync(
  onSync: (item: QueuedPayment) => Promise<{ item: QueuedPayment; complete: boolean }>,
  ready: boolean,
) {
  const isOnline = useOnlineStatus();
  const { toast } = useToast();
  const isSyncingRef = useRef(false);
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const migratedRef = useRef(false);

  const processQueue = useCallback(async () => {
    if (!ready) return;               // don't drain until auth is ready
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    let anyIncomplete = false;
    try {
      if (!migratedRef.current) {
        try {
          const moved = await migrateLegacyQueue();
          migratedRef.current = true;
          if (moved.corrupt) {
            toast({ variant: "destructive", title: "Saved sales follow-up was unreadable", description: "It was kept aside, not deleted. Tell the manager." });
          }
        } catch (err) {
          console.error("[QueueSync] could not move the old queue into IndexedDB; it stays where it is", err);
        }
      }
      // Reclaim stale "syncing" items: isSyncingRef prevents concurrent drains within a session, so any "syncing" left in storage is from a
      // prior session hard-killed mid-await — reprocess it (per-effect state stops done effects re-firing).
      for (const stale of (await listEffectItems()).filter((q) => q.status === "syncing")) {
        await updateEffectItem(stale.id, { status: "pending" });
      }
      const queue = await listRunnableEffectItems();
      if (queue.length === 0) { attemptsRef.current = 0; return; }

      for (const item of queue) {
        await updateEffectItem(item.id, { status: "syncing" });
        try {
          const { item: updated, complete } = await onSyncRef.current(item);
          if (complete) {
            await removeEffectItem(item.id);
            toast({ title: "Offline sale synced", description: `Session ${item.sessionId.slice(0, 6)}… finalized.` });
          } else {
            anyIncomplete = true;
            await updateEffectItem(item.id, { status: "pending", effects: updated.effects });
          }
        } catch (err: any) {
          // A THROW is a terminal conflict (e.g. an authoritative online receipt exists). It stays on the manager list with Retry.
          await updateEffectItem(item.id, { status: "failed", errorMessage: err?.message ?? String(err) });
          toast({ variant: "destructive", title: "Sync conflict", description: `Session ${item.sessionId.slice(0, 6)}…: ${err?.message ?? err}` });
        }
      }
    } catch (err) {
      console.error("[QueueSync] drain failed", err);
      anyIncomplete = true;
    } finally {
      isSyncingRef.current = false;
      notifyOutboxChanged();
    }

    if (anyIncomplete && isOnline && ready && attemptsRef.current < 5) {
      attemptsRef.current += 1;
      const delay = Math.min(30000, 2000 * 2 ** (attemptsRef.current - 1)); // 2s,4s,8s,16s,30s
      if (retryRef.current) clearTimeout(retryRef.current);
      retryRef.current = setTimeout(() => { void processQueue(); }, delay);
    } else if (!anyIncomplete) {
      attemptsRef.current = 0;
    }
  }, [ready, isOnline, toast]);

  useEffect(() => {
    if (isOnline && ready) void processQueue();
    return () => { if (retryRef.current) clearTimeout(retryRef.current); };
  }, [isOnline, ready, processQueue]);

  // A ledger row turning `acknowledged` is what makes an item runnable; look again every minute while online.
  useEffect(() => {
    if (!isOnline || !ready) return;
    const timer = setInterval(() => { void processQueue(); }, 60_000);
    return () => clearInterval(timer);
  }, [isOnline, ready, processQueue]);

  // Listen for SW background sync message (PWA)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "PROCESS_PAYMENT_QUEUE") {
        console.log("[QueueSync] SW triggered sync");
        void processQueue();
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [processQueue]);
}
