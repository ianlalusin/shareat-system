"use client";
import { useEffect, useRef, useCallback } from "react";
import { useOnlineStatus } from "./use-online-status";
import { getQueue, updateQueueItem, removeFromQueue, type QueuedPayment } from "@/lib/offline/payment-queue";
import { useToast } from "./use-toast";

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

  const processQueue = useCallback(async () => {
    if (!ready) return;               // don't drain until auth is ready
    if (isSyncingRef.current) return;
    // Reclaim stale "syncing" items too: isSyncingRef prevents concurrent drains
    // within a session, so any "syncing" left in storage is from a prior session
    // hard-killed mid-await — reprocess it (per-effect state stops done effects re-firing).
    const queue = getQueue().filter((q) => q.status === "pending" || q.status === "syncing");
    if (queue.length === 0) { attemptsRef.current = 0; return; }

    isSyncingRef.current = true;
    let anyIncomplete = false;
    try {
      for (const item of queue) {
        updateQueueItem(item.id, { status: "syncing" });
        try {
          const { item: updated, complete } = await onSyncRef.current(item);
          if (complete) {
            removeFromQueue(item.id);
            toast({ title: "Offline sale synced", description: `Session ${item.sessionId.slice(0, 6)}… finalized.` });
          } else {
            anyIncomplete = true;
            updateQueueItem(item.id, { status: "pending", effects: updated.effects });
          }
        } catch (err: any) {
          // A THROW is a terminal conflict (e.g. an authoritative online receipt exists).
          updateQueueItem(item.id, { status: "failed", errorMessage: err?.message ?? String(err) });
          toast({ variant: "destructive", title: "Sync conflict", description: `Session ${item.sessionId.slice(0, 6)}…: ${err?.message ?? err}` });
        }
      }
    } finally {
      isSyncingRef.current = false;
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
